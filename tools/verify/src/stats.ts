import type { Row } from "./csv.ts";

/** Nearest-rank percentile of a sorted list: the smallest value with at least q of the sample at or below it. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) throw new Error("percentile of an empty sample");
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] as number;
}

export type Dist = { n: number; min: number; p50: number; p90: number; max: number };

export function dist(values: number[]): Dist | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, min: s[0] as number, p50: percentile(s, 0.5), p90: percentile(s, 0.9), max: s[s.length - 1] as number };
}

type WeiRange = { n: number; min: string; max: string };
function weiRange(values: bigint[]): WeiRange | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { n: s.length, min: (s[0] as bigint).toString(), max: (s[s.length - 1] as bigint).toString() };
}

export type SampleLoop = {
  loop: string;
  deployment: string;
  invoiceId: string;
  seq: string;
  originChain: number;
  callbackChain: number;
  originTx: string;
  reactiveTx: string;
  callbackTx: string;
  ackTx: string;
  amountRaw: string;
  token: string;
  originTsMs: number;
  reactiveTsMs: number;
  callbackTsMs: number;
  ackTsMs: number;
  reactiveCostWei: string;
  ackCostWei: string;
  callbackGas: string;
  destFeeWei: string;
  originToCallbackMs: number;
  originClock: string;
  callbackClock: string;
  receipt: string;
  notes: string;
};

export type LoopStats = {
  rows: number;
  byStatus: Record<string, number>;
  /** Distinct payments traced (origin tx and log index), trace errors excluded. */
  payments: number;
  settlementsClosed: number;
  /** Distinct (deployment, invoice) pairs with at least one closed settlement. */
  invoicesSettled: number;
  unclosed: number;
  wrongTokenNotDelivered: number;
  wrongTokenFlagged: number;
  deliveriesAboveOne: number;
  receiptsAttested: number;
  receiptsFailed: number;
  /** Origin transfer to callback, both on Base Sepolia's millisecond clock. */
  originToCallbackMsBase: Dist | null;
  /** Origin transfer to callback on Unichain Sepolia's whole-second clock. */
  originToCallbackMsUnichain: Dist | null;
  /** Reaction to ack, both on Lasna's whole-second clock. */
  reactionToAckMs: Dist | null;
  /** v1 only: fee of each cover reaction that requested one settlement, each ack, and their sum per loop. */
  v1CoverWei: WeiRange | null;
  v1AckWei: WeiRange | null;
  v1CoverPlusAckWei: WeiRange | null;
  /** Destination callback fee, wei of ETH, per chain. */
  destFeeWei: Record<string, WeiRange>;
  callbackGas: Record<string, WeiRange>;
  samples: SampleLoop[];
};

const deployment = (r: Row) => ((r.loop ?? "").startsWith("v0") ? "v0" : "v1");

