import "server-only";
import { type Address, decodeEventLog, getAddress, type PublicClient, toEventSelector } from "viem";
import { daybookReactiveAbi, daybookTillAbi } from "@/generated/abis";
import { LASNA, PAYMENT_CHAINS, type PaymentChain, paymentChain, tokenSymbol } from "@/lib/chains";
import { payAddress } from "@/lib/pay-address";
import {
  type AcceptedPair,
  type Clock,
  ENTRY_KINDS,
  type Hex,
  type Hop,
  INVOICE_STATUS,
  type InvoiceSnapshot,
  type LedgerLine,
  SETTLEMENT_STATUS,
  type SettlementLine,
} from "@/lib/types";
import { chainClient, lasna, onNetwork } from "./rpc";
import { loadCallback, saveCallback } from "./store";

/**
 * Reads Daybook state from chain and keeps what can never change (ledger lines, block times, transaction hops)
 * in memory, so a refresh only asks for what is new. The ledger on DaybookReactive is append-only, events are
 * final once read, and a settlement's callback transaction never moves, which is what makes caching safe.
 */

type RawLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  blockTimestampMs?: Hex | null;
};

const LEDGER_RECORDED = toEventSelector(eventAbi("LedgerRecorded"));
const SETTLEMENT_REQUESTED = toEventSelector(eventAbi("SettlementRequested"));
const SETTLEMENT_ACKED = toEventSelector(eventAbi("SettlementAcked"));
const SETTLED = toEventSelector(
  findEvent(daybookTillAbi, "Settled") ?? raise("Settled event missing from DaybookTill ABI"),
);

function raise(msg: string): never {
  throw new Error(msg);
}

type AbiItem = { type: string; name?: string };
function findEvent<A extends readonly AbiItem[]>(abi: A, name: string) {
  const e = abi.find((x) => x.type === "event" && x.name === name);
  return e as Extract<A[number], { type: "event" }> | undefined;
}
function eventAbi(name: string) {
  return findEvent(daybookReactiveAbi, name) ?? raise(`${name} event missing from DaybookReactive ABI`);
}

