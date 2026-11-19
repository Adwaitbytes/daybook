import {
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  toEventSelector,
} from "viem";
import { erc20Abi, ledgerKinds, payableAbi, reactiveAbi, tillAbi } from "./abi.ts";
import { type ClockPrecision, LASNA, type PaymentChain, paymentChain } from "./chains.ts";
import { type LoopRow, emptyRow } from "./evidence.ts";

/** A raw log as the node returns it, keeping fields viem's formatter drops (Base's `blockTimestampMs`). */
export type RawLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  blockTimestampMs?: Hex | null;
};

type RawReceipt = { status: Hex; gasUsed: Hex; blockNumber: Hex; transactionHash: Hex; logs: RawLog[] };

export type Stamp = { ms: number; clock: ClockPrecision };

/** Max block span per eth_getLogs call, from the providers' error messages (Base public RPC 200, Lasna 30,000). */
const LOG_SPAN: Record<number, bigint> = { 84_532: 200n, 1301: 2000n, [LASNA.id]: 30_000n };

const TRANSFER = toEventSelector(erc20Abi[0]);
const SETTLED = toEventSelector(tillAbi[0]);
// Both till generations: v0 emitted ReceiptFailed(invoiceId, seq); v1 adds gasLeft.
const RECEIPT_FAILED_V0 = toEventSelector("event ReceiptFailed(uint256 indexed invoiceId, uint256 indexed seq)");
const RECEIPT_FAILED_V1 = toEventSelector(
  "event ReceiptFailed(uint256 indexed invoiceId, uint256 indexed seq, uint256 gasLeft)",
);
const RECEIPT = toEventSelector(tillAbi[1]);

function event(name: string): AbiEvent {
  const e = [...reactiveAbi, ...tillAbi].find((x) => x.type === "event" && x.name === name);
  if (e === undefined || e.type !== "event") throw new Error(`no event ${name}`);
  return e;
}

export function client(rpc: string): PublicClient {
  return createPublicClient({ transport: http(rpc, { retryCount: 4, retryDelay: 750 }) });
}

export function topicOf(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

async function rawReceipt(c: PublicClient, hash: Hex): Promise<RawReceipt> {
  const r = (await c.request({ method: "eth_getTransactionReceipt", params: [hash] })) as RawReceipt | null;
  if (r === null) throw new Error(`no receipt for ${hash}`);
  return r;
}

async function blockStamp(c: PublicClient, block: bigint): Promise<Stamp> {
  const b = (await c.request({
    method: "eth_getBlockByNumber",
    params: [`0x${block.toString(16)}`, false],
  })) as { timestamp: Hex; timestampMs?: Hex } | null;
  if (b === null) throw new Error(`no block ${block}`);
  if (b.timestampMs !== undefined && b.timestampMs !== null) return { ms: Number(BigInt(b.timestampMs)), clock: "ms" };
  return { ms: Number(BigInt(b.timestamp)) * 1000, clock: "s" };
}

/** Prefers the log's own millisecond stamp (Base, Denim) and falls back to the block's whole-second time. */
async function logStamp(c: PublicClient, log: RawLog): Promise<Stamp> {
  if (log.blockTimestampMs !== undefined && log.blockTimestampMs !== null) {
    return { ms: Number(BigInt(log.blockTimestampMs)), clock: "ms" };
  }
  return blockStamp(c, BigInt(log.blockNumber));
}

/** Largest block whose timestamp is at or before `unixSeconds`. Binary search over a window below head sized
 * for blocks as fast as 200 ms, because Lasna's public RPC does not serve its oldest blocks. */
export async function blockAtOrBefore(c: PublicClient, unixSeconds: number): Promise<bigint> {
  const head = await c.getBlock();
  const elapsed = BigInt(Math.max(0, Number(head.timestamp) - unixSeconds));
  const window = elapsed * 6n + 200n;
  let lo = head.number > window ? head.number - window : 0n;
  let hi = head.number;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const b = await c.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) <= unixSeconds) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** eth_getLogs over [from, to] in provider-sized chunks, stopping at the first chunk with a match when `first`. */
