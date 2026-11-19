import { type Address, type Hex, getAddress } from "viem";
import { TOPIC } from "./abi.ts";
import {
  type ReactiveSnapshot,
  callbackFee,
  decodeSettled,
  firstSettled,
  invoiceOfPayAddress,
  logStamp,
  reactionFee,
  receiptOutcome,
} from "./chaindata.ts";
import { V0, V1 } from "./config.ts";
import type { Row } from "./csv.ts";
import type { Report } from "./report.ts";
import type { RawLog, Rpc } from "./rpc.ts";

export type Ctx = { lasna: Rpc; byChain: Map<number, Rpc>; fresh: boolean };

export function rpcFor(ctx: Ctx, chainId: number): Rpc {
  const r = ctx.byChain.get(chainId);
  if (r === undefined) throw new Error(`no RPC for chain ${chainId}`);
  return r;
}

/** Fields the tracer derives from chain, in evidence/loops.csv column order. `loop`, `notes` and `traced_at` are
 * the operator's label and the trace time, so they are not chain data. */
const DERIVED = [
  "invoice_id",
  "origin_chain",
  "token",
  "amount_raw",
  "origin_ts_ms",
  "origin_clock",
  "deliveries",
  "ledger_kind",
  "reactive_tx",
  "reactive_block",
  "reactive_ts_ms",
  "reactive_gas",
  "reactive_cost_wei",
  "settlement_seqs",
  "callback_chain",
  "callback_tx",
  "callback_status",
  "callback_ts_ms",
  "callback_clock",
  "callback_gas",
  "dest_fee_wei",
  "receipt_outcome",
  "ack_tx",
  "ack_ts_ms",
  "ack_gas",
  "ack_cost_wei",
  "origin_to_reactive_ms",
  "origin_to_callback_ms",
  "origin_to_ack_ms",
  "loop_status",
] as const;

/** What verify rebuilt for one row, kept for the doc checks (block numbers the CSV does not carry). */
export type RebuiltLoop = { row: Row; rebuilt: Record<string, string>; ackBlock: bigint | null; deployment: "v1" | "v0" };

const SECTION = "loops.csv";

/** Seqs each traced reaction requested, filled while rows are rebuilt. */
const requestedSeqs = new Map<string, string[]>();

/** Which deployment a row belongs to: the tracer labels v0 loops `v0-...`. */
export const deploymentOf = (row: Row) => (row.loop?.startsWith("v0") ? V0 : V1);

/**
 * Re-derives every chain field of every evidence/loops.csv row from the origin, Lasna and destination receipts and
 * logs, and compares it with the committed value. Rows the tracer recorded as `trace_error` carry no chain data;
 * verify only checks that a later row traced the same origin transaction.
 */
export async function verifyLoops(
  ctx: Ctx,
  rows: Row[],
  snaps: Map<Address, ReactiveSnapshot>,
  report: Report,
): Promise<RebuiltLoop[]> {
  const sec = report.section(SECTION);
  sec.rows = rows.length;
  const out: RebuiltLoop[] = [];
  for (const [i, row] of rows.entries()) {
    const item = `row ${i + 2} ${row.loop}${row.settlement_seqs ? ` seq ${row.settlement_seqs}` : ""}`;
    if (row.loop_status === "trace_error") {
      const later = rows.slice(i + 1).find((r) => r.origin_tx === row.origin_tx && r.loop_status !== "trace_error");
      report.eq(SECTION, item, "trace_error row has a later trace of the same origin tx", "yes", later === undefined ? "no" : "yes");
      sec.notes.push(`${item}: trace_error row kept (rows are never dropped); the origin tx is traced again in a later row`);
      continue;
    }
    try {
      const rebuilt = await rebuildRow(ctx, row, snaps);
      for (const f of DERIVED) report.eq(SECTION, item, f, row[f], rebuilt.fields[f]);
      out.push({ row, rebuilt: rebuilt.fields, ackBlock: rebuilt.ackBlock, deployment: deploymentOf(row).label });
    } catch (err) {
      report.error(SECTION, item, err);
    }
  }
  // Every settlement a traced reaction requested has its own row.
  const groups = new Map<string, Set<string>>();
  for (const r of out) {
    if (r.rebuilt.reactive_tx === "") continue;
    const k = r.rebuilt.reactive_tx as string;
    const set = groups.get(k) ?? new Set<string>();
    if (r.row.settlement_seqs) set.add(r.row.settlement_seqs);
    groups.set(k, set);
  }
  for (const [tx, seqs] of groups) {
    const requested = requestedSeqs.get(tx) ?? [];
    report.eq(SECTION, `reaction ${tx}`, "settlements with a row", requested.join("+"), [...seqs].sort().join("+"));
  }
  return out;
}

