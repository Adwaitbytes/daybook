# First live loops

19 Nov 2026, 08:30 to 09:40 UTC. Reactive Lasna, Base Sepolia, Unichain Sepolia. Addresses are in DEPLOYMENTS.md, and every row is in `evidence/loops.csv` (written by `scripts/src/trace`, one row per traced payment and settlement, failures included).

## Result

Seven loops on two deployments. Every payment that should close did close, on the first send, with no resend and no cron tick:

| Loop | Deployment | What | Outcome |
|---|---|---|---|
| v0-L1 | v0 | 1.00 USDC invoice, exact payment on Base | closed; EAS receipt **failed** (`ReceiptFailed`, M-3 confirmed live) |
| v1-L1 | v1 | 1.00 exact on Base | closed, EAS attestation issued |
| v1-L2 | v1 | 2.00 invoice: 0.75, then 1 DBKTEST (wrong token, strict watch), then 1.25 | partial recorded with no settlement; wrong token **not delivered at all**; closed on the 1.25 |
| v1-L3 | v1 | 1.00 invoice paid 1.50 | closed; 0.50 excess to the treasury unsplit |
| v1-L4 | v1 | `watchAllTokens` invoice (the one deliberate watch-all): 1 DBKTEST, then 1.00 USDC | DBKTEST flagged `WrongToken` and left in the pay address; closed on the USDC, which also unsubscribed the wildcard watch |
| v1-L5 | v1 | 2.00 invoice accepting Base and Unichain USDC: 1.00 on Base, then 1.00 on Unichain | partial on Base; the Unichain payment covered it and one reaction sent two settlements, each settled and acknowledged on its own chain |
| probe | DoubleSubProbe | one USDC Transfer matching two filters of one RC | delivered **once** |

Unclosed: none. Failed: the v0 EAS receipt (by design of the old gas limit), and one tracer run that crashed before the tool was finished (row `v0-L1-exact` with `trace_error`, kept because rows are never dropped; the next row is the real trace).

## Every hash

Lasna explorer `https://lasna.reactscan.net/tx/<hash>`, Base `https://sepolia.basescan.org/tx/<hash>`, Unichain `https://unichain-sepolia.blockscout.com/tx/<hash>`.

