# Daybook contracts: security review

Fresh-context adversarial review of `contracts/src` (DaybookReactive, DaybookTill, PayAddressFactory/InvoiceVault, SavingsVault, EasReceiptIssuer, DaybookTypes) against MASTER_PROMPT sections 7 and 9 and the Reactive docs in `ref/reactive-docs`. Reviewed 19 Nov 2026. Source files were not modified.

Proof tests live in `contracts/test/security/`. They assert the *desired* property; they failed on the reviewed code and all pass after the fixes (Resolution lines below). Run them with:

```
forge test --match-path 'test/security/*' -vv
```

`EasReceiptGas.t.sol` forks Base mainnet (`BASE_RPC_URL`, default `https://mainnet.base.org`). Keep the folder out of CI until the fixes land, or flip the tests into regression tests as each fix goes in.

Observed results (19 Nov 2026):

| Test | Result |
|---|---|
| `SpamDrain.t.sol` (H-1) | FAIL: 300 spam logs -> 300 billed reactions (MAX_FLAGGED = 16). 2,047 attacker gas per log on the payment chain; 71,683 gas per reaction plus the system's K = 100,000 surcharge. |
| `LostAck.t.sol` (M-1) | FAIL: funds swept and split, invoice stays `Paid` (2), never `Settled` (3); settlement ends `Stuck`. |
| `ReceiptHijack.t.sol` (M-2) | FAIL (2 tests): a 1-unit sender gets the receipt for the full 1,000 USDC. |
| `EasReceiptGas.t.sol` (M-3) | FAIL: a real EAS attestation on Base mainnet uses 313,995 gas; `RECEIPT_GAS` is 250,000. |

## What holds up

These were attacked and held. No finding.

- **Forged settlement.** `settle` requires `onlyServiceProvider` (callback proxy) and `onlyCallbackSender(rc)` against the immutable reactive address (`DaybookTill.sol:98`). `react()` is `onlySystem` (`DaybookReactive.sol:305`). Acks are accepted only if `log_.contractAddress == tillOf[chainId]` with the right `opCode` (`:313-317`), and `_onSettled` cross-checks invoice, chain and token against the stored settlement (`:761`). A payment can only be counted from a log emitted by the accepted token contract itself (`_findPair` on `log_.contractAddress`), which an attacker cannot impersonate.
- **Replay / double count.** Origin logs are deduplicated on `(chainId, txHash, logIndex)` before any state change (`:546-551`). The till is idempotent per `(invoiceId, seq)` (`:99-102`); seqs are globally unique and pair balances are zeroed before a settlement is created (`:695-696`), so no two settlements cover the same raw units. A settlement only moves `amount + excess` from the pay address; the counted part is capped at the invoice amount (`_apply`, `:590-605`) and the rest is unsplit excess to the treasury.
- **Split arithmetic.** `validate` bounds tax + team at 10,000 bps and five recipients; every share floors and the treasury takes `amount - spent`, so the split sums exactly and cannot underflow (`DaybookTypes.sol:44-73`).
- **Pay-address vault.** `InvoiceVault.sweep` is factory-only; the factory is till-only; the till sweeps only salts namespaced by its own immutable reactive address. Early permissionless `deploy()` changes nothing. A CREATE2 collision attack is not practical: the target set (pay addresses) is not attacker-chosen, so it is a 2^160 preimage, not a 2^80 birthday search.
- **Reentrancy.** `settle`, `sweep`, `sweepNative` are `nonReentrant`; team payouts go through the token (USDC has no hooks); the receipt issuer is gas-bounded and the EAS schema is resolver-less. No reachable reentrant path.
- **Subscription drift.** Every subscribe and unsubscribe goes through `_subscribe`/`_unsubscribe` with the same stored `Sub` struct (`:958-966`); invoice subs are stored and replayed exactly on close (`:916-922`); till ack subs are rebuilt from the same pure helper (`:924-933`).
- **Cron leak.** Cron is held exactly while `_timed`, `_pending` or `_closing` is non-empty (`:948-955`); every path out of those sets (cover, cancel, expiry, overdue without expiry, ack, resolve, stuck) removes the entry. Stuck settlements leave `_pending`, so they do not hold cron.
- **900k reactive gas cap.** Multi-chain covers stop requesting callbacks below `GAS_RESERVE` and defer to `_closing` (`:691-694`); cron queues are bounded to 8 items and gas-checked. One exception, L-5.
- **Mainnet guards.** Per-token settlement cap with zero meaning disabled (`DaybookTill.sol:104-105`), pause on `settle`, owner sweep that works while paused, owner rescue, no proxies or delegatecall upgrade paths anywhere. Gaps: L-3, L-6.

