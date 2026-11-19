// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { EasReceiptIssuer, IEAS } from "../../src/EasReceiptIssuer.sol";
import { DaybookLib } from "../../src/DaybookTypes.sol";

interface ISchemaRegistry {
    function register(string calldata schema, address resolver, bool revocable) external returns (bytes32);
}

/// @notice SECURITY REVIEW, finding M-3. Fork test against the real EAS predeploy on Base mainnet.
/// Run: forge test --match-path test/security/EasReceiptGas.t.sol (needs network; BASE_RPC_URL overrides).
/// Checks that a real attestation fits in the till's RECEIPT_GAS budget (raised to 400,000 after this test).
contract EasReceiptGasForkTest is Test {
    IEAS internal constant EAS = IEAS(0x4200000000000000000000000000000000000021);
    ISchemaRegistry internal constant REGISTRY = ISchemaRegistry(0x4200000000000000000000000000000000000020);
    string internal constant SCHEMA = "uint256 invoiceId,uint256 seq,address token,uint256 amount,uint256 chainId";
    uint256 internal constant RECEIPT_GAS = DaybookLib.RECEIPT_GAS; // the till's budget, not a copy

    EasReceiptIssuer internal issuer;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        bytes32 uid = keccak256(abi.encodePacked(SCHEMA, address(0), false));
        try REGISTRY.register(SCHEMA, address(0), false) returns (bytes32 u) {
            uid = u;
        } catch { }
        issuer = new EasReceiptIssuer(EAS, uid, address(this)); // this test plays the till
    }

    function test_M3_RealEasAttestation_FitsInReceiptGas() public {
        address payerAddr = address(0xC0FFEE);
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

        // Unbounded first, to measure.
        uint256 g0 = gasleft();
        issuer.issue(1, 1, payerAddr, usdc, 1000e6);
        uint256 used = g0 - gasleft();
        emit log_named_uint("gas used by one real EAS receipt (warm-ish)", used);

        // Then exactly as the till calls it, on a fresh invoice id and payer (cold storage).
        (bool ok,) = address(issuer).call{ gas: RECEIPT_GAS }(
            abi.encodeCall(issuer.issue, (2, 2, address(0xBEEF), usdc, 1000e6))
        );
        assertTrue(ok, "a real EAS attestation must fit in RECEIPT_GAS or every receipt silently fails");
    }
}