/** Everything README and JUDGE.md say about the traced loops, computed from evidence/loops.csv alone. */
export function loopStats(rows: Row[]): LoopStats {
  const traced = rows.filter((r) => r.loop_status !== "trace_error");
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.loop_status ?? ""] = (byStatus[r.loop_status ?? ""] ?? 0) + 1;
  const closed = traced.filter((r) => r.loop_status === "closed");
  const payments = new Set(traced.map((r) => `${r.origin_chain}:${r.origin_tx}:${r.origin_log_index}`));
  const invoices = new Set(closed.map((r) => `${deployment(r)}:${r.invoice_id}`));
  const ms = (r: Row) => Number(r.origin_to_callback_ms);
  const base = closed.filter((r) => r.origin_chain === "84532" && r.callback_chain === "84532" && r.origin_clock === "ms" && r.callback_clock === "ms");
  const uni = closed.filter((r) => r.origin_chain === "1301" && r.callback_chain === "1301");
  const v1 = closed.filter((r) => deployment(r) === "v1");
  const single = v1.filter((r) => closed.filter((x) => x.reactive_tx === r.reactive_tx).length === 1);
  const uniqueBy = <T>(list: Row[], k: keyof Row & string, f: (r: Row) => T) => [...new Map(list.map((r) => [r[k], f(r)])).values()];
  const destFeeWei: Record<string, WeiRange> = {};
  const callbackGas: Record<string, WeiRange> = {};
  for (const id of ["84532", "1301"]) {
    const on = closed.filter((r) => r.callback_chain === id && deployment(r) === "v1");
    const fee = weiRange(on.map((r) => BigInt(r.dest_fee_wei ?? "0")));
    const gas = weiRange(on.map((r) => BigInt(r.callback_gas ?? "0")));
    if (fee !== null) destFeeWei[id] = fee;
    if (gas !== null) callbackGas[id] = gas;
  }
  // One sample per scenario label: the label's last closed settlement, v1 first, then v0, five in all.
  const labels = [...new Set(closed.map((r) => r.loop ?? ""))];
  const last = labels.map((l) => closed.filter((r) => r.loop === l).at(-1) as Row);
  const ordered = [...last.filter((r) => deployment(r) === "v1"), ...last.filter((r) => deployment(r) === "v0")];
  const samples: SampleLoop[] = ordered.slice(0, 5).map((r) => ({
    loop: r.loop ?? "",
    deployment: deployment(r),
    invoiceId: r.invoice_id ?? "",
    seq: r.settlement_seqs ?? "",
    originChain: Number(r.origin_chain),
    callbackChain: Number(r.callback_chain),
    originTx: r.origin_tx ?? "",
    reactiveTx: r.reactive_tx ?? "",
    callbackTx: r.callback_tx ?? "",
    ackTx: r.ack_tx ?? "",
    amountRaw: r.amount_raw ?? "",
    token: r.token ?? "",
    originTsMs: Number(r.origin_ts_ms),
    reactiveTsMs: Number(r.reactive_ts_ms),
    callbackTsMs: Number(r.callback_ts_ms),
    ackTsMs: Number(r.ack_ts_ms),
    reactiveCostWei: r.reactive_cost_wei ?? "",
    ackCostWei: r.ack_cost_wei ?? "",
    callbackGas: r.callback_gas ?? "",
    destFeeWei: r.dest_fee_wei ?? "",
    originToCallbackMs: ms(r),
    originClock: r.origin_clock ?? "",
    callbackClock: r.callback_clock ?? "",
    receipt: r.receipt_outcome ?? "",
    notes: (r.notes ?? "").split(";")[0] ?? "",
  }));
  return {
    rows: rows.length,
    byStatus,
    payments: payments.size,
    settlementsClosed: closed.length,
    invoicesSettled: invoices.size,
    unclosed: traced.filter((r) => r.loop_status === "no_callback" || r.loop_status === "no_ack").length,
    wrongTokenNotDelivered: traced.filter((r) => r.loop_status === "no_reaction").length,
    wrongTokenFlagged: traced.filter((r) => r.ledger_kind === "WrongToken").length,
    deliveriesAboveOne: traced.filter((r) => Number(r.deliveries) > 1).length,
    receiptsAttested: closed.filter((r) => (r.receipt_outcome ?? "").startsWith("Attested(")).length,
    receiptsFailed: closed.filter((r) => (r.receipt_outcome ?? "").startsWith("ReceiptFailed")).length,
    originToCallbackMsBase: dist(base.map(ms)),
    originToCallbackMsUnichain: dist(uni.map(ms)),
    reactionToAckMs: dist(closed.map((r) => Number(r.ack_ts_ms) - Number(r.reactive_ts_ms))),
    v1CoverWei: weiRange(uniqueBy(single, "reactive_tx", (r) => BigInt(r.reactive_cost_wei ?? "0"))),
    v1AckWei: weiRange(uniqueBy(v1, "ack_tx", (r) => BigInt(r.ack_cost_wei ?? "0"))),
    v1CoverPlusAckWei: weiRange(single.map((r) => BigInt(r.reactive_cost_wei ?? "0") + BigInt(r.ack_cost_wei ?? "0"))),
    destFeeWei,
    callbackGas,
    samples,
  };
}
