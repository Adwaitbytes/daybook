# Daybook architecture

Daybook marks invoices paid without anything of ours running. One reactive contract on Reactive Network holds the invoices and the ledger; one till per payment chain moves the money when told to.

## The loop

```
client wallet ──USDC Transfer──▶ pay address (chain X, no code yet)
                                   │ Transfer log, topic2 = pay address
                                   ▼
                      DaybookReactive.react()            Reactive Network
                      match, dedupe, ledger entry
                      covered? unsubscribe, request settle on X
                                   │ callback through X's proxy
                                   ▼
                      DaybookTill.settle()               chain X
                      sweep pay address, tax to vault,
                      team split, rest to treasury,
                      receipt, emit Settled
                                   │ Settled log
                                   ▼
                      DaybookReactive.react()            ack: settlement closed,
                                                         invoice Settled, cron released
```

If the ack does not come back within `resendAfter` seconds, the next cron tick sends the same settlement again with the same sequence number. The till ignores a sequence number it has already settled.

## Pay addresses: same on every chain

Three contracts, split by what is allowed to differ per chain:

| Contract | Address | Why |
|---|---|---|
| `PayAddressFactory` | identical on every payment chain | deployed through the CREATE2 deployer `0x4e59...956C` with a fixed salt; its only constructor argument is the owner, the same EOA everywhere |
| `InvoiceVault` implementation | identical | the factory's first CREATE, so it follows from the factory address |
| `DaybookTill` | differs per chain | `AbstractCallback` stores the callback proxy as an immutable, and the proxy differs per chain |

```
salt        = keccak256(abi.encode(reactiveContract, invoiceId))
implementation = address(CREATE(factory, nonce 1))
payAddress  = CREATE2(factory, salt, eip1167CloneInitCode(implementation))
```

Nothing chain-specific enters that formula. `DaybookReactive` takes the factory address in its constructor, derives the implementation the same way, and computes pay addresses on Reactive with `Clones.predictDeterministicAddress`; the deploy script predicts the factory address before any payment chain is touched, so the reactive contract is deployed first. `scripts/src/payAddress.ts` computes the same address offline; its test vector comes from a local two-chain run of the deploy scripts in which both contracts returned it.

Salting with the reactive contract's address means a redeployed reactive contract (whose ids restart at 1) never reuses an old pay address.

The vault holds whatever is sent to it and has one rule: only the factory can move funds, and the factory only moves them to the till that asks (`isTill`). No vault is deployed until the first sweep. The owner can authorize more than one till per chain during a migration.

## DaybookReactive (Reactive Network)

State: split policies (immutable once created), invoices, accepted (chain, token, decimals) pairs, per-pair held balances, the ledger, settlements, and three work queues (open timed invoices, pending settlements, invoices whose balances are still being sent).

Owner functions:

| Function | Effect |
|---|---|
| `createPolicy(treasury, taxBps, team[])` | Registers an immutable policy. Up to five team members; tax plus team at most 10,000 bps |
| `setTill(chainId, till)` | Sets the till on a chain and moves the `Settled` and `ManualSweep` subscriptions to it. Refused while that chain has open settlements |
| `createInvoice(params)` | Stores the invoice, subscribes to `Transfer` into its pay address (per accepted token by default; per chain with any token when `watchAllTokens`), joins the timed queue if it has a due or expiry time. Refused above `maxInvoiceAmount` |
| `recordMissedTransfer(log)` | Records a Transfer whose delivery was missed, through the same dedupe key as `react()`; emits `OwnerRecorded` |
| `setMaxInvoiceAmount(amount)` | Largest invoice that may be issued; keep it at or below every till's cap |
| `cancel(id)` | Open invoices only. Unsubscribes; any money already received is forwarded to the treasury unsplit |
| `retrySettlement(seq)` | A stuck settlement goes back in the queue and is sent now |
| `resolveSettlement(seq)` | Marks a pending or stuck settlement as handled by hand |
| `setCallbackGasLimit`, `setResendAfter` | Bounded at 100,000 gas and 60 seconds |
| `withdrawNative(amount, to)` | Owner withdrawal of REACT held by the contract |

