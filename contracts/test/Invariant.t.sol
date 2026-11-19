// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { DaybookFixture } from "./harness/DaybookFixture.sol";
import { DaybookReactive } from "../src/DaybookReactive.sol";
import { AcceptedToken } from "../src/DaybookTypes.sol";

/// @notice Drives the whole system through the harness with random invoices, payments on three chains,
/// duplicate deliveries, lost callbacks, paused tills, cron ticks and cancellations.
contract DaybookHandler is DaybookFixture {
    uint256[3] internal chains = [CHAIN_A, CHAIN_B, CHAIN_C];

    /// @notice Raw units delivered to open invoices, per chain (the matched total the ledger must equal).
    mapping(uint256 chainId => uint256) public ghostMatched;
    /// @notice Raw units sent to any pay address, per chain.
    mapping(uint256 chainId => uint256) public ghostSent;
    uint256 public ghostJunk;

    constructor() {
        vm.deal(address(this), 10 ether);
        setUp();
    }

    function create(uint256 amountSeed, uint256 timing) external {
        uint256 amount = bound(amountSeed, 1e6, 500e6);
        uint64 expiresAt = timing % 3 == 0 ? uint64(block.timestamp + bound(timing, 1 hours, 3 days)) : 0;
        uint64 dueAt = timing % 3 == 1 ? uint64(block.timestamp + bound(timing, 1 hours, 3 days)) : 0;
        _create(amount, _acceptABC(), dueAt, expiresAt, timing % 2 == 0);
    }

    function pay(uint256 invoiceSeed, uint256 chainSeed, uint256 amountSeed) external {
        uint256 n = reactive.nextInvoiceId();
        if (n == 0) return;
        uint256 id = bound(invoiceSeed, 1, n);
        if (_status(id) != DaybookReactive.InvoiceStatus.Open) return;
        uint256 chainId = chains[chainSeed % 3];
        uint256 v = bound(amountSeed, 1, 300e6);
        if (chainId == CHAIN_C) v *= 1e12;
        _payInvoice(chainId, id, v);
        ghostMatched[chainId] += v;
        ghostSent[chainId] += v;
    }

    function payJunk(uint256 invoiceSeed, uint256 amountSeed) external {
        uint256 n = reactive.nextInvoiceId();
        if (n == 0) return;
        uint256 id = bound(invoiceSeed, 1, n);
        uint256 v = bound(amountSeed, 1, 1e9);
        _pay(junkA, payer, reactive.payAddressOf(id), v);
        ghostJunk += v;
    }

    function replay(uint256 seed) external {
        uint256 len = _historyLength();
        if (len == 0) return;
        _replay(seed % len);
    }

    function tick(uint256 secondsSeed) external {
        _warpTick(bound(secondsSeed, 60, 2 days));
    }

    function cancel(uint256 invoiceSeed) external {
        uint256 n = reactive.nextInvoiceId();
        if (n == 0) return;
        uint256 id = bound(invoiceSeed, 1, n);
        if (_status(id) != DaybookReactive.InvoiceStatus.Open) return;
        vm.prank(owner);
        reactive.cancel(id);
        _flush();
        _drain();
    }

    function togglePause(uint256 chainSeed) external {
        uint256 chainId = chains[chainSeed % 3];
        vm.startPrank(owner);
        if (tillOn[chainId].paused()) tillOn[chainId].unpause();
        else tillOn[chainId].pause();
        vm.stopPrank();
        _flush();
    }

    function loseNextCallback(uint256 chainSeed) external {
        dropNext[chains[chainSeed % 3]] += 1;
    }

    // ------------------------------------------------------------------ views

    function chainAt(uint256 i) external view returns (uint256) {
        return chains[i];
    }

    function paidOut(uint256 chainId) external view returns (uint256) {
        return _paidOut(chainId);
    }

    function heldInPayAddresses(uint256 chainId) public view returns (uint256 sum) {
        uint256 n = reactive.nextInvoiceId();
        for (uint256 id = 1; id <= n; ++id) {
            sum += usd[chainId].balanceOf(reactive.payAddressOf(id));
        }
    }

    function token(uint256 chainId) external view returns (address) {
        return address(usd[chainId]);
    }

    function stats() external view returns (uint256 reverts, uint256 misses, uint256 maxGas) {
        return (reactReverts, unsubscribeMisses, maxReactGas);
    }

    function reactiveAddr() external view returns (DaybookReactive) {
        return reactive;
    }

    function tillBalance(uint256 chainId) external view returns (uint256) {
        return usd[chainId].balanceOf(address(tillOn[chainId]));
    }
}

