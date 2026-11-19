// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { SplitPolicy } from "../DaybookTypes.sol";

/// @notice The part of the till that the reactive contract depends on: the callback entry point and the two
/// acknowledgement events it subscribes to.
interface IDaybookTill {
    /// @notice Emitted once per (invoiceId, seq) when a settlement completes. The reactive contract treats it
    /// as the acknowledgement that closes the loop.
    event Settled(
        uint256 indexed invoiceId,
        uint256 indexed seq,
        address indexed token,
        uint256 amount,
        uint256 excess,
        address payer,
        uint256 chainId,
        bytes32 receiptUid
    );

    /// @notice Emitted when the owner sweeps an invoice's pay address by hand. The reactive contract stops
    /// resending any pending settlement for that invoice and token on this chain.
    event ManualSweep(uint256 indexed invoiceId, address indexed token, address indexed to, uint256 amount);

    function settle(
        address rc,
        uint256 invoiceId,
        uint256 seq,
        address token,
        uint256 amount,
        uint256 excess,
        address payer,
        SplitPolicy calldata policy
    ) external;
}
