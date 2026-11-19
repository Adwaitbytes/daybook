// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DaybookFixture } from "./harness/DaybookFixture.sol";
import { DaybookReactive } from "../src/DaybookReactive.sol";
import { IDaybookTill } from "../src/interfaces/IDaybookTill.sol";
import { AcceptedToken, DaybookLib, Recipient, SplitPolicy } from "../src/DaybookTypes.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

contract DaybookReactiveTest is DaybookFixture {
    uint256 internal constant TRANSFER_TOPIC = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;
    uint256 internal constant AMOUNT = 250e6;

    // ------------------------------------------------------------ construction

    function test_Constructor_RejectsZeroFactory() public {
        vm.expectRevert(DaybookReactive.ZeroAddress.selector);
        new DaybookReactive(owner, address(0), CRON100);
    }

    function test_Constructor_RejectsUnknownCronTopic() public {
        vm.expectRevert(DaybookReactive.BadCronTopic.selector);
        new DaybookReactive(owner, address(factory), uint256(keccak256("Cron7")));
    }

    function test_Constructor_DerivesVaultImplementationFromFactory() public view {
        assertEq(reactive.VAULT_IMPLEMENTATION(), factory.VAULT_IMPLEMENTATION());
        assertEq(reactive.FACTORY(), address(factory));
        assertEq(address(reactive).balance, 1 ether, "payable constructor funded it");
    }

    function test_EventTopicLiterals_MatchTillInterface() public pure {
        assertEq(
            IDaybookTill.Settled.selector,
            keccak256("Settled(uint256,uint256,address,uint256,uint256,address,uint256,bytes32)")
        );
        assertEq(IDaybookTill.ManualSweep.selector, keccak256("ManualSweep(uint256,address,address,uint256)"));
    }

    function test_React_OnlySystem() public {
        IReactive.LogRecord memory rec;
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM_ADDR));
        reactive.react(rec);
    }

    // ---------------------------------------------------------------- policies

    function test_CreatePolicy_StoresAndEmits() public {
        Recipient[] memory team = new Recipient[](1);
        team[0] = Recipient(team1, 9000);
        vm.prank(owner);
        uint32 id = reactive.createPolicy(treasury, 1000, team);
        SplitPolicy memory p = reactive.getPolicy(id);
        assertEq(p.treasury, treasury);
        assertEq(p.taxBps, 1000);
        assertEq(p.team.length, 1);
        assertEq(p.team[0].bps, 9000);
    }

    function test_CreatePolicy_RejectsTooManyRecipients() public {
        Recipient[] memory team = new Recipient[](6);
        for (uint256 i; i < 6; ++i) {
            team[i] = Recipient(address(uint160(i + 1)), 100);
        }
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DaybookLib.TooManyRecipients.selector, 6));
        reactive.createPolicy(treasury, 0, team);
    }

    function test_CreatePolicy_RejectsBpsOverflow() public {
        Recipient[] memory team = new Recipient[](1);
        team[0] = Recipient(team1, 9001);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DaybookLib.BpsOverflow.selector, 10_001));
        reactive.createPolicy(treasury, 1000, team);
    }

    function test_CreatePolicy_RejectsZeroTreasuryAndZeroShare() public {
        Recipient[] memory team = new Recipient[](0);
        vm.startPrank(owner);
        vm.expectRevert(DaybookLib.ZeroAddress.selector);
        reactive.createPolicy(address(0), 0, team);
        team = new Recipient[](1);
        team[0] = Recipient(team1, 0);
        vm.expectRevert(DaybookLib.ZeroBps.selector);
        reactive.createPolicy(treasury, 0, team);
        team[0] = Recipient(address(0), 10);
        vm.expectRevert(DaybookLib.ZeroAddress.selector);
        reactive.createPolicy(treasury, 0, team);
        vm.stopPrank();
    }

    function test_CreatePolicy_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reactive.createPolicy(treasury, 0, new Recipient[](0));
    }

    // ------------------------------------------------------------ invoice input

    function _expectCreateRevert(DaybookReactive.CreateInvoiceParams memory p, bytes memory err) internal {
        vm.prank(owner);
        vm.expectRevert(err);
        reactive.createInvoice(p);
    }

    function test_CreateInvoice_RejectsZeroAmount() public {
        _expectCreateRevert(_params(0, _acceptAB(), 0, 0, false), abi.encodeWithSelector(DaybookReactive.ZeroAmount.selector));
    }

    function test_CreateInvoice_RejectsUnknownPolicy() public {
        DaybookReactive.CreateInvoiceParams memory p = _params(AMOUNT, _acceptAB(), 0, 0, false);
        p.policyId = 99;
        _expectCreateRevert(p, abi.encodeWithSelector(DaybookReactive.UnknownPolicy.selector, uint32(99)));
    }

    function test_CreateInvoice_RejectsChainWithoutTill() public {
        AcceptedToken[] memory acc = new AcceptedToken[](1);
        acc[0] = AcceptedToken(42_161, address(usd[CHAIN_A]), 6);
        _expectCreateRevert(
            _params(AMOUNT, acc, 0, 0, false), abi.encodeWithSelector(DaybookReactive.NoTill.selector, 42_161)
        );
    }

    function test_CreateInvoice_RejectsDuplicatePair() public {
        AcceptedToken[] memory acc = new AcceptedToken[](2);
        acc[0] = _accept(CHAIN_A);
        acc[1] = _accept(CHAIN_A);
        _expectCreateRevert(
            _params(AMOUNT, acc, 0, 0, false),
            abi.encodeWithSelector(DaybookReactive.DuplicatePair.selector, CHAIN_A, address(usd[CHAIN_A]))
        );
    }

    function test_CreateInvoice_RejectsBadDecimals() public {
        AcceptedToken[] memory acc = new AcceptedToken[](1);
        acc[0] = AcceptedToken(uint64(CHAIN_A), address(usd[CHAIN_A]), 31);
        _expectCreateRevert(
            _params(AMOUNT, acc, 0, 0, false), abi.encodeWithSelector(DaybookReactive.BadDecimals.selector, 31)
        );
    }

    function test_CreateInvoice_RejectsEmptyOrTooManyAccepted() public {
        _expectCreateRevert(
            _params(AMOUNT, new AcceptedToken[](0), 0, 0, false),
            abi.encodeWithSelector(DaybookReactive.BadAccepted.selector)
        );
        AcceptedToken[] memory acc = new AcceptedToken[](9);
        for (uint256 i; i < 9; ++i) {
            acc[i] = AcceptedToken(uint64(CHAIN_A), address(uint160(0x1000 + i)), 6);
        }
        _expectCreateRevert(
            _params(AMOUNT, acc, 0, 0, false), abi.encodeWithSelector(DaybookReactive.BadAccepted.selector)
        );
    }

    function test_CreateInvoice_RejectsBadTimes() public {
        uint64 nowTs = uint64(block.timestamp);
        bytes memory err = abi.encodeWithSelector(DaybookReactive.BadTimes.selector);
        _expectCreateRevert(_params(AMOUNT, _acceptAB(), nowTs, 0, false), err);
        _expectCreateRevert(_params(AMOUNT, _acceptAB(), 0, nowTs, false), err);
        _expectCreateRevert(_params(AMOUNT, _acceptAB(), nowTs + 100, nowTs + 50, false), err);
    }

    function test_CreateInvoice_OnlyOwner() public {
        DaybookReactive.CreateInvoiceParams memory p = _params(AMOUNT, _acceptAB(), 0, 0, false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reactive.createInvoice(p);
    }

    function test_CreateInvoice_StoresEverything() public {
        uint64 due = uint64(block.timestamp + 3 days);
        uint256 id = _create(AMOUNT, _acceptAB(), due, 0, false);
        DaybookReactive.Invoice memory inv = reactive.getInvoice(id);
        assertEq(id, 1);
        assertEq(inv.amount, AMOUNT);
        assertEq(inv.dueAt, due);
        assertEq(inv.policyId, policyId);
        assertEq(inv.detailsHash, keccak256("invoice details"));
        assertEq(uint8(inv.status), uint8(DaybookReactive.InvoiceStatus.Open));
        assertEq(reactive.invoiceOfPayAddress(inv.payAddress), id);
        assertEq(reactive.timedInvoices().length, 1);
        assertTrue(reactive.cronActive());
    }

    function test_PayAddresses_DistinctPerInvoice() public {
        uint256 a = _createAB(AMOUNT);
        uint256 b = _createAB(AMOUNT);
        assertTrue(reactive.payAddressOf(a) != reactive.payAddressOf(b));
    }

    // ----------------------------------------------------------- subscriptions

    function test_Subscriptions_WildcardModeOnePerChain() public {
        uint256 id = _createAB(AMOUNT);
        DaybookReactive.Sub[] memory s = reactive.subscriptionsOf(id);
        assertEq(s.length, 2);
        uint256 pay = uint256(uint160(reactive.payAddressOf(id)));
        for (uint256 i; i < 2; ++i) {
            assertEq(s[i].contractAddr, address(0), "any token on the chain");
            assertEq(s[i].topic0, TRANSFER_TOPIC);
            assertEq(s[i].topic1, REACTIVE_IGNORE);
            assertEq(s[i].topic2, pay);
            assertEq(s[i].topic3, REACTIVE_IGNORE);
            assertTrue(sys.isActive(address(reactive), s[i].chainId, address(0), TRANSFER_TOPIC, REACTIVE_IGNORE, pay, REACTIVE_IGNORE));
        }
    }

    function test_Subscriptions_StrictModeOnePerToken() public {
        MockERC20 second = new MockERC20("USDT", 6);
        AcceptedToken[] memory acc = new AcceptedToken[](2);
        acc[0] = _accept(CHAIN_A);
        acc[1] = AcceptedToken(uint64(CHAIN_A), address(second), 6);
        uint256 id = _create(AMOUNT, acc, 0, 0, true);
        DaybookReactive.Sub[] memory s = reactive.subscriptionsOf(id);
        assertEq(s.length, 2);
        assertEq(s[0].contractAddr, address(usd[CHAIN_A]));
        assertEq(s[1].contractAddr, address(second));
    }

    function test_Subscriptions_WildcardModeDedupesTokensOnSameChain() public {
        MockERC20 second = new MockERC20("USDT", 6);
        AcceptedToken[] memory acc = new AcceptedToken[](2);
        acc[0] = _accept(CHAIN_A);
        acc[1] = AcceptedToken(uint64(CHAIN_A), address(second), 6);
        uint256 id = _create(AMOUNT, acc, 0, 0, false);
        assertEq(reactive.subscriptionsOf(id).length, 1);
    }

    function test_SetTill_MovesAckSubscriptions() public {
        address oldTill = address(tillOn[CHAIN_A]);
        address newTill = makeAddr("newTill");
        vm.prank(owner);
        reactive.setTill(CHAIN_A, newTill);
        _flush();
        assertEq(reactive.tillOf(CHAIN_A), newTill);
        uint256 settled = uint256(IDaybookTill.Settled.selector);
        assertFalse(sys.isActive(address(reactive), CHAIN_A, oldTill, settled, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE));
        assertTrue(sys.isActive(address(reactive), CHAIN_A, newTill, settled, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE));
        assertEq(unsubscribeMisses, 0);

        vm.prank(owner);
        reactive.setTill(CHAIN_A, address(0));
        _flush();
        assertEq(_activeSubsOf(address(reactive)), 4);
    }

    function test_SetTill_RejectsZeroChain() public {
        vm.prank(owner);
        vm.expectRevert(DaybookReactive.BadAccepted.selector);
        reactive.setTill(0, address(1));
    }

    // ------------------------------------------------------------- filtering

    function _record(uint256 chainId, address emitter, uint256 t0, uint256 t1, uint256 t2, uint256 t3, uint256 opCode, bytes memory data)
        internal
        returns (IReactive.LogRecord memory rec)
    {
        rec.chainId = chainId;
        rec.contractAddress = emitter;
        rec.topic0 = t0;
        rec.topic1 = t1;
        rec.topic2 = t2;
        rec.topic3 = t3;
        rec.opCode = opCode;
        rec.data = data;
        rec.txHash = uint256(keccak256(abi.encode(++txCounter)));
    }

    function _reactDirect(IReactive.LogRecord memory rec) internal {
        vm.prank(SYSTEM_ADDR);
        reactive.react(rec);
        _flush();
    }

    function test_React_IgnoresErc721Transfer() public {
        uint256 id = _createAB(AMOUNT);
        uint256 pay = uint256(uint160(reactive.payAddressOf(id)));
        _reactDirect(_record(CHAIN_A, address(usd[CHAIN_A]), TRANSFER_TOPIC, 1, pay, 7, 4, ""));
        assertEq(reactive.ledgerLength(), 0);
    }

    function test_React_IgnoresMalformedData() public {
        uint256 id = _createAB(AMOUNT);
        uint256 pay = uint256(uint160(reactive.payAddressOf(id)));
        _reactDirect(_record(CHAIN_A, address(usd[CHAIN_A]), TRANSFER_TOPIC, 1, pay, 0, 3, hex"01"));
        _reactDirect(_record(CHAIN_A, address(usd[CHAIN_A]), TRANSFER_TOPIC, 1, pay, 0, 3, abi.encode(1, 2)));
        assertEq(reactive.ledgerLength(), 0);
    }

    function test_React_IgnoresZeroValueTransfer() public {
        uint256 id = _createAB(AMOUNT);
        _pay(usd[CHAIN_A], payer, reactive.payAddressOf(id), 0);
        assertEq(reactive.ledgerLength(), 0);
    }

    function test_React_IgnoresUnknownPayAddress() public {
        _createAB(AMOUNT);
        _reactDirect(_record(CHAIN_A, address(usd[CHAIN_A]), TRANSFER_TOPIC, 1, 0xBEEF, 0, 3, abi.encode(5)));
        assertEq(reactive.ledgerLength(), 0);
    }

    function test_React_IgnoresSettledFromImpostor() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        tillOn[CHAIN_A].pause();
        _payInvoice(CHAIN_A, id, AMOUNT);
        uint256 settled = uint256(IDaybookTill.Settled.selector);
        // Right chain, wrong emitter.
        _reactDirect(
            _record(CHAIN_A, makeAddr("impostor"), settled, id, 1, uint256(uint160(address(usd[CHAIN_A]))), 4, "")
        );
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Paid));
        // Right emitter, wrong token in topic3.
        _reactDirect(_record(CHAIN_A, address(tillOn[CHAIN_A]), settled, id, 1, 0xdead, 4, ""));
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Paid));
        // Right everything except chain: B's till acking A's settlement.
        _reactDirect(
            _record(CHAIN_B, address(tillOn[CHAIN_B]), settled, id, 1, uint256(uint160(address(usd[CHAIN_A]))), 4, "")
        );
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Paid));
    }

    function test_React_IgnoresAckForUnknownSeq() public {
        uint256 settled = uint256(IDaybookTill.Settled.selector);
        _reactDirect(_record(CHAIN_A, address(tillOn[CHAIN_A]), settled, 1, 77, 0, 4, ""));
        assertEq(reactive.pendingSeqs().length, 0);
    }

    function test_React_IgnoresCronFromWrongEmitterOrChain() public {
        uint64 due = uint64(block.timestamp + 10);
        uint256 id = _create(AMOUNT, _acceptAB(), due, 0, false);
        vm.warp(block.timestamp + 11);
        _reactDirect(_record(block.chainid, makeAddr("fakeCron"), CRON100, 0, 0, 0, 1, abi.encode(1)));
        _reactDirect(_record(CHAIN_A, CRON_EMITTER, CRON100, 0, 0, 0, 1, abi.encode(1)));
        assertFalse(reactive.getInvoice(id).overdue);
        _reactDirect(_record(block.chainid, CRON_EMITTER, CRON100, 0, 0, 0, 1, abi.encode(1)));
        assertTrue(reactive.getInvoice(id).overdue);
    }

    function test_React_IgnoresUnrelatedTopic() public {
        _reactDirect(_record(CHAIN_A, address(usd[CHAIN_A]), 0x1234, 0, 0, 0, 1, ""));
        assertEq(reactive.ledgerLength(), 0);
    }

    // ---------------------------------------------------------------- matching

    function test_Matching_EighteenDecimalTokenNormalized() public {
        AcceptedToken[] memory acc = new AcceptedToken[](1);
        acc[0] = _accept(CHAIN_C);
        uint256 id = _create(AMOUNT, acc, 0, 0, false);
        _payInvoice(CHAIN_C, id, 100e18);
        assertEq(reactive.getInvoice(id).paid, 100e6);
        _payInvoice(CHAIN_C, id, 150e18 + 5);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        DaybookReactive.LedgerEntry memory e = reactive.ledgerEntry(1);
        assertEq(e.excess, 5, "sub-micro-dollar dust is excess");
    }

    function test_Matching_LedgerEntryCarriesOrigin() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_B, id, 1e6);
        DaybookReactive.LedgerEntry memory e = reactive.ledgerEntry(0);
        assertEq(e.chainId, CHAIN_B);
        assertEq(e.token, address(usd[CHAIN_B]));
        assertEq(e.payer, payer);
        assertEq(e.amount, 1e6);
        assertEq(e.invoiceId, id);
        assertEq(e.txHash, history[history.length - 1].txHash);
        assertEq(uint8(e.kind), uint8(DaybookReactive.EntryKind.Payment));
        assertTrue(reactive.seen(keccak256(abi.encode(CHAIN_B, e.txHash, uint256(e.logIndex)))));
    }

    function test_Matching_FlagCapBoundsSpam() public {
        uint256 id = _createAB(AMOUNT);
        address pay = reactive.payAddressOf(id);
        for (uint256 i; i < 17; ++i) {
            _pay(junkA, payer, pay, 1);
        }
        assertEq(reactive.flaggedCount(id), 16);
        assertEq(reactive.droppedFlags(id), 1);
        assertEq(reactive.ledgerLength(), 16);
    }

    function test_Matching_OversizedValueIsFlagged() public {
        uint256 id = _createAB(AMOUNT);
        _pay(usd[CHAIN_A], payer, reactive.payAddressOf(id), uint256(type(uint96).max) + 1);
        assertEq(reactive.getInvoice(id).paid, 0);
        assertEq(uint8(reactive.ledgerEntry(0).kind), uint8(DaybookReactive.EntryKind.WrongToken));
    }

    function test_Matching_FirstArgOfPayloadIsZeroAddress() public {
        uint256 id = _createAB(AMOUNT);
        autoDrain = false;
        _payInvoice(CHAIN_A, id, AMOUNT);
        CallbackReq memory req = _pop();
        assertEq(req.recipient, address(tillOn[CHAIN_A]));
        assertEq(req.chainId, CHAIN_A);
        assertGe(req.gasLimit, 100_000);
        bytes memory p = req.payload;
        bytes4 sel;
        address first;
        assembly {
            sel := mload(add(p, 32))
            first := mload(add(p, 36))
        }
        assertEq(sel, IDaybookTill.settle.selector);
        assertEq(first, address(0), "system overwrites the first argument");
    }

    function test_Matching_OrphanedAfterCancelForwardedToTreasury() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        reactive.cancel(id);
        _flush();
        // In-flight delivery after the unsubscribe.
        address pay = reactive.payAddressOf(id);
        usd[CHAIN_A].mint(pay, 3e6);
        IReactive.LogRecord memory rec = _record(
            CHAIN_A, address(usd[CHAIN_A]), TRANSFER_TOPIC, uint256(uint160(payer)), uint256(uint160(pay)), 0, 3, abi.encode(3e6)
        );
        _react(address(reactive), rec);
        _drain();
        assertEq(uint8(reactive.ledgerEntry(0).kind), uint8(DaybookReactive.EntryKind.Orphaned));
        assertEq(usd[CHAIN_A].balanceOf(treasury), 3e6);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Cancelled));
    }

    // ----------------------------------------------------------- cron and time

    function test_Cron_OverdueWithoutExpiryReleasesCron() public {
        uint64 due = uint64(block.timestamp + 1 hours);
        uint256 id = _create(AMOUNT, _acceptAB(), due, 0, false);
        assertTrue(reactive.cronActive());
        _warpTick(1 hours);
        assertTrue(reactive.getInvoice(id).overdue);
        assertEq(reactive.timedInvoices().length, 0);
        assertFalse(reactive.cronActive());
        // Still payable after the due date.
        _payInvoice(CHAIN_A, id, AMOUNT);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
    }

    function test_Cron_NotSubscribedForUntimedInvoices() public {
        _createAB(AMOUNT);
        assertFalse(reactive.cronActive());
        assertFalse(sys.isActive(address(reactive), block.chainid, CRON_EMITTER, CRON100, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE));
    }

    function test_Cron_TickBeforeDueDoesNothing() public {
        uint64 due = uint64(block.timestamp + 1 days);
        uint256 id = _create(AMOUNT, _acceptAB(), due, due + 1 days, false);
        _warpTick(1 hours);
        assertFalse(reactive.getInvoice(id).overdue);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Open));
    }

    function test_Cron_ManyTimedInvoicesProcessedAcrossTicks() public {
        uint64 exp = uint64(block.timestamp + 1 hours);
        for (uint256 i; i < 20; ++i) {
            _create(AMOUNT, _acceptAB(), 0, exp, false);
        }
        vm.warp(exp);
        uint256 ticks;
        while (reactive.timedInvoices().length > 0 && ticks < 10) {
            _cronTick();
            ++ticks;
        }
        assertEq(ticks, 3, "eight per tick");
        for (uint256 i = 1; i <= 20; ++i) {
            assertEq(uint8(_status(i)), uint8(DaybookReactive.InvoiceStatus.Expired));
        }
        assertFalse(reactive.cronActive());
        assertEq(unsubscribeMisses, 0);
        assertLt(maxReactGas, REACT_GAS_CAP);
    }

    function test_Poke_IsPermissionlessAndTimeGated() public {
        uint64 exp = uint64(block.timestamp + 1 hours);
        uint256 id = _create(AMOUNT, _acceptAB(), 0, exp, false);
        vm.prank(makeAddr("anyone"));
        reactive.poke();
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Open));
        vm.warp(exp);
        vm.prank(makeAddr("anyone"));
        reactive.poke();
        _flush();
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Expired));
    }

    // ---------------------------------------------------------------- gas bound

    function test_Gas_CoverWithEightFundedPairsStaysUnderCapAndDefers() public {
        AcceptedToken[] memory acc = new AcceptedToken[](8);
        MockERC20[] memory toks = new MockERC20[](8);
        uint256[3] memory chains = [CHAIN_A, CHAIN_B, CHAIN_C];
        for (uint256 i; i < 8; ++i) {
            uint256 c = chains[i % 3];
            toks[i] = new MockERC20("USD", 6);
            _registerEmitter(address(toks[i]), c);
            vm.prank(owner);
            tillOn[c].setMaxSettlement(IERC20(address(toks[i])), CAP);
            acc[i] = AcceptedToken(uint64(c), address(toks[i]), 6);
        }
        _flush();
        uint256 id = _create(800e6, acc, 0, 0, false);
        address pay = reactive.payAddressOf(id);
        for (uint256 i; i < 7; ++i) {
            _pay(toks[i], payer, pay, 100e6);
        }
        maxReactGas = 0;
        _pay(toks[7], payer, pay, 100e6);
        assertEq(reactReverts, 0, "no reactive transaction ran out of gas");
        assertLt(maxReactGas, REACT_GAS_CAP);
        emit log_named_uint("max react gas, eight-pair cover", maxReactGas);
        assertLt(maxReactGas, 800_000, "at least 100k headroom under the reactive cap");
        uint256 sentNow = reactive.nextSeq();
        emit log_named_uint("settlements sent in the covering reaction", sentNow);
        assertLt(sentNow, 8, "some balances deferred to cron");
        assertEq(reactive.closingInvoices().length, 1);
        assertTrue(reactive.cronActive());

        _warpTick(1);
        _warpTick(1);
        assertEq(reactive.nextSeq(), 8);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        for (uint256 i; i < 8; ++i) {
            assertEq(toks[i].balanceOf(pay), 0);
        }
        assertFalse(reactive.cronActive());
    }

    function test_Gas_WorstCaseSettleFitsCallbackLimit() public {
        Recipient[] memory team = new Recipient[](5);
        for (uint256 i; i < 5; ++i) {
            team[i] = Recipient(makeAddr(string(abi.encode(i))), 1000);
        }
        vm.prank(owner);
        uint32 heavy = reactive.createPolicy(treasury, 2000, team);
        DaybookReactive.CreateInvoiceParams memory p = _params(AMOUNT, _acceptAB(), 0, 0, false);
        p.policyId = heavy;
        vm.prank(owner);
        uint256 id = reactive.createInvoice(p);
        _flush();
        _payInvoice(CHAIN_A, id, AMOUNT + 1);
        uint256 used = proxyOf[CHAIN_A].maxGasUsed();
        emit log_named_uint("worst-case settle gas (5 recipients, reserve, excess, vault deploy)", used);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        // Budget against the worst proxy overhead (Ethereum, 200k) plus the full receipt-issuer allowance.
        assertLt(used + 200_000 + tillOn[CHAIN_A].RECEIPT_GAS(), reactive.callbackGasLimit(), "fits callback gas");
    }

    // ------------------------------------------------------------------ admin

    function test_Cancel_OnlyOpenAndOnlyOwner() public {
        uint256 id = _createAB(AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reactive.cancel(id);
        _payInvoice(CHAIN_A, id, AMOUNT);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DaybookReactive.NotOpen.selector, id));
        reactive.cancel(id);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(DaybookReactive.NotOpen.selector, 999));
        reactive.cancel(999);
    }

    function test_Cancel_WithPartialForwardsToTreasuryUnsplit() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_A, id, 40e6);
        _payInvoice(CHAIN_B, id, 10e6);
        vm.prank(owner);
        reactive.cancel(id);
        _flush();
        _drain();
        assertEq(usd[CHAIN_A].balanceOf(treasury), 40e6);
        assertEq(usd[CHAIN_B].balanceOf(treasury), 10e6);
        assertEq(usd[CHAIN_A].balanceOf(team1), 0);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Cancelled));
        assertEq(reactive.getInvoice(id).openSettlements, 0);
    }

    function test_Setters_BoundsAndOwner() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(DaybookReactive.GasLimitTooLow.selector, uint64(99_999)));
        reactive.setCallbackGasLimit(99_999);
        reactive.setCallbackGasLimit(500_000);
        assertEq(reactive.callbackGasLimit(), 500_000);
        vm.expectRevert(abi.encodeWithSelector(DaybookReactive.ResendTooSoon.selector, uint64(59)));
        reactive.setResendAfter(59);
        reactive.setResendAfter(600);
        assertEq(reactive.resendAfter(), 600);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reactive.setResendAfter(600);
    }

    function test_RetryAndResolve_RejectWrongStatus() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(DaybookReactive.NotStuck.selector, 1));
        reactive.retrySettlement(1);
        vm.expectRevert(abi.encodeWithSelector(DaybookReactive.NotOutstanding.selector, 1));
        reactive.resolveSettlement(1);
        vm.stopPrank();
    }

    function test_ResolveSettlement_ClosesInvoiceAndReleasesCron() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        tillOn[CHAIN_A].pause();
        _payInvoice(CHAIN_A, id, AMOUNT);
        assertTrue(reactive.cronActive());
        vm.prank(owner);
        reactive.resolveSettlement(1);
        _flush();
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        assertFalse(reactive.cronActive());
        assertEq(uint8(reactive.getSettlement(1).status), uint8(DaybookReactive.SettlementStatus.Resolved));
    }

    function test_WithdrawNative_OwnerOnly() public {
        address payable to = payable(makeAddr("to"));
        vm.prank(owner);
        reactive.withdrawNative(0.4 ether, to);
        assertEq(to.balance, 0.4 ether);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reactive.withdrawNative(1, to);
        vm.prank(owner);
        vm.expectRevert(DaybookReactive.ZeroAddress.selector);
        reactive.withdrawNative(1, payable(address(0)));
    }

    function test_CoverDebt_PaysNothingWhenNoDebt() public {
        uint256 before = address(reactive).balance;
        reactive.coverDebt();
        assertEq(address(reactive).balance, before);
    }

    function test_Ownership_TwoStep() public {
        address next = makeAddr("next");
        vm.prank(owner);
        reactive.transferOwnership(next);
        assertEq(reactive.owner(), owner);
        vm.prank(next);
        reactive.acceptOwnership();
        assertEq(reactive.owner(), next);
    }

    function test_GetSettlement_ViewResolvesPair() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_B, id, AMOUNT);
        DaybookReactive.SettlementView memory v = reactive.getSettlement(1);
        assertEq(v.invoiceId, id);
        assertEq(v.chainId, CHAIN_B);
        assertEq(v.token, address(usd[CHAIN_B]));
        assertEq(v.amount, AMOUNT);
        assertEq(uint8(v.status), uint8(DaybookReactive.SettlementStatus.Acked));
        assertEq(reactive.getSettlement(2).invoiceId, 0);
    }
}