## Findings

### H-1 (High). Anyone can drain the reactive contract's REACT by emitting fake Transfer logs to a public pay address

**Location.** `DaybookReactive.sol:894` (wildcard contract in the default subscription), `:539-558` and `:607-616` (every matching log is processed and billed; `MAX_FLAGGED` bounds storage only). Default is non-strict: `scripts/src/cli.ts:83`, `script/CreateInvoice.s.sol:30`.

**Scenario.** The pay address is public on the pay page. In the default mode the subscription is `(chainId, address(0), Transfer, *, payAddress, *)`, so every Transfer-shaped log from **any contract** on that chain naming the pay address is a reactive transaction billed to DaybookReactive. The attacker deploys a 10-line contract on Base that emits N `Transfer(x, payAddress, 1)` logs in a loop.

- Attacker cost, measured: **2,047 gas per log** on Base. A 30M-gas transaction emits about 14,000 logs; at Base gas prices that is cents.
- Defender cost, measured: **71,683 gas per reaction** on the cheapest path (flag budget exhausted, `seen` SSTORE plus `droppedFlags` SSTORE plus event), plus the system surcharge `K = 100,000`. DECISIONS.md already estimates about 0.04 REACT per reaction on mainnet: 14,000 logs is about 560 REACT.
- When reserves and balance run out the contract goes into debt and the network **silently stops calling `react()`**. Real client payments during that window are never recorded (see M-4), no settlement is requested, and the Health page goes stale. Funds are not lost (owner sweep works) but the product stops, which is exactly what this track judges. Organic address-poisoning bots, which target addresses that receive USDC with non-zero fake-token transfers, produce the same effect at a lower rate without any targeted attacker.
- Strict mode narrows the vector to the accepted token itself; the attacker then needs real 1-unit USDC transfers (about 30k gas each plus 1e-6 USDC), still a large cost asymmetry against a ledger-writing reaction.

**Proof.** `test/security/SpamDrain.t.sol::test_H1_SpamLogsToPublicPayAddress_AreEachABilledReaction`: 300 spam logs produce 300 reactions; `droppedFlags = 285`.

**Fix.** Nothing inside `react()` can avoid the bill once a log matches; the defence has to change what matches.

1. Make `strictTokens = true` the default in the CLI and the forge script, and detect wrong-token payments off-chain (the indexer already reads the chain).
2. Keep wildcard mode as opt-in, but have it narrow itself the first time the flag budget is exhausted:

```solidity
function _flagWrongToken(uint256 invoiceId, LogRecord calldata log_, address payer, uint256 value) internal {
    if (flaggedCount[invoiceId] >= MAX_FLAGGED) {
        ++droppedFlags[invoiceId];
        emit FlagDropped(invoiceId, log_.chainId, log_.contractAddress, value);
        Invoice storage inv = _invoices[invoiceId];
        if (!inv.strictTokens) {
            // Under attack or poisoning spam: stop paying for logs from arbitrary contracts.
            _unsubscribeInvoice(invoiceId);
            delete _subs[invoiceId];
            inv.strictTokens = true;
            _buildAndSubscribe(invoiceId, inv.payAddress, true);
        }
        return;
    }
    ...
}
```

   (Measure the 8-unsubscribe plus 8-subscribe worst case against the 900k cap on Lasna; if it does not fit, lower `MAX_ACCEPTED` or narrow per chain.)
3. Add the runway monitor from section 7 rule 18 with an alert on a sudden rise in reactions per hour, and document the residual strict-mode vector in the Limits section.


**Resolution (H-1, 19 Nov 2026).** Fixed. The invoice field is now `watchAllTokens` (inverted from `strictTokens`), so the zero value, the CLI default and the `CreateInvoice` script default all watch accepted tokens only. A watch-all invoice narrows itself (unsubscribes its per-chain wildcards, resubscribes per accepted token, emits `WatchNarrowed`) on the sixteenth flagged entry, so spam costs an invoice at most `MAX_FLAGGED` reactions; the 8-pair narrowing peaks at about 510k gas. Invoice subscriptions are now derived from the accepted pairs, pay address and mode instead of stored, which is what makes the narrowing fit. New `runway()` view returns balance, reserves, debt and the three cron queues for the health page. Residual strict-mode vector (real 1-unit transfers of the accepted token) is in docs/LIMITS.md. Tests: `SpamDrain.t.sol` (16 reactions for 300 logs), `SecurityFixes.t.sol` H-1 tests, updated `test_Matching_FlagCapBoundsSpam`.

