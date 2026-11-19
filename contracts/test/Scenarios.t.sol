// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { DaybookFixture } from "./harness/DaybookFixture.sol";
import { DaybookReactive } from "../src/DaybookReactive.sol";
import { AcceptedToken } from "../src/DaybookTypes.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { Vm } from "forge-std/Vm.sol";

/// @notice End-to-end loops through the local Omni harness: origin transfer -> react -> callback -> till ->
/// Settled ack -> react. Each test is one of the scenarios the testnet evidence run also covers.
contract ScenariosTest is DaybookFixture {
    uint256 internal constant AMOUNT = 1000e6; // 1,000 USD in micro-dollars

    function _assertSplit(uint256 chainId, uint256 amount, uint256 excess) internal view {
        MockERC20 t = usd[chainId];
        uint256 tax = amount * TAX_BPS / 10_000;
        uint256 t1 = amount * TEAM1_BPS / 10_000;
        uint256 t2 = amount * TEAM2_BPS / 10_000;
        assertEq(t.balanceOf(address(reserveOn[chainId])), tax, "tax");
        assertEq(t.balanceOf(team1), t1, "team1");
        assertEq(t.balanceOf(team2), t2, "team2");
        assertEq(t.balanceOf(treasury), amount - tax - t1 - t2 + excess, "treasury");
    }

    function test_ExactPayment_SettlesAndClosesLoop() public {
        uint256 id = _createAB(AMOUNT);
        address pay = reactive.payAddressOf(id);
        assertEq(pay, factory.payAddress(keccak256(abi.encode(address(reactive), id))));
        assertTrue(reactive.cronActive() == false, "no cron for untimed invoice");

        _payInvoice(CHAIN_A, id, AMOUNT);

        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        assertEq(usd[CHAIN_A].balanceOf(pay), 0, "pay address swept");
        _assertSplit(CHAIN_A, AMOUNT, 0);
        assertEq(reactive.pendingSeqs().length, 0);
        assertFalse(reactive.cronActive(), "cron released once ack arrived");
        assertEq(_activeSubsOf(address(reactive)), 6, "only the 3x2 till ack subscriptions remain");
        assertEq(unsubscribeMisses, 0, "every unsubscribe matched");
        assertEq(reactReverts, 0);
    }

    function test_PartialThenCompleted() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_A, id, 400e6);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Open));
        assertEq(reactive.getInvoice(id).paid, 400e6);
        assertEq(totalCallbacks, 0, "no callback before the invoice is covered");

        _payInvoice(CHAIN_A, id, 600e6);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        _assertSplit(CHAIN_A, AMOUNT, 0);
        assertEq(reactive.ledgerLength(), 2);
        assertEq(reactive.nextSeq(), 1, "one settlement for both partials on the same chain");
    }

    function test_Overpayment_ExcessToTreasuryUnsplit() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_A, id, AMOUNT + 37e6);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        _assertSplit(CHAIN_A, AMOUNT, 37e6);
        DaybookReactive.LedgerEntry memory e = reactive.ledgerEntry(0);
        assertEq(e.amount, AMOUNT + 37e6);
        assertEq(e.excess, 37e6);
        assertEq(usd[CHAIN_A].balanceOf(reactive.payAddressOf(id)), 0);
    }

    function test_WrongToken_FlaggedAndLeftForOwner() public {
        uint256 id = _createAB(AMOUNT);
        address pay = reactive.payAddressOf(id);
        _pay(junkA, payer, pay, 55e6);

        assertEq(reactive.ledgerLength(), 1);
        DaybookReactive.LedgerEntry memory e = reactive.ledgerEntry(0);
        assertEq(uint8(e.kind), uint8(DaybookReactive.EntryKind.WrongToken));
        assertEq(e.token, address(junkA));
        assertEq(reactive.getInvoice(id).paid, 0, "wrong token never counts");
        assertEq(totalCallbacks, 0);

        // The owner recovers it by hand.
        vm.prank(owner);
        tillOn[CHAIN_A].sweep(id, address(junkA), treasury);
        _relayRecorded();
        assertEq(junkA.balanceOf(treasury), 55e6);
        assertEq(junkA.balanceOf(pay), 0);
    }

    function test_StrictMode_DoesNotSeeWrongToken() public {
        uint256 id = _create(AMOUNT, _acceptAB(), 0, 0, true);
        _pay(junkA, payer, reactive.payAddressOf(id), 55e6);
        assertEq(reactive.ledgerLength(), 0, "strict mode only watches accepted tokens");
        _payInvoice(CHAIN_B, id, AMOUNT);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
    }

    function test_PaymentsOnDifferentChains_EachChainSettlesItsOwnBalance() public {
        uint256 id = _create(AMOUNT, _acceptABC(), 0, 0, false);
        address pay = reactive.payAddressOf(id);
        _payInvoice(CHAIN_A, id, 300e6);
        _payInvoice(CHAIN_C, id, 200e18); // 18-decimal stablecoin on chain C
        assertEq(reactive.getInvoice(id).paid, 500e6);
        _payInvoice(CHAIN_B, id, 500e6);

        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        assertEq(reactive.nextSeq(), 3);
        _assertSplit(CHAIN_A, 300e6, 0);
        _assertSplit(CHAIN_B, 500e6, 0);
        _assertSplit(CHAIN_C, 200e18, 0);
        assertEq(usd[CHAIN_A].balanceOf(pay) + usd[CHAIN_B].balanceOf(pay) + usd[CHAIN_C].balanceOf(pay), 0);
    }

    function test_Expiry_UnsubscribesAndForwardsPartialToTreasury() public {
        uint64 due = uint64(block.timestamp + 1 days);
        uint256 id = _create(AMOUNT, _acceptAB(), due, due + 7 days, false);
        assertTrue(reactive.cronActive(), "cron while a timed invoice is open");
        _payInvoice(CHAIN_A, id, 100e6);

        _warpTick(1 days + 1);
        assertTrue(reactive.getInvoice(id).overdue);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Open));

        _warpTick(7 days);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Expired));
        assertEq(usd[CHAIN_A].balanceOf(treasury), 100e6, "partial forwarded whole, not split");
        assertEq(usd[CHAIN_A].balanceOf(address(reserveOn[CHAIN_A])), 0);
        assertFalse(reactive.cronActive(), "cron released");
        assertEq(_activeSubsOf(address(reactive)), 6);
        assertEq(unsubscribeMisses, 0);
    }

    function test_Cancellation_StopsWatching() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        reactive.cancel(id);
        _flush();
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Cancelled));
        assertEq(_activeSubsOf(address(reactive)), 6);

        // A payment after cancellation is not delivered at all: the subscription is gone.
        _payInvoice(CHAIN_A, id, AMOUNT);
        assertEq(reactive.ledgerLength(), 0);
        assertEq(usd[CHAIN_A].balanceOf(reactive.payAddressOf(id)), AMOUNT, "left for a manual sweep");
    }

    function test_ForcedCallbackFailure_ThenRecoveryByResend() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        tillOn[CHAIN_A].pause();

        _payInvoice(CHAIN_A, id, AMOUNT);
        assertEq(failedCallbacks, 1, "settle reverted while paused");
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Paid));
        assertTrue(reactive.cronActive(), "cron held while the ack is missing");

        _warpTick(60);
        assertEq(totalCallbacks, 1, "no resend before resendAfter");

        vm.prank(owner);
        tillOn[CHAIN_A].unpause();
        _warpTick(300);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        _assertSplit(CHAIN_A, AMOUNT, 0);
        assertEq(reactive.getSettlement(1).attempts, 2);
        assertFalse(reactive.cronActive());
    }

    function test_LostCallback_ThenResend() public {
        uint256 id = _createAB(AMOUNT);
        dropNext[CHAIN_A] = 1;
        _payInvoice(CHAIN_A, id, AMOUNT);
        assertEq(droppedCallbacks, 1);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Paid));
        _warpTick(301);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
    }

    function test_DuplicateDelivery_NeverDoubleCounts() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_A, id, 400e6);
        uint256 transferRecord = _historyLength() - 1;
        _replay(transferRecord);
        _replay(transferRecord);
        assertEq(reactive.getInvoice(id).paid, 400e6);
        assertEq(reactive.ledgerLength(), 1);
    }

    function test_DuplicateCallback_TillIsIdempotent() public {
        uint256 id = _createAB(AMOUNT);
        autoDrain = false;
        _payInvoice(CHAIN_A, id, AMOUNT);
        // Duplicate the queued settlement by resending it before the first delivery lands.
        _warpTick(301);
        assertEq(_queued(), 2, "original and resend both queued");
        _drain();
        autoDrain = true;
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        _assertSplit(CHAIN_A, AMOUNT, 0);
    }

    function test_LatePayment_AfterSettled_ForwardedToTreasury() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_A, id, AMOUNT);
        // A payment already in flight when the subscription was dropped: replay a fresh transfer record.
        address pay = reactive.payAddressOf(id);
        usd[CHAIN_A].mint(payer, 20e6);
        _flush();
        vm.prank(payer);
        usd[CHAIN_A].transfer(pay, 20e6);
        // Deliver directly to the reactive contract as if the log was already in the pipeline.
        _deliverInFlight();
        assertEq(reactive.ledgerLength(), 2);
        assertEq(uint8(reactive.ledgerEntry(1).kind), uint8(DaybookReactive.EntryKind.Late));
        _assertSplit(CHAIN_A, AMOUNT, 20e6);
        assertEq(usd[CHAIN_A].balanceOf(pay), 0);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
    }

    function _deliverInFlight() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (chainOf[logs[i].emitter] == 0) continue;
            _react(address(reactive), _toRecord(chainOf[logs[i].emitter], logs[i], uint256(keccak256("late")), i));
        }
        _drain();
    }

    function test_StuckAfterMaxAttempts_ThenOwnerRetry() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        tillOn[CHAIN_A].pause();
        _payInvoice(CHAIN_A, id, AMOUNT);
        for (uint256 i; i < 5; ++i) {
            _warpTick(301);
        }
        uint256 seq = 1;
        assertEq(uint8(reactive.getSettlement(seq).status), uint8(DaybookReactive.SettlementStatus.Stuck));
        assertFalse(reactive.cronActive(), "a stuck settlement does not hold cron");

        vm.prank(owner);
        tillOn[CHAIN_A].unpause();
        vm.prank(owner);
        reactive.retrySettlement(seq);
        _flush();
        _drain();
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
    }

    function test_ManualSweep_ResolvesPendingSettlement() public {
        uint256 id = _createAB(AMOUNT);
        vm.prank(owner);
        tillOn[CHAIN_A].pause();
        _payInvoice(CHAIN_A, id, AMOUNT);
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Paid));

        _flush();
        vm.prank(owner);
        tillOn[CHAIN_A].sweep(id, address(usd[CHAIN_A]), treasury);
        _relayRecorded();
        uint256 seq = 1;
        assertEq(uint8(reactive.getSettlement(seq).status), uint8(DaybookReactive.SettlementStatus.Resolved));
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        assertEq(usd[CHAIN_A].balanceOf(treasury), AMOUNT);
        assertFalse(reactive.cronActive());
    }

    function test_OutOfOrderAcks_AcrossChains() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_A, id, 500e6);
        autoDrain = false;
        _payInvoice(CHAIN_B, id, 500e6);
        // Two settlements queued (A then B). Deliver B first.
        MockERC20 b = usd[CHAIN_B];
        assertEq(_queued(), 2);
        // Pop A and hold it, deliver B, then A.
        _drainReversed();
        autoDrain = true;
        assertEq(uint8(_status(id)), uint8(DaybookReactive.InvoiceStatus.Settled));
        assertEq(b.balanceOf(reactive.payAddressOf(id)), 0);
    }

    function _drainReversed() internal {
        uint256 n = _queued();
        CallbackReq[] memory reqs = new CallbackReq[](n);
        for (uint256 i; i < n; ++i) {
            reqs[i] = _pop();
        }
        for (uint256 i = n; i > 0; --i) {
            _deliverCallback(reqs[i - 1]);
        }
    }

    function test_DatabaseIndependence_PayAddressFromChainOnly() public {
        // Everything needed to pay and settle lives on chain: the pay address is derivable from the
        // reactive contract's address and the invoice id alone, with no off-chain lookup.
        uint256 id = _createAB(AMOUNT);
        bytes32 salt = keccak256(abi.encode(address(reactive), id));
        assertEq(reactive.payAddressOf(id), factory.payAddress(salt));
        assertEq(reactive.VAULT_IMPLEMENTATION(), factory.VAULT_IMPLEMENTATION());
        AcceptedToken[] memory acc = reactive.acceptedOf(id);
        assertEq(acc.length, 2);
    }
}