export function topicOf(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

const sortedTopics = (topics: Hex[]) => topics as [signature: Hex, ...args: Hex[]];

// ---------------------------------------------------------------- per-contract cache

type RequestInfo = { seq: string; invoiceId: string; chainId: number; hop: Hop };
type CallbackInfo = { hop: Hop; uid: Hex };

type Cache = {
  reactive: Address;
  startBlock: bigint | null;
  scannedTo: bigint;
  ledger: LedgerLine[];
  ledgerHops: Map<string, Hop>;
  requests: Map<string, RequestInfo>;
  acks: Map<string, Hop>;
  callbacks: Map<string, CallbackInfo>;
  callbackMisses: Map<string, number>;
  lastRefresh: number;
  inflight: Promise<void> | null;
};

const caches = new Map<Address, Cache>();
const lasnaBlockTimes = new Map<bigint, number>();
const originTimes = new Map<string, { at: number; clock: Clock }>();

function cacheFor(reactive: Address): Cache {
  let c = caches.get(reactive);
  if (c === undefined) {
    c = {
      reactive,
      startBlock: null,
      scannedTo: 0n,
      ledger: [],
      ledgerHops: new Map(),
      requests: new Map(),
      acks: new Map(),
      callbacks: new Map(),
      callbackMisses: new Map(),
      lastRefresh: 0,
      inflight: null,
    };
    caches.set(reactive, c);
  }
  return c;
}

// ---------------------------------------------------------------- reads

export type Core = {
  factory: Address;
  owner: Address;
  invoiceCount: bigint;
  policyCount: number;
  seqCount: bigint;
  tills: { chain: PaymentChain; till: Address | null }[];
};

const coreCache = new Map<Address, { at: number; value: Core }>();

/** Factory and owner never change; tills and counters change rarely, so a 30 s cache is safe for reads. */
export async function readCore(reactive: Address, needInvoice?: bigint): Promise<Core> {
  const hit = coreCache.get(reactive);
  if (
    hit !== undefined &&
    Date.now() - hit.at < 30_000 &&
    (needInvoice === undefined || needInvoice <= hit.value.invoiceCount)
  ) {
    return hit.value;
  }
  const value = await readCoreUncached(reactive);
  coreCache.set(reactive, { at: Date.now(), value });
  return value;
}

async function readCoreUncached(reactive: Address): Promise<Core> {
  return onNetwork("Reactive Lasna", async () => {
    const c = lasna();
    const r = { address: reactive, abi: daybookReactiveAbi } as const;
    const [factory, owner, invoiceCount, policyCount, seqCount, ...tills] = await Promise.all([
      c.readContract({ ...r, functionName: "FACTORY" }),
      c.readContract({ ...r, functionName: "owner" }),
      c.readContract({ ...r, functionName: "nextInvoiceId" }),
      c.readContract({ ...r, functionName: "nextPolicyId" }),
      c.readContract({ ...r, functionName: "nextSeq" }),
      ...PAYMENT_CHAINS.map((ch) => c.readContract({ ...r, functionName: "tillOf", args: [BigInt(ch.id)] })),
    ]);
    return {
      factory,
      owner,
      invoiceCount,
      policyCount: Number(policyCount),
      seqCount,
      tills: PAYMENT_CHAINS.map((chain, i) => {
        const t = tills[i];
        return { chain, till: t === undefined || /^0x0+$/.test(t) ? null : t };
      }),
    };
  });
}

async function lasnaBlockTime(c: PublicClient, block: bigint): Promise<number> {
  const known = lasnaBlockTimes.get(block);
  if (known !== undefined) return known;
  const b = await c.getBlock({ blockNumber: block });
  const ms = Number(b.timestamp) * 1000;
  lasnaBlockTimes.set(block, ms);
  return ms;
}

/** First Lasna block worth scanning: the deploy block if known, else a block safely before the first invoice. */
async function findStartBlock(c: PublicClient, reactive: Address, deployBlock: bigint | null): Promise<bigint> {
  if (deployBlock !== null) return deployBlock;
  const head = await c.getBlock();
  const first = await c.readContract({
    address: reactive,
    abi: daybookReactiveAbi,
    functionName: "getInvoice",
    args: [1n],
  });
  const target = first.createdAt === 0n ? Number(head.timestamp) - 3600 : Number(first.createdAt) - 120;
  // Lasna averages about 1.06 s a block; start 10% further back and step back until we are before the target.
  const behind = BigInt(Math.ceil(((Number(head.timestamp) - target) / (LASNA.blockMs / 1000)) * 1.1)) + 200n;
  let from = head.number > behind ? head.number - behind : 0n;
  for (let i = 0; i < 6 && from > 0n; i++) {
    const b = await c.getBlock({ blockNumber: from });
    if (Number(b.timestamp) <= target) break;
    from = from > behind ? from - behind : 0n;
  }
  return from;
}

async function getLogs(
  c: PublicClient,
  filter: { address: Address; topics: (Hex | Hex[] | null)[] },
  from: bigint,
  to: bigint,
): Promise<RawLog[]> {
  return (await c.request({
    method: "eth_getLogs",
    params: [
      {
        address: filter.address,
        topics: filter.topics,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ],
  } as never)) as RawLog[];
}

function readEntry(
  raw: {
    token: Address;
    chainId: bigint;
    kind: number;
    payer: Address;
    invoiceId: bigint;
    logIndex: number;
    amount: bigint;
    excess: bigint;
    txHash: bigint;
  },
  index: number,
): LedgerLine {
  const chainId = Number(raw.chainId);
  const symbol = tokenSymbol(chainId, raw.token);
  return {
    index,
    invoiceId: raw.invoiceId.toString(),
    kind: ENTRY_KINDS[raw.kind] ?? "WrongToken",
    chainId,
    token: getAddress(raw.token),
    symbol,
    decimals: symbol === "USDC" ? 6 : null,
    payer: getAddress(raw.payer),
    amount: raw.amount.toString(),
    excess: raw.excess.toString(),
    originTx: topicOf(raw.txHash),
    logIndex: raw.logIndex,
    originAt: null,
    originClock: null,
    reactive: null,
  };
}

async function refresh(cache: Cache, deployBlock: bigint | null): Promise<void> {
  const c = lasna();
  const r = { address: cache.reactive, abi: daybookReactiveAbi } as const;

  // New ledger lines (append-only, so only indices past what we hold).
  const length = Number(await c.readContract({ ...r, functionName: "ledgerLength" }));
  if (length > cache.ledger.length) {
    const idx = Array.from({ length: length - cache.ledger.length }, (_, i) => cache.ledger.length + i);
    const raws = await Promise.all(
      idx.map((i) => c.readContract({ ...r, functionName: "ledgerEntry", args: [BigInt(i)] })),
    );
    raws.forEach((raw, i) => {
      cache.ledger.push(readEntry(raw, idx[i] ?? 0));
    });
  }

  // Events since the last scan: which reactive transaction wrote each line, each settlement request and ack.
  if (cache.startBlock === null) {
    if (length === 0) return;
    cache.startBlock = await findStartBlock(c, cache.reactive, deployBlock);
    cache.scannedTo = cache.startBlock - 1n;
  }
  const head = await c.getBlockNumber();
  const ranges: [bigint, bigint][] = [];
  for (let s = cache.scannedTo + 1n; s <= head; s += LASNA.logSpan) {
    ranges.push([s, s + LASNA.logSpan - 1n < head ? s + LASNA.logSpan - 1n : head]);
  }
  const chunks = await Promise.all(
    ranges.map(([a, b]) =>
      getLogs(
        c,
        { address: cache.reactive, topics: [[LEDGER_RECORDED, SETTLEMENT_REQUESTED, SETTLEMENT_ACKED]] },
        a,
        b,
      ),
    ),
  );
  const logs = chunks.flat();
  await Promise.all([...new Set(logs.map((l) => BigInt(l.blockNumber)))].map((b) => lasnaBlockTime(c, b)));
  for (const log of logs) {
    const block = BigInt(log.blockNumber);
    const hop: Hop = { chainId: LASNA.id, tx: log.transactionHash, at: lasnaBlockTimes.get(block) ?? null, clock: "s" };
    const topic0 = log.topics[0];
    if (topic0 === LEDGER_RECORDED) {
      const d = decodeEventLog({
        abi: daybookReactiveAbi,
        eventName: "LedgerRecorded",
        data: log.data,
        topics: sortedTopics(log.topics),
      });
      cache.ledgerHops.set(`${topicOf(d.args.txHash)}:${Number(d.args.logIndex)}`, hop);
    } else if (topic0 === SETTLEMENT_REQUESTED) {
      const d = decodeEventLog({
        abi: daybookReactiveAbi,
        eventName: "SettlementRequested",
        data: log.data,
        topics: sortedTopics(log.topics),
      });
      const seq = d.args.seq.toString();
      // A resend repeats the request; the first one is when the loop asked for settlement.
      if (!cache.requests.has(seq)) {
        cache.requests.set(seq, { seq, invoiceId: d.args.invoiceId.toString(), chainId: Number(d.args.chainId), hop });
      }
    } else if (topic0 === SETTLEMENT_ACKED) {
      const d = decodeEventLog({
        abi: daybookReactiveAbi,
        eventName: "SettlementAcked",
        data: log.data,
        topics: sortedTopics(log.topics),
      });
      cache.acks.set(d.args.seq.toString(), hop);
    }
  }
  cache.scannedTo = head;

  for (const line of cache.ledger) {
    if (line.reactive === null) line.reactive = cache.ledgerHops.get(`${line.originTx}:${line.logIndex}`) ?? null;
  }
  await fillOriginTimes(cache.ledger.filter((l) => l.originAt === null));
}

/** Block time of each line's origin transfer, with Base's millisecond clock where the chain has one. */
async function fillOriginTimes(lines: LedgerLine[]): Promise<void> {
  const todo = lines.slice(0, 40);
  await Promise.all(
    todo.map(async (line) => {
      const key = `${line.chainId}:${line.originTx}`;
      let t = originTimes.get(key);
      if (t === undefined) {
        const chain = paymentChain(line.chainId);
        if (chain === undefined) return;
        try {
          t = await txTime(chainClient(chain), line.originTx);
          originTimes.set(key, t);
        } catch {
          // A public RPC that drops one call leaves this line's time blank until the next refresh.
          return;
        }
      }
      line.originAt = t.at;
      line.originClock = t.clock;
    }),
  );
}

async function txTime(c: PublicClient, tx: Hex): Promise<{ at: number; clock: Clock }> {
  const receipt = (await c.request({ method: "eth_getTransactionReceipt", params: [tx] } as never)) as {
    blockNumber: Hex;
  } | null;
  if (receipt === null) throw new Error(`no receipt for ${tx}`);
  return blockTime(c, BigInt(receipt.blockNumber));
}

async function blockTime(c: PublicClient, block: bigint): Promise<{ at: number; clock: Clock }> {
  const b = (await c.request({
    method: "eth_getBlockByNumber",
    params: [`0x${block.toString(16)}`, false],
  } as never)) as {
    timestamp: Hex;
    timestampMs?: Hex | null;
  } | null;
  if (b === null) throw new Error(`no block ${block}`);
  if (b.timestampMs !== undefined && b.timestampMs !== null) return { at: Number(BigInt(b.timestampMs)), clock: "ms" };
  return { at: Number(BigInt(b.timestamp)) * 1000, clock: "s" };
}

/** Brings the cache up to date at most every few seconds; concurrent callers share one refresh. */
export async function synced(reactive: Address, deployBlock: bigint | null, fresh = false): Promise<Cache> {
  const cache = cacheFor(reactive);
  if (Date.now() - cache.lastRefresh < 3_000) return cache;
  // Stale while revalidate: once the cache has been filled, answer from it and refresh in the background, because
  // the public Lasna RPC takes one to four seconds a call. `fresh` waits for the refresh instead.
  const warm = cache.lastRefresh > 0;
  if (cache.inflight === null) {
    cache.inflight = onNetwork("Reactive Lasna", () => refresh(cache, deployBlock))
      .then(() => {
        cache.lastRefresh = Date.now();
      })
      .finally(() => {
        cache.inflight = null;
      });
  }
  const running = cache.inflight;
  if (warm && !fresh) {
    running.catch(() => {
      // A failed background refresh keeps the last good cache; the next request tries again.
    });
    return cache;
  }
  await running;
  return cache;
}

// ---------------------------------------------------------------- settlement callbacks

/** Finds the till's Settled log for a settlement on its payment chain, searching only around when it was asked for. */
async function findCallback(
  cache: Cache,
  req: RequestInfo,
  till: Address,
  ackAt: number | null,
): Promise<CallbackInfo | null> {
  const known = cache.callbacks.get(req.seq);
  if (known !== undefined) return known;
  const missAt = cache.callbackMisses.get(req.seq);
  if (missAt !== undefined && Date.now() - missAt < 4_000) return null;
  const stored = await loadCallback(cache.reactive, req.seq);
  if (stored !== null) {
    cache.callbacks.set(req.seq, stored);
    return stored;
  }
  const chain = paymentChain(req.chainId);
  if (chain === undefined || req.hop.at === null) return null;
  const c = chainClient(chain);
  const result = await onNetwork(chain.name, async () => {
    const headBlock = await c.getBlockNumber();
    const head = await blockTime(c, headBlock);
    const fromMs = req.hop.at === null ? head.at : req.hop.at - 30_000;
    // Without an ack yet, look up to 15 minutes past the request; with one, the callback came before the ack.
    const toMs = ackAt !== null ? ackAt + 10_000 : Math.min(head.at, fromMs + 15 * 60_000);
    const blockAt = (ms: number) => {
      const back = BigInt(Math.max(0, Math.floor((head.at - ms) / chain.blockMs)));
      return headBlock > back ? headBlock - back : 0n;
    };
    const from = blockAt(fromMs);
    const to = blockAt(toMs);
    const ranges: [bigint, bigint][] = [];
    for (let s = from; s <= to; s += chain.logSpan) {
      ranges.push([s, s + chain.logSpan - 1n < to ? s + chain.logSpan - 1n : to]);
    }
    const topics = [SETTLED, topicOf(BigInt(req.invoiceId)), topicOf(BigInt(req.seq))];
    const found = (await Promise.all(ranges.map(([a, b]) => getLogs(c, { address: till, topics }, a, b)))).flat();
    // A duplicate delivery re-emits Settled for the same seq; the first one is the settlement.
    const first = found.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)))[0];
    if (first === undefined) return null;
    const t =
      first.blockTimestampMs !== undefined && first.blockTimestampMs !== null
        ? { at: Number(BigInt(first.blockTimestampMs)), clock: "ms" as const }
        : await blockTime(c, BigInt(first.blockNumber));
    const d = decodeEventLog({
      abi: daybookTillAbi,
      eventName: "Settled",
      data: first.data,
      topics: sortedTopics(first.topics),
    });
    return { hop: { chainId: chain.id, tx: first.transactionHash, at: t.at, clock: t.clock }, uid: d.args.receiptUid };
  });
  if (result === null) cache.callbackMisses.set(req.seq, Date.now());
  else {
    cache.callbacks.set(req.seq, result);
    await saveCallback(cache.reactive, req.seq, result.hop, result.uid);
  }
  return result;
}

