// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Where a till parks the tax share. The default implementation is a plain holding vault; a yield
/// bearing implementation can sit behind the same interface without touching the till.
interface IReserve {
    /// @notice Pulls `amount` of `token` from the caller (who must have approved it) and books it to `invoiceId`.
    function deposit(address token, uint256 amount, uint256 invoiceId) external;
}
