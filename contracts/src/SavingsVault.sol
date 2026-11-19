// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IReserve } from "./interfaces/IReserve.sol";

/// @title SavingsVault
/// @notice Plain holding vault for the tax share. It earns nothing and does nothing clever, on purpose: with
/// real money the simplest thing that cannot lose funds wins. A yield-bearing reserve can replace it behind
/// `IReserve` once that integration has been verified.
contract SavingsVault is IReserve, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Running total deposited per token, for reconciliation.
    mapping(address token => uint256 total) public deposited;

    event Deposited(address indexed token, address indexed from, uint256 indexed invoiceId, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();

    constructor(address owner_) Ownable(owner_) { }

    /// @inheritdoc IReserve
    function deposit(address token, uint256 amount, uint256 invoiceId) external {
        deposited[token] += amount;
        emit Deposited(token, msg.sender, invoiceId, amount);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Owner withdrawal, for paying the tax bill.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }
}
