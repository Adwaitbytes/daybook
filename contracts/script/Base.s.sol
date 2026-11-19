// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script } from "forge-std/Script.sol";

/// @notice Shared helpers for the deploy scripts. Every input comes from the environment and a missing one
/// stops the script with its name; nothing chain-specific is hardcoded. Broadcast with the keystore:
///   forge script <script> --rpc-url $RPC --account omni-deployer --sender $DEPLOYER --broadcast
abstract contract DaybookScript is Script {
    /// @dev Arachnid's deterministic deployer, called directly (calldata = salt ++ init code) rather than through
    /// forge's `new X{salt: s}` routing, which reverted in simulation on Unichain Sepolia. Present on every
    /// payment chain we use (ref/FACTS.md section 5), absent on Reactive Network.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant DEFAULT_FACTORY_SALT = keccak256("daybook.pay-address-factory.v1");

    uint256 internal constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 internal constant CRON1000 = 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4;

    /// @dev The factory's creation code, pinned. Both DeployReactive (which predicts the factory) and DeployTill
    /// (which deploys it) read this one file instead of `type(PayAddressFactory).creationCode`, because that
    /// expression compiles differently depending on which compiler profile pulls the script in: with
    /// DaybookReactive on the IR pipeline the two scripts disagreed. This is the via-IR build of commit
    /// `adfc5a8` (`forge inspect PayAddressFactory bytecode --via-ir`), the factory deployed for v1 at
    /// 0xA7984241CC7596B0ED7C3b71409Bda7cf6E0D33c on Base Sepolia and Unichain Sepolia. A new factory version
    /// gets a new file and a new salt; this one is never regenerated.
    string internal constant FACTORY_INITCODE_PATH = "script/artifacts/PayAddressFactory.v1.initcode.hex";

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

    function _expectedFactoryKey() internal view virtual returns (string memory) {
        return "EXPECTED_FACTORY";
    }

    function _factoryCreationCode() internal view returns (bytes memory code) {
        code = vm.parseBytes(vm.trim(vm.readFile(FACTORY_INITCODE_PATH)));
        require(code.length > 0, "empty factory artifact");
    }

    function _factoryInitCode(address owner) internal view returns (bytes memory) {
        return abi.encodePacked(_factoryCreationCode(), abi.encode(owner));
    }

    /// @notice Where the factory lands on every payment chain for this owner and salt. Computable anywhere,
    /// including before the factory exists, which is what lets the reactive contract be deployed first.
    /// If EXPECTED_FACTORY is set (for example the address already live on another chain), the prediction must
    /// equal it, checked before anything is broadcast.
    function _predictFactory(address owner) internal view returns (address predicted) {
        predicted = vm.computeCreate2Address(_factorySalt(), keccak256(_factoryInitCode(owner)), CREATE2_DEPLOYER);
        address expected = vm.envOr(_expectedFactoryKey(), address(0));
        require(expected == address(0) || expected == predicted, "factory prediction differs from EXPECTED_FACTORY");
    }

    /// @notice Deploys the factory by calling the CREATE2 deployer directly, unless it is already there.
    /// Must run inside a broadcast. Reverts unless it lands exactly where `_predictFactory` says.
    function _ensureFactory(address owner) internal returns (address factory) {
        factory = _predictFactory(owner);
        if (factory.code.length != 0) return factory;
        require(CREATE2_DEPLOYER.code.length > 0, "no CREATE2 deployer on this chain");
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(_factorySalt(), _factoryInitCode(owner)));
        require(ok && ret.length == 20, "CREATE2 deployer call failed");
        require(address(bytes20(ret)) == factory, "factory landed at an unexpected address");
    }

    /// @dev Lasna refuses transactions whose fee cap exceeds 1 ether; forge's default (twice the base fee on a
    /// multi-million gas limit) crosses it. Scripts that broadcast to Lasna refuse to run above 100 gwei, and the
    /// Makefile passes `--with-gas-price 100gwei` there.
    function _checkLasnaGasPrice() internal view {
        if (block.chainid == 5_318_007) require(tx.gasprice <= 100 gwei, "on Lasna pass --with-gas-price 100gwei");
    }
}