### M-1 (Medium). A lost `Settled` acknowledgement can never be recovered by the resend loop

**Location.** `DaybookTill.sol:99-102` (duplicate branch emits only `DuplicateSettlement`), `DaybookReactive.sol:874-885` (resend), `:313-315` (only `Settled` is treated as an ack).

**Scenario.** The till executes seq N (funds swept and split) but the `Settled` log never reaches `react()`: the reactive contract was briefly in debt (H-1 makes this cheap to cause), the ack reaction reverted, or the till changed (L-1). Section 7 rule 15 relies on "a missing acknowledgement triggers a resend". Each resend reaches the till, hits `settled[invoiceId][seq] == true`, emits `DuplicateSettlement`, which the reactive contract does not subscribe to, and returns. After `MAX_ATTEMPTS` the settlement is `Stuck` and the invoice stays `Paid` forever although the money was settled. Every resend is a billed callback. The pay page never shows Settled and the published "invoices settled" count is wrong until the owner calls `resolveSettlement` by hand.

**Proof.** `test/security/LostAck.t.sol::test_M1_LostSettledAck_IsNeverRecoveredByResend`: `settled(id, 1) == true`, invoice status 2 (`Paid`) after six resend windows.

**Fix.** Make the idempotent branch re-acknowledge. `_onSettled` is already idempotent (it ignores anything not `Pending`/`Stuck`), so a second `Settled` is harmless on the reactive side; `make verify` must dedupe `Settled` by `(invoiceId, seq)`.

```solidity
mapping(uint256 invoiceId => mapping(uint256 seq => bytes32 uid)) public receiptUidOf;

if (settled[invoiceId][seq]) {
    emit DuplicateSettlement(invoiceId, seq);
    // Re-acknowledge so a resend can close a loop whose first ack was lost.
    emit Settled(invoiceId, seq, token, amount, excess, payer, block.chainid, receiptUidOf[invoiceId][seq]);
    return;
}
...
bytes32 uid = _issueReceipt(invoiceId, seq, payer, token, amount + excess);
receiptUidOf[invoiceId][seq] = uid;
```


**Resolution (M-1, 19 Nov 2026).** Fixed. The till stores the receipt UID per (invoiceId, seq) and its duplicate branch emits `DuplicateSettlement` and then `Settled` again with the stored UID; no funds move and no second receipt is issued. Indexers must dedupe `Settled` on (invoiceId, seq). Tests: `LostAck.t.sol`, `test_M1_DuplicateReEmitsSettledWithStoredUid`.

### M-2 (Medium). Anyone can redirect the payment receipt (EAS attestation) to themselves with one raw unit

**Location.** `DaybookReactive.sol:563` (`pair.lastPayer = payer` on every accepted-token transfer, including late ones), `:745` (`_send` reads `lastPayer` at send time, including on every resend), `DaybookTill.sol:113` (receipt for `amount + excess` to that payer).

**Scenario A (cover).** The pay page is public and shows the outstanding remainder. The client pays 999.999999 USDC of a 1,000 USDC invoice (an exchange withdrawal fee, a wallet rounding). The attacker sends 0.000001 USDC and becomes `lastPayer`. The till issues the receipt, an EAS attestation from the Daybook issuer, stating that **the attacker** paid 1,000 USDC for invoice N. The real client gets nothing. The attestation is permanent and non-revocable (`EasReceiptIssuer.sol:57`) and can be used as false proof of payment.

**Scenario B (resend).** Seq N's first delivery is lost; a 1-unit transfer arrives before the resend (a late transfer still in the pipeline). The resend re-reads `lastPayer` and the full receipt goes to the attacker.

More generally, with several payers the receipt goes only to whoever paid last, for an amount that includes everyone's money.

**Proof.** `test/security/ReceiptHijack.t.sol` (both tests): receipt recipient is the attacker, amount 1,000,000,000 (1,000 USDC).

