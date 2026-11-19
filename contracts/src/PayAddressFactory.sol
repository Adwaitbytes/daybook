// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title InvoiceVault
/// @notice The code behind every pay address. It holds whatever was paid to it and can only move funds when
/// the factory that created it says so. It has no owner, no initializer and no chain-specific state, which is
/// what keeps its address identical on every chain.
contract InvoiceVault {
    using SafeERC20 for IERC20;

    /// @notice The factory that deployed the implementation. Clones read it from the implementation's code.
    address public immutable FACTORY;

    error OnlyFactory();
    error NativeTransferFailed();

    constructor() {
        FACTORY = msg.sender;
    }

    /// @notice Accepts native coin so a mistaken native payment can be recovered by a sweep.
    receive() external payable { }

    /// @notice Sends `amount` of `token` to `to`. Factory only.
    function sweep(IERC20 token, address to, uint256 amount) external {
        if (msg.sender != FACTORY) revert OnlyFactory();
        token.safeTransfer(to, amount);
    }

    /// @notice Sends the whole native balance to `to`. Factory only.
    function sweepNative(address payable to) external returns (uint256 amount) {
        if (msg.sender != FACTORY) revert OnlyFactory();
        amount = address(this).balance;
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
    }
}

/// @title PayAddressFactory
/// @notice Deterministic, chain-agnostic factory for invoice pay addresses.
/// @dev Deployed through the canonical CREATE2 deployer with the same salt and the same init code on every
/// chain, so it lands at the same address everywhere. Its only constructor argument is the owner, which is
/// the same EOA on every chain. Its first CREATE deploys the vault implementation, so that address is also
/// identical everywhere. A pay address is an EIP-1167 clone of the implementation at
/// CREATE2(factory, salt, cloneInitCode(implementation)); nothing chain-specific enters that formula, and the
/// reactive contract recomputes it on Reactive Network without ever calling this contract.
///
/// Chain-specific wiring (which till may sweep) is plain storage set by the owner after deployment, so it
/// does not affect any address. More than one till may be authorized at once, which lets the owner migrate to
/// a new till (for example after redeploying the reactive contract) without stranding funds.
contract PayAddressFactory is Ownable2Step {
    /// @notice The vault implementation every pay address clones.
    address public immutable VAULT_IMPLEMENTATION;

    /// @notice Tills allowed to sweep pay addresses on this chain.
    mapping(address till => bool allowed) public isTill;

    event TillAuthorized(address indexed till, bool allowed);
    event VaultDeployed(bytes32 indexed salt, address indexed vault);

    error NotTill(address caller);
    error ZeroAddress();
    error RenounceDisabled();

    modifier onlyTill() {
        if (!isTill[msg.sender]) revert NotTill(msg.sender);
        _;
    }

    constructor(address owner_) Ownable(owner_) {
        VAULT_IMPLEMENTATION = address(new InvoiceVault());
    }

    /// @notice Disabled: without an owner no new till could ever be authorized on this chain.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Authorizes or revokes a till on this chain.
    function setTill(address till, bool allowed) external onlyOwner {
        if (till == address(0)) revert ZeroAddress();
        isTill[till] = allowed;
        emit TillAuthorized(till, allowed);
    }

    /// @notice The pay address for `salt`, whether or not it has been deployed yet.
    function payAddress(bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(VAULT_IMPLEMENTATION, salt, address(this));
    }

    /// @notice Deploys the vault behind a pay address. Permissionless and idempotent: deploying early changes
    /// nothing about who can move the funds.
    function deploy(bytes32 salt) public returns (address vault) {
        vault = payAddress(salt);
        if (vault.code.length == 0) {
            Clones.cloneDeterministic(VAULT_IMPLEMENTATION, salt);
            emit VaultDeployed(salt, vault);
        }
    }

    /// @notice Moves `amount` of `token` from the pay address to the calling till, deploying the vault first
    /// if needed. Tills only.
    function sweep(bytes32 salt, IERC20 token, uint256 amount) external onlyTill {
        address vault = deploy(salt);
        InvoiceVault(payable(vault)).sweep(token, msg.sender, amount);
    }

    /// @notice Moves the pay address's whole native balance to `to`. Tills only.
    function sweepNative(bytes32 salt, address payable to) external onlyTill returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        address vault = deploy(salt);
        amount = InvoiceVault(payable(vault)).sweepNative(to);
    }
}