| Loop | Invoice / create tx (Lasna) | Origin transfer | Reactive tx (Lasna) | Callback (destination) | Ack reactive tx (Lasna) |
|---|---|---|---|---|---|
| v0-L1 | v0 #1 `0x39e678b084d133d781dbfa69be47dbc314968ec82fd22c096b3d4a6b4b679665` | Base `0xdaf7cf59b3edc7f6840f768ae29131bcbe78ead8fd0f806ad9c37dc211635dfa` | `0x1b5eadbcce3bd91d284ebdad7757835078bdc2b1997c71f50c4f5d8c85eaadfe` | Base `0xe4f04843c67021dba7a23018fd438d6513b715a7a5abf03ad5b451c4e5ee6cfb` | `0x7002f16d6165816557785a9fe1441ae0e32ea987b888b9fa0ea3d527ad7de73c` |
| v1-L1 | #1 `0x906f904bd24d78a1b47b126fa64aa3b5f78ec250030fa1252b14e0bdc119d03a` | Base `0x83f977cbdfafa67375d522af4875de0e09c0a67a75a79923f967e168122aad6b` | `0xc4088634fc23911523f4416d44aeeb0bfd01f42300825201a7b541cb87fd049e` | Base `0x5569926add8acec5aaf62de139f33380d89ead0b1fcf9b24c0eb89990af75ede` | `0x3793b50209a91d710a38eee163783264aad46e0b7d814c42c8acb3b5617ce2a8` |
| v1-L2 part 1 | #2 `0x45a2ca20358ebca65717adc5c1378b8ea24bbcee9848683b8ed62c8def29993b` | Base `0xcbae45d5354987f3f9172cc6024fc44527e4a02081395bb02a6c3cad40127714` | `0xbf41ec030910f59b4b7092012df6170a6d4498a6eec58137c2a86ad76cb3219a` | none (partial) | none |
| v1-L2 wrong token | #2 | Base `0x57ae8a97862b6096af48881a5ca8708e69c47f283b1ea403e5f8e13d2ab3f0a2` | none: `trace_origin_event` says the origin block was sequenced in Lasna block 8721759 and the log not carried (no filter matched) | none | none |
| v1-L2 part 2 | #2 | Base `0x571a746d104a9094419d9f212cdd1b8f99b676d2e95db7f7f2cec25e716fec1d` | `0x8a15fe1641b05feecb2cd72f28c2628dadbd6bd969b90b43b30036bd8d5df20a` | Base `0x913205c03661d557038c886d87b5d25bc43a2d1e81931edc5a8e3d78e2de4996` | `0xd52269659f059639e38599c18894ab673b6ac8bd0a7cf62a38594911e10fd4d3` |
| v1-L3 | #3 `0xdd1f2fa8b7e74d90afc9cb8b13080e60e23d7fcb98cd31ba2f2b7f08bc9f873f` | Base `0xaad6f93363971ee5e74975a971efee11f58eb46819c97d3b111a3a18b29eab48` | `0x80384b8c31e7580b6ac37748e633e94b5ded062ea7fccc554dccd4d7a2bd41a1` | Base `0xbd84ab8160ed99b51b5d186ea09549d2bfda8e600334e9770a048334a9066e27` | `0xdd8ff73cd88427cdbfc78e6c181b174415234e9982d2a2c556e177d5a767d571` |
| v1-L4 flag | #4 `0xaa56b1f74dab646e48e280a3dfb64882f057f87c8c3e5e5dd7b040f1a0b36aff` | Base `0xdb07994f8fb36e799f027731b4d3037fb08bfaf26a55fed422e2a656916d160d` | `0xf9a2a94fcf8af27b93d68d272d3928349f0b349ca45674d9762d65ea2b9a195b` | none (flag only) | none |
| v1-L4 pay | #4 | Base `0x8327385fc022ce2c635f1165dd517d34cf071b0519851a40f2178a43f932f542` | `0xdfbe0f6e81241b752a2277b1b7438fb27a5bb90f51413c374c17821b2a99d9a9` | Base `0x705256eb739c22e93d881b5943f70de69a2d2e4371b9ac3c1b75558530f443f0` | `0x298f74b980858ed327db3cd1993b223d2d33a3904cc74dacbc866acb2ce0a1bb` |
| v1-L5 Base half | #5 `0x9ccd281f7e24a2e6d68574fb5b70848803536d42001a51a4368aea80a6b9f872` | Base `0xdb1bb8814699f59c02a24d2201e122b108f8fb07116f300669a6f495decf9acd` | `0x4c0202cf7a02af049d0e9f7b826e900e024f6bd91ede0884d71f94ac723f26d7` | none (partial) | none |
| v1-L5 Unichain half, seq 5 | #5 | Unichain `0x18af17f2a2bd2a37c006bfea8d1d4116d0385d881ea62baafa4258abacd50a01` | `0x5191b720bd27b724a448736cbce2dbb48143492b87d53825ba2cc5a058235388` | Base `0x91bf8d2cae61e2455852525fc29fd7c76cafae8636d26c87310c13a1cf449698` | `0x66930ebf51d2ed7a294a060076fb657d35058d93883dfb4319a682dcc95302bb` |
| v1-L5 Unichain half, seq 6 | #5 | same | same | Unichain `0x93ddf1089b5a98b48e8871a4e80272dc64d5e59bbfdc9ed1d8f37c0ec6821b3b` | `0x236705b6386e382e0c79437c4ff22b8cb4bffdc221d77740e474c5ed8714cd77` |
| probe | probe deploy `0x4c1bc6bd2bb75a19f0f1bc874a33f915c4a25165d0291b74f8a0f275f5b67b0b` | Base `0x58782ebe1a9ae96090a8dd075959937b89f5c74fd202abea2261e95886457d68` | `0x905d8af3aa64764524a91dc50f2366f59f63c690e45289a02b87614472b99a85` (the only one) | n/a | n/a |

EAS attestation UIDs (v1, on the destination chain): L1 `0x31d2f2a0…45ce`, L2 `0x1025e4b9…70f1`, L3 `0x030527c5…8a54`, L4 `0xdb27e857…2667`, L5 seq 5 `0xb8d82c95…516b`, seq 6 `0x4fa26005…a2d4` (full UIDs in `receipt_outcome` in the CSV).