**Fix.** Pin the receipt payer when the settlement is created, and choose it from contribution, not recency. Track the largest contributor per pair (packs into the `lastPayer` slot: `address` + `uint96`), store it per seq, and never re-read pair state on resend:

```solidity
struct PairState { uint128 counted; uint128 excess; address topPayer; uint96 topAmount; }
mapping(uint256 seq => address) public receiptPayerOf;

// _onTransfer, Open branch:
if (value > pair.topAmount) { pair.topPayer = payer; pair.topAmount = uint96(value); }
// Late/Orphaned branch: the settlement is for this transfer only, so pin `payer` itself.

// _requestSettlement:
receiptPayerOf[seq] = payerForThisSettlement;
// _send: use receiptPayerOf[seq]
```

Better still for multi-payer invoices: issue one receipt per Payment ledger entry (payer, own amount) rather than one per settlement.


**Resolution (M-2, 19 Nov 2026).** Fixed by pinning, not per-entry receipts. Each pair tracks the sender of its largest single counted transfer (`topPayer`, packed with `topAmount`); it only changes while the invoice is open, so a settlement made at close (and every resend of it) names that payer. A late or orphaned settlement covers exactly one transfer and pins that transfer's sender per seq. `receiptPayerOf(seq)` exposes it. Per-entry receipts were rejected: they would multiply EAS cost per settlement. Tests: `ReceiptHijack.t.sol` (both), `test_M2_*` in `SecurityFixes.t.sol`.

### M-3 (Medium). EAS receipts always fail on Base mainnet: a real attestation needs about 314k gas, the till gives it 250k

**Location.** `DaybookTill.sol:29` (`RECEIPT_GAS = 250_000`), `:247-251` (failure caught and turned into `ReceiptFailed`).

**Scenario.** Measured against the live EAS predeploy (`0x4200…0021`) on a Base mainnet fork with the exact schema and payload `EasReceiptIssuer` uses: **313,995 gas**. Every settlement on Base therefore runs out of gas inside the issuer, the `try` catches it, and the till emits `ReceiptFailed` with `uid = 0`. The spec feature "issue an on-chain receipt to the payer using EAS" never works on mainnet, silently, and each settlement burns the full 250k. The unit tests use `MockEAS`, which costs a fraction of this, so the suite cannot see it.

**Proof.** `test/security/EasReceiptGas.t.sol::test_M3_RealEasAttestation_FitsInReceiptGas` (fork).

**Fix.** Raise the budget with margin and make the regression test permanent; re-measure on every chain where EAS is enabled.

```solidity
uint256 public constant RECEIPT_GAS = 400_000;
```

Then re-check the callback budget: `callbackGasLimit` 1,000,000 minus the proxy's 130k (Base) or 200k (Ethereum) overhead must still cover sweep plus vault deploy, reserve deposit, five team transfers, treasury transfer, 400k receipt and events. Raise `callbackGasLimit` if the worst case does not fit with 20% margin. Also emit `ReceiptFailed` with the revert reason length or gas left, so the next silent failure shows up on the Health page.


**Resolution (M-3, 19 Nov 2026).** Fixed. `RECEIPT_GAS` is 400,000 (in `DaybookLib`, read by the till and by the fork test), about 27% over the measured 313,995. The issuer is called with a low-level call that copies at most 32 bytes back; `ReceiptFailed` now carries `gasLeft`. Default `callbackGasLimit` raised to 1,300,000: worst-case settle (428k) plus receipt (400k) with 20% margin plus the Ethereum proxy overhead (200k) is about 1.19M. Tests: `EasReceiptGas.t.sol` (fork, passes), `test_Gas_WorstCaseSettleFitsCallbackLimit`, `test_M3_ReceiptBudgetCoversMeasuredEas`.

### M-4 (Medium). A payment whose log is missed can never be recorded; the invoice stays Open

**Location.** No owner reconciliation path exists in `DaybookReactive.sol`; payments enter only through `react()` (`:539`).

**Scenario.** Per `economy.md`, while the contract has any debt the system does not call `react()`. Logs in that window, or a reaction that reverts (any unexpected revert, for example L-5), are not replayed by the contract. The client's transfer sits in the pay address, the ledger never shows it, the invoice stays Open (and later Expired, forwarding nothing because `pair.counted` is zero). The owner can sweep the funds by hand but cannot mark the invoice paid, issue the receipt or run the split through the normal path. Combined with H-1, an attacker can choose the window.