export async function getLogsChunked(
  c: PublicClient,
  chainId: number,
  filter: { address: Address; topics: (Hex | null)[] },
  from: bigint,
  to: bigint,
  first = false,
): Promise<RawLog[]> {
  const span = LOG_SPAN[chainId] ?? 1000n;
  const out: RawLog[] = [];
  for (let start = from; start <= to; start += span) {
    const end = start + span - 1n < to ? start + span - 1n : to;
    const logs = (await c.request({
      method: "eth_getLogs",
      params: [
        {
          address: filter.address,
          topics: filter.topics,
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
        },
      ],
    })) as RawLog[];
    out.push(...logs);
    if (first && out.length > 0) break;
  }
  return out;
}

/** balance + reserves - debt of a payer at a block: what it can still spend on fees. */
async function funds(c: PublicClient, payer: Address, service: Address, block: bigint): Promise<bigint> {
  const [bal, res, debt] = await Promise.all([
    c.getBalance({ address: payer, blockNumber: block }),
    c.readContract({ address: service, abi: payableAbi, functionName: "reserves", args: [payer], blockNumber: block }),
    c.readContract({ address: service, abi: payableAbi, functionName: "debt", args: [payer], blockNumber: block }),
  ]);
  return bal + res - debt;
}

/** Fee charged in `block`, as the drop in the payer's spendable funds across it. Also reports how many distinct
 * transactions in that block touched the payer's logs, since the drop then covers all of them. */
async function feeAcross(
  c: PublicClient,
  payer: Address,
  service: Address,
  block: bigint,
): Promise<{ fee: bigint; txsInBlock: number }> {
  const [before, after, logs] = await Promise.all([
    funds(c, payer, service, block - 1n),
    funds(c, payer, service, block),
    c.request({
      method: "eth_getLogs",
      params: [{ address: payer, fromBlock: `0x${block.toString(16)}`, toBlock: `0x${block.toString(16)}` }],
    }) as Promise<RawLog[]>,
  ]);
  return { fee: before - after, txsInBlock: new Set(logs.map((l) => l.transactionHash)).size };
}

export type TraceOptions = {
  loop: string;
  originChain: number;
  originTx: Hex;
  reactive: Address;
  /** Seconds to keep polling for the reaction, callback and ack before recording what was seen. */
  waitSeconds: number;
  notes?: string;
};

type Transfer = { logIndex: number; token: Address; to: Address; value: bigint; stamp: Stamp; block: bigint };

type Settlement = { seq: bigint; chainId: number; invoiceId: bigint };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a value or the deadline passes. */
async function poll<T>(deadline: number, fn: () => Promise<T | undefined>): Promise<T | undefined> {
  for (;;) {
    const v = await fn();
    if (v !== undefined || Date.now() >= deadline) return v;
    await sleep(4000);
  }
}

/**
 * Traces every Transfer in an origin transaction that pays a Daybook pay address: the reactive transaction that
 * recorded it, any settlements it requested, each settlement's callback on its destination chain and the ack.
 * Returns one evidence row per transfer and settlement; a stage that never happened is left blank and the row's
 * `loop_status` says where the loop stopped.
 */
