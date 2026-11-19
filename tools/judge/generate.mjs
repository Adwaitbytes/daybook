#!/usr/bin/env node
// Generates README.md and JUDGE.md from evidence/summary.json (written by `make summary` from evidence/loops.csv,
// the contract list, the test runs and a pinned chain snapshot) and the repo's own package manifests. Text is never
// edited by hand, so a number in the docs cannot drift from the data. `--check` exits 1 if either file differs.
// Node built-ins only.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const json = (p) => JSON.parse(read(p));
const s = json("evidence/summary.json");

const REPO_URL = "https://github.com/Adwaitbytes/daybook";
const CHAIN = {
  5318007: { name: "Reactive Lasna", tx: "https://lasna.reactscan.net/tx/", addr: "https://lasna.reactscan.net/address/" },
  84532: { name: "Base Sepolia", tx: "https://sepolia.basescan.org/tx/", addr: "https://sepolia.basescan.org/address/" },
  1301: { name: "Unichain Sepolia", tx: "https://unichain-sepolia.blockscout.com/tx/", addr: "https://unichain-sepolia.blockscout.com/address/" },
};

// ---------------------------------------------------------------- formatting

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const usdc = (raw) => {
  const v = BigInt(raw);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
};
/** Wei of lREACT rounded half up to `dp` decimals. */
const lreact = (wei, dp = 4) => {
  const scale = 10n ** BigInt(18 - dp);
  const q = (BigInt(wei) + scale / 2n) / scale;
  const t = q.toString().padStart(dp + 1, "0");
  return `${t.slice(0, -dp)}.${t.slice(-dp)}`;
};
/** Wei of lREACT truncated to four decimals, as the Health page prints it. */
const lreactPage = (wei) => {
  const t = BigInt(wei).toString().padStart(19, "0");
  return `${t.slice(0, -18)}.${t.slice(-18, -14)}`;
};
/** Wei of ETH as a short decimal, three significant figures. */
const eth = (wei) => Number(BigInt(wei)) / 1e18;
const ethText = (wei) => `${eth(wei).toPrecision(3)} ETH`;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const date = (ms) => {
  const d = new Date(ms);
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
};
const time = (ms) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
const short = (h) => `${h.slice(0, 10)}…${h.slice(-4)}`;
const txLink = (chainId, h) => `[\`${short(h)}\`](${CHAIN[chainId].tx}${h})`;
const addrLink = (chainId, a) => `[\`${a}\`](${CHAIN[chainId].addr}${a})`;
const chainName = (id) => CHAIN[id].name;
const sourcifyText = (c) => (c.sourcify === null ? "not verified" : c.sourcify);

// ---------------------------------------------------------------- shared facts

const L = s.loops;
const H = s.chain.health;
const V1 = s.chain.v1;
const asOf = `${date(s.asOf.lasnaTimeMs)}, ${time(s.asOf.lasnaTimeMs)} (Lasna block ${grouped(s.asOf.lasnaBlock)})`;
const base = L.originToCallbackMsBase;
const current = s.contracts.filter((c) => c.deployment === "v1");
const byName = (name, chainId) => current.find((c) => c.name === name && c.chainId === chainId);
const reactive = byName("DaybookReactive", 5318007);
const resends = V1.settlements.resends + s.chain.v0.settlements.resends;
const firstCommit = execFileSync("git", ["log", "--reverse", "--format=%cs"], { cwd: REPO, encoding: "utf8" }).split("\n")[0];

const kindLabel = {
  "v1-L1-exact": "Exact payment on Base",
  "v1-L2-partial": "Partial payment, a wrong token, then the rest",
  "v1-L3-overpay": "Overpayment (1.50 on a 1.00 invoice)",
  "v1-L4-wrongtoken": "Wrong token flagged on a watch-all invoice, then paid",
  "v1-L5-crosschain": "Half on Base, half on Unichain",
  "v0-L1-exact": "Exact payment on the superseded v0 deployment",
};

