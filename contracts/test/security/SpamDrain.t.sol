// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { DaybookFixture } from "../harness/DaybookFixture.sol";

/// @notice A contract anyone can deploy on a payment chain. It moves no value; it only emits ERC-20 shaped
/// Transfer logs naming a public pay address as the recipient.
contract SpamEmitter {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function spam(address to, uint256 n) external {
        for (uint256 i; i < n; ++i) {
            emit Transfer(address(uint160(i + 1)), to, 1);
        }
    }
}

/// @notice SECURITY REVIEW, finding H-1. Expected to FAIL on the current code.
/// In the default watching mode (`strictTokens = false`) the subscription is (chain, any contract, Transfer,
/// any, payAddress, any). Every log matching it is a billed reactive transaction, and MAX_FLAGGED only bounds
/// ledger storage, not the number of reactions. One cheap transaction on Base buys hundreds of reactions.
contract SpamDrainTest is DaybookFixture {
    function test_H1_SpamLogsToPublicPayAddress_AreEachABilledReaction() public {
        uint256 id = _createAB(1000e6); // default mode: strictTokens = false
        address pay = reactive.payAddressOf(id);

        SpamEmitter spammer = new SpamEmitter();
        _registerEmitter(address(spammer), CHAIN_A);
        _flush();

        uint256 n = 300;
        uint256 g0 = gasleft();
        spammer.spam(pay, n);
        uint256 attackerGas = g0 - gasleft();

        uint256 reactsBefore = reactCalls;
        _relayRecorded();
        uint256 reactions = reactCalls - reactsBefore;

        // Gas of one more spam reaction on the cheapest path (flag budget already exhausted).
        IReactive.LogRecord memory rec;
        rec.chainId = CHAIN_A;
        rec.contractAddress = address(spammer);
        rec.topic0 = uint256(keccak256("Transfer(address,address,uint256)"));
        rec.topic1 = 0xdead;
        rec.topic2 = uint256(uint160(pay));
        rec.data = abi.encode(uint256(1));
        rec.opCode = 3;
        rec.txHash = 0xbeef;
        rec.logIndex = 1;
        vm.prank(SYSTEM_ADDR);
        uint256 r0 = gasleft();
        IReactive(payable(address(reactive))).react(rec);
        uint256 reactGas = r0 - gasleft();

        emit log_named_uint("attacker gas on the payment chain for all logs", attackerGas);
        emit log_named_uint("attacker gas per log", attackerGas / n);
        emit log_named_uint("reactions billed to DaybookReactive", reactions);
        emit log_named_uint("gas of one spam reaction (before the system surcharge K)", reactGas);
        emit log_named_uint("droppedFlags (spam counted but still billed)", reactive.droppedFlags(id));

        assertLe(reactions, reactive.MAX_FLAGGED(), "every spam log costs a billed reaction: REACT drain");
    }
}
