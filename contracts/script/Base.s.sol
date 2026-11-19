// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script } from "forge-std/Script.sol";
import { PayAddressFactory } from "../src/PayAddressFactory.sol";

/// @notice Shared helpers for the deploy scripts. Every input comes from the environment and a missing one
/// stops the script with its name; nothing chain-specific is hardcoded. Broadcast with the keystore:
///   forge script <script> --rpc-url $RPC --account omni-deployer --sender $DEPLOYER --broadcast
abstract contract DaybookScript is Script {
    /// @dev Arachnid's deterministic deployer; forge routes `new X{salt: s}` through it when broadcasting.
    /// Present on every payment chain we use (ref/FACTS.md section 5), absent on Reactive Network.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant DEFAULT_FACTORY_SALT = keccak256("daybook.pay-address-factory.v1");

    uint256 internal constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 internal constant CRON1000 = 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4;

    function _envAddress(string memory key) internal view returns (address v) {
        v = vm.envOr(key, address(0));
        require(v != address(0), string.concat("missing env ", key));
    }

    function _envUint(string memory key) internal view returns (uint256 v) {
        require(vm.envExists(key), string.concat("missing env ", key));
        v = vm.envUint(key);
    }

    function _factorySalt() internal view returns (bytes32) {
        return vm.envOr("FACTORY_SALT", DEFAULT_FACTORY_SALT);
    }

    /// @notice Where the factory lands on every payment chain for this owner and salt. Computable anywhere,
    /// including before the factory exists, which is what lets the reactive contract be deployed first.
    function _predictFactory(address owner) internal view returns (address) {
        bytes memory init = abi.encodePacked(type(PayAddressFactory).creationCode, abi.encode(owner));
        return vm.computeCreate2Address(_factorySalt(), keccak256(init), CREATE2_DEPLOYER);
    }
}