function sampleTable(samples) {
  const rows = samples.map(
    (x) =>
      `| ${x.loop}${x.seq ? ` (seq ${x.seq})` : ""} | ${kindLabel[x.loop] ?? x.notes} | ${chainName(x.originChain)} ${txLink(x.originChain, x.originTx)} | ${txLink(5318007, x.reactiveTx)} | ${chainName(x.callbackChain)} ${txLink(x.callbackChain, x.callbackTx)} | ${txLink(5318007, x.ackTx)} |`,
  );
  return [
    "| Loop | What it tests | Origin transfer | Reactive tx (Lasna) | Callback | Ack (Lasna) |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function untracedTable() {
  const u = s.chain.untraced;
  if (u.length === 0) return "";
  const rows = u.map(
    (x) =>
      `| ${x.invoiceId} | ${x.seq} | ${usdc(BigInt(x.amount) + BigInt(x.excess))} | ${x.origins.map((o) => `${chainName(o.chainId)} ${txLink(o.chainId, o.tx)}`).join(", ")} | ${txLink(5318007, x.requestTx)} | ${x.callbackTx === null ? "not found" : `${chainName(x.chainId)} ${txLink(x.chainId, x.callbackTx)}`} | ${x.ackTx === null ? "none yet" : txLink(5318007, x.ackTx)} |`,
  );
  return [
    "| Invoice | Seq | USDC | Origin transfer | Reactive tx (Lasna) | Callback | Ack (Lasna) |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function contractTable(list) {
  return [
    "| Contract | Chain | Address | Sourcify |",
    "|---|---|---|---|",
    ...list.map(
      (c) =>
        `| ${c.name} | ${chainName(c.chainId)} | ${addrLink(c.chainId, c.address)} | [${sourcifyText(c)}](https://repo.sourcify.dev/${c.chainId}/${c.address}) |`,
    ),
  ].join("\n");
}

function ledgerTable() {
  return [
    "| Invoice | Status | Amount | Paid | Ledger entries | Received at the pay address | Swept by callbacks | Accepted token left | Other tokens left (flagged) |",
    "|---|---|---|---|---|---|---|---|---|",
    ...V1.lines.map(
      (l) =>
        `| ${l.id} | ${l.status} | ${usdc(l.amount)} | ${usdc(l.paid)} | ${l.entries} | ${usdc(l.received)} | ${usdc(l.settled)} | ${usdc(l.leftAccepted)} | ${l.leftOther.length === 0 ? "none" : l.leftOther.map((o) => `${usdc(o.raw)} of ${short(o.token)} on ${chainName(o.chainId)}`).join(", ")} |`,
    ),
  ].join("\n");
}

const inflowText = () => {
  const f = V1.inflows;
  const parts = [`${f.matched} matched to an invoice`];
  if (f.flaggedWrongToken > 0) parts.push(`${f.flaggedWrongToken} flagged as a wrong token`);
  if (f.unwatchedToken > 0) parts.push(`${f.unwatchedToken} in a token the invoice does not accept and does not watch, so it was never delivered`);
  if (f.afterClose > 0) parts.push(`${f.afterClose} sent after the invoice closed`);
  if (f.zeroValue > 0) parts.push(`${f.zeroValue} zero-value`);
  parts.push(`${f.unrecorded} unaccounted for`);
  return `${f.total} transfers into v1 pay addresses on both payment chains: ${parts.join(", ")}`;
};

const testsLine = () => {
  const t = s.tests;
  return `${t.forge.passed} of ${t.forge.total} Foundry tests pass (${t.forge.unit} unit, ${t.forge.fuzz} fuzz, ${t.forge.invariant} invariant, in ${t.forge.suites} suites), ${t.web.passed} of ${t.web.total} web tests (${t.web.skipped} skipped: the live database test, which needs \`DATABASE_URL\`), ${t.scripts.passed} of ${t.scripts.total} CLI and tracer tests and ${t.verify.passed} of ${t.verify.total} verify tests`;
};

const limitsInline = [
  "**Testnet only.** Everything runs on Reactive Lasna, Base Sepolia and Unichain Sepolia with test USDC. I have no mainnet funds for Daybook right now, so there is no mainnet deployment, no real money in it and no mainnet history to show.",
  "**Amounts are public.** Invoice amounts, pay addresses, payers and the split are on chain for anyone to read. Only client names and notes stay off chain, and the chain holds just their hash.",
  "**Trust in Reactive.** Settlement depends on Reactive Network delivering the payment log and relaying the callback. If it stops, money waits safely at the pay address and the owner can sweep it by hand (`DaybookTill.sweep`), but nothing settles on its own.",
  `**Unaudited, so capped.** The contracts had an internal adversarial review (docs/SECURITY_REVIEW.md) and no external audit. Read from chain at the snapshot, the till caps are ${Object.entries(s.chain.caps.maxSettlementUsdc).map(([id, v]) => `${usdc(v)} USDC per settlement on ${chainName(id)}`).join(" and ")}, and the reactive contract refuses any invoice above ${usdc(s.chain.caps.maxInvoiceAmount)} USDC.`,
  "**The REACT balance runs out.** Every reaction is paid from the reactive contract's lREACT. When it hits zero the contract goes into debt and the network stops calling it until someone tops it up; the Health page shows the balance and how many reactions it still pays for.",
];

// ---------------------------------------------------------------- dependencies

function dependencies() {
  const lock = json("contracts/foundry.lock");
  const ci = read(".github/workflows/ci.yml");
  const env = (k) => new RegExp(`${k}: "?([^"\\n]+)"?`).exec(ci)?.[1] ?? "?";
  const rows = [
    ["Foundry (forge, cast)", env("FOUNDRY_VERSION").replace(/^v/, ""), "build, test, deploy"],
    ["Node.js", `${env("NODE_VERSION")} or later`, "web app, CLI, tracer, verify"],
    ["pnpm", env("PNPM_VERSION"), "package manager"],
  ];
  for (const [path, v] of Object.entries(lock)) rows.push([path.replace("lib/", ""), v.tag.name, "Solidity library (git submodule)"]);
  const pkgs = [
    ["web/package.json", "web app"],
    ["scripts/package.json", "CLI and loop tracer"],
    ["tools/verify/package.json", "make verify and make summary"],
    ["tools/smoke/package.json", "smoke test of the live site"],
  ];
  const seen = new Map();
  for (const [p, use] of pkgs) {
    const pkg = json(p);
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const key = `${name}@${v}`;
      if (seen.has(key)) seen.get(key).uses.add(use);
      else seen.set(key, { name, v, uses: new Set([use]) });
    }
  }
  for (const d of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))) rows.push([d.name, d.v, [...d.uses].join(", ")]);
  rows.push(["Slither", env("SLITHER_VERSION"), "static analysis in CI"]);
  rows.push(["gitleaks", env("GITLEAKS_VERSION"), "secret scan of the full history in CI"]);
  return ["| Dependency | Version | Used for |", "|---|---|---|", ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`)].join("\n");
}

// ---------------------------------------------------------------- README.md

const hero = L.samples.find((x) => x.loop === "v1-L1-exact") ?? L.samples[0];
const crossChain = L.samples.find((x) => x.loop === "v1-L5-crosschain");

function readme() {
  return `<!-- Generated by tools/judge/generate.mjs from evidence/summary.json. Edit the generator, then run \`make docs\`. -->

# Daybook

Daybook is an invoice that marks itself paid: the client sends USDC to one address on Base Sepolia or Unichain Sepolia, and a reactive contract on Reactive Network matches the payment, sweeps it, sets tax aside, pays the team split and issues a receipt, with no server of mine involved.

In ${L.settlementsClosed} traced settlements across ${L.invoicesSettled} invoices, every payment that should have closed did close on the first send${resends === 0 ? ", with no resend" : ""}. Measured on Base Sepolia's millisecond block clock, the settlement callback landed a median ${secs(base.p50)} after the payment (n = ${base.n}, range ${secs(base.min)} to ${secs(base.max)}).

Daybook runs on testnets only: Reactive Lasna, Base Sepolia and Unichain Sepolia, with Circle's test USDC. I have no mainnet funds for it right now, so there is no mainnet deployment and no real money has gone through it.

## Live site, video and addresses

- Live site: ${s.site}. You can try it without a wallet: press **Pay a demo invoice** on the home page. A demo wallet sends 0.10 test USDC on Base Sepolia to a real demo invoice, and you watch its pay page go from waiting to Paid as the reaction, the settlement callback and the acknowledgement land.
- Video: coming
- Health, read from chain as of ${asOf}: running since ${date(H.runningSinceMs)}, ${H.invoicesSettled} of ${H.invoicesIssued} invoices settled, ${lreactPage(H.reactSpentWei)} lREACT spent on ${H.samples} measured reactions. The live numbers are at ${s.site}/health.

Current deployment (v1). Every contract is verified on Sourcify; the superseded v0 and the unused v1-a are in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

${contractTable(current)}

## The problem

Getting paid in stablecoins sounds simple until you do it every month. Someone has to watch several explorers, work out which transfer belongs to which invoice, mark it paid somewhere, send a receipt, move the tax share aside and pay the people who did the work. Every one of those steps is manual, and every one is a chance to get it wrong. Anyone who invoices in USDC has this problem, and it grows with each chain a client might pay from.

I built Daybook for my own company's invoices.

## How it works

\`\`\`mermaid
sequenceDiagram
    participant Client as Client wallet or exchange
    participant Pay as Pay address (same on every chain)
    participant RC as DaybookReactive (Reactive Lasna)
    participant Till as DaybookTill (payment chain)
    Client->>Pay: USDC Transfer on Base Sepolia or Unichain Sepolia
    Pay-->>RC: Transfer log (subscribed by pay address)
    RC->>RC: match invoice, dedupe, ledger entry
    RC->>Till: settle callback on the chain that holds the money
    Till->>Till: sweep, tax to SavingsVault, team split, rest to treasury, EAS receipt
    Till-->>RC: Settled log
    RC->>RC: ack: settlement closed, invoice Settled, unsubscribe
\`\`\`

1. I create an invoice directly on the reactive contract: amount, accepted chains and tokens, due date and a split policy. Its pay address comes from CREATE2 through a factory at the same address on every payment chain, so it is the same everywhere and needs no deployment until it is swept.
2. On creation the contract subscribes, per accepted chain and token, to \`Transfer\` logs whose recipient is the pay address. On settlement it unsubscribes with exactly the same arguments.
3. When a matching transfer lands, the reaction checks the token and amount, records partial payments and overpayments in an on-chain ledger, and once the invoice is covered asks the till on that chain to settle.
4. The till sweeps the pay address, sends the tax share to the savings vault, pays the team, sends the rest to the treasury and issues an EAS attestation to the payer. Its \`Settled\` log comes back to the reactive contract as the acknowledgement; a missing ack is resent on a cron tick.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the details, including how pay addresses are derived and what each contract may do.

## Why it needs Reactive

The client pays with a plain USDC transfer from any wallet or exchange. A transfer to an address runs no code of mine on the payment chain, so nothing on that chain can notice it, let alone settle it. Something has to watch logs on several chains and then act on the chain where the money is.

Without Reactive that something is a server: a process polling each chain's RPC and holding a key that can sweep pay addresses. If it is down, invoices sit unpaid. If it is compromised, the key can move the money. A cron job is the same server on a timer: it still needs my machine, my RPC keys and a hot key, and it only notices payments when it next wakes up.

With Reactive the subscriptions are state of the reactive contract, the network runs the reaction when the log appears, and the callback reaches the till through the chain's callback proxy. The till accepts \`settle\` only from that proxy and only on behalf of my reactive contract, so no key of mine sits anywhere online. If the website and its database disappear, payments still reconcile and settle; the web app's database-down test covers the site side of that.

## One real loop, hop by hop

Invoice ${hero.invoiceId} on v1, ${usdc(hero.amountRaw)} USDC, paid exactly on Base Sepolia (${hero.loop} in [evidence/loops.csv](evidence/loops.csv)).

| Hop | Transaction | Block time | What happened |
|---|---|---|---|
| 1. Payment | ${chainName(hero.originChain)} ${txLink(hero.originChain, hero.originTx)} | ${time(hero.originTsMs).replace(" UTC", "")}.${String(hero.originTsMs % 1000).padStart(3, "0")} | The client's USDC transfer to the pay address |
| 2. Reaction | Lasna ${txLink(5318007, hero.reactiveTx)} | ${time(hero.reactiveTsMs)} | Matched invoice ${hero.invoiceId}, wrote the ledger entry, requested settlement ${hero.seq}; cost ${lreact(hero.reactiveCostWei)} lREACT |
| 3. Callback | ${chainName(hero.callbackChain)} ${txLink(hero.callbackChain, hero.callbackTx)} | ${time(hero.callbackTsMs).replace(" UTC", "")}.${String(hero.callbackTsMs % 1000).padStart(3, "0")} | The till swept the pay address, split the money and issued the EAS receipt; ${grouped(hero.callbackGas)} gas, ${ethText(hero.destFeeWei)} |
| 4. Ack | Lasna ${txLink(5318007, hero.ackTx)} | ${time(hero.ackTsMs)} | The \`Settled\` log closed the settlement and the invoice; cost ${lreact(hero.ackCostWei)} lREACT |

The callback landed ${secs(hero.originToCallbackMs)} after the payment on Base's own millisecond clock. Lasna stamps whole seconds and runs one to two seconds behind Base, which is why its times above look earlier than the payment; cross-chain differences are kept raw in the CSV and never reported as latency (docs/FIRST_LOOPS.md, Latency).${crossChain === undefined ? "" : ` The cross-chain case, ${crossChain.loop}, is in [JUDGE.md](JUDGE.md).`}

## Evidence and how to reproduce it

From [evidence/loops.csv](evidence/loops.csv), ${L.rows} rows written by the loop tracer (\`scripts/src/trace\`), one per traced payment and settlement, failures kept:

| Measure | Value |
|---|---|
| Payments traced | ${L.payments} |
| Settlements closed (payment, reaction, callback, ack) | ${L.settlementsClosed} |
| Invoices settled in the traced loops | ${L.invoicesSettled} |
| Settlements left unclosed | ${L.unclosed} |
| Wrong-token transfers flagged on a watch-all invoice | ${L.wrongTokenFlagged} |
| Wrong-token transfers not delivered to an accepted-token invoice, as designed | ${L.wrongTokenNotDelivered} |
| Payments delivered more than once | ${L.deliveriesAboveOne} |
| EAS receipts issued / failed | ${L.receiptsAttested} / ${L.receiptsFailed} (the failure is the v0 gas limit the security review predicted) |
| Payment to callback, Base Sepolia ms clock | median ${secs(base.p50)}, range ${secs(base.min)} to ${secs(base.max)}, n = ${base.n} |
| Reaction to ack on Lasna | ${secs(L.reactionToAckMs.min)} to ${secs(L.reactionToAckMs.max)}, n = ${L.reactionToAckMs.n} |
| lREACT per single-chain loop on v1 (cover plus ack) | ${lreact(L.v1CoverPlusAckWei.min)} to ${lreact(L.v1CoverPlusAckWei.max)}, n = ${L.v1CoverPlusAckWei.n}, plus about 0.02 lREACT to create the invoice |
| Callback fee on Base Sepolia | ${ethText(L.destFeeWei["84532"].min)} to ${ethText(L.destFeeWei["84532"].max)}, n = ${L.destFeeWei["84532"].n} |

From chain, at ${asOf}, for the whole v1 deployment including the live demo: ${V1.entries} ledger entries; ${inflowText()}; ${V1.settlements.splitsChecked} settlement splits recomputed from their policies and matched to the transfers in their callbacks; no accepted token left at any settled pay address.

${ledgerTable()}

To reproduce:

\`\`\`
make verify            # re-reads every row, ledger entry, split, contract and doc link from public RPCs and Sourcify
make verify FRESH=1    # the same without the receipt cache
make summary           # rebuilds evidence/summary.json (tests plus a new chain snapshot), then README.md and JUDGE.md
\`\`\`

\`make verify\` rebuilds every number above from RPC data alone, checks the live Health page against chain, writes [evidence/verify-report.json](evidence/verify-report.json) and exits non-zero on any mismatch. The first run takes a few minutes on public RPCs; reruns use the cache in \`tools/verify/.cache\`.

## Run it locally

You need Node 24 or later, pnpm ${env("PNPM_VERSION")} and Foundry ${env("FOUNDRY_VERSION").replace(/^v/, "")}.

\`\`\`
git clone --recurse-submodules ${REPO_URL}
cd daybook
make test                                  # verify's tests, the Foundry suite, then the CLI and tracer tests
cd web && pnpm install && pnpm dev         # http://localhost:3000, reading the live Lasna deployment
\`\`\`

The web app needs no keys to read: it takes the reactive contract's address from docs/DEPLOYMENTS.md and reads everything else from public RPCs. The demo button and the database are optional and show a designed state when unset (\`web/.env.example\` lists the variables).

${testsLine()}.

## Limits and trust assumptions

${limitsInline.map((x) => `- ${x}`).join("\n")}

The full list, including spam with real tokens, owner trust and token quirks, is in [docs/LIMITS.md](docs/LIMITS.md).

## Dependencies and what was built during the event

Everything in this repository was written during the event: the first commit is from ${date(Date.parse(`${firstCommit}T00:00:00Z`))} and every commit since is later. Shared tooling (the writing check, the Slither gate, the smoke test and parts of verify) is copied between my three entries so each repository stands alone.

${dependencies()}

MIT licensed.
`;
}

