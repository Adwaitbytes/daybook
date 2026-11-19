// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice One payee in a split policy. `bps` is the share of the invoice amount in basis points.
struct Recipient {
    address account;
    uint16 bps;
}

/// @notice How a settled invoice amount is divided. The tax share goes to the till's reserve on the payment
/// chain, each team member gets their bps, and the treasury receives the remainder plus all rounding dust.
/// Excess (overpayment, late or orphaned funds) is never split: it goes to the treasury untouched.
struct SplitPolicy {
    address treasury;
    uint16 taxBps;
    Recipient[] team;
}

/// @notice An accepted (chain, token) pair for one invoice. Packs into one storage slot.
struct AcceptedToken {
    uint64 chainId;
    address token;
    uint8 decimals;
}

/// @notice Shared constants and pure helpers used by both sides of the loop.
library DaybookLib {
    uint16 internal constant BPS = 10_000;
    uint256 internal constant MAX_TEAM = 5;
    /// @notice Gas the till forwards to its receipt issuer. A real EAS attestation measured 313,995 gas on a
    /// Base mainnet fork (test/security/EasReceiptGas.t.sol); 400,000 leaves about 25% margin.
    uint256 internal constant RECEIPT_GAS = 400_000;

    error TooManyRecipients(uint256 count);
    error ZeroAddress();
    error ZeroBps();
    error BpsOverflow(uint256 total);

    /// @notice The CREATE2 salt for an invoice's pay address. Namespaced by the reactive contract so a
    /// redeployed reactive contract (whose ids restart at 1) never collides with old pay addresses.
    function salt(address reactive, uint256 invoiceId) internal pure returns (bytes32) {
        return keccak256(abi.encode(reactive, invoiceId));
    }

    /// @notice Reverts unless the policy is well formed: treasury set, at most five recipients, no zero
    /// address or zero share, and tax plus team shares not above 100%.
    function validate(SplitPolicy memory policy) internal pure {
        if (policy.treasury == address(0)) revert ZeroAddress();
        uint256 n = policy.team.length;
        if (n > MAX_TEAM) revert TooManyRecipients(n);
        uint256 total = policy.taxBps;
        for (uint256 i; i < n; ++i) {
            if (policy.team[i].account == address(0)) revert ZeroAddress();
            if (policy.team[i].bps == 0) revert ZeroBps();
            total += policy.team[i].bps;
        }
        if (total > BPS) revert BpsOverflow(total);
    }

    /// @notice Splits `amount` by the policy. Every share rounds down and the treasury takes the remainder,
    /// so `tax + sum(team) + treasury == amount` exactly.
    function split(uint256 amount, SplitPolicy memory policy)
        internal
        pure
        returns (uint256 tax, uint256[] memory team, uint256 treasury)
    {
        tax = amount * policy.taxBps / BPS;
        uint256 n = policy.team.length;
        team = new uint256[](n);
        uint256 spent = tax;
        for (uint256 i; i < n; ++i) {
            team[i] = amount * policy.team[i].bps / BPS;
            spent += team[i];
        }
        treasury = amount - spent;
    }
}
