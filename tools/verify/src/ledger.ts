import { type Address, type Hex, getAddress } from "viem";
import { LEDGER_KINDS, type LedgerKind, TOPIC } from "./abi.ts";
import {
  type InvoiceEv,
  type ReactiveSnapshot,
  type Transfer,
  decodeSettled,
  firstSettled,
  getInvoice,
  getPolicy,
  stateAt,
  tillReserve,
  transfersIn,
} from "./chaindata.ts";
import { PAYMENT_CHAINS } from "./config.ts";
import { type Ctx, rpcFor } from "./loops.ts";
import { payAddress } from "./payaddress.ts";
import type { Report } from "./report.ts";
import { topicOf } from "./rpc.ts";

/** Pinned blocks a chain snapshot is read at. Payment chains are pinned a minute before the Lasna block, so every
 * transfer inside the scan has had time to be delivered and recorded on Lasna by the Lasna block. */
export type Pins = { lasnaBlock: string; lasnaTimeMs: number; payment: Record<string, string> };

export type InvoiceLine = {
  id: string;
  status: string;
  amount: string;
  paid: string;
  entries: number;
  /** Raw units of accepted tokens received at the pay address, all chains. */
  received: string;
  /** Raw units swept by settlement callbacks (amount plus excess). */
  settled: string;
  /** Accepted-token raw units still at the pay address at the pinned blocks. */
  leftAccepted: string;
  /** Non-accepted tokens still at the pay address (flagged, never swept by a callback). */
  leftOther: { chainId: number; token: Address; raw: string }[];
};

export type LedgerSummary = {
  deployment: string;
  reactive: Address;
  invoices: { issued: number; settled: number; open: number; paid: number; cancelled: number; expired: number };
  entries: number;
  byKind: Record<LedgerKind, number>;
  inflows: {
    total: number;
    matched: number;
    flaggedWrongToken: number;
    unwatchedToken: number;
    afterClose: number;
    zeroValue: number;
    unrecorded: number;
  };
  /** `resends` counts SettlementRequested logs beyond the first for a seq (cron resends after a missing ack). */
  settlements: { requested: number; resends: number; acked: number; callbacks: number; splitsChecked: number };
  lines: InvoiceLine[];
  /** Every settlement with the transactions of its loop, in seq order. */
  loops: SettlementLoop[];
};

export type SettlementLoop = {
  seq: string;
  invoiceId: string;
  chainId: number;
  amount: string;
  excess: string;
  /** Origin transfers of the invoice's counted ledger entries on this settlement's chain. */
  origins: { chainId: number; tx: Hex }[];
  requestTx: Hex;
  callbackTx: Hex | null;
  ackTx: Hex | null;
};

const SECTION = "ledger";

const key = (chainId: number, tx: Hex, logIndex: number) => `${chainId}:${tx.toLowerCase()}:${logIndex}`;

/**
 * Rebuilds a deployment's ledger from chain at pinned blocks: every inflow to every pay address on every payment
 * chain is matched to a ledger entry or flagged, each entry is checked against its origin transfer, per-invoice
 * totals are recomputed, every settlement's split is recomputed from its policy and checked against the transfers in
 * its callback, and settled pay addresses must hold no accepted token.
 */
