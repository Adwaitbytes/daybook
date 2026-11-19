// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { AcceptedToken, DaybookLib, Recipient, SplitPolicy } from "./DaybookTypes.sol";
import { IDaybookTill } from "./interfaces/IDaybookTill.sol";

/// @title DaybookReactive
/// @notice Invoice registry and ledger on Reactive Network. The owner creates an invoice here; the contract
/// watches the invoice's pay address on every accepted chain, matches incoming transfers, keeps the ledger,
/// and when the invoice is covered asks the till on each chain that holds funds to settle them. The till's
/// `Settled` event comes back here as the acknowledgement; a missing acknowledgement is resent on a cron tick.
///
/// @dev Delivery is treated as at least once and possibly out of order: every origin log is deduplicated by
/// (chainId, txHash, logIndex), every settlement carries a sequence number, and the till is idempotent per
/// (invoiceId, seq). `react()` never reverts to filter; it returns early.
contract DaybookReactive is AbstractReactive, Ownable2Step {
    // ------------------------------------------------------------------ types

    enum InvoiceStatus {
        None,
        Open,
        Paid,
        Settled,
        Cancelled,
        Expired
    }

    enum EntryKind {
        Payment, // accepted token while open, counted toward the invoice (any overpayment part is `excess`)
        Late, // accepted token after the invoice was covered: all excess, forwarded to the treasury
        Orphaned, // accepted token after cancellation or expiry: all excess, forwarded to the treasury
        WrongToken // token or chain not accepted for this invoice: flagged, left in the pay address
    }

    enum SettlementStatus {
        None,
        Pending,
        Acked,
        Stuck,
        Resolved
    }

    struct Invoice {
        address payAddress;
        uint64 dueAt;
        uint32 policyId;
        uint64 expiresAt;
        uint64 createdAt;
        InvoiceStatus status;
        bool overdue;
        bool watchAllTokens;
        uint16 openSettlements;
        uint256 amount;
        uint256 paid;
        bytes32 detailsHash;
    }

    struct CreateInvoiceParams {
        uint256 amount; // in INVOICE_DECIMALS units (micro-dollars for USD stablecoins)
        uint64 dueAt; // 0 = no due date
        uint64 expiresAt; // 0 = never expires
        uint32 policyId;
        // false (the default): watch accepted tokens only. true: watch every token sent to the pay address on each
        // accepted chain, so wrong-token payments are flagged; narrows itself to accepted tokens once the flag
        // budget is spent, because every matching log is a billed reaction.
        bool watchAllTokens;
        bytes32 detailsHash;
        AcceptedToken[] accepted;
    }

    /// @notice Six subscription criteria kept together so subscribe and unsubscribe can never drift.
    struct Sub {
        uint256 chainId;
        address contractAddr;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
    }

    struct PairState {
        uint128 counted; // raw token units counted toward the invoice, not yet sent for settlement
        uint128 excess; // raw token units beyond the invoice amount, not yet sent for settlement
        // Receipt payer: the sender of the largest single transfer counted on this pair, so a one-unit transfer
        // cannot take the receipt for someone else's payment.
        address topPayer;
        uint96 topAmount;
    }

    struct LedgerEntry {
        address token;
        uint64 chainId;
        EntryKind kind;
        address payer;
        uint64 invoiceId;
        uint32 logIndex;
        uint128 amount;
        uint128 excess;
        uint256 txHash;
    }

    /// @dev Two storage slots. Chain and token come from the invoice's accepted pair, the receipt payer from
    /// the pair's latest payer at send time; keeping them out of storage keeps a multi-chain cover under the
    /// reactive gas cap.
    struct Settlement {
        uint64 invoiceId;
        uint64 lastSentAt;
        uint32 pendingIndex; // 1-based position in the pending queue, 0 when not queued
        uint8 pairIndex;
        uint8 attempts;
        SettlementStatus status;
        uint128 amount;
        uint128 excess;
    }

    struct SettlementView {
        uint256 invoiceId;
        uint256 chainId;
        address token;
        uint256 amount;
        uint256 excess;
        uint64 lastSentAt;
        uint8 attempts;
        SettlementStatus status;
    }

    // -------------------------------------------------------------- constants

    uint256 internal constant TRANSFER_TOPIC = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;
    // Literal signatures because event selectors are not compile-time constants; a test pins them to the interface.
    uint256 internal constant SETTLED_TOPIC =
        uint256(keccak256("Settled(uint256,uint256,address,uint256,uint256,address,uint256,bytes32)"));
    uint256 internal constant MANUAL_SWEEP_TOPIC = uint256(keccak256("ManualSweep(uint256,address,address,uint256)"));

    address internal constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
    uint256 internal constant CRON1 = 0xf02d6ea5c22a71cffe930a4523fcb4f129be6c804db50e4202fb4e0b07ccb514;
    uint256 internal constant CRON10 = 0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687;
    uint256 internal constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 internal constant CRON1000 = 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4;
    uint256 internal constant CRON10000 = 0xd214e1d84db704ed42d37f538ea9bf71e44ba28bc1cc088b2f5deca654677a56;

    /// @notice Decimals of the invoice amount. Token amounts are normalized to this before comparison.
    uint8 public constant INVOICE_DECIMALS = 6;
    /// @notice Accepted (chain, token) pairs per invoice. Bounds every per-invoice loop.
    uint256 public constant MAX_ACCEPTED = 8;
    /// @notice Gas kept in hand before starting another settlement request inside one reactive transaction.
    /// When less is left, the rest of the invoice's balances are requested on the next cron tick instead, so a
    /// cover with many funded chains never runs into the 900k reactive gas cap.
    uint256 public constant GAS_RESERVE = 320_000;
    /// @notice Gas kept in hand while a manual-sweep acknowledgement walks the pending queue.
    uint256 internal constant SWEEP_SCAN_RESERVE = 100_000;
    /// @notice Flagged wrong-token entries kept per invoice. Beyond it inflows are only counted, which bounds
    /// what spam sent to a public pay address can cost.
    uint256 public constant MAX_FLAGGED = 16;
    /// @notice Items handled per cron tick for each queue, to stay well under the reactive gas cap.
    uint256 public constant MAX_CRON_WORK = 8;
    /// @notice Sends of one settlement (first send plus resends) before it is marked stuck.
    uint8 public constant MAX_ATTEMPTS = 5;
    uint64 public constant MIN_CALLBACK_GAS = 100_000;
    uint64 public constant MIN_RESEND_AFTER = 60;

    // ------------------------------------------------------------- immutables

    /// @notice Pay address factory, at the same address on every payment chain.
    address public immutable FACTORY;
    /// @notice The vault implementation the factory deploys with its first CREATE.
    address public immutable VAULT_IMPLEMENTATION;
    /// @notice Cron topic used while timed work is pending.
    uint256 public immutable CRON_TOPIC;

    // ------------------------------------------------------------------ state

    uint64 public callbackGasLimit = 1_300_000;
    uint64 public resendAfter = 300;
    bool public cronActive;

    uint256 public nextInvoiceId;
    uint256 public nextSeq;
    uint32 public nextPolicyId;

    mapping(uint256 chainId => address till) public tillOf;
    mapping(uint32 policyId => SplitPolicy) internal _policies;

    mapping(uint256 invoiceId => Invoice) internal _invoices;
    mapping(uint256 invoiceId => AcceptedToken[]) internal _accepted;
    mapping(uint256 invoiceId => mapping(uint256 pairIndex => PairState)) internal _pairs;
    mapping(address payAddress => uint256 invoiceId) public invoiceOfPayAddress;

    /// @notice Origin logs already processed, keyed by keccak256(chainId, txHash, logIndex).
    mapping(bytes32 key => bool) public seen;
    mapping(uint256 invoiceId => uint256) public flaggedCount;
    mapping(uint256 invoiceId => uint256) public droppedFlags;
    /// @notice Receipt payer pinned for a late or orphaned settlement (the sender of that one transfer). Zero for
    /// settlements made when an invoice closes: those use the pair's top payer, which cannot change once the
    /// invoice is no longer open, so resends always name the same payer.
    mapping(uint256 seq => address) internal _receiptPayerOverride;
    /// @dev Open (unacknowledged, unresolved, stuck included) settlements per chain, stored plus one once a till is
    /// registered so the counter never pays a zero-to-nonzero write on the reaction path.
    mapping(uint256 chainId => uint256) internal _openOnChainPlusOne;
    /// @notice Largest invoice amount (INVOICE_DECIMALS units) the owner may issue; mirrors the tills' caps.
    uint256 public maxInvoiceAmount = 10_000e6;

    LedgerEntry[] internal _ledger;
    mapping(uint256 seq => Settlement) internal _settlements;

    uint256[] internal _pending;
    IdSet.Set internal _timed; // open invoices with a due or expiry time
    IdSet.Set internal _closing; // closed invoices whose balances are not all sent for settlement yet
    uint256 internal _pendingCursor;
    uint256 internal _timedCursor;

    // ----------------------------------------------------------------- events

    event PolicyCreated(uint32 indexed policyId, address treasury, uint16 taxBps, Recipient[] team);
    event TillSet(uint256 indexed chainId, address indexed till);
    event InvoiceCreated(
        uint256 indexed invoiceId,
        address indexed payAddress,
        uint256 amount,
        uint64 dueAt,
        uint64 expiresAt,
        uint32 policyId,
        bool watchAllTokens,
        bytes32 detailsHash,
        AcceptedToken[] accepted
    );
    event SubscriptionChanged(
        uint256 chainId,
        address contractAddr,
        uint256 topic0,
        uint256 topic1,
        uint256 topic2,
        uint256 topic3,
        bool active
    );
    event LedgerRecorded(
        uint256 indexed index,
        uint256 indexed invoiceId,
        EntryKind indexed kind,
        uint256 chainId,
        address token,
        address payer,
        uint256 amount,
        uint256 excess,
        uint256 txHash,
        uint256 logIndex
    );
    event FlagDropped(uint256 indexed invoiceId, uint256 chainId, address token, uint256 amount);
    event DuplicateDelivery(uint256 indexed invoiceId, uint256 chainId, uint256 txHash, uint256 logIndex);
    event InvoicePaid(uint256 indexed invoiceId);
    event InvoiceSettled(uint256 indexed invoiceId);
    event InvoiceOverdue(uint256 indexed invoiceId);
    event InvoiceCancelled(uint256 indexed invoiceId);
    event InvoiceExpired(uint256 indexed invoiceId);
    event SettlementRequested(
        uint256 indexed seq,
        uint256 indexed invoiceId,
        uint256 chainId,
        address token,
        uint256 amount,
        uint256 excess,
        uint8 attempt
    );
    event SettlementAcked(uint256 indexed seq, uint256 indexed invoiceId);
    event SettlementStuck(uint256 indexed seq, uint256 indexed invoiceId);
    event SettlementResolved(uint256 indexed seq, uint256 indexed invoiceId);
    event PairBalanceCleared(
        uint256 indexed invoiceId, uint256 chainId, address token, uint256 counted, uint256 excess
    );
    event CronActive(bool active);
    event CallbackGasLimitSet(uint64 gasLimit);
    event ResendAfterSet(uint64 secondsAfter);
    event NativeWithdrawn(address indexed to, uint256 amount);
    event WatchNarrowed(uint256 indexed invoiceId);
    event OwnerRecorded(uint256 indexed invoiceId, uint256 chainId, uint256 txHash, uint256 logIndex);
    event MaxInvoiceAmountSet(uint256 amount);

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error BadCronTopic();
    error UnknownPolicy(uint32 policyId);
    error NoTill(uint256 chainId);
    error BadAccepted();
    error DuplicatePair(uint256 chainId, address token);
    error BadDecimals(uint8 decimals);
    error BadTimes();
    error NotOpen(uint256 invoiceId);
    error NotStuck(uint256 seq);
    error NotOutstanding(uint256 seq);
    error GasLimitTooLow(uint64 gasLimit);
    error ResendTooSoon(uint64 secondsAfter);
    error NativeTransferFailed();
    error OverInvoiceCap(uint256 amount, uint256 cap);
    error OpenSettlementsOnChain(uint256 chainId, uint256 open);
    error NotRecordable();
    error RenounceDisabled();

    // ------------------------------------------------------------ constructor

    /// @param owner_ Owner who creates invoices and policies.
    /// @param factory_ `PayAddressFactory` address (identical on every payment chain).
    /// @param cronTopic_ One of the five documented cron topics; Cron100 (about two minutes) on mainnet.
    constructor(address owner_, address factory_, uint256 cronTopic_) payable Ownable(owner_) {
        if (factory_ == address(0)) revert ZeroAddress();
        if (
            cronTopic_ != CRON1 && cronTopic_ != CRON10 && cronTopic_ != CRON100 && cronTopic_ != CRON1000
                && cronTopic_ != CRON10000
        ) revert BadCronTopic();
        FACTORY = factory_;
        // The implementation is the factory's first CREATE (contract nonces start at 1, EIP-161).
        VAULT_IMPLEMENTATION = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), factory_, bytes1(0x01)))))
        );
        CRON_TOPIC = cronTopic_;
    }

    // ------------------------------------------------------------------ react

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.topic0 == TRANSFER_TOPIC) {
            // ERC-721 Transfer shares topic0 but has four topics; ERC-20 has three.
            if (log_.opCode != 3) return;
            _onTransfer(log_);
        } else if (log_.topic0 == CRON_TOPIC) {
            if (log_.contractAddress != CRON_EMITTER || log_.chainId != block.chainid) return;
            _runScheduledWork();
        } else if (log_.topic0 == SETTLED_TOPIC) {
            if (log_.opCode != 4 || log_.contractAddress != tillOf[log_.chainId]) return;
            _onSettled(log_);
        } else if (log_.topic0 == MANUAL_SWEEP_TOPIC) {
            if (log_.opCode != 4 || log_.contractAddress != tillOf[log_.chainId]) return;
            if (log_.data.length != 32) return;
            _onManualSweep(log_.chainId, log_.topic1, address(uint160(log_.topic2)), abi.decode(log_.data, (uint256)));
        }
    }

    // ------------------------------------------------------------ owner admin

    /// @notice Registers an immutable split policy. Policies are never edited, so an invoice's terms cannot
    /// change after it is issued; create a new policy instead.
    function createPolicy(address treasury, uint16 taxBps, Recipient[] calldata team)
        external
        onlyOwner
        returns (uint32 policyId)
    {
        SplitPolicy memory p = SplitPolicy({ treasury: treasury, taxBps: taxBps, team: team });
        DaybookLib.validate(p);
        policyId = ++nextPolicyId;
        SplitPolicy storage s = _policies[policyId];
        s.treasury = treasury;
        s.taxBps = taxBps;
        for (uint256 i; i < team.length; ++i) {
            s.team.push(team[i]);
        }
        emit PolicyCreated(policyId, treasury, taxBps, team);
    }

    /// @notice Sets (or clears, with zero) the till on a payment chain and moves the acknowledgement
    /// subscriptions with it.
    function setTill(uint256 chainId, address till) external onlyOwner {
        if (chainId == 0) revert BadAccepted();
        uint256 open = openSettlementsOn(chainId);
        if (open != 0) revert OpenSettlementsOnChain(chainId, open);
        if (_openOnChainPlusOne[chainId] == 0) _openOnChainPlusOne[chainId] = 1;
        address old = tillOf[chainId];
        if (old != address(0)) {
            _unsubscribe(_tillSub(chainId, old, SETTLED_TOPIC));
            _unsubscribe(_tillSub(chainId, old, MANUAL_SWEEP_TOPIC));
        }
        tillOf[chainId] = till;
        if (till != address(0)) {
            _subscribe(_tillSub(chainId, till, SETTLED_TOPIC));
            _subscribe(_tillSub(chainId, till, MANUAL_SWEEP_TOPIC));
        }
        emit TillSet(chainId, till);
    }

    /// @notice Creates an invoice and starts watching its pay address on every accepted chain.
    function createInvoice(CreateInvoiceParams calldata p) external onlyOwner returns (uint256 invoiceId) {
        if (p.amount == 0) revert ZeroAmount();
        if (p.amount > maxInvoiceAmount) revert OverInvoiceCap(p.amount, maxInvoiceAmount);
        if (_policies[p.policyId].treasury == address(0)) revert UnknownPolicy(p.policyId);
        if (p.expiresAt != 0 && (p.expiresAt <= block.timestamp || (p.dueAt != 0 && p.expiresAt < p.dueAt))) {
            revert BadTimes();
        }
        if (p.dueAt != 0 && p.dueAt <= block.timestamp) revert BadTimes();
        uint256 n = p.accepted.length;
        if (n == 0 || n > MAX_ACCEPTED) revert BadAccepted();

        invoiceId = ++nextInvoiceId;
        address pay = payAddressOf(invoiceId);
        AcceptedToken[] storage acc = _accepted[invoiceId];
        for (uint256 i; i < n; ++i) {
            AcceptedToken calldata a = p.accepted[i];
            if (a.token == address(0) || a.chainId == 0) revert BadAccepted();
            if (a.decimals > 30) revert BadDecimals(a.decimals);
            if (tillOf[a.chainId] == address(0)) revert NoTill(a.chainId);
            for (uint256 j; j < i; ++j) {
                if (p.accepted[j].chainId == a.chainId && p.accepted[j].token == a.token) {
                    revert DuplicatePair(a.chainId, a.token);
                }
            }
            acc.push(a);
        }

        _invoices[invoiceId] = Invoice({
            payAddress: pay,
            dueAt: p.dueAt,
            policyId: p.policyId,
            expiresAt: p.expiresAt,
            createdAt: uint64(block.timestamp),
            status: InvoiceStatus.Open,
            overdue: false,
            watchAllTokens: p.watchAllTokens,
            openSettlements: 0,
            amount: p.amount,
            paid: 0,
            detailsHash: p.detailsHash
        });
        invoiceOfPayAddress[pay] = invoiceId;
        emit InvoiceCreated(
            invoiceId, pay, p.amount, p.dueAt, p.expiresAt, p.policyId, p.watchAllTokens, p.detailsHash, p.accepted
        );

        _subscribeInvoice(invoiceId);
        if (p.dueAt != 0 || p.expiresAt != 0) IdSet.add(_timed, invoiceId);
        _syncCron();
    }

    /// @notice Cancels an open invoice. Funds already received are forwarded to the treasury as excess (not
    /// split), so nothing stays in the pay address; refunds are the owner's call.
    function cancel(uint256 invoiceId) external onlyOwner {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status != InvoiceStatus.Open) revert NotOpen(invoiceId);
        inv.status = InvoiceStatus.Cancelled;
        emit InvoiceCancelled(invoiceId);
        _close(invoiceId);
        _syncCron();
    }

    /// @notice Puts a stuck settlement back in the resend queue and sends it now.
    function retrySettlement(uint256 seq) external onlyOwner {
        Settlement storage s = _settlements[seq];
        if (s.status != SettlementStatus.Stuck) revert NotStuck(seq);
        s.status = SettlementStatus.Pending;
        s.attempts = 0;
        _pendingAdd(seq);
        _send(seq);
        _syncCron();
    }

    /// @notice Marks a pending or stuck settlement as handled by hand (for example after an owner sweep whose
    /// acknowledgement was lost), so it stops counting against the invoice.
    function resolveSettlement(uint256 seq) external onlyOwner {
        Settlement storage s = _settlements[seq];
        if (s.status != SettlementStatus.Pending && s.status != SettlementStatus.Stuck) revert NotOutstanding(seq);
        _resolve(seq, s);
        _syncCron();
    }

    /// @notice Records a Transfer whose delivery was missed (for example while the contract was in debt). It goes
    /// through the same dedupe key as `react()`, so if the log does arrive later it is a harmless duplicate. The
    /// owner is the payee, so this adds no trust a payer does not already extend; `OwnerRecorded` lets a
    /// verifier check each such entry against the origin chain.
    function recordMissedTransfer(LogRecord calldata log_) external onlyOwner {
        if (log_.topic0 != TRANSFER_TOPIC || log_.opCode != 3 || log_.data.length != 32) revert NotRecordable();
        uint256 invoiceId = invoiceOfPayAddress[address(uint160(log_.topic2))];
        if (invoiceId == 0 || seen[keccak256(abi.encode(log_.chainId, log_.txHash, log_.logIndex))]) {
            revert NotRecordable();
        }
        emit OwnerRecorded(invoiceId, log_.chainId, log_.txHash, log_.logIndex);
        _onTransfer(log_);
    }

    /// @notice Sets the largest invoice amount that may be issued. Keep it at or below every till's cap.
    function setMaxInvoiceAmount(uint256 amount) external onlyOwner {
        if (amount == 0 || amount > type(uint128).max) revert ZeroAmount();
        maxInvoiceAmount = amount;
        emit MaxInvoiceAmountSet(amount);
    }

    /// @notice Disabled: losing the owner would strand invoices and stuck settlements for good.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function setCallbackGasLimit(uint64 gasLimit) external onlyOwner {
        if (gasLimit < MIN_CALLBACK_GAS) revert GasLimitTooLow(gasLimit);
        callbackGasLimit = gasLimit;
        emit CallbackGasLimitSet(gasLimit);
    }

    function setResendAfter(uint64 secondsAfter) external onlyOwner {
        if (secondsAfter < MIN_RESEND_AFTER) revert ResendTooSoon(secondsAfter);
        resendAfter = secondsAfter;
        emit ResendAfterSet(secondsAfter);
    }

    function withdrawNative(uint256 amount, address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit NativeWithdrawn(to, amount);
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
    }

    /// @notice Settles system contract debt from this contract's balance. Open to anyone so a third party can
    /// revive a stalled contract.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice Runs the same scheduled work as a cron tick (overdue, expiry, resends). Permissionless re-poke for
    /// when cron delivery is degraded; every action is time-gated so calling it early does nothing.
    function poke() external {
        _runScheduledWork();
    }

    // ------------------------------------------------------------------ views

    /// @notice The pay address of an invoice: identical on every chain where the factory is deployed.
    function payAddressOf(uint256 invoiceId) public view returns (address) {
        return
            Clones.predictDeterministicAddress(VAULT_IMPLEMENTATION, DaybookLib.salt(address(this), invoiceId), FACTORY);
    }

    /// @notice Everything a health page needs to judge how long this contract keeps running: its own balance,
    /// reserves and debt at the system contract (any debt stops all reactions), and the work holding cron.
    function runway()
        external
        view
        returns (
            uint256 balance,
            uint256 reserves,
            uint256 debt,
            bool cron,
            uint256 pending,
            uint256 timed,
            uint256 closing
        )
    {
        balance = address(this).balance;
        (bool ok, bytes memory ret) =
            address(SYSTEM).staticcall(abi.encodeWithSignature("reserves(address)", address(this)));
        if (ok && ret.length == 32) reserves = abi.decode(ret, (uint256));
        debt = SYSTEM.debt(address(this));
        return (balance, reserves, debt, cronActive, _pending.length, _timed.items.length, _closing.items.length);
    }

    /// @notice Settlements on a chain not yet acknowledged or resolved, stuck ones included. `setTill` is refused
    /// while this is non-zero, so an in-flight settlement is never answered by, or re-run on, a different till.
    function openSettlementsOn(uint256 chainId) public view returns (uint256) {
        uint256 v = _openOnChainPlusOne[chainId];
        return v == 0 ? 0 : v - 1;
    }

    /// @notice The payer named on a settlement's receipt (fixed for the settlement's lifetime).
    function receiptPayerOf(uint256 seq) public view returns (address) {
        address o = _receiptPayerOverride[seq];
        if (o != address(0)) return o;
        Settlement storage s = _settlements[seq];
        return _pairs[s.invoiceId][s.pairIndex].topPayer;
    }

    function getInvoice(uint256 invoiceId) external view returns (Invoice memory) {
        return _invoices[invoiceId];
    }

    function acceptedOf(uint256 invoiceId) external view returns (AcceptedToken[] memory) {
        return _accepted[invoiceId];
    }

    function subscriptionsOf(uint256 invoiceId) external view returns (Sub[] memory) {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status != InvoiceStatus.Open) return new Sub[](0);
        return _invoiceSubs(invoiceId, inv.watchAllTokens);
    }

    function pairState(uint256 invoiceId, uint256 pairIndex) external view returns (PairState memory) {
        return _pairs[invoiceId][pairIndex];
    }

    function getPolicy(uint32 policyId) external view returns (SplitPolicy memory) {
        return _policies[policyId];
    }

    function getSettlement(uint256 seq) external view returns (SettlementView memory v) {
        Settlement storage s = _settlements[seq];
        if (s.status == SettlementStatus.None) return v;
        AcceptedToken storage a = _accepted[s.invoiceId][s.pairIndex];
        v = SettlementView({
            invoiceId: s.invoiceId,
            chainId: a.chainId,
            token: a.token,
            amount: s.amount,
            excess: s.excess,
            lastSentAt: s.lastSentAt,
            attempts: s.attempts,
            status: s.status
        });
    }

    function ledgerLength() external view returns (uint256) {
        return _ledger.length;
    }

    function ledgerEntry(uint256 index) external view returns (LedgerEntry memory) {
        return _ledger[index];
    }

    function pendingSeqs() external view returns (uint256[] memory) {
        return _pending;
    }

    function timedInvoices() external view returns (uint256[] memory) {
        return _timed.items;
    }

    function closingInvoices() external view returns (uint256[] memory) {
        return _closing.items;
    }

    // -------------------------------------------------------------- transfers

    function _onTransfer(LogRecord calldata log_) internal {
        uint256 invoiceId = invoiceOfPayAddress[address(uint160(log_.topic2))];
        if (invoiceId == 0 || log_.data.length != 32) return;
        uint256 value = abi.decode(log_.data, (uint256));
        // Zero-value transfers are the address-poisoning pattern; they move nothing, so they are not recorded.
        if (value == 0) return;

        bytes32 key = keccak256(abi.encode(log_.chainId, log_.txHash, log_.logIndex));
        if (seen[key]) {
            emit DuplicateDelivery(invoiceId, log_.chainId, log_.txHash, log_.logIndex);
            return;
        }
        seen[key] = true;

        address payer = address(uint160(log_.topic1));
        (bool found, uint256 pairIndex) = _findPair(invoiceId, log_.chainId, log_.contractAddress);
        // Accepted-token values above uint96 (8e28 raw units) cannot be real stablecoin payments; flag them.
        if (!found || value > type(uint96).max) {
            _flagWrongToken(invoiceId, log_, payer, value);
            return;
        }

        Invoice storage inv = _invoices[invoiceId];
        PairState storage pair = _pairs[invoiceId][pairIndex];

        if (inv.status == InvoiceStatus.Open) {
            if (value > pair.topAmount) {
                pair.topPayer = payer;
                pair.topAmount = uint96(value);
            }
            uint8 decimals = _accepted[invoiceId][pairIndex].decimals;
            (uint256 counted, uint256 excess, uint256 credit) = _apply(inv.amount - inv.paid, value, decimals);
            inv.paid += credit;
            pair.counted += uint128(counted);
            pair.excess += uint128(excess);
            _record(invoiceId, log_, payer, EntryKind.Payment, value, excess);
            if (inv.paid >= inv.amount) _onCovered(invoiceId);
        } else {
            // Covered, cancelled or expired: this money is not invoice income. Forward it to the treasury now
            // so it never sits in the pay address.
            EntryKind kind = (inv.status == InvoiceStatus.Paid || inv.status == InvoiceStatus.Settled)
                ? EntryKind.Late
                : EntryKind.Orphaned;
            _record(invoiceId, log_, payer, kind, value, value);
            // This settlement is for this one transfer, so its receipt goes to its sender.
            _requestSettlement(invoiceId, pairIndex, 0, value, payer);
        }
        _syncCron();
    }

    /// @notice Splits a raw transfer into the part that counts toward the invoice and the excess.
    /// @param remaining Outstanding invoice amount in INVOICE_DECIMALS units.
    /// @return counted Raw units that count toward the invoice.
    /// @return excess Raw units beyond the invoice amount.
    /// @return credit INVOICE_DECIMALS units credited to `paid` (never more than `remaining`).
    function _apply(uint256 remaining, uint256 value, uint8 decimals)
        internal
        pure
        returns (uint256 counted, uint256 excess, uint256 credit)
    {
        uint256 normalized = decimals >= INVOICE_DECIMALS
            ? value / 10 ** (decimals - INVOICE_DECIMALS)
            : value * 10 ** (INVOICE_DECIMALS - decimals);
        if (normalized < remaining) return (value, 0, normalized);
        // The smallest raw amount worth at least `remaining`; for coarser tokens this rounds up by design.
        counted = decimals >= INVOICE_DECIMALS
            ? remaining * 10 ** (decimals - INVOICE_DECIMALS)
            : (remaining + 10 ** (INVOICE_DECIMALS - decimals) - 1) / 10 ** (INVOICE_DECIMALS - decimals);
        excess = value - counted;
        credit = remaining;
    }

    function _flagWrongToken(uint256 invoiceId, LogRecord calldata log_, address payer, uint256 value) internal {
        if (flaggedCount[invoiceId] >= MAX_FLAGGED) {
            ++droppedFlags[invoiceId];
            emit FlagDropped(invoiceId, log_.chainId, log_.contractAddress, value);
            return;
        }
        uint256 flagged = ++flaggedCount[invoiceId];
        uint128 clipped = value > type(uint128).max ? type(uint128).max : uint128(value);
        _record(invoiceId, log_, payer, EntryKind.WrongToken, clipped, 0);
        if (flagged == MAX_FLAGGED) _narrowWatch(invoiceId);
    }

    /// @dev Every log matching a subscription is a billed reaction, and anyone can emit Transfer-shaped logs
    /// naming a public pay address. Once the flag budget is spent, an all-token watch drops to accepted tokens
    /// only, which caps what spam can cost an invoice at MAX_FLAGGED reactions.
    function _narrowWatch(uint256 invoiceId) internal {
        Invoice storage inv = _invoices[invoiceId];
        if (!inv.watchAllTokens || inv.status != InvoiceStatus.Open) return;
        _unsubscribeInvoice(invoiceId);
        inv.watchAllTokens = false;
        _subscribeInvoice(invoiceId);
        emit WatchNarrowed(invoiceId);
    }

    function _record(
        uint256 invoiceId,
        LogRecord calldata log_,
        address payer,
        EntryKind kind,
        uint256 amount,
        uint256 excess
    ) internal {
        uint256 index = _ledger.length;
        _ledger.push(
            LedgerEntry({
                token: log_.contractAddress,
                chainId: uint64(log_.chainId),
                kind: kind,
                payer: payer,
                invoiceId: uint64(invoiceId),
                logIndex: uint32(log_.logIndex),
                amount: uint128(amount),
                excess: uint128(excess),
                txHash: log_.txHash
            })
        );
        emit LedgerRecorded(
            index,
            invoiceId,
            kind,
            log_.chainId,
            log_.contractAddress,
            payer,
            amount,
            excess,
            log_.txHash,
            log_.logIndex
        );
    }

    function _findPair(uint256 invoiceId, uint256 chainId, address token) internal view returns (bool, uint256) {
        AcceptedToken[] storage acc = _accepted[invoiceId];
        uint256 n = acc.length;
        for (uint256 i; i < n; ++i) {
            if (acc[i].chainId == chainId && acc[i].token == token) return (true, i);
        }
        return (false, 0);
    }

    // ------------------------------------------------------- invoice closure

    function _onCovered(uint256 invoiceId) internal {
        _invoices[invoiceId].status = InvoiceStatus.Paid;
        emit InvoicePaid(invoiceId);
        _close(invoiceId);
    }

    /// @dev Stops watching the invoice and sends every chain's held balance for settlement.
    function _close(uint256 invoiceId) internal {
        _unsubscribeInvoice(invoiceId);
        IdSet.remove(_timed, invoiceId);
        _sendBalances(invoiceId);
    }

    /// @dev Requests settlement of every held pair balance while gas allows; whatever is left waits in the
    /// closing set for the next cron tick. For a paid invoice the counted part is income and is split; after
    /// cancellation or expiry everything goes to the treasury as excess.
    /// @return done Whether every balance has been sent.
    function _sendBalances(uint256 invoiceId) internal returns (bool done) {
        Invoice storage inv = _invoices[invoiceId];
        bool asIncome = inv.status == InvoiceStatus.Paid;
        uint256 n = _accepted[invoiceId].length;
        for (uint256 i; i < n; ++i) {
            PairState storage pair = _pairs[invoiceId][i];
            uint256 counted = pair.counted;
            uint256 excess = pair.excess;
            if (counted == 0 && excess == 0) continue;
            if (gasleft() < GAS_RESERVE) {
                IdSet.add(_closing, invoiceId);
                return false;
            }
            pair.counted = 0;
            pair.excess = 0;
            // The receipt names the pair's top payer, frozen now that the invoice is closed.
            if (asIncome) _requestSettlement(invoiceId, i, counted, excess, address(0));
            else _requestSettlement(invoiceId, i, 0, counted + excess, address(0));
        }
        IdSet.remove(_closing, invoiceId);
        if (inv.status == InvoiceStatus.Paid && inv.openSettlements == 0) _markSettled(invoiceId);
        return true;
    }

    function _markSettled(uint256 invoiceId) internal {
        _invoices[invoiceId].status = InvoiceStatus.Settled;
        emit InvoiceSettled(invoiceId);
    }

    // ------------------------------------------------------------ settlements

    function _requestSettlement(
        uint256 invoiceId,
        uint256 pairIndex,
        uint256 amount,
        uint256 excess,
        address receiptPayerOverride
    ) internal {
        uint256 seq = ++nextSeq;
        if (receiptPayerOverride != address(0)) _receiptPayerOverride[seq] = receiptPayerOverride;
        ++_openOnChainPlusOne[_accepted[invoiceId][pairIndex].chainId];
        _settlements[seq] = Settlement({
            invoiceId: uint64(invoiceId),
            lastSentAt: 0,
            pendingIndex: 0,
            pairIndex: uint8(pairIndex),
            attempts: 0,
            status: SettlementStatus.Pending,
            amount: uint128(amount),
            excess: uint128(excess)
        });
        ++_invoices[invoiceId].openSettlements;
        _pendingAdd(seq);
        _send(seq);
    }

    function _send(uint256 seq) internal {
        Settlement storage s = _settlements[seq];
        s.attempts += 1;
        s.lastSentAt = uint64(block.timestamp);
        uint256 invoiceId = s.invoiceId;
        AcceptedToken memory a = _accepted[invoiceId][s.pairIndex];
        emit SettlementRequested(seq, invoiceId, a.chainId, a.token, s.amount, s.excess, s.attempts);
        bytes memory payload = abi.encodeCall(
            IDaybookTill.settle,
            (
                address(0), // replaced by the system with this contract's address
                invoiceId,
                seq,
                a.token,
                s.amount,
                s.excess,
                receiptPayerOf(seq),
                _policies[_invoices[invoiceId].policyId]
            )
        );
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: a.chainId, recipient: tillOf[a.chainId], gasLimit: callbackGasLimit, payload: payload
            })
        );
    }

    function _onSettled(LogRecord calldata log_) internal {
        uint256 seq = log_.topic2;
        Settlement storage s = _settlements[seq];
        if (s.status != SettlementStatus.Pending && s.status != SettlementStatus.Stuck) return;
        AcceptedToken storage a = _accepted[s.invoiceId][s.pairIndex];
        if (s.invoiceId != log_.topic1 || a.chainId != log_.chainId || a.token != address(uint160(log_.topic3))) {
            return;
        }
        s.status = SettlementStatus.Acked;
        uint256 invoiceId = s.invoiceId;
        emit SettlementAcked(seq, invoiceId);
        _finishSettlement(s, invoiceId);
        _syncCron();
    }

    /// @dev The owner moved `swept` units by hand. Settlements still waiting for this pair are resolved only up to
    /// what was actually moved, then the remainder comes off the held balance; a later transfer that raced the
    /// sweep keeps its own balance. The queue walk is gas-bounded: whatever it cannot reach keeps being resent,
    /// fails against the emptied address and ends Stuck for the owner to resolve.
    function _onManualSweep(uint256 chainId, uint256 invoiceId, address token, uint256 swept) internal {
        if (swept == 0 || _invoices[invoiceId].status == InvoiceStatus.None) return;
        (bool found, uint256 pairIndex) = _findPair(invoiceId, chainId, token);
        if (!found) return;
        uint256 remaining = swept;
        // Walk backwards because resolving removes entries by swap-and-pop.
        for (uint256 i = _pending.length; i > 0 && remaining != 0; --i) {
            if (gasleft() < SWEEP_SCAN_RESERVE) break;
            uint256 seq = _pending[i - 1];
            Settlement storage s = _settlements[seq];
            if (s.invoiceId != invoiceId || s.pairIndex != pairIndex) continue;
            uint256 total = uint256(s.amount) + s.excess;
            if (total > remaining) continue;
            remaining -= total;
            _resolve(seq, s);
        }
        PairState storage pair = _pairs[invoiceId][pairIndex];
        uint256 fromCounted = remaining < pair.counted ? remaining : pair.counted;
        remaining -= fromCounted;
        uint256 fromExcess = remaining < pair.excess ? remaining : pair.excess;
        if (fromCounted != 0 || fromExcess != 0) {
            pair.counted -= uint128(fromCounted);
            pair.excess -= uint128(fromExcess);
            emit PairBalanceCleared(invoiceId, chainId, token, fromCounted, fromExcess);
        }
        _syncCron();
    }

    function _resolve(uint256 seq, Settlement storage s) internal {
        s.status = SettlementStatus.Resolved;
        uint256 invoiceId = s.invoiceId;
        emit SettlementResolved(seq, invoiceId);
        _finishSettlement(s, invoiceId);
    }

    function _finishSettlement(Settlement storage s, uint256 invoiceId) internal {
        _pendingRemove(s);
        --_openOnChainPlusOne[_accepted[invoiceId][s.pairIndex].chainId];
        Invoice storage inv = _invoices[invoiceId];
        --inv.openSettlements;
        if (inv.openSettlements == 0 && inv.status == InvoiceStatus.Paid && !IdSet.contains(_closing, invoiceId)) {
            _markSettled(invoiceId);
        }
    }

    // --------------------------------------------------------- scheduled work

    function _runScheduledWork() internal {
        _processClosing();
        _processTimed();
        _processPending();
        _syncCron();
    }

    function _processClosing() internal {
        uint256[] storage items = _closing.items;
        // Walk backwards: a finished invoice is removed by swap-and-pop.
        for (uint256 i = items.length; i > 0; --i) {
            if (gasleft() < GAS_RESERVE) return;
            if (!_sendBalances(items[i - 1])) return;
        }
    }

    function _processTimed() internal {
        uint256[] storage items = _timed.items;
        uint256 len = items.length;
        if (len == 0) return;
        uint256 work = len < MAX_CRON_WORK ? len : MAX_CRON_WORK;
        uint256 i = _timedCursor % len;
        for (uint256 k; k < work; ++k) {
            if (items.length == 0 || gasleft() < GAS_RESERVE) break;
            if (i >= items.length) i = 0;
            if (!_checkTimed(items[i])) ++i;
        }
        _timedCursor = i;
    }

    /// @return removed Whether the invoice left the timed queue (the caller must not advance its index).
    function _checkTimed(uint256 invoiceId) internal returns (bool removed) {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.expiresAt != 0 && block.timestamp >= inv.expiresAt) {
            inv.status = InvoiceStatus.Expired;
            emit InvoiceExpired(invoiceId);
            _close(invoiceId);
            return true;
        }
        if (inv.dueAt != 0 && !inv.overdue && block.timestamp >= inv.dueAt) {
            inv.overdue = true;
            emit InvoiceOverdue(invoiceId);
            if (inv.expiresAt == 0) {
                IdSet.remove(_timed, invoiceId);
                return true;
            }
        }
        return false;
    }

    function _processPending() internal {
        uint256 len = _pending.length;
        if (len == 0) return;
        uint256 work = len < MAX_CRON_WORK ? len : MAX_CRON_WORK;
        uint256 i = _pendingCursor % len;
        for (uint256 k; k < work; ++k) {
            if (_pending.length == 0 || gasleft() < GAS_RESERVE) break;
            if (i >= _pending.length) i = 0;
            if (!_checkPending(_pending[i])) ++i;
        }
        _pendingCursor = i;
    }

    /// @return removed Whether the settlement left the pending queue.
    function _checkPending(uint256 seq) internal returns (bool removed) {
        Settlement storage s = _settlements[seq];
        if (block.timestamp < uint256(s.lastSentAt) + resendAfter) return false;
        if (s.attempts >= MAX_ATTEMPTS) {
            s.status = SettlementStatus.Stuck;
            emit SettlementStuck(seq, s.invoiceId);
            _pendingRemove(s);
            return true;
        }
        _send(seq);
        return false;
    }

    // ---------------------------------------------------------- subscriptions

    /// @dev An invoice's subscriptions are derived, never stored: from its accepted pairs (immutable), its pay
    /// address (immutable) and its watch mode. Subscribe and unsubscribe both call this with the mode in force,
    /// so the six arguments always match. Watching all tokens needs one subscription per chain; watching
    /// accepted tokens needs one per pair.
    function _invoiceSubs(uint256 invoiceId, bool watchAll) internal view returns (Sub[] memory subs) {
        AcceptedToken[] storage acc = _accepted[invoiceId];
        uint256 pay = uint256(uint160(_invoices[invoiceId].payAddress));
        uint256 n = acc.length;
        subs = new Sub[](n);
        uint256 count = 0;
        for (uint256 i; i < n; ++i) {
            address contractAddr = watchAll ? address(0) : acc[i].token;
            bool dup = false;
            for (uint256 j; j < count; ++j) {
                if (subs[j].chainId == acc[i].chainId && subs[j].contractAddr == contractAddr) dup = true;
            }
            if (dup) continue;
            subs[count++] = Sub({
                chainId: acc[i].chainId,
                contractAddr: contractAddr,
                topic0: TRANSFER_TOPIC,
                topic1: REACTIVE_IGNORE,
                topic2: pay,
                topic3: REACTIVE_IGNORE
            });
        }
        assembly ("memory-safe") {
            mstore(subs, count)
        }
    }

    function _subscribeInvoice(uint256 invoiceId) internal {
        Sub[] memory subs = _invoiceSubs(invoiceId, _invoices[invoiceId].watchAllTokens);
        for (uint256 i; i < subs.length; ++i) {
            _subscribe(subs[i]);
        }
    }

    function _unsubscribeInvoice(uint256 invoiceId) internal {
        Sub[] memory subs = _invoiceSubs(invoiceId, _invoices[invoiceId].watchAllTokens);
        for (uint256 i; i < subs.length; ++i) {
            _unsubscribe(subs[i]);
        }
    }

    function _tillSub(uint256 chainId, address till, uint256 topic0) internal pure returns (Sub memory) {
        return Sub({
            chainId: chainId,
            contractAddr: till,
            topic0: topic0,
            topic1: REACTIVE_IGNORE,
            topic2: REACTIVE_IGNORE,
            topic3: REACTIVE_IGNORE
        });
    }

    function _cronSub() internal view returns (Sub memory) {
        return Sub({
            chainId: block.chainid,
            contractAddr: CRON_EMITTER,
            topic0: CRON_TOPIC,
            topic1: REACTIVE_IGNORE,
            topic2: REACTIVE_IGNORE,
            topic3: REACTIVE_IGNORE
        });
    }

    /// @dev Cron is billed every tick, so it is held only while some invoice has a due or expiry time or some
    /// settlement awaits its acknowledgement.
    function _syncCron() internal {
        bool need = _timed.items.length != 0 || _pending.length != 0 || _closing.items.length != 0;
        if (need == cronActive) return;
        cronActive = need;
        if (need) _subscribe(_cronSub());
        else _unsubscribe(_cronSub());
        emit CronActive(need);
    }

    /// @dev Every subscribe in this contract goes through here, and its twin below, with the same struct.
    function _subscribe(Sub memory s) internal {
        SYSTEM.subscribe(s.chainId, s.contractAddr, s.topic0, s.topic1, s.topic2, s.topic3);
        emit SubscriptionChanged(s.chainId, s.contractAddr, s.topic0, s.topic1, s.topic2, s.topic3, true);
    }

    function _unsubscribe(Sub memory s) internal {
        SYSTEM.unsubscribe(s.chainId, s.contractAddr, s.topic0, s.topic1, s.topic2, s.topic3);
        emit SubscriptionChanged(s.chainId, s.contractAddr, s.topic0, s.topic1, s.topic2, s.topic3, false);
    }

    // ------------------------------------------------------------ index sets

    function _pendingAdd(uint256 seq) internal {
        Settlement storage s = _settlements[seq];
        if (s.pendingIndex != 0) return;
        _pending.push(seq);
        s.pendingIndex = uint32(_pending.length);
    }

    /// @dev Swap-and-pop. When `s` is the last entry the moved index is written to it and then cleared.
    function _pendingRemove(Settlement storage s) internal {
        uint256 idx = s.pendingIndex;
        if (idx == 0) return;
        uint256 last = _pending[_pending.length - 1];
        _pending[idx - 1] = last;
        _settlements[last].pendingIndex = uint32(idx);
        _pending.pop();
        s.pendingIndex = 0;
    }
}

/// @notice Unordered set of ids with O(1) add, remove and membership, used for the cron work queues.
library IdSet {
    struct Set {
        uint256[] items;
        mapping(uint256 id => uint256 indexPlusOne) index;
    }

    function add(Set storage set, uint256 id) internal {
        if (set.index[id] != 0) return;
        set.items.push(id);
        set.index[id] = set.items.length;
    }

    function remove(Set storage set, uint256 id) internal {
        uint256 idx = set.index[id];
        if (idx == 0) return;
        uint256 last = set.items[set.items.length - 1];
        set.items[idx - 1] = last;
        set.index[last] = idx;
        set.items.pop();
        delete set.index[id];
    }

    function contains(Set storage set, uint256 id) internal view returns (bool) {
        return set.index[id] != 0;
    }
}
