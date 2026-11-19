// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Local stand-in for a destination chain's callback proxy. It overwrites the payload's first argument
/// with the requesting reactive contract's address, holds back a fixed overhead from the gas limit (the real
/// proxy keeps gas for its own accounting), calls the recipient, and reports failure as an event instead of
/// reverting, like the real proxy's `CallbackFailure`. It charges nothing.
contract MockCallbackProxy {
    /// @notice Gas withheld from the requested limit before the call: the live proxy's `_extraGas` plus
    /// `_maxChargeGas`, read on 19 Nov 2026 (ref/FACTS.md): 80k + 50k on Base, Unichain and Arbitrum (and their
    /// testnets), 150k + 50k on Ethereum and Ethereum Sepolia.
    uint256 public immutable OVERHEAD;

    constructor(uint256 overhead_) {
        OVERHEAD = overhead_;
    }

    event CallbackDelivered(address indexed recipient, address indexed rc, bool ok, uint256 gasUsed);
    event CallbackFailure(address indexed recipient, address indexed rc, bytes reason);

    error NotAContract(address recipient);

    uint256 public lastGasUsed;
    uint256 public maxGasUsed;

    function deliver(address rc, address recipient, uint64 gasLimit, bytes memory payload) external returns (bool ok) {
        if (recipient.code.length == 0) revert NotAContract(recipient);
        assembly ("memory-safe") {
            // payload layout: [len][selector 4 bytes][arg0 32 bytes]...; overwrite arg0 with rc
            mstore(add(payload, 36), rc)
        }
        uint256 forward = gasLimit > OVERHEAD ? gasLimit - OVERHEAD : 0;
        uint256 before = gasleft();
        bytes memory ret;
        (ok, ret) = recipient.call{ gas: forward }(payload);
        lastGasUsed = before - gasleft();
        if (lastGasUsed > maxGasUsed) maxGasUsed = lastGasUsed;
        if (!ok) emit CallbackFailure(recipient, rc, ret);
        emit CallbackDelivered(recipient, rc, ok, lastGasUsed);
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function depositTo(address) external payable { }

    receive() external payable { }
}
