// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { console } from "forge-std/console.sol";
import { DaybookScript } from "./Base.s.sol";
import { DaybookReactive } from "../src/DaybookReactive.sol";
import { AcceptedToken } from "../src/DaybookTypes.sol";

/// @notice Creates one invoice on Reactive and prints its pay address.
/// Env: REACTIVE, POLICY_ID, AMOUNT (micro-dollars, 6 decimals), ACCEPT_CHAIN_IDS, ACCEPT_TOKENS and
/// ACCEPT_DECIMALS (comma lists, same length), DUE_AT and EXPIRES_AT (unix seconds, optional),
/// WATCH_ALL_TOKENS (optional bool, default false: watch accepted tokens only), DETAILS_HASH (optional bytes32, hash of the off-chain invoice record).
contract CreateInvoice is DaybookScript {
    function run() external returns (uint256 id, address pay) {
        DaybookReactive reactive = DaybookReactive(payable(_envAddress("REACTIVE")));
        uint256[] memory chains = vm.envUint("ACCEPT_CHAIN_IDS", ",");
        address[] memory tokens = vm.envAddress("ACCEPT_TOKENS", ",");
        uint256[] memory decimals = vm.envUint("ACCEPT_DECIMALS", ",");
        require(chains.length == tokens.length && tokens.length == decimals.length, "ACCEPT_* lengths differ");
        AcceptedToken[] memory acc = new AcceptedToken[](chains.length);
        for (uint256 i; i < chains.length; ++i) {
            require(chains[i] <= type(uint64).max && decimals[i] <= 30, "bad accepted entry");
            acc[i] = AcceptedToken(uint64(chains[i]), tokens[i], uint8(decimals[i]));
        }
        DaybookReactive.CreateInvoiceParams memory p = DaybookReactive.CreateInvoiceParams({
            amount: _envUint("AMOUNT"),
            dueAt: uint64(vm.envOr("DUE_AT", uint256(0))),
            expiresAt: uint64(vm.envOr("EXPIRES_AT", uint256(0))),
            policyId: uint32(_envUint("POLICY_ID")),
            watchAllTokens: vm.envOr("WATCH_ALL_TOKENS", false),
            detailsHash: vm.envOr("DETAILS_HASH", bytes32(0)),
            accepted: acc
        });

        vm.startBroadcast();
        id = reactive.createInvoice(p);
        vm.stopBroadcast();

        pay = reactive.payAddressOf(id);
        console.log("invoiceId", id);
        console.log("pay address (same on every accepted chain)", pay);
    }
}