## Latency

Clocks:
- **Base Sepolia**: `blockTimestampMs` on logs, 200 ms blocks. Precision 200 ms (one block).
- **Unichain Sepolia**: whole-second block timestamps only. Precision 1 s.
- **Lasna**: whole-second block timestamps, about 1 s blocks. Precision 1 s.
- **Cross-chain clocks disagree.** Sampled against the local clock (within 56 ms of NTP), Lasna heads read 0.9 to 2.2 s *behind* wall time and Base heads 0.2 to 0.7 s *ahead*. Every reactive tx is therefore stamped before the payment it reacts to (−400 to −1,800 ms in the CSV). So only same-chain intervals are reported as latency; cross-chain columns in the CSV are raw stamp differences, not latencies.

| Loop | Origin → callback, same clock | Clock | Reaction → ack on Lasna | Lasna blocks, reaction → ack (from 1 s stamps) |
|---|---|---|---|---|
| v0-L1 | 1,000 ms (5 Base blocks) | Base ms | 1 s | 1 |
| v1-L1 | 1,400 ms (7 blocks) | Base ms | 1 s | 1 |
| v1-L2 | 1,800 ms (9 blocks) | Base ms | 1 s | 1 |
| v1-L3 | 1,200 ms (6 blocks) | Base ms | 2 s | 2 |
| v1-L4 | 1,000 ms (5 blocks) | Base ms | 1 s | 1 |
| v1-L5 seq 6 (Unichain payment → Unichain callback) | 2 s | Unichain s (±1 s) | 2 s | 2 |
| v1-L5 seq 5 (Unichain payment → Base callback) | 1.6 s raw | mixed (±1 s plus skew) | 1 s | 1 |

The full loop, payment through ack, is about 2 to 3 s of wall time: the callback lands 1.0 to 1.8 s after the payment, and the ack is in the next one or two Lasna blocks.

## Cost

Lasna fees are the drop in `balance + reserves − debt` of the reactive contract across the block (system contract `0x8888…8888`, per economy.md); no other reactive contract transaction shared a block. Lasna gas price was 100 gwei and `C = 1`, `K = 100,000`, so `fee / 100 gwei − 100,000` is the gas billed for `react()`. That is 41k to 61k below the receipt's `gasUsed`, because the receipt also counts `trigger()` in the system contract.

| Reaction | Receipt gasUsed | lREACT | Billed react gas |
|---|---|---|---|
| createInvoice (owner tx, one accepted pair) | 212,601 to 230,037 | 0.0213 to 0.0230 | n/a |
| createInvoice, two chains | 252,466 | 0.0252 | n/a |
| Partial payment (no settlement) | 282,423 / 282,435 | 0.0321 | 221,499 |
| Wrong-token flag (watch-all) | 223,927 | 0.0263 | 162,991 |
| Cover, one settlement (incl. cron subscribe) | 398,793 to 469,193 | 0.0443 to 0.0528 | 342,657 to 428,157 |
| Cover, two settlements on two chains | 536,609 | 0.0600 | 500,397 |
| Ack (`Settled`; incl. cron unsubscribe) | 118,299 to 123,180 | 0.0161 to 0.0171 | 61,183 to 70,828 |
| Probe reaction (counter only) | n/a | 0.0134 | 34,191 |

**Per closed single-chain loop on v1: about 0.083 to 0.093 lREACT** (invoice 0.021 to 0.023, cover 0.044 to 0.053, ack 0.017) **plus 4.24e-6 ETH on Base** (576k to 611k callback gas at 0.006 gwei × 1.1, plus 80k extra gas; the first sweep of each pay address deploys its vault). Unichain callback: 644,786 gas, 1.17e-6 ETH. The cross-chain loop cost 0.0252 + 0.0321 + 0.0600 + 0.0161 + 0.0171 = 0.1506 lREACT plus both destination fees. The MCP's `get_rc_health` assumes about 0.016 lREACT per reaction; real Daybook reactions are 1.6× to 3.75× that.

## Measurements asked for