export async function traceOrigin(o: TraceOptions): Promise<LoopRow[]> {
  const origin = paymentChain(o.originChain);
  const oc = client(origin.rpc);
  const lc = client(LASNA.rpc);
  const deadline = Date.now() + o.waitSeconds * 1000;

  const receipt = await rawReceipt(oc, o.originTx);
  const transfers: Transfer[] = [];
  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER || log.topics.length !== 3) continue;
    const to = getAddress(`0x${(log.topics[2] ?? "0x").slice(26)}`);
    transfers.push({
      logIndex: Number(BigInt(log.logIndex)),
      token: getAddress(log.address),
      to,
      value: BigInt(log.data),
      stamp: await logStamp(oc, log),
      block: BigInt(log.blockNumber),
    });
  }
  if (transfers.length === 0) throw new Error(`${o.originTx} has no ERC-20 Transfer`);

  const rows: LoopRow[] = [];
  for (const t of transfers) {
    const invoiceId = await lc.readContract({
      address: o.reactive,
      abi: reactiveAbi,
      functionName: "invoiceOfPayAddress",
      args: [t.to],
    });
    if (invoiceId === 0n) continue;

    const base = emptyRow();
    base.loop = o.loop;
    base.invoice_id = invoiceId.toString();
    base.origin_chain = String(origin.id);
    base.origin_tx = o.originTx;
    base.origin_log_index = String(t.logIndex);
    base.token = t.token;
    base.amount_raw = t.value.toString();
    base.origin_ts_ms = String(t.stamp.ms);
    base.origin_clock = t.stamp.clock;
    base.notes = o.notes ?? "";

    const fromBlock = await blockAtOrBefore(lc, Math.floor(t.stamp.ms / 1000) - 30);
    const ledger = await poll(deadline, async () => {
      const head = await lc.getBlockNumber();
      const logs = await getLogsChunked(
        lc,
        LASNA.id,
        { address: o.reactive, topics: [toEventSelector(event("LedgerRecorded")), null, topicOf(invoiceId)] },
        fromBlock,
        head,
      );
      const mine = logs.filter((l) => {
        const d = decodeEventLog({ abi: reactiveAbi, eventName: "LedgerRecorded", data: l.data, topics: l.topics as [signature: Hex, ...args: Hex[]] });
        return topicOf(d.args.txHash) === o.originTx.toLowerCase() && Number(d.args.logIndex) === t.logIndex;
      });
      return mine.length > 0 ? { logs: mine, head } : undefined;
    });

    if (ledger === undefined) {
      base.loop_status = "no_reaction";
      base.deliveries = "0";
      base.traced_at = new Date().toISOString();
      rows.push(base);
      continue;
    }

    const first = ledger.logs[0] as RawLog;
    const kindLog = decodeEventLog({ abi: reactiveAbi, eventName: "LedgerRecorded", data: first.data, topics: first.topics as [signature: Hex, ...args: Hex[]] });
    base.ledger_kind = ledgerKinds[kindLog.args.kind] ?? String(kindLog.args.kind);
    const dups = await getLogsChunked(
      lc,
      LASNA.id,
      { address: o.reactive, topics: [toEventSelector(event("DuplicateDelivery")), topicOf(invoiceId)] },
      fromBlock,
      ledger.head,
    );
    const dupCount = dups.filter((l) => {
      const d = decodeEventLog({ abi: reactiveAbi, eventName: "DuplicateDelivery", data: l.data, topics: l.topics as [signature: Hex, ...args: Hex[]] });
      return topicOf(d.args.txHash) === o.originTx.toLowerCase() && Number(d.args.logIndex) === t.logIndex;
    }).length;
    base.deliveries = String(ledger.logs.length + dupCount);

    const reactiveTx = first.transactionHash;
    const rr = await rawReceipt(lc, reactiveTx);
    const rBlock = BigInt(rr.blockNumber);
    const rStamp = await blockStamp(lc, rBlock);
    const rFee = await feeAcross(lc, o.reactive, LASNA.system, rBlock);
    base.reactive_tx = reactiveTx;
    base.reactive_block = rBlock.toString();
    base.reactive_ts_ms = String(rStamp.ms);
    base.reactive_gas = BigInt(rr.gasUsed).toString();
    base.reactive_cost_wei = rFee.fee.toString();
    base.origin_to_reactive_ms = String(rStamp.ms - t.stamp.ms);
    if (rFee.txsInBlock > 1) base.notes = join(base.notes, `reactive cost covers ${rFee.txsInBlock} txs in block`);

    const settlements = settlementsIn(rr, o.reactive);
    if (settlements.length === 0) {
      base.loop_status = base.ledger_kind === "WrongToken" ? "flagged_no_settlement" : "recorded_partial";
      base.traced_at = new Date().toISOString();
      rows.push(base);
      continue;
    }
    for (const s of settlements) {
      rows.push(await traceSettlement({ ...base }, s, o, t, rBlock, deadline));
    }
  }
  if (rows.length === 0) throw new Error(`${o.originTx} pays no pay address known to ${o.reactive}`);
  return rows;
}

function join(a: string, b: string): string {
  return a.length === 0 ? b : `${a}; ${b}`;
}

function settlementsIn(r: RawReceipt, reactive: Address): Settlement[] {
  const sel = toEventSelector(event("SettlementRequested"));
  return r.logs
    .filter((l) => getAddress(l.address) === reactive && l.topics[0] === sel)
    .map((l) => {
      const d = decodeEventLog({ abi: reactiveAbi, eventName: "SettlementRequested", data: l.data, topics: l.topics as [signature: Hex, ...args: Hex[]] });
      return { seq: d.args.seq, chainId: Number(d.args.chainId), invoiceId: d.args.invoiceId };
    });
}

