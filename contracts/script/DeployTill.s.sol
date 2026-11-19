// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { console } from "forge-std/console.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { DaybookScript } from "./Base.s.sol";
import { PayAddressFactory } from "../src/PayAddressFactory.sol";
import { DaybookTill } from "../src/DaybookTill.sol";
import { SavingsVault } from "../src/SavingsVault.sol";
import { EasReceiptIssuer, IEAS } from "../src/EasReceiptIssuer.sol";

/// @notice Step 2, once per payment chain. Deploys the factory through the CREATE2 deployer if it is not there
/// yet (same address everywhere), then the till, its savings vault and, where EAS is set, the receipt issuer.
/// Env: OWNER (must be the broadcaster), REACTIVE, CALLBACK_PROXY, USDC, MAX_SETTLEMENT (token units),
/// TILL_FUND_WEI (optional), EAS and EAS_SCHEMA (optional, both or neither), FACTORY_SALT (optional).
contract DeployTill is DaybookScript {
    function run() external {
        address owner = _envAddress("OWNER");
        address reactive = _envAddress("REACTIVE");
        address proxy = _envAddress("CALLBACK_PROXY");
        address usdc = _envAddress("USDC");
        uint256 cap = _envUint("MAX_SETTLEMENT");
        uint256 fund = vm.envOr("TILL_FUND_WEI", uint256(0));
        address eas = vm.envOr("EAS", address(0));
        bytes32 schema = vm.envOr("EAS_SCHEMA", bytes32(0));
        require((eas == address(0)) == (schema == bytes32(0)), "set EAS and EAS_SCHEMA together");
        require(CREATE2_DEPLOYER.code.length > 0, "no CREATE2 deployer on this chain");
        require(usdc.code.length > 0, "USDC has no code on this chain");

        address predicted = _predictFactory(owner);
        vm.startBroadcast();
        PayAddressFactory factory = PayAddressFactory(predicted);
        if (predicted.code.length == 0) {
            factory = new PayAddressFactory{ salt: _factorySalt() }(owner);
            require(address(factory) == predicted, "factory landed at an unexpected address");
        }
        DaybookTill till = new DaybookTill{ value: fund }(IPayable(payable(proxy)), reactive, factory, owner);
        SavingsVault vault = new SavingsVault(owner);
        factory.setTill(address(till), true);
        till.setReserve(vault);
        till.setMaxSettlement(IERC20(usdc), cap);
        address issuer;
        if (eas != address(0)) {
            issuer = address(new EasReceiptIssuer(IEAS(eas), schema, address(till)));
            till.setReceiptIssuer(EasReceiptIssuer(issuer));
        }
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("PayAddressFactory", address(factory));
        console.log("DaybookTill", address(till));
        console.log("SavingsVault", address(vault));
        console.log("EasReceiptIssuer", issuer);
    }
}
