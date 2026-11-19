// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test, Vm } from "forge-std/Test.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DaybookFixture } from "./harness/DaybookFixture.sol";
import { DaybookReactive } from "../src/DaybookReactive.sol";
import { DaybookTill } from "../src/DaybookTill.sol";
import { PayAddressFactory } from "../src/PayAddressFactory.sol";
import { SavingsVault } from "../src/SavingsVault.sol";
import { IDaybookTill } from "../src/interfaces/IDaybookTill.sol";
import { IReserve } from "../src/interfaces/IReserve.sol";
import { IReceiptIssuer } from "../src/interfaces/IReceiptIssuer.sol";
import { AcceptedToken as AcceptedToken_, DaybookLib, Recipient, SplitPolicy } from "../src/DaybookTypes.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

/// @notice Returns nothing: `try` would revert decoding this; the till's low-level call must not.
contract SilentIssuer {
    fallback() external { }
}

/// @notice Returns a megabyte of data: the till must not pay to copy it.
contract ReturnBombIssuer {
    fallback() external {
        assembly {
            return(0, 1000000)
        }
    }
}

/// @notice Regression tests for the security review findings (docs/SECURITY_REVIEW.md), one or more per fix.
contract SecurityFixesTest is DaybookFixture {
    uint256 internal constant TRANSFER_TOPIC = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;
    uint256 internal constant AMOUNT = 1000e6;

    // ------------------------------------------------------------------- H-1

    function test_H1_DefaultParamsWatchAcceptedTokensOnly() public {
        DaybookReactive.CreateInvoiceParams memory p;
        p.amount = AMOUNT;
        p.policyId = policyId;
        p.accepted = _acceptAB();
        vm.prank(owner);
        uint256 id = reactive.createInvoice(p);
        _flush();
        assertFalse(reactive.getInvoice(id).watchAllTokens);
        DaybookReactive.Sub[] memory subs = reactive.subscriptionsOf(id);
        assertEq(subs[0].contractAddr, address(usd[CHAIN_A]), "zero-valued params mean strict watching");
        _pay(junkA, payer, reactive.payAddressOf(id), 5);
        assertEq(reactive.ledgerLength(), 0, "spam from other contracts never reaches react()");
    }

    function test_H1_NarrowingKeepsCoverGasUnderCap() public {
        // Eight pairs (worst case for unsubscribe plus resubscribe) on a watch-all invoice.
        uint256[3] memory chains = [CHAIN_A, CHAIN_B, CHAIN_C];
        DaybookReactive.CreateInvoiceParams memory p = _params(AMOUNT, _acceptAB(), 0, 0, false);
        AcceptedTokenList memory l;
        for (uint256 i; i < 8; ++i) {
            MockERC20 t = new MockERC20("USD", 6);
            _registerEmitter(address(t), chains[i % 3]);
            l.items[i] = t;
        }
        p.accepted = _toAccepted(l, chains);
        vm.prank(owner);
        uint256 id = reactive.createInvoice(p);
        _flush();
        maxReactGas = 0;
        for (uint256 i; i < 16; ++i) {
            _pay(junkA, payer, reactive.payAddressOf(id), 1);
        }
        assertFalse(reactive.getInvoice(id).watchAllTokens);
        assertEq(reactive.subscriptionsOf(id).length, 8);
        assertEq(reactReverts, 0);
        emit log_named_uint("max react gas, narrowing an eight-pair watch", maxReactGas);
        assertLt(maxReactGas, 800_000);
        assertEq(unsubscribeMisses, 0);
    }

    struct AcceptedTokenList {
        MockERC20[8] items;
    }

    function _toAccepted(AcceptedTokenList memory l, uint256[3] memory chains)
        internal
        view
        returns (AcceptedToken_[] memory acc)
    {
        acc = new AcceptedToken_[](8);
        for (uint256 i; i < 8; ++i) {
            acc[i] = AcceptedToken_(uint64(chains[i % 3]), address(l.items[i]), 6);
        }
    }

    function test_H1_RunwayViewReportsBalanceAndQueues() public {
        uint64 due = uint64(block.timestamp + 1 days);
        _create(AMOUNT, _acceptAB(), due, 0, true);
        (uint256 balance, uint256 reserves, uint256 debt, bool cron, uint256 pending, uint256 timed, uint256 closing) =
            reactive.runway();
        assertEq(balance, 1 ether);
        assertEq(reserves, 0, "the mock system has no reserves() and the view tolerates that");
        assertEq(debt, 0);
        assertTrue(cron);
        assertEq(pending, 0);
        assertEq(timed, 1);
        assertEq(closing, 0);
    }

    // ------------------------------------------------------------------- M-2

    function test_M2_ReceiptGoesToLargestContributor() public {
        uint256 id = _createAB(AMOUNT);
        _pay(usd[CHAIN_A], payer2, reactive.payAddressOf(id), 100e6);
        _payInvoice(CHAIN_A, id, 600e6);
        _pay(usd[CHAIN_A], payer2, reactive.payAddressOf(id), 300e6);
        assertEq(reactive.receiptPayerOf(1), payer, "600 beats 300 and 100");
    }

    function test_M2_LatePaymentReceiptNamesItsOwnSender() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_A, id, AMOUNT);
        address late = makeAddr("late");
        address pay = reactive.payAddressOf(id);
        usd[CHAIN_A].mint(pay, 7e6);
        IReactive.LogRecord memory rec;
        rec.chainId = CHAIN_A;
        rec.contractAddress = address(usd[CHAIN_A]);
        rec.topic0 = TRANSFER_TOPIC;
        rec.topic1 = uint256(uint160(late));
        rec.topic2 = uint256(uint160(pay));
        rec.opCode = 3;
        rec.data = abi.encode(7e6);
        rec.txHash = 0x1a7e;
        _react(address(reactive), rec);
        _drain();
        assertEq(reactive.receiptPayerOf(2), late);
        assertEq(reactive.receiptPayerOf(1), payer, "the first settlement keeps its payer");
    }

    // ------------------------------------------------------------------- M-4

    function _missed(uint256 id, uint256 value, uint256 txHash) internal view returns (IReactive.LogRecord memory r) {
        r.chainId = CHAIN_A;
        r.contractAddress = address(usd[CHAIN_A]);
        r.topic0 = TRANSFER_TOPIC;
        r.topic1 = uint256(uint160(payer));
        r.topic2 = uint256(uint160(reactive.payAddressOf(id)));
        r.opCode = 3;
        r.data = abi.encode(value);
        r.txHash = txHash;
    }

    function test_M4_OwnerRecordsMissedTransferAndLateDeliveryIsDuplicate() public {
        uint256 id = _createAB(AMOUNT);
        usd[CHAIN_A].mint(reactive.payAddressOf(id), AMOUNT);
        IReactive.LogRecord memory r = _missed(id, AMOUNT, 0xfeed);
        vm.expectEmit(true, false, false, true, address(reactive));
        emit DaybookReactive.OwnerRecorded(id, CHAIN_A, 0xfeed, 0);
        vm.prank(owner);
        reactive.recordMissedTransfer(r);
        _flush();
        _drain();
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        // The log turns up after all: a harmless duplicate.
        _react(address(reactive), r);
        assertEq(reactive.ledgerLength(), 1);
        // And the owner cannot record it twice.
        vm.prank(owner);
        vm.expectRevert(DaybookReactive.NotRecordable.selector);
        reactive.recordMissedTransfer(r);
    }

    function test_M4_RecordMissedTransferGuards() public {
        uint256 id = _createAB(AMOUNT);
        IReactive.LogRecord memory r = _missed(id, 1, 0xabc);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reactive.recordMissedTransfer(r);
        vm.startPrank(owner);
        r.opCode = 4;
        vm.expectRevert(DaybookReactive.NotRecordable.selector);
        reactive.recordMissedTransfer(r);
        r.opCode = 3;
        r.topic2 = 0xdead;
        vm.expectRevert(DaybookReactive.NotRecordable.selector);
        reactive.recordMissedTransfer(r);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------- L-1

    function test_L1_SetTillRefusedWhileSettlementsOpenOnThatChain() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        tillOn[CHAIN_A].pause();
        _payInvoice(CHAIN_A, id, AMOUNT);
        assertEq(reactive.openSettlementsOn(CHAIN_A), 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DaybookReactive.OpenSettlementsOnChain.selector, CHAIN_A, 1));
        reactive.setTill(CHAIN_A, makeAddr("newTill"));
        // Other chains are unaffected.
        vm.prank(owner);
        reactive.setTill(CHAIN_B, address(tillOn[CHAIN_B]));
        // Once acknowledged, the change goes through.
        vm.prank(owner);
        tillOn[CHAIN_A].unpause();
        _warpTick(301);
        assertEq(reactive.openSettlementsOn(CHAIN_A), 0);
        vm.prank(owner);
        reactive.setTill(CHAIN_A, makeAddr("newTill"));
    }

    function test_L1_StuckSettlementStillBlocksSetTill() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        tillOn[CHAIN_A].pause();
        _payInvoice(CHAIN_A, id, AMOUNT);
        for (uint256 i; i < 5; ++i) {
            _warpTick(301);
        }
        assertEq(uint8(reactive.getSettlement(1).status), uint8(DaybookReactive.SettlementStatus.Stuck));
        assertEq(reactive.openSettlementsOn(CHAIN_A), 1);
        vm.prank(owner);
        reactive.resolveSettlement(1);
        assertEq(reactive.openSettlementsOn(CHAIN_A), 0);
    }

    // ------------------------------------------------------------------- L-3

    function test_L3_RenounceOwnershipDisabledEverywhere() public {
        vm.startPrank(owner);
        vm.expectRevert(DaybookReactive.RenounceDisabled.selector);
        reactive.renounceOwnership();
        vm.expectRevert(DaybookTill.RenounceDisabled.selector);
        tillOn[CHAIN_A].renounceOwnership();
        vm.expectRevert(PayAddressFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
        vm.expectRevert(SavingsVault.RenounceDisabled.selector);
        reserveOn[CHAIN_A].renounceOwnership();
        vm.stopPrank();
        assertEq(reactive.owner(), owner);
    }

    // ------------------------------------------------------------------- L-4

    function test_L4_ZeroSweepEmitsNothingAndResolvesNothing() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        tillOn[CHAIN_A].pause();
        _payInvoice(CHAIN_A, id, AMOUNT);
        // Wrong token: nothing to move.
        vm.prank(owner);
        tillOn[CHAIN_A].sweep(id, address(junkA), treasury);
        _relayRecorded();
        assertEq(uint8(reactive.getSettlement(1).status), uint8(DaybookReactive.SettlementStatus.Pending));
    }

    function test_L4_SweepOnlyClearsWhatItMoved() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_A, id, 300e6);
        // The owner sweeps 300; a 200 transfer lands right after and is reacted to before the ManualSweep log.
        vm.prank(owner);
        tillOn[CHAIN_A].sweep(id, address(usd[CHAIN_A]), treasury);
        Vm.Log[] memory sweepLogs = vm.getRecordedLogs();
        _payInvoice(CHAIN_A, id, 200e6);
        _relayLogs(sweepLogs);
        DaybookReactive.PairState memory ps = reactive.pairState(id, 0);
        assertEq(ps.counted, 200e6, "the raced transfer keeps its balance");
        _payInvoice(CHAIN_A, id, 500e6);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        assertEq(usd[CHAIN_A].balanceOf(reactive.payAddressOf(id)), 0, "nothing left behind");
    }

    // ------------------------------------------------------------------- L-5

    function test_L5_ManualSweepAckStaysUnderGasCapWithManyPending() public {
        vm.prank(owner);
        tillOn[CHAIN_A].pause();
        uint256 first;
        for (uint256 i; i < 40; ++i) {
            uint256 id = _createAB(10e6);
            if (i == 0) first = id;
            _payInvoice(CHAIN_A, id, 10e6);
        }
        assertEq(reactive.pendingSeqs().length, 40);
        vm.prank(owner);
        tillOn[CHAIN_A].sweep(first, address(usd[CHAIN_A]), treasury);
        maxReactGas = 0;
        _relayRecorded();
        assertEq(reactReverts, 0);
        assertLt(maxReactGas, 900_000);
        assertEq(uint8(_status(first)), uint8(DaybookReactive.InvoiceStatus.Settled));
    }

    // ------------------------------------------------------------------- L-6

    function test_L6_InvoiceCapMirrorsTill() public {
        vm.prank(owner);
        reactive.setMaxInvoiceAmount(5000e6);
        DaybookReactive.CreateInvoiceParams memory p = _params(5000e6 + 1, _acceptAB(), 0, 0, true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DaybookReactive.OverInvoiceCap.selector, 5000e6 + 1, 5000e6));
        reactive.createInvoice(p);
        vm.startPrank(owner);
        vm.expectRevert(DaybookReactive.ZeroAmount.selector);
        reactive.setMaxInvoiceAmount(0);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reactive.setMaxInvoiceAmount(1);
    }

    function test_L6_DefaultInvoiceCap() public {
        DaybookReactive fresh = new DaybookReactive(owner, address(factory), CRON100);
        assertEq(fresh.maxInvoiceAmount(), 10_000e6);
    }
}

