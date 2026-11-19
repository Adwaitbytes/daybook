// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { DeployReactive } from "../../script/DeployReactive.s.sol";
import { DeployTill } from "../../script/DeployTill.s.sol";
import { DaybookScript } from "../../script/Base.s.sol";
import { DaybookReactive } from "../../src/DaybookReactive.sol";
import { PayAddressFactory } from "../../src/PayAddressFactory.sol";
import { DaybookLib } from "../../src/DaybookTypes.sol";
import { MockERC20 } from "../mocks/MockERC20.sol";
import { MockCallbackProxy } from "../harness/MockCallbackProxy.sol";

/// @notice Runs the real deploy scripts in-process and checks they agree on the factory: the address the
/// reactive contract predicts must be the address the till script deploys, and the pinned artifact must give
/// the factory that is live for v1.
contract DeployScriptsTest is Test {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// Arachnid's deterministic deployer runtime code.
    bytes internal constant ARACHNID_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
    address internal constant LIVE_V1_FACTORY = 0xA7984241CC7596B0ED7C3b71409Bda7cf6E0D33c;
    address internal constant DEPLOYER = 0x4d96Ec766088D952D62255227902eeEe1C58276c;

    /// The broadcaster in forge tests: owner must be the broadcaster, since DeployTill configures the factory.
    address internal sender = DEFAULT_SENDER;

    function setUp() public {
        vm.etch(CREATE2_DEPLOYER, ARACHNID_CODE);
        vm.setEnv("OWNER", vm.toString(sender));
        vm.deal(sender, 10 ether);
    }

    function _deployReactive() internal returns (DaybookReactive reactive) {
        vm.chainId(5_318_007);
        vm.txGasPrice(100 gwei);
        reactive = new DeployReactive().run();
    }

    function _deployTill(uint256 chainId, address reactive) internal returns (address factory, address till) {
        vm.chainId(chainId);
        vm.txGasPrice(1 gwei);
        MockERC20 usdc = new MockERC20("USDC", 6);
        MockCallbackProxy proxy = new MockCallbackProxy(130_000);
        vm.setEnv("REACTIVE", vm.toString(reactive));
        vm.setEnv("CALLBACK_PROXY", vm.toString(address(proxy)));
        vm.setEnv("USDC", vm.toString(address(usdc)));
        vm.setEnv("MAX_SETTLEMENT", "20000000");
        return new DeployTill().run();
    }

    function test_ReactivePredictionEqualsFactoryTheTillScriptDeploys() public {
        DaybookReactive reactive = _deployReactive();
        (address factory, address till) = _deployTill(84_532, address(reactive));
        assertEq(reactive.FACTORY(), factory, "both scripts must agree on the factory");
        assertEq(reactive.VAULT_IMPLEMENTATION(), PayAddressFactory(factory).VAULT_IMPLEMENTATION());
        assertTrue(PayAddressFactory(factory).isTill(till));
        assertEq(reactive.payAddressOf(7), PayAddressFactory(factory).payAddress(DaybookLib.salt(address(reactive), 7)));
    }

    function test_SecondChainReusesTheSameFactory() public {
        DaybookReactive reactive = _deployReactive();
        (address f1,) = _deployTill(84_532, address(reactive));
        (address f2,) = _deployTill(1301, address(reactive));
        assertEq(f1, f2, "already deployed: the script reuses it");
    }

    function test_PinnedArtifactIsTheLiveV1Factory() public {
        assertEq(new FactoryProbe("EXPECTED_FACTORY_UNSET").predict(DEPLOYER), LIVE_V1_FACTORY);
    }

    function test_ExpectedFactoryMismatchStopsTheScript() public {
        FactoryProbe probe = new FactoryProbe("EXPECTED_FACTORY_PROBE");
        vm.setEnv("EXPECTED_FACTORY_PROBE", vm.toString(address(0xBEEF)));
        vm.expectRevert("factory prediction differs from EXPECTED_FACTORY");
        probe.predict(DEPLOYER);
    }

    function test_LasnaGasPriceCap() public {
        vm.chainId(5_318_007);
        vm.txGasPrice(101 gwei);
        DeployReactive s = new DeployReactive();
        vm.expectRevert("on Lasna pass --with-gas-price 100gwei");
        s.run();
    }
}

/// @notice Exposes the scripts' shared factory prediction, with its own expected-address variable so tests running
/// in parallel never see each other's environment.
contract FactoryProbe is DaybookScript {
    string internal _key;

    constructor(string memory key) {
        _key = key;
    }

    function _expectedFactoryKey() internal view override returns (string memory) {
        return _key;
    }

    function predict(address owner) external view returns (address) {
        return _predictFactory(owner);
    }
}
