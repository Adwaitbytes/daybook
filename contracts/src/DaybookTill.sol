// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { DaybookLib, SplitPolicy } from "./DaybookTypes.sol";
import { IDaybookTill } from "./interfaces/IDaybookTill.sol";
import { IReserve } from "./interfaces/IReserve.sol";
import { IReceiptIssuer } from "./interfaces/IReceiptIssuer.sol";
import { PayAddressFactory } from "./PayAddressFactory.sol";

/// @title DaybookTill
/// @notice One per payment chain. Receives settlement callbacks from `DaybookReactive` through the callback
/// proxy, sweeps the invoice's pay address, sets the tax share aside, pays the team, sends the rest to the
/// treasury, issues a receipt and emits `Settled`, which the reactive contract reads as the acknowledgement.
/// @dev Chain-specific on purpose: AbstractCallback stores the proxy and the reactive contract as immutables,
/// so this contract's address differs per chain. Pay addresses do not depend on it; they come from the
/// chain-agnostic `PayAddressFactory`.
contract DaybookTill is IDaybookTill, AbstractCallback, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Gas forwarded to the receipt issuer. Bounded so a misbehaving issuer cannot starve settlement.
    uint256 public constant RECEIPT_GAS = DaybookLib.RECEIPT_GAS;

    PayAddressFactory public immutable FACTORY;

    /// @notice Where the tax share goes on this chain. Zero sends tax to the treasury with an event.
    IReserve public reserve;
    /// @notice Optional receipt issuer (EAS where available). Zero means the `Receipt` event is the receipt.
    IReceiptIssuer public receiptIssuer;
    /// @notice Largest total (amount plus excess) one settlement may move, per token. Zero means the token is
    /// not enabled on this till, so an unconfigured token can never be swept by a callback.
    mapping(address token => uint256 cap) public maxSettlement;

    mapping(uint256 invoiceId => mapping(uint256 seq => bool done)) public settled;
    /// @notice Receipt UID per settlement, re-emitted when a repeated delivery re-acknowledges it.
    mapping(uint256 invoiceId => mapping(uint256 seq => bytes32 uid)) public receiptUidOf;

    event Receipt(
        uint256 indexed invoiceId,
        uint256 indexed seq,
        address indexed payer,
        address token,
        uint256 amount,
        bytes32 uid
    );
    event Payout(uint256 indexed invoiceId, address indexed token, address indexed to, uint256 amount, uint8 role);
    event PayoutRedirected(uint256 indexed invoiceId, address indexed token, address indexed intended, uint256 amount);
    event ReceiptFailed(uint256 indexed invoiceId, uint256 indexed seq, uint256 gasLeft);
    event DuplicateSettlement(uint256 indexed invoiceId, uint256 indexed seq);
    event ReserveSet(address indexed reserve);
    event ReceiptIssuerSet(address indexed issuer);
    event MaxSettlementSet(address indexed token, uint256 cap);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event NativeWithdrawn(address indexed to, uint256 amount);

    error CapExceeded(address token, uint256 total, uint256 cap);
    error ZeroAddress();
    error NativeTransferFailed();
    error ReserveMismatch(uint256 pulled, uint256 expected);
    error NotAContract(address target);
    error RenounceDisabled();

    uint8 internal constant ROLE_TAX = 1;
    uint8 internal constant ROLE_TEAM = 2;
    uint8 internal constant ROLE_TREASURY = 3;

    /// @param callbackProxy_ Callback proxy on this chain (from the Reactive docs, per chain).
    /// @param reactive_ The `DaybookReactive` contract on Reactive Network allowed to call `settle`.
    /// @param factory_ The chain-agnostic pay address factory (same address on every chain).
    /// @param owner_ Owner for guards, sweeps and configuration.
    constructor(IPayable callbackProxy_, address reactive_, PayAddressFactory factory_, address owner_)
        payable
        AbstractCallback(callbackProxy_, reactive_)
        Ownable(owner_)
    {
        if (address(factory_) == address(0) || reactive_ == address(0)) revert ZeroAddress();
        FACTORY = factory_;
    }

    // ---------------------------------------------------------------- callback

    /// @inheritdoc IDaybookTill
    /// @dev Idempotent per (invoiceId, seq): a repeated delivery emits `DuplicateSettlement` and changes nothing.
    /// Reverts (and is retried by the reactive contract's resend) only when paused, over cap, or the pay
    /// address does not hold the funds.
    function settle(
        address rc,
        uint256 invoiceId,
        uint256 seq,
        address token,
        uint256 amount,
        uint256 excess,
        address payer,
        SplitPolicy calldata policy
    ) external nonReentrant onlyServiceProvider onlyCallbackSender(rc) whenNotPaused {
        if (settled[invoiceId][seq]) {
            // Re-acknowledge, so a resend can close a loop whose first Settled log never reached Reactive. The
            // reactive side ignores acks for settlements it already closed; indexers dedupe on (invoiceId, seq).
            emit DuplicateSettlement(invoiceId, seq);
            _ack(invoiceId, seq, token, amount, excess, payer);
            return;
        }
        uint256 total = amount + excess;
        uint256 cap = maxSettlement[token];
        if (total > cap) revert CapExceeded(token, total, cap);
        DaybookLib.validate(policy);

        settled[invoiceId][seq] = true;

        if (total > 0) FACTORY.sweep(DaybookLib.salt(rc, invoiceId), IERC20(token), total);
        _distribute(invoiceId, token, amount, excess, policy);

        receiptUidOf[invoiceId][seq] = _issueReceipt(invoiceId, seq, payer, token, amount + excess);
        _ack(invoiceId, seq, token, amount, excess, payer);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Sweeps the whole `token` balance of an invoice's pay address to `to`. Works while paused, so a
    /// failed or stuck callback can never strand funds.
    function sweep(uint256 invoiceId, address token, address to) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        bytes32 salt = DaybookLib.salt(_CALLBACK_SENDER, invoiceId);
        uint256 amount = IERC20(token).balanceOf(FACTORY.payAddress(salt));
        // Nothing moved, nothing to tell the reactive contract: a zero sweep must not resolve anything.
        if (amount == 0) return;
        emit ManualSweep(invoiceId, token, to, amount);
        FACTORY.sweep(salt, IERC20(token), amount);
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Sweeps native coin mistakenly sent to an invoice's pay address.
    function sweepNative(uint256 invoiceId, address payable to) external nonReentrant onlyOwner {
        uint256 amount = FACTORY.sweepNative(DaybookLib.salt(_CALLBACK_SENDER, invoiceId), to);
        if (amount != 0) emit ManualSweep(invoiceId, address(0), to, amount);
    }

    /// @notice Recovers tokens held by the till itself (it should hold none between settlements).
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit Rescued(address(token), to, amount);
        token.safeTransfer(to, amount);
    }

    /// @notice Withdraws native coin held for callback fees.
    function withdrawNative(uint256 amount, address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit NativeWithdrawn(to, amount);
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
    }

    /// @notice Zero sends tax to the treasury. Anything else must be a contract: `try` cannot catch a call to an
    /// address with no code, so an EOA here would make every settlement revert.
    function setReserve(IReserve reserve_) external onlyOwner {
        if (address(reserve_) != address(0) && address(reserve_).code.length == 0) {
            revert NotAContract(address(reserve_));
        }
        reserve = reserve_;
        emit ReserveSet(address(reserve_));
    }

    function setReceiptIssuer(IReceiptIssuer issuer_) external onlyOwner {
        if (address(issuer_) != address(0) && address(issuer_).code.length == 0) revert NotAContract(address(issuer_));
        receiptIssuer = issuer_;
        emit ReceiptIssuerSet(address(issuer_));
    }

    /// @notice Enables a token on this till with a per-settlement cap, or disables it with zero.
    function setMaxSettlement(IERC20 token, uint256 cap) external onlyOwner {
        maxSettlement[address(token)] = cap;
        emit MaxSettlementSet(address(token), cap);
    }

    /// @notice Disabled: without an owner a paused till could never be unpaused or swept.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Settles callback proxy debt from this contract's balance. Open to anyone so a third party can
    /// revive a stalled till by sending native coin and calling this.
    function coverDebt() external {
        _coverDebt();
    }

    // ---------------------------------------------------------------- internals

    function _distribute(uint256 invoiceId, address token, uint256 amount, uint256 excess, SplitPolicy calldata policy)
        internal
    {
        (uint256 tax, uint256[] memory team, uint256 toTreasury) = DaybookLib.split(amount, policy);
        toTreasury += excess;

        if (tax > 0) {
            if (_depositTax(invoiceId, token, tax)) {
                emit Payout(invoiceId, token, address(reserve), tax, ROLE_TAX);
            } else {
                emit PayoutRedirected(invoiceId, token, address(reserve), tax);
                toTreasury += tax;
            }
        }
        for (uint256 i; i < team.length; ++i) {
            if (team[i] == 0) continue;
            address to = policy.team[i].account;
            if (_tryTransfer(token, to, team[i])) {
                emit Payout(invoiceId, token, to, team[i], ROLE_TEAM);
            } else {
                emit PayoutRedirected(invoiceId, token, to, team[i]);
                toTreasury += team[i];
            }
        }
        if (toTreasury > 0) {
            emit Payout(invoiceId, token, policy.treasury, toTreasury, ROLE_TREASURY);
            IERC20(token).safeTransfer(policy.treasury, toTreasury);
        }
    }

    function _ack(uint256 invoiceId, uint256 seq, address token, uint256 amount, uint256 excess, address payer)
        internal
    {
        emit Settled(invoiceId, seq, token, amount, excess, payer, block.chainid, receiptUidOf[invoiceId][seq]);
    }

    /// @dev A team payout that fails (for example a blocklisted recipient) is redirected to the treasury
    /// rather than reverting, because a revert here would block the whole invoice forever.
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return token.code.length > 0;
        return ret.length >= 32 && abi.decode(ret, (bool));
    }

    /// @dev A reserve that reverts is bypassed (tax goes to the treasury with an event) so it cannot block
    /// settlement. A reserve that succeeds but pulls a different amount is a broken integration and reverts.
    function _depositTax(uint256 invoiceId, address token, uint256 tax) internal returns (bool ok) {
        IReserve r = reserve;
        if (address(r).code.length == 0) return false;
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).forceApprove(address(r), tax);
        try r.deposit(token, tax, invoiceId) {
            uint256 pulled = before - IERC20(token).balanceOf(address(this));
            if (pulled != tax) revert ReserveMismatch(pulled, tax);
            ok = true;
        } catch {
            ok = false;
        }
        IERC20(token).forceApprove(address(r), 0);
    }

    /// @dev Low-level call so that no failure of the issuer, including a missing contract or a short or malformed
    /// return, can revert settlement. Only a 32-byte return is taken as the receipt UID.
    function _issueReceipt(uint256 invoiceId, uint256 seq, address payer, address token, uint256 amount)
        internal
        returns (bytes32 uid)
    {
        address issuer = address(receiptIssuer);
        if (issuer != address(0)) {
            bool ok = false;
            uint256 size = 0;
            bytes32 out = bytes32(0);
            if (issuer.code.length != 0) {
                bytes memory data = abi.encodeCall(IReceiptIssuer.issue, (invoiceId, seq, payer, token, amount));
                uint256 budget = RECEIPT_GAS;
                assembly ("memory-safe") {
                    // Copy at most 32 bytes back, so a hostile issuer cannot make us pay for a huge return.
                    ok := call(budget, issuer, 0, add(data, 0x20), mload(data), 0x00, 0x20)
                    size := returndatasize()
                    out := mload(0x00)
                }
            }
            if (ok && size == 32) uid = out;
            else emit ReceiptFailed(invoiceId, seq, gasleft());
        }
        emit Receipt(invoiceId, seq, payer, token, amount, uid);
    }
}