- **Two subscriptions matching one transfer are delivered once.** The probe subscribed (Base, USDC, Transfer, any, X, any), the same again, and (Base, any contract, Transfer, any, X, any). The identical pair collapsed to one filter at subscribe time (`list_subscriptions`: 2 filters), and one USDC transfer to X produced exactly one `react()` (counter 1 after 40+ s). Daybook's `seen` dedupe was never exercised live: no `DuplicateDelivery` appeared in any loop (`deliveries = 1` everywhere).
- **320k reserve and peak gas.** Peak live reaction 536,609 gas (two settlements). The second request adds about 100k to 140k gas (536,609 against single-settlement covers of 398,793 to 469,193), the range GAS_RESERVE was sized for. With the 900k cap, a reaction that has spent about 430k on matching and the first request still has about 470k left, above the 320k reserve, so the second request goes out in the same transaction, as observed. Nothing seen live contradicts the harness, so no contract change was made.
- **Callback gas.** v1 `settle` with a real EAS attestation used 576k to 645k at the destination, within the 1.3M limit (MCP: about 1,139,144 reaches the target after proxy overhead). v0's 250k receipt allowance failed live (`ReceiptFailed` in `0xe4f04843…6cfb`), matching M-3.
- **Cron.** Every settlement subscribed cron in the cover and unsubscribed it in the ack one or two seconds later. No cron tick was ever billed (all v1 contract spend, 0.448 lREACT, is matched by traced reactions and acks).

## Surprises

1. **Concurrent source edits broke the first v0 invoice.** The security fixes were being written into `contracts/src` while v0 was live, so `CreateInvoice.s.sol` compiled the new `watchAllTokens` field against the v0 contract's `strictTokens`. Same type, opposite meaning: v0 invoice 1 came out watch-all. It closed and unsubscribed on cover, so it was never exposed. After that, every v0 script ran from a worktree pinned to the deployed commit `d8b866b` (the Sourcify sources were confirmed identical to it).
2. **The v1 deploy scripts disagree on the factory address.** `foundry.toml` compiles `DaybookReactive.sol` through via-IR, and that pulls `DeployReactive.s.sol`'s whole compilation unit into the IR profile. So `type(PayAddressFactory).creationCode` there is the IR build (`0xA798…D33c`), while `DeployTill.s.sol` builds and deploys the legacy one (`0xAa4A…1D04`). Fixed for this deployment by creating the IR factory by hand on both chains and deploying the tills with `forge create`. The scripts still need a fix (DECISIONS.md).
3. **Forge did not route the salted CREATE through the CREATE2 deployer on Unichain Sepolia** during the v0 deploy (it worked on Base); the simulation reverted and nothing was sent. The factory was then created with a direct call to `0x4e59…956C`.
4. **`getCallbacks` is always empty on Lasna** and no `CallbackPosted` event exists in the last 30,000 blocks (`trace_reactive_tx`). The tracer therefore finds callbacks by `Settled(invoiceId, seq)` logs on the destination.
5. **Lasna stamps run 1 to 2 s behind Base.** See Latency.
6. **RPC limits.** Base public RPC: `eth_getLogs` at most 200 blocks (40 s). Lasna: at most 30,000 blocks, old blocks not served, and an `eth_sendRawTransaction` fee cap of 1 ether (forge's default 2× base fee times a 6.3M gas limit exceeded it; deploys need `--with-gas-price 100gwei`). Receipts report `effectiveGasPrice = 0`.
7. **Sourcify failed on byte-identical code on Unichain** (`bytecode_length_mismatch`) for three v0 contracts that verified exact on Base; it worked for v1.
8. **Address collisions across chains.** Equal deployer nonces gave the v0 till the same address on both chains, and gave the v1 Unichain till and vault the same addresses as the superseded v1-a Base till and vault.

## Probe source

`DoubleSubProbe` (deployed `0x2C10…bA05`, compiled 0.8.30, optimizer on): a reactive contract whose constructor makes the three subscriptions above, whose `react()` increments a counter and emits `Reacted(n, contract, txHash, logIndex)`, and whose `close()` unsubscribes and returns its balance. It was closed after the measurement (`0xc45d5d7c345d302919b6852e2c0ee380b60a09c2f2e34ff0eb220fbfcb021915`).

## Reproducing a trace

```
cd scripts
node src/trace/cli.ts --loop <label> --chain <84532|1301> --tx <origin tx> \
  --reactive 0x182BA62E240433B54136712d8840Ccc354bb78d3 [--wait 300] [--notes "..."]
```