**Fix.** Add an owner-only reconciliation entry that goes through the same dedupe key, so a log that does arrive later is a harmless duplicate:

```solidity
function recordMissedTransfer(LogRecord calldata log_) external onlyOwner {
    // Same validation and accounting as react(); the ledger entry is marked as owner-recorded.
    if (log_.topic0 != TRANSFER_TOPIC || log_.opCode != 3) revert BadAccepted();
    emit OwnerRecorded(log_.chainId, log_.txHash, log_.logIndex);
    _onTransfer(log_);
}
```

The owner is the payee, so this adds no trust a payer does not already extend; `make verify` should list owner-recorded entries separately and check each against the origin chain.


**Resolution (M-4, 19 Nov 2026).** Fixed. Owner-only `recordMissedTransfer(LogRecord)` checks topic0, opCode and data length, refuses unknown pay addresses and already-seen keys, emits `OwnerRecorded`, then runs the same `_onTransfer` path and dedupe key as `react()`, so the real log arriving later is a duplicate. Tests: `test_M4_*`.

### L-1 (Low). Changing a chain's till while settlements are in flight loses their acks and can re-sweep

**Location.** `DaybookReactive.sol:345-358` (`setTill` drops the old ack subscriptions immediately), `:751` (resends go to the current `tillOf`), `DaybookTill.sol:41` (`settled` is per till).

**Scenario.** Owner migrates chain A from till T1 to T2 while seq N is pending. T1 already executed N, but its `Settled` arrives after the unsubscribe and is ignored. The resend goes to T2, whose `settled` map is empty. If the pay address is empty, T2 reverts until N is `Stuck` (M-1 symptoms). If the pay address holds other funds of that token (a late payment awaiting its own seq), T2 sweeps them and splits them **again** as seq N's income (team paid twice from treasury-only excess), and the later seq then fails.

**Fix.** Refuse `setTill` while any pending settlement targets that chain, or keep a `previousTill[chainId]` whose acks are still accepted and whose `settled` map the new till consults:

```solidity
mapping(uint256 chainId => uint256) public pendingOnChain; // ++ in _requestSettlement, -- in _finishSettlement
if (pendingOnChain[chainId] != 0) revert PendingOnChain(chainId);
```


**Resolution (L-1, 19 Nov 2026).** Fixed. Open settlements (pending or stuck, until acked or resolved) are counted per chain; `setTill` reverts with `OpenSettlementsOnChain` while that chain's count is non-zero. View `openSettlementsOn(chainId)`. Tests: `test_L1_*`.

### L-2 (Low). "A broken issuer never blocks settlement" is not true for some broken issuers or reserves

**Location.** `DaybookTill.sol:247` (`try issuer.issue(...) returns (bytes32 u)`), `:231` (`try r.deposit(...)`), interface comment `IReceiptIssuer.sol:4-6`.

**Scenario.** Solidity's `try` does not catch failures that happen in the caller: a call to an address with no code (the extcodesize check for `deposit`, which returns nothing) and ABI-decoding a short return (an issuer returning no data). If `setReserve` or `setReceiptIssuer` is pointed at an EOA, a not-yet-deployed address, or a contract with the wrong ABI, **every** `settle` on that chain reverts until fixed, each failure billed.

**Fix.** Validate in the setters and make the calls tolerant:

```solidity
function setReceiptIssuer(IReceiptIssuer issuer_) external onlyOwner {
    if (address(issuer_) != address(0) && address(issuer_).code.length == 0) revert NotAContract();
    ...
}
// and in _issueReceipt use a low-level call and accept only ret.length == 32.
```


**Resolution (L-2, 19 Nov 2026).** Fixed. `setReserve` and `setReceiptIssuer` reject non-zero addresses without code; at call time a reserve without code is treated as absent (tax to treasury) and the issuer call is low-level with a code check and a 32-byte return cap. Tests: `test_L2_*`.

### L-3 (Low). `renounceOwnership` is live on every contract

**Location.** Inherited from `Ownable` via `Ownable2Step`: `DaybookTill.sol:25`, `PayAddressFactory.sol:57`, `DaybookReactive.sol:22`, `SavingsVault.sol:14`.

**Scenario.** One mistaken call (a wallet "renounce" button, a script typo) is irreversible. On a paused till it strands every pay address on that chain (no unpause, no sweep); on the factory it prevents ever authorizing a new till; on the vault it locks the tax reserve.

