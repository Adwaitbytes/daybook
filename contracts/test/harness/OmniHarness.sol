// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test, Vm } from "forge-std/Test.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { MockSystemContract } from "./MockSystemContract.sol";
import { MockCallbackProxy } from "./MockCallbackProxy.sol";

/// @notice Local Omni harness. Several "chains" share one EVM: every origin-side contract (token, till) is
/// registered with the chain id it lives on, and the relay turns its recorded logs into `LogRecord`s carrying
/// that chain id, matches them against the active subscriptions (equality and wildcards, as the node does),
/// calls `react()` as the system with the 900k reactive gas cap, then delivers queued callbacks through the
/// destination chain's mock proxy and relays the logs those produce, until the loop is quiet.
///
/// The harness learns about subscriptions and callback requests from the mock system contract's events, so
/// it must see every log: tests call `_flush()` after any direct transaction (it absorbs system events and
/// drops origin logs) and `_relayRecorded()` after an origin transaction whose logs should be delivered.
///
/// Timing here is not real latency: everything happens inside one test transaction, in an order the harness
/// picks. Tests can drop, hold back, reorder and replay deliveries to model at-least-once, out-of-order
/// delivery. Nothing here measures fees.
abstract contract OmniHarness is Test {
    address internal constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;
    address internal constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
    uint256 internal constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint256 internal constant REACT_GAS_CAP = 900_000;

    struct SubRec {
        address rc;
        uint256 chainId;
        address contractAddr;
        uint256[4] topics;
    }

    struct CallbackReq {
        address rc;
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    MockSystemContract internal sys;
    mapping(address emitter => uint256 chainId) internal chainOf;
    mapping(uint256 chainId => MockCallbackProxy) internal proxyOf;

    SubRec[] internal subs;
    CallbackReq[] internal queue;
    uint256 internal queueHead;

    /// @notice When false, callbacks stay queued until the test calls `_drain()`.
    bool internal autoDrain = true;
    /// @notice Callbacks to a chain to drop in transit (never delivered), counted down.
    mapping(uint256 chainId => uint256) internal dropNext;

    uint256 internal txCounter;
    uint256 internal reactCalls;
    uint256 internal reactReverts;
    uint256 internal maxReactGas;
    uint256 internal droppedCallbacks;
    uint256 internal failedCallbacks;
    uint256 internal deliveredCallbacks;
    uint256 internal totalCallbacks;
    uint256 internal ignoredCallbacks;
    uint256 internal unsubscribeMisses;
    uint256 internal subscribeEvents;
    uint256 internal unsubscribeEvents;
    IReactive.LogRecord[] internal history;

    function _installSystem() internal {
        MockSystemContract impl = new MockSystemContract();
        vm.etch(SYSTEM_ADDR, address(impl).code);
        sys = MockSystemContract(payable(SYSTEM_ADDR));
        vm.recordLogs();
    }

    function _registerEmitter(address emitter, uint256 chainId) internal {
        chainOf[emitter] = chainId;
    }

    // ------------------------------------------------------------ log ingestion

    /// @notice Absorbs system contract events recorded so far and drops everything else.
    function _flush() internal {
        _ingest(vm.getRecordedLogs(), false);
    }

    /// @notice Relays every log recorded since the last flush; origin logs are delivered as one transaction.
    function _relayRecorded() internal {
        _ingest(vm.getRecordedLogs(), true);
    }

    function _relayLogs(Vm.Log[] memory logs) internal {
        _ingest(logs, true);
    }

    function _ingest(Vm.Log[] memory logs, bool relayOrigin) internal {
        uint256 txHash = uint256(keccak256(abi.encode("tx", ++txCounter)));
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == SYSTEM_ADDR) {
                _onSystemLog(logs[i]);
                continue;
            }
            uint256 chainId = chainOf[logs[i].emitter];
            if (!relayOrigin || chainId == 0) continue;
            _deliver(_toRecord(chainId, logs[i], txHash, i));
        }
    }

    function _onSystemLog(Vm.Log memory l) internal {
        bytes32 sig = l.topics[0];
        if (sig == MockSystemContract.Subscribed.selector) {
            ++subscribeEvents;
            (uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) =
                abi.decode(l.data, (uint256, address, uint256, uint256, uint256, uint256));
            subs.push(SubRec(address(uint160(uint256(l.topics[1]))), c, a, [t0, t1, t2, t3]));
        } else if (sig == MockSystemContract.Unsubscribed.selector) {
            ++unsubscribeEvents;
            (uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) =
                abi.decode(l.data, (uint256, address, uint256, uint256, uint256, uint256));
            _removeSub(SubRec(address(uint160(uint256(l.topics[1]))), c, a, [t0, t1, t2, t3]));
        } else if (sig == MockSystemContract.UnsubscribeMiss.selector) {
            ++unsubscribeMisses;
        } else if (sig == MockSystemContract.CallbackRequested.selector) {
            ++totalCallbacks;
            (uint256 c, address r, uint64 g, bytes memory p) = abi.decode(l.data, (uint256, address, uint64, bytes));
            queue.push(CallbackReq(address(uint160(uint256(l.topics[1]))), c, r, g, p));
        } else if (sig == MockSystemContract.CallbackIgnored.selector) {
            ++ignoredCallbacks;
        }
    }

    function _removeSub(SubRec memory s) internal {
        bytes32 key = _subKey(s);
        for (uint256 i; i < subs.length; ++i) {
            if (_subKey(subs[i]) == key) {
                subs[i] = subs[subs.length - 1];
                subs.pop();
                return;
            }
        }
        revert("harness: unsubscribe event for unknown subscription");
    }

    function _subKey(SubRec memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(s.rc, s.chainId, s.contractAddr, s.topics));
    }

    function _toRecord(uint256 chainId, Vm.Log memory l, uint256 txHash, uint256 logIndex)
        internal
        view
        returns (IReactive.LogRecord memory rec)
    {
        rec.chainId = chainId;
        rec.contractAddress = l.emitter;
        uint256 n = l.topics.length;
        if (n > 0) rec.topic0 = uint256(l.topics[0]);
        if (n > 1) rec.topic1 = uint256(l.topics[1]);
        if (n > 2) rec.topic2 = uint256(l.topics[2]);
        if (n > 3) rec.topic3 = uint256(l.topics[3]);
        rec.data = l.data;
        rec.blockNumber = block.number;
        rec.opCode = n;
        rec.blockHash = uint256(blockhash(block.number - 1));
        rec.txHash = txHash;
        rec.logIndex = logIndex;
    }

    // ------------------------------------------------------------ Reactive side

    /// @notice Subscribers with an active subscription matching the record, each listed once.
    function _matching(IReactive.LogRecord memory rec) internal view returns (address[] memory out) {
        address[] memory tmp = new address[](subs.length);
        uint256[4] memory topics = [rec.topic0, rec.topic1, rec.topic2, rec.topic3];
        uint256 n;
        for (uint256 i; i < subs.length; ++i) {
            SubRec storage s = subs[i];
            if (s.chainId != 0 && s.chainId != rec.chainId) continue;
            if (s.contractAddr != address(0) && s.contractAddr != rec.contractAddress) continue;
            bool ok = true;
            for (uint256 t; t < 4; ++t) {
                if (s.topics[t] != REACTIVE_IGNORE && s.topics[t] != topics[t]) ok = false;
            }
            if (!ok) continue;
            bool dup;
            for (uint256 j; j < n; ++j) {
                if (tmp[j] == s.rc) dup = true;
            }
            if (!dup) tmp[n++] = s.rc;
        }
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
    }

    /// @notice Delivers one record to every matching subscriber, then (by default) drains callbacks.
    function _deliver(IReactive.LogRecord memory rec) internal {
        history.push(rec);
        address[] memory targets = _matching(rec);
        for (uint256 i; i < targets.length; ++i) {
            _react(targets[i], rec);
        }
        if (autoDrain) _drain();
    }

    function _react(address target, IReactive.LogRecord memory rec) internal {
        ++reactCalls;
        vm.prank(SYSTEM_ADDR);
        uint256 before = gasleft();
        try IReactive(payable(target)).react{ gas: REACT_GAS_CAP }(rec) {
            uint256 used = before - gasleft();
            if (used > maxReactGas) maxReactGas = used;
        } catch {
            // The real system catches this as ReactiveContractReverted and bills it in full.
            ++reactReverts;
        }
        _flush();
    }

    /// @notice Emits a cron tick on the Reactive chain to whoever subscribed to it.
    function _cronTick() internal {
        IReactive.LogRecord memory rec;
        rec.chainId = block.chainid;
        rec.contractAddress = CRON_EMITTER;
        rec.topic0 = CRON100;
        rec.data = abi.encode(block.number);
        rec.blockNumber = block.number;
        rec.opCode = 1;
        rec.txHash = uint256(keccak256(abi.encode("cron", ++txCounter)));
        _deliver(rec);
    }

    function _queued() internal view returns (uint256) {
        return queue.length - queueHead;
    }

    function _pop() internal returns (CallbackReq memory req) {
        req = queue[queueHead];
        delete queue[queueHead];
        ++queueHead;
    }

    /// @notice Delivers every queued callback, relaying whatever each delivery emits, until the queue is empty.
    function _drain() internal {
        while (_queued() > 0) {
            CallbackReq memory req = _pop();
            if (dropNext[req.chainId] > 0) {
                --dropNext[req.chainId];
                ++droppedCallbacks;
                continue;
            }
            _deliverCallback(req);
        }
    }

    function _deliverCallback(CallbackReq memory req) internal {
        MockCallbackProxy proxy = proxyOf[req.chainId];
        require(address(proxy) != address(0), "harness: no proxy for chain");
        _flush();
        bool ok = proxy.deliver(req.rc, req.recipient, req.gasLimit, req.payload);
        if (ok) ++deliveredCallbacks;
        else ++failedCallbacks;
        _relayRecorded();
    }

    /// @notice Replays a previously delivered record (duplicate delivery).
    function _replay(uint256 historyIndex) internal {
        _deliver(history[historyIndex]);
    }

    function _historyLength() internal view returns (uint256) {
        return history.length;
    }

    function _activeSubsOf(address rc) internal view returns (uint256 n) {
        for (uint256 i; i < subs.length; ++i) {
            if (subs[i].rc == rc) ++n;
        }
    }
}