contract DaybookInvariantTest is Test {
    DaybookHandler internal h;
    DaybookReactive internal reactive;

    function setUp() public {
        h = new DaybookHandler();
        reactive = h.reactiveAddr();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = DaybookHandler.create.selector;
        sel[1] = DaybookHandler.pay.selector;
        sel[2] = DaybookHandler.payJunk.selector;
        sel[3] = DaybookHandler.replay.selector;
        sel[4] = DaybookHandler.tick.selector;
        sel[5] = DaybookHandler.cancel.selector;
        sel[6] = DaybookHandler.togglePause.selector;
        sel[7] = DaybookHandler.loseNextCallback.selector;
        targetSelector(FuzzSelector({ addr: address(h), selectors: sel }));
    }

    /// @notice Ledger totals equal the sum of transfers matched, per chain, whatever was replayed.
    function invariant_LedgerEqualsMatchedTransfers() public view {
        uint256 n = reactive.ledgerLength();
        uint256[3] memory sums;
        for (uint256 i; i < n; ++i) {
            DaybookReactive.LedgerEntry memory e = reactive.ledgerEntry(i);
            if (e.kind == DaybookReactive.EntryKind.WrongToken) continue;
            for (uint256 c; c < 3; ++c) {
                if (e.chainId == h.chainAt(c)) sums[c] += e.amount;
            }
        }
        for (uint256 c; c < 3; ++c) {
            assertEq(sums[c], h.ghostMatched(h.chainAt(c)));
        }
    }

    /// @notice Money is conserved: every unit sent to a pay address is either still there or paid out once.
    /// A double settlement would pay out more than arrived and break this.
    function invariant_FundsConserved() public view {
        for (uint256 c; c < 3; ++c) {
            uint256 chainId = h.chainAt(c);
            assertEq(h.paidOut(chainId) + h.heldInPayAddresses(chainId), h.ghostSent(chainId));
            assertEq(h.tillBalance(chainId), 0, "the till never keeps funds");
        }
    }

    /// @notice An invoice settles at most once: the income settled for it never exceeds its amount, and a
    /// closed invoice with no open settlement leaves nothing in its pay address.
    function invariant_SettlesAtMostOnceAndSweepsClean() public view {
        uint256 invoices = reactive.nextInvoiceId();
        uint256 seqs = reactive.nextSeq();
        uint256[] memory income = new uint256[](invoices + 1);
        for (uint256 s = 1; s <= seqs; ++s) {
            DaybookReactive.SettlementView memory v = reactive.getSettlement(s);
            if (v.status != DaybookReactive.SettlementStatus.Acked) continue;
            uint256 norm = v.token == h.token(h.chainAt(2)) ? v.amount / 1e12 : v.amount;
            income[v.invoiceId] += norm;
        }
        for (uint256 id = 1; id <= invoices; ++id) {
            DaybookReactive.Invoice memory inv = reactive.getInvoice(id);
            assertLe(income[id], inv.amount, "settled more income than invoiced");
            bool closed = inv.status != DaybookReactive.InvoiceStatus.Open;
            bool allClosing = false;
            uint256[] memory closing = reactive.closingInvoices();
            for (uint256 k; k < closing.length; ++k) {
                if (closing[k] == id) allClosing = true;
            }
            if (closed && inv.openSettlements == 0 && !allClosing) {
                for (uint256 c; c < 3; ++c) {
                    assertEq(_bal(h.chainAt(c), inv.payAddress), 0, "funds left in a closed pay address");
                }
            }
        }
    }

    /// @notice Cron is held exactly while there is timed or pending work.
    function invariant_CronOnlyWhileWorkPending() public view {
        bool need = reactive.timedInvoices().length != 0 || reactive.pendingSeqs().length != 0
            || reactive.closingInvoices().length != 0;
        assertEq(reactive.cronActive(), need);
    }

    /// @notice react() never reverts, never exceeds the cap, and every unsubscribe matched a subscription.
    function invariant_ReactHealthy() public view {
        (uint256 reverts, uint256 misses, uint256 maxGas) = h.stats();
        assertEq(reverts, 0);
        assertEq(misses, 0);
        assertLt(maxGas, 900_000);
    }

    /// @notice Shows the runs exercised the system (invoices, settlements, ledger) rather than idling.
    function afterInvariant() public {
        emit log_named_uint("invoices", reactive.nextInvoiceId());
        emit log_named_uint("settlements", reactive.nextSeq());
        emit log_named_uint("ledger entries", reactive.ledgerLength());
    }

    function _bal(uint256 chainId, address who) internal view returns (uint256) {
        return IBal(h.token(chainId)).balanceOf(who);
    }
}

interface IBal {
    function balanceOf(address) external view returns (uint256);
}