**Fix.** On all four:

```solidity
function renounceOwnership() public pure override { revert RenounceDisabled(); }
```


**Resolution (L-3, 19 Nov 2026).** Fixed. `renounceOwnership` reverts with `RenounceDisabled` on DaybookReactive, DaybookTill, PayAddressFactory and SavingsVault. Note: this changes the factory's init code, so the factory (and every pay address) for a deployment of this version differs from the one deployed from the earlier commit. Test: `test_L3_RenounceOwnershipDisabledEverywhere`.

### L-4 (Low). A manual sweep clears the whole pair balance regardless of what it moved

**Location.** `DaybookTill.sol:125` (emits `ManualSweep` even when `amount == 0`), `DaybookReactive.sol:771-790` (ignores the swept amount, resolves every pending seq for the pair, zeroes `counted` and `excess`).

**Scenario.** Delivery may be out of order (section 7 rule 15). If a transfer that landed after the owner's sweep is reacted to before the `ManualSweep` log, its balance is cleared with the sweep: the money stays in the pay address with nothing requesting its settlement, and the invoice can reach `Settled` with funds left behind. A zero-amount sweep (owner checking, wrong token decimals) also resolves in-flight settlements and wipes balances still held.

**Fix.** Skip emitting when `amount == 0`; carry the amount in the event (it is already in `data`) and subtract it instead of clearing:

```solidity
uint256 swept = abi.decode(log_.data, (uint256));
uint256 fromCounted = swept < pair.counted ? swept : pair.counted;
pair.counted -= uint128(fromCounted);
uint256 rest = swept - fromCounted;
pair.excess -= uint128(rest < pair.excess ? rest : pair.excess);
```


**Resolution (L-4, 19 Nov 2026).** Fixed. The till emits nothing and moves nothing on a zero sweep. The reactive side decodes the swept amount, resolves pending settlements for that pair only while their total fits in what was swept, then takes the rest off the held balance (counted first, then excess); a transfer that raced the sweep keeps its balance. Tests: `test_L4_*`.

### L-5 (Low). `_onManualSweep` walks the whole global pending queue with no gas bound

**Location.** `DaybookReactive.sol:777-781`.

**Scenario.** About 4.5k gas per pending entry (two cold SLOADs). With roughly 200 pending settlements across all invoices (a paused till or an empty callback balance during a busy period) the ManualSweep reaction exceeds 900k and reverts: the sweep is not acknowledged and the pending seqs keep being resent until Stuck.

**Fix.** Index pending seqs per `(invoiceId, pairIndex)` (at most a handful), or bound the loop with `gasleft()` and resume on the next cron tick.


**Resolution (L-5, 19 Nov 2026).** Fixed by bounding: the manual-sweep queue walk stops when less than 100,000 gas is left. Anything it cannot reach keeps being resent, fails against the empty pay address and ends Stuck for `resolveSettlement` (recorded in docs/LIMITS.md). With 40 pending settlements the reaction stays well under the cap. Test: `test_L5_ManualSweepAckStaysUnderGasCapWithManyPending`.

### L-6 (Low). The cap is per settlement, not per invoice; an over-cap invoice is guaranteed to fail five billed callbacks

**Location.** `DaybookTill.sol:103-105`; `DaybookReactive.sol:362` accepts any amount up to `uint128`.

**Scenario.** The spec asks for a per-invoice cap. An invoice above the till cap (or a large overpayment) is accepted on Reactive, then every send reverts `CapExceeded` until `Stuck`, each attempt billed on the destination. Funds are safe (manual sweep), but the guard surfaces only as failed callbacks.

**Fix.** Mirror the cap on Reactive (`maxInvoiceAmount`, owner-set, checked in `createInvoice`) so an over-cap invoice cannot be issued, and keep the till cap as the hard backstop.


**Resolution (L-6, 19 Nov 2026).** Fixed. `maxInvoiceAmount` (default 10,000 USD, owner-set via `setMaxInvoiceAmount`) is checked in `createInvoice` with `OverInvoiceCap`; the till cap stays as the backstop. Overpayment beyond the till cap still fails at the till and needs a manual sweep (docs/LIMITS.md). Tests: `test_L6_*`.

### L-7 (Low, platform). Any reactive contract can make the till pay for failed callbacks

**Location.** `DaybookTill.sol:98` (authorization happens inside the call; per `callback-contracts.md` the proxy bills the recipient whether or not the call succeeds).