function env(k) {
  return new RegExp(`${k}: "?([^"\\n]+)"?`).exec(read(".github/workflows/ci.yml"))?.[1] ?? "?";
}

// ---------------------------------------------------------------- JUDGE.md

function judge() {
  const t = s.tests;
  const v0 = s.chain.v0;
  return `<!-- Generated by tools/judge/generate.mjs from evidence/summary.json. Edit the generator, then run \`make docs\`. -->

# Daybook for judges

Ten minutes, four criteria. Each section starts with the fastest way to check it yourself. Chain numbers are as of ${asOf}; \`make verify\` rebuilds all of them from public RPCs.

Daybook runs on testnets only (Reactive Lasna, Base Sepolia, Unichain Sepolia). I have no mainnet funds for it right now.

## Execution

Five closed loops from [evidence/loops.csv](evidence/loops.csv), each with its four transactions: the payment, the reaction on Lasna, the settlement callback and the acknowledgement on Lasna.

${sampleTable(L.samples)}

- ${L.settlementsClosed} settlements closed out of ${L.payments} traced payments (${L.rows} CSV rows, failures kept). ${L.unclosed} left unclosed; ${resends === 0 ? "no settlement needed a resend" : `${resends} settlement requests were resends`}.
- Payment to callback on Base Sepolia's millisecond clock: median ${secs(base.p50)}, p90 ${secs(base.p90)}, range ${secs(base.min)} to ${secs(base.max)}, n = ${base.n}.
- Each payment was delivered exactly once (${L.deliveriesAboveOne} duplicate deliveries).
${s.chain.untraced.length === 0 ? "" : `\nSettled through the live demo after the traced runs, read from chain and not yet in loops.csv:\n\n${untracedTable()}\n`}
Check it: open any link above, or run \`make verify\`, which re-derives every field of every CSV row from receipts and logs and compares it (${L.rows} rows).

## Integration

- Dynamic subscriptions: each invoice subscribes to \`Transfer\` into its pay address on creation and unsubscribes with the same arguments on settlement ([ARCHITECTURE.md](docs/ARCHITECTURE.md)).
- Callbacks to two chains from one reaction: ${crossChain === undefined ? "see loops.csv" : `${crossChain.loop} paid half on Base and half on Unichain; the covering reaction sent one settlement to each chain and each was acknowledged on its own`}.
- Cron only while timed work is open, resend on a missing ack, and receipts through EAS on each payment chain.

Verified contracts (current v1 deployment):

${contractTable(current)}

The superseded v0 (${v0.invoices.settled} invoice settled, kept visible) and the unused v1-a are in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md), with why each was replaced.

## Usefulness

Trigger your own loop without a wallet:

1. Open ${s.site} and press **Pay a demo invoice**. A demo wallet sends 0.10 test USDC on Base Sepolia to a real open demo invoice.
2. Follow **Open its pay page**. It shows the payment seen, then stamps Paid with the receipt and the three linked transactions once the till's settlement is acknowledged.
3. Open ${s.site}/ledger for every inflow, matched or flagged, with a CSV export, and ${s.site}/health for how long it has run and what it cost.

Health from chain at the snapshot: running since ${date(H.runningSinceMs)}, ${H.invoicesSettled} of ${H.invoicesIssued} invoices settled, ${H.invoicesOpen} open, ${lreactPage(H.reactSpentWei)} lREACT spent on ${H.samples} measured reactions.

The ledger, rebuilt from chain: ${inflowText()}. ${V1.settlements.splitsChecked} of ${V1.settlements.acked} acknowledged settlements had their tax, team and treasury shares recomputed from the policy and matched to the callback's transfers, and no accepted token was left at a settled pay address.

## Craft

\`\`\`
make test      # verify's unit tests, forge test, then the CLI and tracer tests
make ci        # everything CI runs: fmt, build, tests, coverage, Slither, lint, typecheck, writing check, secret scan
make verify    # every published number against chain
\`\`\`

- ${testsLine()}.
- Fuzz and invariant tests cover matching and split arithmetic, no funds left in a swept address, splits summing to the amount and an invoice settling at most once.
- An adversarial security review with proof tests ([SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)); its High and Medium findings were fixed before v1 went live.
- README.md and this file are generated from [evidence/summary.json](evidence/summary.json) by \`tools/judge/generate.mjs\`; \`make docs-check\` fails if either differs from the generator's output.

Evidence tables, with n:

| Table | n | Where |
|---|---|---|
| Loop rows (traced payments and settlements) | ${L.rows} | [evidence/loops.csv](evidence/loops.csv) |
| Closed settlements | ${L.settlementsClosed} | same |
| Ledger entries, v1, from chain | ${V1.entries} | \`make verify\` |
| Inflows to v1 pay addresses, from chain | ${V1.inflows.total} | same |
| Settlement splits checked | ${V1.settlements.splitsChecked} | same |
| Contracts checked for code and Sourcify status | ${s.contracts.length} | [evidence/verify-report.json](evidence/verify-report.json) |

## Limits

${limitsInline.slice(0, 5).map((x) => `- ${x}`).join("\n")}

Everything else is in [docs/LIMITS.md](docs/LIMITS.md).
`;
}

// ---------------------------------------------------------------- write or check

const outputs = [
  ["README.md", readme()],
  ["JUDGE.md", judge()],
];
const check = process.argv.includes("--check");
const stale = [];
for (const [name, text] of outputs) {
  const path = join(REPO, name);
  let old = "";
  try {
    old = readFileSync(path, "utf8");
  } catch {
    old = "";
  }
  if (old === text) continue;
  if (check) stale.push(name);
  else writeFileSync(path, text);
}
if (check && stale.length > 0) {
  console.log(`${stale.join(" and ")} differ from what tools/judge/generate.mjs makes from evidence/summary.json; run make docs`);
  process.exit(1);
}