// ---------------------------------------------------------------- invoice snapshot

type AcceptedRaw = readonly { chainId: bigint; token: Address; decimals: number }[];
const acceptedCache = new Map<string, AcceptedRaw>();
type SettlementRaw = {
  token: Address;
  amount: bigint;
  excess: bigint;
  status: number;
};
const settlementCache = new Map<string, SettlementRaw>();

export type InvoiceRead = { kind: "ok"; snapshot: InvoiceSnapshot } | { kind: "not-found" };

export async function readInvoice(
  reactive: Address,
  deployBlock: bigint | null,
  id: bigint,
  core?: Core,
): Promise<InvoiceRead> {
  const k = core ?? (await readCore(reactive, id));
  if (id < 1n || id > k.invoiceCount) return { kind: "not-found" };
  const c = lasna();
  const r = { address: reactive, abi: daybookReactiveAbi } as const;
  const acceptedKey = `${reactive}:${id}`;
  const cachedAccepted = acceptedCache.get(acceptedKey);
  const [inv, accepted, cache] = await Promise.all([
    onNetwork("Reactive Lasna", () => c.readContract({ ...r, functionName: "getInvoice", args: [id] })),
    cachedAccepted !== undefined
      ? Promise.resolve(cachedAccepted)
      : onNetwork("Reactive Lasna", () => c.readContract({ ...r, functionName: "acceptedOf", args: [id] })),
    synced(reactive, deployBlock),
  ]);
  // An invoice's accepted pairs are fixed at creation.
  if (inv.status !== 0) acceptedCache.set(acceptedKey, accepted);
  if (inv.status === 0) return { kind: "not-found" };
  const idText = id.toString();

  const reqs = [...cache.requests.values()].filter((q) => q.invoiceId === idText);
  const settlements: SettlementLine[] = await Promise.all(
    reqs.map(async (q) => {
      const settleKey = `${reactive}:${q.seq}`;
      const view =
        settlementCache.get(settleKey) ??
        (await onNetwork("Reactive Lasna", () =>
          c.readContract({ ...r, functionName: "getSettlement", args: [BigInt(q.seq)] }),
        ));
      // Acked and Resolved are final states.
      if (view.status === 2 || view.status === 4) settlementCache.set(settleKey, view);
      const till = k.tills.find((t) => t.chain.id === q.chainId)?.till ?? null;
      const ack = cache.acks.get(q.seq) ?? null;
      let cb: CallbackInfo | null = null;
      if (till !== null) {
        try {
          cb = await findCallback(cache, q, till, ack?.at ?? null);
        } catch {
          // The payment chain's RPC failing should not hide the rest of the invoice; the hop shows as not found yet.
          cb = null;
        }
      }
      return {
        seq: q.seq,
        chainId: q.chainId,
        token: getAddress(view.token),
        amount: view.amount.toString(),
        excess: view.excess.toString(),
        status: SETTLEMENT_STATUS[view.status] ?? "None",
        requested: q.hop,
        callback: cb?.hop ?? null,
        ack,
        receiptUid: cb === null || /^0x0+$/.test(cb.uid) ? null : cb.uid,
      };
    }),
  );

  const expected = payAddress(k.factory, reactive, id);
  const pairs: AcceptedPair[] = accepted.map((a) => ({
    chainId: Number(a.chainId),
    token: getAddress(a.token),
    decimals: a.decimals,
    symbol: tokenSymbol(Number(a.chainId), a.token),
  }));

  return {
    kind: "ok",
    snapshot: {
      id: idText,
      reactive,
      payAddress: getAddress(inv.payAddress),
      payAddressVerified: getAddress(inv.payAddress) === expected,
      amount: inv.amount.toString(),
      paid: inv.paid.toString(),
      status: INVOICE_STATUS[inv.status] ?? "None",
      overdue: inv.overdue,
      dueAt: inv.dueAt === 0n ? null : Number(inv.dueAt) * 1000,
      expiresAt: inv.expiresAt === 0n ? null : Number(inv.expiresAt) * 1000,
      createdAt: Number(inv.createdAt) * 1000,
      policyId: inv.policyId,
      detailsHash: inv.detailsHash,
      accepted: pairs,
      entries: cache.ledger.filter((l) => l.invoiceId === idText).map((l) => ({ ...l })),
      settlements: settlements.sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq))),
      readAt: Date.now(),
    },
  };
}