async function traceSettlement(
  row: LoopRow,
  s: Settlement,
  o: TraceOptions,
  t: Transfer,
  reactiveBlock: bigint,
  deadline: number,
): Promise<LoopRow> {
  const dest: PaymentChain = paymentChain(s.chainId);
  const dc = client(dest.rpc);
  const lc = client(LASNA.rpc);
  row.settlement_seqs = s.seq.toString();
  row.callback_chain = String(dest.id);

  const till = await lc.readContract({ address: o.reactive, abi: reactiveAbi, functionName: "tillOf", args: [BigInt(dest.id)] });
  const reactiveStamp = Number(row.reactive_ts_ms);
  const destFrom = await blockAtOrBefore(dc, Math.floor(Math.min(t.stamp.ms, reactiveStamp) / 1000) - 5);

  // Settled can repeat for one (invoiceId, seq) on a duplicate delivery; the first one is the settlement.
  const settled = await poll(deadline, async () => {
    const head = await dc.getBlockNumber();
    const logs = await getLogsChunked(
      dc,
      dest.id,
      { address: till, topics: [SETTLED, topicOf(s.invoiceId), topicOf(s.seq)] },
      destFrom,
      head,
      true,
    );
    return logs[0];
  });
  if (settled === undefined) {
    row.loop_status = "no_callback";
    row.traced_at = new Date().toISOString();
    return row;
  }
  const cr = await rawReceipt(dc, settled.transactionHash);
  const cStamp = await logStamp(dc, settled);
  const cFee = await feeAcross(dc, till, dest.callbackProxy, BigInt(cr.blockNumber));
  row.callback_tx = settled.transactionHash;
  row.callback_status = cr.status === "0x1" ? "success" : "reverted";
  row.callback_ts_ms = String(cStamp.ms);
  row.callback_clock = cStamp.clock;
  row.callback_gas = BigInt(cr.gasUsed).toString();
  row.dest_fee_wei = cFee.fee.toString();
  row.origin_to_callback_ms = String(cStamp.ms - t.stamp.ms);
  row.receipt_outcome = receiptOutcome(cr, till);

  const ackSel = toEventSelector(event("SettlementAcked"));
  const ack = await poll(deadline, async () => {
    const head = await lc.getBlockNumber();
    const logs = await getLogsChunked(lc, LASNA.id, { address: o.reactive, topics: [ackSel, topicOf(s.seq)] }, reactiveBlock, head, true);
    return logs[0];
  });
  if (ack === undefined) {
    row.loop_status = "no_ack";
    row.traced_at = new Date().toISOString();
    return row;
  }
  const ar = await rawReceipt(lc, ack.transactionHash);
  const aBlock = BigInt(ar.blockNumber);
  const aStamp = await blockStamp(lc, aBlock);
  const aFee = await feeAcross(lc, o.reactive, LASNA.system, aBlock);
  row.ack_tx = ack.transactionHash;
  row.ack_ts_ms = String(aStamp.ms);
  row.ack_gas = BigInt(ar.gasUsed).toString();
  row.ack_cost_wei = aFee.fee.toString();
  row.origin_to_ack_ms = String(aStamp.ms - t.stamp.ms);
  if (aFee.txsInBlock > 1) row.notes = join(row.notes, `ack cost covers ${aFee.txsInBlock} txs in block`);
  row.loop_status = "closed";
  row.traced_at = new Date().toISOString();
  return row;
}

function receiptOutcome(r: RawReceipt, till: Address): string {
  const mine = r.logs.filter((l) => getAddress(l.address) === till);
  const failed = mine.find((l) => l.topics[0] === RECEIPT_FAILED_V0 || l.topics[0] === RECEIPT_FAILED_V1);
  if (failed !== undefined) {
    return failed.topics[0] === RECEIPT_FAILED_V1 ? `ReceiptFailed(gasLeft=${BigInt(failed.data)})` : "ReceiptFailed";
  }
  const rec = mine.find((l) => l.topics[0] === RECEIPT);
  if (rec === undefined) return "none";
  const uid = `0x${rec.data.slice(-64)}`;
  return /^0x0+$/.test(uid) ? "Receipt(no uid)" : `Attested(${uid})`;
}
