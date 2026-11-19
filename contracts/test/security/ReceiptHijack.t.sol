// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Vm } from "forge-std/Vm.sol";
import { DaybookFixture } from "../harness/DaybookFixture.sol";
import { IReceiptIssuer } from "../../src/interfaces/IReceiptIssuer.sol";

contract RecordingIssuer is IReceiptIssuer {
    mapping(uint256 seq => address) public payerOf;
    mapping(uint256 seq => uint256) public amountOf;

    function issue(uint256, uint256 seq, address payer, address, uint256 amount) external returns (bytes32) {
        payerOf[seq] = payer;
        amountOf[seq] = amount;
        return bytes32(seq);
    }
}

/// @notice SECURITY REVIEW, finding M-2. Expected to FAIL on the current code.
/// The receipt (EAS attestation where enabled) goes to `pair.lastPayer`, which any sender of one raw unit of
/// the accepted token overwrites. The attestation then states that the attacker paid the whole pair total.
contract ReceiptHijackTest is DaybookFixture {
    uint256 internal constant AMOUNT = 1000e6;
    address internal attacker = makeAddr("attacker");
    RecordingIssuer internal issuer;

    function setUp() public override {
        super.setUp();
        issuer = new RecordingIssuer();
        vm.prank(owner);
        tillOn[CHAIN_A].setReceiptIssuer(issuer);
    }

    /// The client is one micro-dollar short (an exchange withdrawal fee, a rounding wallet). The pay page is
    /// public and shows the remainder; the attacker pays it.
    function test_M2_DustCover_TakesTheReceiptForTheWholeInvoice() public {
        uint256 id = _createAB(AMOUNT);
        _payInvoice(CHAIN_A, id, AMOUNT - 1);
        _pay(usd[CHAIN_A], attacker, reactive.payAddressOf(id), 1);

        emit log_named_address("receipt recipient", issuer.payerOf(1));
        emit log_named_uint("receipt amount", issuer.amountOf(1));
        assertEq(issuer.payerOf(1), payer, "the client who paid 999.999999 USDC should get the receipt");
    }

    /// A resend re-reads lastPayer, so a late 1-unit transfer re-targets the receipt of a settlement whose
    /// first delivery was lost.
    function test_M2_LateDustBeforeResend_RetargetsTheReceipt() public {
        uint256 id = _createAB(AMOUNT);
        address pay = reactive.payAddressOf(id);
        dropNext[CHAIN_A] = 1;
        _payInvoice(CHAIN_A, id, AMOUNT); // seq 1 is sent, delivery lost

        // A 1-unit transfer already in the pipeline when the subscription was dropped.
        usd[CHAIN_A].mint(attacker, 1);
        _flush();
        vm.prank(attacker);
        usd[CHAIN_A].transfer(pay, 1);
        _deliverInFlight();

        _warpTick(301); // resend of seq 1
        assertEq(issuer.amountOf(1), AMOUNT);
        assertEq(issuer.payerOf(1), payer, "the 1000 USDC receipt should go to the client");
    }

    function _deliverInFlight() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (chainOf[logs[i].emitter] == 0) continue;
            _react(address(reactive), _toRecord(chainOf[logs[i].emitter], logs[i], uint256(keccak256("late")), i));
        }
        _drain();
    }
}