/** Every invoice's status, newest first. */
export async function readInvoiceStatuses(
  reactive: Address,
  count: bigint,
): Promise<{ id: bigint; status: (typeof INVOICE_STATUS)[number]; createdAt: number; amount: bigint }[]> {
  const c = lasna();
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const invs = await onNetwork("Reactive Lasna", () =>
    Promise.all(
      ids.map((id) =>
        c.readContract({ address: reactive, abi: daybookReactiveAbi, functionName: "getInvoice", args: [id] }),
      ),
    ),
  );
  return invs
    .map((inv, i) => ({
      id: ids[i] ?? 0n,
      status: INVOICE_STATUS[inv.status] ?? ("None" as const),
      createdAt: Number(inv.createdAt) * 1000,
      amount: inv.amount,
    }))
    .reverse();
}

// ---------------------------------------------------------------- fees

const measuredFees = new Map<string, bigint | null>();
const feeMisses = new Map<string, number>();

/** What one reactive transaction cost, as the drop in the contract's spendable funds across its block. */
async function feeOf(reactive: Address, hop: Hop): Promise<bigint | null> {
  const known = measuredFees.get(hop.tx);
  if (known !== undefined) return known;
  const missed = feeMisses.get(hop.tx);
  if (missed !== undefined && Date.now() - missed < 60_000) return null;
  const c = lasna();
  try {
    const receipt = await c.getTransactionReceipt({ hash: hop.tx });
    const block = receipt.blockNumber;
    const funds = async (b: bigint) => {
      const [bal, reserves, debt] = await Promise.all([
        c.getBalance({ address: reactive, blockNumber: b }),
        c.readContract({
          address: LASNA.system,
          abi: payableAbi,
          functionName: "reserves",
          args: [reactive],
          blockNumber: b,
        }),
        c.readContract({
          address: LASNA.system,
          abi: payableAbi,
          functionName: "debt",
          args: [reactive],
          blockNumber: b,
        }),
      ]);
      return bal + reserves - debt;
    };
    const [before, after] = await Promise.all([funds(block - 1n), funds(block)]);
    const blockLogs = await getLogs(c, { address: reactive, topics: [] }, block, block);
    // If two of our reactions share a block the drop covers both, so the sample is not attributable to one;
    // that is a fact about the chain, so it is remembered like a measurement.
    const fee = new Set(blockLogs.map((l) => l.transactionHash)).size > 1 || before < after ? null : before - after;
    measuredFees.set(hop.tx, fee);
    return fee;
  } catch {
    // A busy or pruned RPC: leave this reaction out of the sample now and try it again in a minute.
    feeMisses.set(hop.tx, Date.now());
    return null;
  }
}