Open to anyone: `coverDebt()` settles system contract debt from the contract's balance; `poke()` runs the same time-gated work as a cron tick.

`react()` routes on `topic0` and returns early on anything it does not expect:

- `Transfer` with `opCode == 3` (an ERC-721 `Transfer` has four topics and is ignored). Looks up the invoice by `topic2`, rejects malformed data and zero values, dedupes on `keccak256(chainId, txHash, logIndex)`, then:
  - accepted token, invoice open: counts it (normalized to 6 decimals), records the part beyond the invoice amount as excess, writes a `Payment` ledger entry; when covered, marks the invoice `Paid` and closes it.
  - accepted token, invoice already paid, cancelled or expired: a `Late` or `Orphaned` entry, sent straight to the treasury as excess.
  - any other token (only seen when `watchAllTokens`), or an accepted token above uint96 raw units: a `WrongToken` entry, left in the pay address for the owner. On the sixteenth such entry a watch-all invoice narrows to accepted tokens (`WatchNarrowed`), which caps what spam sent to a public address can cost.
- Cron (only from the cron emitter on Reactive's own chain id): expires invoices past `expiresAt`, marks invoices past `dueAt` overdue, resends settlements whose ack is late, marks a settlement stuck after five sends, and finishes any invoice whose balances were deferred.
- `Settled` from the registered till on that chain: closes the settlement if invoice, chain and token match. An invoice is `Settled` when it is `Paid` and none of its settlements are open.
- `ManualSweep` from the registered till: resolves pending settlements for that invoice and token while their total fits in the swept amount, then takes the remainder off the held balance, so nothing keeps asking to sweep money that is gone and a transfer that raced the sweep keeps its balance.

The receipt payer of a settlement is the sender of the largest single transfer counted on that pair (frozen once the invoice closes), or for a late or orphaned settlement the sender of that transfer (`receiptPayerOf(seq)`). `runway()` returns the contract's balance, reserves and debt at the system contract and the sizes of the three cron queues.

`Paid` means the payment was seen on the origin chain; `Settled` means every settlement was acknowledged by its till. The pay page shows Paid only on `Settled`.

Closing an invoice (cover, cancel or expiry) unsubscribes with the stored subscription structs, then requests one settlement per (chain, token) holding a balance, each on its own chain. If less than 320,000 gas is left before a request, the rest wait for the next cron tick; this keeps a cover with every pair funded under the 900,000 reactive gas cap (an eight-pair cover peaks at about 764,000 in the harness, with three requests sent at once and the rest on the next tick).

Cron is subscribed only while one of the three queues is non-empty and unsubscribed the moment all are empty.

Every subscribe and unsubscribe goes through `_subscribe(Sub)` / `_unsubscribe(Sub)`. Invoice subscriptions are derived by one function from the invoice's accepted pairs and pay address (both immutable) and its watch mode, used for both subscribing and unsubscribing; till and cron subscriptions are rebuilt from stored state (the till address, an immutable topic). The test suite asserts that no unsubscribe ever misses.

Events: `PolicyCreated`, `TillSet`, `InvoiceCreated`, `SubscriptionChanged`, `LedgerRecorded`, `FlagDropped`, `DuplicateDelivery`, `InvoicePaid`, `InvoiceSettled`, `InvoiceOverdue`, `InvoiceCancelled`, `InvoiceExpired`, `SettlementRequested`, `SettlementAcked`, `SettlementStuck`, `SettlementResolved`, `PairBalanceCleared`, `CronActive`, `CallbackGasLimitSet`, `ResendAfterSet`, `NativeWithdrawn`, `WatchNarrowed`, `OwnerRecorded`, `MaxInvoiceAmountSet`.

## DaybookTill (each payment chain)

`settle(rc, invoiceId, seq, token, amount, excess, payer, policy)` is guarded by `onlyServiceProvider` and `onlyCallbackSender(rc)`, is `nonReentrant` and `whenNotPaused`. It:

1. If `(invoiceId, seq)` was already settled, emits `DuplicateSettlement` and `Settled` again with the stored receipt UID (a re-acknowledgement for a lost ack) and moves nothing.
2. Reverts if `amount + excess` is above the token's cap (zero means the token is not enabled) or the policy is malformed.
3. Sweeps exactly `amount + excess` from the pay address through the factory, deploying the vault if needed.
4. Splits `amount`: tax to the reserve (`IReserve.deposit`), each team share by transfer, the remainder plus `excess` plus rounding dust to the treasury. A team transfer that fails (a blocklisted address) and a reserve that reverts are redirected to the treasury with `PayoutRedirected`; a reserve that pulls the wrong amount reverts.
5. Calls the receipt issuer, if set and holding code, with at most 400,000 gas through a low-level call that copies back at most 32 bytes; a failure emits `ReceiptFailed(invoiceId, seq, gasLeft)`. Always emits `Receipt`.
6. Emits `Settled`, the acknowledgement.

A revert (paused, over cap, pay address short) is caught by the proxy as `CallbackFailure`; the reactive contract resends on cron. Owner functions: `sweep` and `sweepNative` (work while paused, emit `ManualSweep`), `rescue`, `withdrawNative`, `setReserve`, `setReceiptIssuer`, `setMaxSettlement`, `pause`, `unpause`. `coverDebt()` is open to anyone. Nothing is upgradeable.

Events: `Settled`, `ManualSweep`, `Receipt`, `Payout`, `PayoutRedirected`, `ReceiptFailed` (now with `gasLeft`), `DuplicateSettlement`, `ReserveSet`, `ReceiptIssuerSet`, `MaxSettlementSet`, `Rescued`, `NativeWithdrawn`.

Worst-case `settle` (five recipients, reserve deposit, excess, first vault deploy) uses about 428,000 gas. The default callback gas limit is 1,300,000: that plus the 400,000 receipt allowance (a real EAS attestation measured 313,995 on a Base mainnet fork) with 20% margin, plus the largest measured proxy overhead (Ethereum: 150,000 extra gas plus 50,000 charge gas). Owner `sweep` does nothing on a zero balance; `renounceOwnership` is disabled; `setReserve` and `setReceiptIssuer` refuse addresses without code.

## Supporting contracts

- `SavingsVault`: plain holding vault behind `IReserve`. Anyone can deposit (it pulls from the caller), only the owner withdraws. A yield-bearing reserve can replace it later behind the same interface.
- `EasReceiptIssuer`: attests `(invoiceId, seq, token, amount, chainId)` to the payer through EAS. Only the till can call it. Used only where EAS is deployed and verified (see ref/FACTS.md); elsewhere the `Receipt` event is the receipt.

## Local Omni harness

`contracts/test/harness/` runs the whole loop inside `forge test`. A mock system contract is etched at `0x8888...8888`; it keeps one storage bit per subscription and reports subscribes, unsubscribes and callback requests as events, which the harness reads back. Keeping that bookkeeping out of the mock's storage keeps the gas a reactive contract spends there close to the real system contract, so the harness can call `react()` with the real 900,000 gas cap. Each simulated chain has its own tokens, till and mock callback proxy (which overwrites the first payload argument with the reactive contract's address and withholds the measured proxy overhead). The relay turns recorded logs into `LogRecord`s with the right chain id, matches them against active subscriptions with wildcards, and loops until no callback is queued. Tests can drop, hold, reorder and replay deliveries.

Local timing is not real latency. Everything happens inside one test transaction.