async function rebuildRow(
  ctx: Ctx,
  row: Row,
  snaps: Map<Address, ReactiveSnapshot>,
): Promise<{ fields: Record<string, string>; ackBlock: bigint | null }> {
  const dep = deploymentOf(row);
  const snap = snaps.get(dep.reactive);
  if (snap === undefined) throw new Error(`no snapshot for ${dep.label}`);
  const f: Record<string, string> = Object.fromEntries(DERIVED.map((k) => [k, ""]));
  const originChain = Number(row.origin_chain);
  const oc = rpcFor(ctx, originChain);
  const originTx = row.origin_tx as Hex;
  const logIndex = Number(row.origin_log_index);
  if (row.origin_log_index === "" || !Number.isInteger(logIndex)) throw new Error("row has no origin_log_index");

  const or = await oc.receipt(originTx);
  const log = or.logs.find((l) => Number(BigInt(l.logIndex)) === logIndex);
  if (log === undefined || log.topics[0] !== TOPIC.transfer || log.topics.length !== 3) {
    throw new Error(`origin tx has no ERC-20 Transfer at log index ${logIndex}`);
  }
  const to = getAddress(`0x${(log.topics[2] ?? "").slice(26)}`);
  const stamp = await logStamp(oc, log);
  f.origin_chain = String(originChain);
  f.token = getAddress(log.address);
  f.amount_raw = BigInt(log.data).toString();
  f.origin_ts_ms = String(stamp.ms);
  f.origin_clock = stamp.clock;
  f.invoice_id = (await invoiceOfPayAddress(ctx.lasna, dep.reactive, to, await ctx.lasna.head())).toString();

  const key = (tx: Hex, li: number) => `${tx.toLowerCase()}:${li}`;
  const me = key(originTx, logIndex);
  const entries = snap.ledger.filter((e) => e.chainId === originChain && key(e.originTx, e.logIndex) === me);
  const dups = snap.duplicates.filter((d) => d.chainId === originChain && key(d.originTx, d.logIndex) === me);
  f.deliveries = String(entries.length + dups.length);
  const first = entries[0];
  if (first === undefined) {
    f.loop_status = "no_reaction";
    return { fields: f, ackBlock: null };
  }
  f.ledger_kind = first.kind;
  const lc = ctx.lasna;
  const rr = await lc.receipt(first.tx);
  const rBlock = BigInt(rr.blockNumber);
  const rStamp = await lc.stamp(rBlock);
  const rFee = await reactionFee(lc, dep.reactive, rBlock);
  f.reactive_tx = first.tx;
  f.reactive_block = rBlock.toString();
  f.reactive_ts_ms = String(rStamp.ms);
  f.reactive_gas = BigInt(rr.gasUsed).toString();
  f.reactive_cost_wei = rFee.fee.toString();
  f.origin_to_reactive_ms = String(rStamp.ms - stamp.ms);

  const reqs = snap.requests.filter((q) => q.tx === first.tx);
  requestedSeqs.set(first.tx, reqs.map((q) => q.seq.toString()).sort());
  if (reqs.length === 0) {
    f.loop_status = first.kind === "WrongToken" ? "flagged_no_settlement" : "recorded_partial";
    return { fields: f, ackBlock: null };
  }
  const req = reqs.find((q) => q.seq.toString() === row.settlement_seqs);
  if (req === undefined) {
    throw new Error(`reaction ${first.tx} requested seqs ${reqs.map((q) => q.seq).join(",")}, row says ${row.settlement_seqs || "none"}`);
  }
  f.settlement_seqs = req.seq.toString();
  f.callback_chain = String(req.chainId);
  const dc = rpcFor(ctx, req.chainId);
  const till = dep.tills[req.chainId];
  if (till === undefined) throw new Error(`no till for chain ${req.chainId}`);

  let settledLog: RawLog | undefined;
  if (row.callback_tx !== "") {
    const cr0 = await dc.receipt(row.callback_tx as Hex);
    const cBlock = BigInt(cr0.blockNumber);
    // The first Settled for (invoice, seq): look back from the recorded callback far enough to cover the time
    // since the request (a few seconds), so an earlier settlement would be found instead.
    settledLog = await firstSettled(dc, till, req.invoiceId, req.seq, cBlock - 600n, cBlock);
  } else {
    const head = await dc.head();
    settledLog = await firstSettled(dc, till, req.invoiceId, req.seq, head > 6000n ? head - 6000n : 0n, head);
  }
  if (settledLog === undefined) {
    f.loop_status = "no_callback";
    return { fields: f, ackBlock: null };
  }
  const settled = decodeSettled(settledLog);
  const cr = await dc.receipt(settledLog.transactionHash);
  const cStamp = await logStamp(dc, settledLog);
  const cFee = await callbackFee(dc, req.chainId, till, BigInt(cr.blockNumber));
  f.callback_tx = settledLog.transactionHash;
  f.callback_status = cr.status === "0x1" ? "success" : "reverted";
  f.callback_ts_ms = String(cStamp.ms);
  f.callback_clock = cStamp.clock;
  f.callback_gas = BigInt(cr.gasUsed).toString();
  f.dest_fee_wei = cFee.fee.toString();
  f.origin_to_callback_ms = String(cStamp.ms - stamp.ms);
  f.receipt_outcome = receiptOutcome(cr, till);
  if (settled.seq !== req.seq) throw new Error("Settled seq differs from the request");

  const ack = snap.acks.filter((a) => a.seq === req.seq && a.block >= rBlock).sort((a, b) => Number(a.block - b.block))[0];
  if (ack === undefined) {
    f.loop_status = "no_ack";
    return { fields: f, ackBlock: null };
  }
  const ar = await lc.receipt(ack.tx);
  const aBlock = BigInt(ar.blockNumber);
  const aStamp = await lc.stamp(aBlock);
  const aFee = await reactionFee(lc, dep.reactive, aBlock);
  f.ack_tx = ack.tx;
  f.ack_ts_ms = String(aStamp.ms);
  f.ack_gas = BigInt(ar.gasUsed).toString();
  f.ack_cost_wei = aFee.fee.toString();
  f.origin_to_ack_ms = String(aStamp.ms - stamp.ms);
  f.loop_status = "closed";
  return { fields: f, ackBlock: aBlock };
}