const payableAbi = [
  {
    type: "function",
    name: "reserves",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "debt",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export async function measuredReactionFees(
  reactive: Address,
  cache: Cache,
  limit = 60,
): Promise<{ total: bigint; samples: number; reactions: number }> {
  const hops = new Map<string, Hop>();
  for (const h of cache.ledgerHops.values()) hops.set(h.tx, h);
  for (const h of cache.acks.values()) hops.set(h.tx, h);
  const all = [...hops.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  // Six at a time: each measurement is six archive reads, and the public RPC throttles bursts.
  const fees: (bigint | null)[] = [];
  const todo = all.slice(0, limit);
  for (let i = 0; i < todo.length; i += 6) {
    fees.push(...(await Promise.all(todo.slice(i, i + 6).map((h) => feeOf(reactive, h)))));
  }
  let total = 0n;
  let samples = 0;
  for (const f of fees) {
    if (f !== null) {
      total += f;
      samples += 1;
    }
  }
  return { total, samples, reactions: all.length };
}

export async function readRunway(reactive: Address) {
  const c = lasna();
  const [balance, reserves, debt, cron, pending, timed, closing] = await onNetwork("Reactive Lasna", () =>
    c.readContract({ address: reactive, abi: daybookReactiveAbi, functionName: "runway" }),
  );
  return { balance, reserves, debt, cron, pending, timed, closing };
}

export async function lasnaBlockTimeOf(block: bigint): Promise<number> {
  return onNetwork("Reactive Lasna", () => lasnaBlockTime(lasna(), block));
}