export async function rebuildLedger(ctx: Ctx, snap: ReactiveSnapshot, pins: Pins, report: Report): Promise<LedgerSummary> {
  const sec = report.section(SECTION);
  const dep = snap.dep;
  const tag = dep.label;
  const lasnaHead = await ctx.lasna.head();
  const invoices = snap.invoices.sort((a, b) => Number(a.id - b.id));
  sec.rows += invoices.length;

  // Pay addresses recomputed offline from the factory.
  for (const inv of invoices) {
    report.eq(SECTION, `${tag} invoice ${inv.id}`, "pay address (CREATE2 from factory)", inv.payAddress, payAddress(dep.factory, dep.reactive, inv.id));
  }

  // Inflows and outflows of every pay address on each payment chain, up to the pinned block.
  const byPay = new Map<Address, InvoiceEv>(invoices.map((i) => [i.payAddress, i]));
  const payTopics = invoices.map((i) => topicOf(BigInt(i.payAddress)));
  const inflows: (Transfer & { chainId: number; ms: number })[] = [];
  const outflows: (Transfer & { chainId: number })[] = [];
  if (invoices.length > 0) {
    const firstCreated = Number((await ctx.lasna.stamp(invoices[0]?.block ?? 0n)).ms / 1000);
    for (const ch of PAYMENT_CHAINS) {
      const rpc = rpcFor(ctx, ch.id);
      const to = BigInt(pins.payment[String(ch.id)] ?? "0");
      if (to === 0n) throw new Error(`no pinned block for ${ch.name}`);
      const from = await rpc.blockAtOrBefore(firstCreated - 120, to);
      const [ins, outs] = await Promise.all([
        rpc.logs({ topics: [TOPIC.transfer, null, payTopics] }, from, to),
        rpc.logs({ topics: [TOPIC.transfer, payTopics] }, from, to),
      ]);
      for (const t of transfersIn(ins)) inflows.push({ ...t, chainId: ch.id, ms: (await rpc.stamp(t.block)).ms });
      for (const t of transfersIn(outs)) outflows.push({ ...t, chainId: ch.id });
    }
  }

  // Ledger entries, each checked against its origin transfer.
  const entryByKey = new Map(snap.ledger.map((e) => [key(e.chainId, e.originTx, e.logIndex), e]));
  const inflowKeys = new Set(inflows.map((t) => key(t.chainId, t.tx, t.logIndex)));
  for (const e of snap.ledger) {
    const item = `${tag} ledger ${e.index}`;
    const inv = invoices.find((i) => i.id === e.invoiceId);
    if (inv === undefined) {
      report.error(SECTION, item, new Error(`entry names invoice ${e.invoiceId}, which has no InvoiceCreated`));
      continue;
    }
    const r = await rpcFor(ctx, e.chainId).receipt(e.originTx);
    const t = transfersIn(r.logs).find((x) => x.logIndex === e.logIndex);
    report.eq(SECTION, item, "origin Transfer exists", "yes", t === undefined ? "no" : "yes");
    if (t === undefined) continue;
    report.eq(SECTION, item, "token", e.token, t.token);
    report.eq(SECTION, item, "payer", e.payer, t.from);
    report.eq(SECTION, item, "pay address", inv.payAddress, t.to);
    report.eq(SECTION, item, "amount", e.amount, t.value);
    const accepted = inv.accepted.some((a) => a.chainId === e.chainId && a.token === e.token);
    report.eq(SECTION, item, "WrongToken exactly when the token is not accepted", accepted ? "counted" : "WrongToken", e.kind === "WrongToken" ? "WrongToken" : "counted");
    const pin = BigInt(pins.payment[String(e.chainId)] ?? "0");
    if (BigInt(r.blockNumber) <= pin) report.eq(SECTION, item, "entry's transfer found by the inflow scan", "yes", inflowKeys.has(key(e.chainId, e.originTx, e.logIndex)) ? "yes" : "no");
  }

  // Close time of each invoice (first InvoicePaid, cancel or expiry), for transfers that arrive after unsubscribe.
  const closedAt = new Map<bigint, number>();
  for (const ev of [...snap.paid, ...snap.cancelled, ...snap.expired]) {
    const ms = (await ctx.lasna.stamp(ev.block)).ms;
    const prev = closedAt.get(ev.id);
    if (prev === undefined || ms < prev) closedAt.set(ev.id, ms);
  }

  const counts = { total: inflows.length, matched: 0, flaggedWrongToken: 0, unwatchedToken: 0, afterClose: 0, zeroValue: 0, unrecorded: 0 };
  for (const t of inflows) {
    const inv = byPay.get(t.to);
    if (inv === undefined) continue;
    const e = entryByKey.get(key(t.chainId, t.tx, t.logIndex));
    const item = `${tag} inflow ${t.chainId}:${t.tx}:${t.logIndex}`;
    if (e !== undefined) {
      if (e.kind === "WrongToken") counts.flaggedWrongToken++;
      else counts.matched++;
      continue;
    }
    if (t.value === 0n) {
      counts.zeroValue++;
      continue;
    }
    const accepted = inv.accepted.some((a) => a.chainId === t.chainId && a.token === t.token);
    const closed = closedAt.get(inv.id);
    if (!accepted && !inv.watchAll) {
      counts.unwatchedToken++;
      sec.notes.push(`${item}: ${t.value} of non-accepted token ${t.token} to invoice ${inv.id}; not watched by design (accepted-token watch), left at the pay address`);
    } else if (closed !== undefined && t.ms > closed) {
      counts.afterClose++;
      sec.notes.push(`${item}: arrived after invoice ${inv.id} closed and unsubscribed; left at the pay address for the owner`);
    } else {
      counts.unrecorded++;
      report.eq(SECTION, item, "inflow recorded in the ledger", "recorded", "missing");
    }
  }

  // Settlements: first request per seq, its ack, its callback and the split inside it.
  const firstReq = new Map<string, (typeof snap.requests)[number]>();
  for (const q of snap.requests) if (!firstReq.has(q.seq.toString())) firstReq.set(q.seq.toString(), q);
  const swept = new Map<string, bigint>();
  const counted = new Map<string, bigint>();
  let callbacks = 0;
  let splitsChecked = 0;
  const settlementLoops: SettlementLoop[] = [];
  for (const q of firstReq.values()) {
    const item = `${tag} settlement ${q.seq}`;
    const inv = invoices.find((i) => i.id === q.invoiceId);
    if (inv === undefined) {
      report.error(SECTION, item, new Error("request names an unknown invoice"));
      continue;
    }
    const pairKey = `${inv.id}:${q.chainId}:${q.token}`;
    swept.set(pairKey, (swept.get(pairKey) ?? 0n) + q.amount + q.excess);
    const ack = snap.acks.find((a) => a.seq === q.seq);
    const loop: SettlementLoop = {
      seq: q.seq.toString(),
      invoiceId: q.invoiceId.toString(),
      chainId: q.chainId,
      amount: q.amount.toString(),
      excess: q.excess.toString(),
      origins: snap.ledger
        .filter((e) => e.invoiceId === q.invoiceId && e.kind !== "WrongToken")
        .map((e) => ({ chainId: e.chainId, tx: e.originTx })),
      requestTx: q.tx,
      callbackTx: null,
      ackTx: ack?.tx ?? null,
    };
    settlementLoops.push(loop);
    if (ack === undefined) {
      sec.notes.push(`${item}: requested, not acknowledged by the pinned block`);
      continue;
    }
    const till = dep.tills[q.chainId];
    if (till === undefined) throw new Error(`no till on ${q.chainId}`);
    const rpc = rpcFor(ctx, q.chainId);
    const reqS = (await ctx.lasna.stamp(q.block)).ms / 1000;
    const ackS = (await ctx.lasna.stamp(ack.block)).ms / 1000;
    const pin = BigInt(pins.payment[String(q.chainId)] ?? "0");
    const from = await rpc.blockAtOrBefore(Math.floor(reqS) - 30, pin);
    const to = await rpc.blockAtOrBefore(Math.ceil(ackS) + 15, pin);
    const log = await firstSettled(rpc, till, q.invoiceId, q.seq, from, to);
    report.eq(SECTION, item, "callback Settled log between request and ack", "found", log === undefined ? "missing" : "found");
    if (log === undefined) continue;
    callbacks++;
    loop.callbackTx = log.transactionHash;
    const s = decodeSettled(log);
    report.eq(SECTION, item, "callback amount", q.amount, s.amount);
    report.eq(SECTION, item, "callback excess", q.excess, s.excess);
    report.eq(SECTION, item, "callback token", q.token, s.token);
    const receipt = await rpc.receipt(log.transactionHash);
    const block = BigInt(receipt.blockNumber);
    const policy = await getPolicy(ctx.lasna, dep.reactive, inv.policyId, lasnaHead);
    const reserve = await tillReserve(rpc, till, block);
    const moves = transfersIn(receipt.logs).filter((t) => t.token === q.token);
    const sweep = moves.filter((t) => t.from === inv.payAddress && t.to === till).reduce((a, t) => a + t.value, 0n);
    report.eq(SECTION, item, "swept from the pay address", q.amount + q.excess, sweep);
    const redirected = receipt.logs.some((l) => getAddress(l.address) === till && l.topics[0] === TOPIC.payoutRedirected);
    const actual = new Map<Address, bigint>();
    for (const t of moves.filter((x) => x.from === till)) actual.set(t.to, (actual.get(t.to) ?? 0n) + t.value);
    const paidOut = [...actual.values()].reduce((a, v) => a + v, 0n);
    report.eq(SECTION, item, "split sums to the swept amount", sweep, paidOut);
    if (redirected) {
      sec.notes.push(`${item}: a payout was redirected to the treasury; per-recipient shares not compared`);
    } else {
      const expected = new Map<Address, bigint>();
      const add = (a: Address, v: bigint) => {
        if (v > 0n) expected.set(a, (expected.get(a) ?? 0n) + v);
      };
      const tax = (q.amount * BigInt(policy.taxBps)) / 10_000n;
      let spent = tax;
      add(reserve, tax);
      for (const m of policy.team) {
        const share = (q.amount * BigInt(m.bps)) / 10_000n;
        spent += share;
        add(m.account, share);
      }
      add(policy.treasury, q.amount - spent + q.excess);
      const fmt = (m: Map<Address, bigint>) =>
        [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([a, v]) => `${a}=${v}`).join(",");
      report.eq(SECTION, item, "split per recipient (tax, team, treasury)", fmt(expected), fmt(actual));
    }
    splitsChecked++;
  }

  // Per-invoice totals and what is left at each pay address.
  const lines: InvoiceLine[] = [];
  for (const inv of invoices) {
    const item = `${tag} invoice ${inv.id}`;
    const state = stateAt(snap, inv.id);
    const entries = snap.ledger.filter((e) => e.invoiceId === inv.id);
    const norm = (e: (typeof entries)[number]) => {
      const dec = inv.accepted.find((a) => a.chainId === e.chainId && a.token === e.token)?.decimals ?? 6;
      const raw = e.amount - e.excess;
      return dec === 6 ? raw : dec > 6 ? raw / 10n ** BigInt(dec - 6) : raw * 10n ** BigInt(6 - dec);
    };
    const paid = entries.filter((e) => e.kind === "Payment").reduce((a, e) => a + norm(e), 0n);
    for (const e of entries.filter((x) => x.kind !== "WrongToken")) {
      const k = `${inv.id}:${e.chainId}:${e.token}`;
      counted.set(k, (counted.get(k) ?? 0n) + e.amount);
    }
    if (state === "Settled" || state === "Paid") report.eq(SECTION, item, "paid covers the amount", "yes", paid >= inv.amount ? "yes" : "no");
    const live = await getInvoice(ctx.lasna, dep.reactive, inv.id, lasnaHead);
    report.eq(SECTION, item, "pay address stored on the contract", inv.payAddress, live.payAddress);
    report.eq(SECTION, item, "amount stored on the contract", inv.amount, live.amount);
    // Settled is final, so the stored total can be compared with the one rebuilt from entries at the pin.
    if (state === "Settled") report.eq(SECTION, item, "paid (rebuilt from Payment entries) equals stored paid", live.paid, paid);

    let received = 0n;
    let settledRaw = 0n;
    let leftAccepted = 0n;
    const leftOther: InvoiceLine["leftOther"] = [];
    const tokens = new Map<string, { chainId: number; token: Address }>();
    for (const t of [...inflows, ...outflows]) {
      if (t.to === inv.payAddress || t.from === inv.payAddress) tokens.set(`${t.chainId}:${t.token}`, { chainId: t.chainId, token: t.token });
    }
    for (const { chainId, token } of tokens.values()) {
      const inSum = inflows.filter((t) => t.chainId === chainId && t.token === token && t.to === inv.payAddress).reduce((a, t) => a + t.value, 0n);
      const outSum = outflows.filter((t) => t.chainId === chainId && t.token === token && t.from === inv.payAddress).reduce((a, t) => a + t.value, 0n);
      const net = inSum - outSum;
      const accepted = inv.accepted.some((a) => a.chainId === chainId && a.token === token);
      if (accepted) {
        received += inSum;
        leftAccepted += net;
        const k = `${inv.id}:${chainId}:${token}`;
        settledRaw += swept.get(k) ?? 0n;
        if (state === "Settled") {
          report.eq(SECTION, item, `accepted token left at the pay address on ${chainId}`, 0n, net);
          report.eq(SECTION, item, `recorded inflows equal settled amount on ${chainId}`, counted.get(k) ?? 0n, swept.get(k) ?? 0n);
        }
      } else if (net !== 0n) {
        leftOther.push({ chainId, token, raw: net.toString() });
      }
    }
    lines.push({
      id: inv.id.toString(),
      status: state,
      amount: inv.amount.toString(),
      paid: paid.toString(),
      entries: entries.length,
      received: received.toString(),
      settled: settledRaw.toString(),
      leftAccepted: leftAccepted.toString(),
      leftOther,
    });
  }

  const byKind = Object.fromEntries(LEDGER_KINDS.map((k) => [k, snap.ledger.filter((e) => e.kind === k).length])) as Record<LedgerKind, number>;
  const status = lines.map((l) => l.status);
  const count = (s: string) => status.filter((x) => x === s).length;
  return {
    deployment: tag,
    reactive: dep.reactive,
    invoices: {
      issued: lines.length,
      settled: count("Settled"),
      open: count("Open"),
      paid: count("Paid"),
      cancelled: count("Cancelled"),
      expired: count("Expired"),
    },
    entries: snap.ledger.length,
    byKind,
    inflows: counts,
    settlements: {
      requested: firstReq.size,
      resends: snap.requests.length - firstReq.size,
      acked: [...firstReq.values()].filter((q) => snap.acks.some((a) => a.seq === q.seq)).length,
      callbacks,
      splitsChecked,
    },
    lines,
    loops: settlementLoops,
  };
}
