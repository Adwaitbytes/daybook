// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { console } from "forge-std/console.sol";
import { DaybookScript } from "./Base.s.sol";
import { DaybookReactive } from "../src/DaybookReactive.sol";
import { Recipient } from "../src/DaybookTypes.sol";

/// @notice Step 3, on Reactive. Registers each chain's till (which subscribes to its acknowledgements) and
/// creates the split policy.
/// Env: REACTIVE, TILL_CHAIN_IDS and TILL_ADDRESSES (comma lists, same length), TREASURY, TAX_BPS,
/// TEAM_ADDRESSES and TEAM_BPS (comma lists, may be empty), CALLBACK_GAS_LIMIT (optional).
contract Wire is DaybookScript {
    function run() external {
        DaybookReactive reactive = DaybookReactive(payable(_envAddress("REACTIVE")));
        uint256[] memory chainIds = vm.envUint("TILL_CHAIN_IDS", ",");
        address[] memory tills = vm.envAddress("TILL_ADDRESSES", ",");
        require(chainIds.length == tills.length && chainIds.length > 0, "TILL_CHAIN_IDS and TILL_ADDRESSES differ");
        address treasury = _envAddress("TREASURY");
        uint16 taxBps = uint16(_envUint("TAX_BPS"));
        address[] memory teamAddrs = vm.envOr("TEAM_ADDRESSES", ",", new address[](0));
        uint256[] memory teamBps = vm.envOr("TEAM_BPS", ",", new uint256[](0));
        require(teamAddrs.length == teamBps.length, "TEAM_ADDRESSES and TEAM_BPS differ");
        Recipient[] memory team = new Recipient[](teamAddrs.length);
        for (uint256 i; i < team.length; ++i) {
            require(teamBps[i] <= 10_000, "team bps");
            team[i] = Recipient(teamAddrs[i], uint16(teamBps[i]));
        }
        uint256 gasLimit = vm.envOr("CALLBACK_GAS_LIMIT", uint256(0));

        _checkLasnaGasPrice();
        vm.startBroadcast();
        for (uint256 i; i < chainIds.length; ++i) {
            reactive.setTill(chainIds[i], tills[i]);
        }
        uint32 policyId = reactive.createPolicy(treasury, taxBps, team);
        if (gasLimit != 0) reactive.setCallbackGasLimit(uint64(gasLimit));
        vm.stopBroadcast();

        console.log("policyId", policyId);
    }
}
