// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { console } from "forge-std/console.sol";
import { DaybookScript } from "./Base.s.sol";
import { DaybookReactive } from "../src/DaybookReactive.sol";

/// @notice Step 1. Deploys `DaybookReactive` on Lasna (5318007) or Reactive Mainnet (1597).
/// Env: OWNER, CRON_TIER (100 or 1000; default 1000 on mainnet, 100 elsewhere), REACTIVE_FUND_WEI (optional),
/// FACTORY_SALT (optional). The factory address is predicted from OWNER and the salt, so the payment chains can
/// be deployed afterwards.
contract DeployReactive is DaybookScript {
    function run() external returns (DaybookReactive reactive) {
        require(block.chainid == 5_318_007 || block.chainid == 1597, "not a Reactive chain");
        address owner = _envAddress("OWNER");
        uint256 tier = vm.envOr("CRON_TIER", block.chainid == 1597 ? uint256(1000) : uint256(100));
        require(tier == 100 || tier == 1000, "CRON_TIER must be 100 or 1000");
        uint256 fund = vm.envOr("REACTIVE_FUND_WEI", uint256(0));
        address factory = _predictFactory(owner);

        vm.startBroadcast();
        reactive = new DaybookReactive{ value: fund }(owner, factory, tier == 100 ? CRON100 : CRON1000);
        vm.stopBroadcast();

        console.log("DaybookReactive", address(reactive));
        console.log("PayAddressFactory (predicted, every payment chain)", factory);
        console.log("cron tier", tier);
    }
}