**Scenario.** Any Reactive user can request callbacks with `recipient = till`. Each reverts at `onlyCallbackSender` but is charged to the till (`g_used + K`, K about 80k on Base). Sustained, this empties the till's native balance, the till goes into debt, and legitimate settlements stop. Costs are roughly symmetric (the attacker pays Reactive gas per request), so this is a nuisance rather than a cheap attack, and nothing in the contract can refuse the charge.

**Fix.** Keep the till balance at a few days of runway rather than a large float, alert on `CallbackFailure` events whose injected sender is not DaybookReactive, and note it in Limits.


**Resolution (L-7, 19 Nov 2026).** Accepted, documented in docs/LIMITS.md (platform behaviour; nothing in the contract can refuse a proxy charge).

### L-8 (Low). `Paid` is shown before the money is swept

**Location.** `DaybookReactive.sol:572`, `:665-669`.

**Scenario.** `Paid` is set from the origin log alone. If Reactive delivers before finality and the origin block reorgs (rare on Base and Arbitrum, possible), the invoice is `Paid` with no funds and its settlement goes `Stuck`. The pay page "stamps Paid" on this state.

**Fix.** Show "Payment seen" on `Paid` and stamp Paid only on `Settled` (the acknowledged sweep); document the finality assumption.


**Resolution (L-8, 19 Nov 2026).** Documented: the UI must show `Paid` as "Payment seen" and stamp Paid only on `Settled` (docs/LIMITS.md, docs/ARCHITECTURE.md).

### Informational

- **I-1. Owner trust.** The factory owner can authorize any contract as a till and sweep every pay address on that chain (`PayAddressFactory.sol:80-83`, `:103-106`); one EOA owns it on every chain. That is acceptable (the funds are the owner's receivables) but it is the single point of compromise. The owner is a constructor argument, so it fixes the factory address: deploy with the EOA, then `transferOwnership` to a per-chain multisig, which does not move any address.
- **I-2. Owner powers a payer should be told about.** `cancel` forwards money already paid to the treasury with no on-chain refund (`DaybookReactive.sol:411-420`); the owner can sweep any pay address to any address at any time (`DaybookTill.sol:121-130`) and mark settlements resolved by hand. State this on the pay page.
- **I-3. Determinism assumptions.** `VAULT_IMPLEMENTATION` assumes the factory's first CREATE at nonce 1 (`DaybookReactive.sol:296-298`), and the factory address depends on the exact init code, including the IPFS metadata hash (`bytecode_hash = "ipfs"`). Commit the exact factory init code as an artifact and deploy future chains from it, never from a rebuild. Only enable chains with the canonical CREATE2 deployer and standard CREATE/CREATE2 derivation (no zkSync-style chains). A payment on a chain with no till is recoverable later by deploying the same factory and a till there.
- **I-4. Token quirks.** Fee-on-transfer: the till receives less than `total` and the treasury transfer reverts, so settle fails until Stuck and a manual sweep recovers (`DaybookTill.sol:211`). 18 decimals: partial payments floor when normalized (`DaybookReactive.sol:595-597`), so `counted` can exceed `amount * 1e12` by under 1e12 wei per partial, dust-level. `decimals` is owner-supplied and unchecked; a wrong value mis-prices the invoice by orders of magnitude. Have the CLI read `decimals()` from the token.
- **I-5. Spoofable reserve events.** `SavingsVault.deposit` is permissionless (`SavingsVault.sol:28-32`), so anyone can emit `Deposited` with any `invoiceId`. `make verify` must count only deposits whose `from` is a known till.
- **I-6. Unreachable narrowings.** `_requestSettlement(..., 0, counted + excess)` casts the sum to `uint128` (`:698`, `:722`), and `openSettlements` is `uint16`. Neither is reachable with real stablecoin volumes (each needs about 2^32 maximum-size transfers), but a `SafeCast` makes that explicit.
- **I-7. `poke()` is permissionless** (`:469-471`). All work it triggers is time-gated (`resendAfter`, due and expiry times), so an early caller changes nothing; the caller pays Reactive gas and the till pays for resends it would have paid for anyway.
- **I-8. No pause on the reactive side.** Pausing the till stops fund movement, but the reactive contract keeps sending (billed, failing) callbacks until each settlement is Stuck. Acceptable; document that pausing costs up to five callback attempts per open settlement.
