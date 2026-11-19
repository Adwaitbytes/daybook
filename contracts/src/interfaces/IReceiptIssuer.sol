// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Issues an on-chain receipt for a settled payment. The till calls it inside a try/catch with a
/// bounded gas budget, so a broken issuer never blocks settlement; the till's own `Receipt` event is the
/// fallback record.
interface IReceiptIssuer {
    /// @return uid Identifier of the receipt (an EAS attestation UID for the EAS issuer).
    function issue(uint256 invoiceId, uint256 seq, address payer, address token, uint256 amount)
        external
        returns (bytes32 uid);
}
