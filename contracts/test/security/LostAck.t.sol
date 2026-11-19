// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { DaybookFixture } from "../harness/DaybookFixture.sol";
import { DaybookReactive } from "../../src/DaybookReactive.sol";

/// @notice SECURITY REVIEW, finding M-1. Expected to FAIL on the current code.
/// The resend path cannot recover a lost acknowledgement: the till answers a repeated (invoiceId, seq) with
/// `DuplicateSettlement`, which the reactive contract does not subscribe to, and never re-emits `Settled`.
contract LostAckTest is DaybookFixture {
    uint256 internal constant AMOUNT = 1000e6;

    function test_M1_LostSettledAck_IsNeverRecoveredByResend() public {
        uint256 id = _createAB(AMOUNT);
        autoDrain = false;
        _payInvoice(CHAIN_A, id, AMOUNT);
        assertEq(_queued(), 1);

        // The settlement executes on chain A, but its Settled log never reaches react() (for example the
        // reactive contract was briefly in debt, or that reaction reverted).
        CallbackReq memory req = _pop();
        _flush();
        assertTrue(proxyOf[CHAIN_A].deliver(req.rc, req.recipient, req.gasLimit, req.payload));
        _flush(); // drop the ack
        autoDrain = true;
        assertTrue(tillOn[CHAIN_A].settled(id, 1), "funds were swept and split");

        for (uint256 i; i < 6; ++i) {
            _warpTick(301);
        }

        assertEq(
            uint8(_status(id)),
            uint8(DaybookReactive.InvoiceStatus.Settled),
            "invoice should reach Settled once the resend is answered"
        );
    }
}