/// @notice Till-side fixes: re-acknowledgement (M-1), receipt budget and tolerant calls (M-3, L-2), sweep (L-4).
contract TillSecurityFixesTest is Test {
    address internal proxy = makeAddr("proxy");
    address internal rc = makeAddr("rc");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal payer = makeAddr("payer");
    PayAddressFactory internal factory;
    DaybookTill internal till;
    MockERC20 internal usdc;

    function setUp() public {
        factory = new PayAddressFactory(owner);
        till = new DaybookTill(IPayable(payable(proxy)), rc, factory, owner);
        usdc = new MockERC20("USDC", 6);
        vm.startPrank(owner);
        factory.setTill(address(till), true);
        till.setMaxSettlement(IERC20(address(usdc)), 1e12);
        vm.stopPrank();
    }

    function _policy() internal view returns (SplitPolicy memory p) {
        p.treasury = treasury;
        p.team = new Recipient[](0);
    }

    function _settle(uint256 seq, uint256 amount) internal {
        vm.prank(proxy);
        till.settle(rc, 1, seq, address(usdc), amount, 0, payer, _policy());
    }

    function test_M1_DuplicateReEmitsSettledWithStoredUid() public {
        MockEASLike issuer = new MockEASLike();
        vm.prank(owner);
        till.setReceiptIssuer(IReceiptIssuer(address(issuer)));
        usdc.mint(factory.payAddress(DaybookLib.salt(rc, 1)), 10e6);
        _settle(1, 10e6);
        bytes32 uid = till.receiptUidOf(1, 1);
        assertTrue(uid != bytes32(0));
        vm.expectEmit(true, true, true, true, address(till));
        emit IDaybookTill.Settled(1, 1, address(usdc), 10e6, 0, payer, block.chainid, uid);
        _settle(1, 10e6);
        assertEq(issuer.count(), 1, "no second receipt");
        assertEq(usdc.balanceOf(treasury), 10e6, "no second payout");
    }

    function test_M3_ReceiptBudgetCoversMeasuredEas() public view {
        assertGe(till.RECEIPT_GAS(), 313_995 * 12 / 10, "at least 20% over the measured Base EAS attestation");
    }

    function test_L2_SettersRejectAddressesWithoutCode() public {
        address eoa = makeAddr("eoa");
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(DaybookTill.NotAContract.selector, eoa));
        till.setReserve(IReserve(eoa));
        vm.expectRevert(abi.encodeWithSelector(DaybookTill.NotAContract.selector, eoa));
        till.setReceiptIssuer(IReceiptIssuer(eoa));
        till.setReserve(IReserve(address(0)));
        till.setReceiptIssuer(IReceiptIssuer(address(0)));
        vm.stopPrank();
    }

    function test_L2_IssuerReturningNothingDoesNotBlock() public {
        SilentIssuer s = new SilentIssuer();
        vm.prank(owner);
        till.setReceiptIssuer(IReceiptIssuer(address(s)));
        _settle(1, 0);
        assertTrue(till.settled(1, 1));
        assertEq(till.receiptUidOf(1, 1), bytes32(0));
    }

    function test_L2_ReturnBombIsNotCopied() public {
        ReturnBombIssuer b = new ReturnBombIssuer();
        vm.prank(owner);
        till.setReceiptIssuer(IReceiptIssuer(address(b)));
        uint256 g = gasleft();
        _settle(1, 0);
        assertLt(g - gasleft(), 700_000);
        assertTrue(till.settled(1, 1));
    }

    function test_L2_IssuerWhoseCodeVanishedDoesNotBlock() public {
        SilentIssuer s = new SilentIssuer();
        vm.prank(owner);
        till.setReceiptIssuer(IReceiptIssuer(address(s)));
        vm.etch(address(s), "");
        _settle(1, 0);
        assertTrue(till.settled(1, 1));
    }

    function test_L4_ZeroSweepEmitsNoManualSweep() public {
        vm.recordLogs();
        vm.prank(owner);
        till.sweep(1, address(usdc), treasury);
        assertEq(vm.getRecordedLogs().length, 0);
    }
}

contract MockEASLike is IReceiptIssuer {
    uint256 public count;

    function issue(uint256, uint256 seq, address, address, uint256) external returns (bytes32) {
        ++count;
        return keccak256(abi.encode(seq, count));
    }
}
