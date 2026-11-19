import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, type Hex, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { CACHE_DIR, type ChainConfig } from "./config.ts";

export type RawLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
};

export type RawReceipt = {
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  l1Fee?: Hex | null;
  blockNumber: Hex;
  transactionHash: Hex;
  from: Hex;
  to: Hex | null;
  contractAddress: Hex | null;
  logs: RawLog[];
};

type RawBlock = { number: Hex; timestamp: Hex; timestampMs?: Hex | null };

export type Stamp = { ms: number; clock: "ms" | "s" };

export const hex = (n: bigint): Hex => `0x${n.toString(16)}`;
export const topicOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class RpcError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

/** A counting semaphore: at most `limit` requests in flight per endpoint. */
class Gate {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export type RpcStats = { requests: number; cacheHits: number; retries: number };

/**
 * JSON-RPC over fetch with retries, exponential backoff on rate limits and timeouts, endpoint fallback, and a disk
 * cache for answers that cannot change (receipts, blocks by number, state and logs at a fixed past block). `fresh`
 * skips reading the cache but still refreshes it.
 */
export class Rpc {
  readonly stats: RpcStats = { requests: 0, cacheHits: 0, retries: 0 };
  private readonly gates: Gate[];
  private headCache: bigint | undefined;
  readonly cfg: ChainConfig;
  private readonly fresh: boolean;

  constructor(cfg: ChainConfig, fresh: boolean) {
    this.cfg = cfg;
    this.fresh = fresh;
    this.gates = cfg.rpcs.map(() => new Gate(cfg.concurrency));
  }

  private cachePath(key: string): string {
    const h = createHash("sha256").update(key).digest("hex");
    return join(CACHE_DIR, String(this.cfg.id), h.slice(0, 2), `${h}.json`);
  }

  async request<T>(method: string, params: unknown[], cacheable: boolean): Promise<T> {
    const key = `${method}:${JSON.stringify(params)}`;
    const path = this.cachePath(key);
    if (cacheable && !this.fresh && existsSync(path)) {
      this.stats.cacheHits++;
      return JSON.parse(readFileSync(path, "utf8")) as T;
    }
    const result = await this.send<T>(method, params);
    if (cacheable && result !== null && result !== undefined) {
      mkdirSync(join(path, ".."), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(result));
      renameSync(tmp, path);
    }
    return result;
  }

  private async send<T>(method: string, params: unknown[]): Promise<T> {
    const attempts = 8;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const i = attempt % this.cfg.rpcs.length;
      const url = this.cfg.rpcs[i] as string;
      const gate = this.gates[i] as Gate;
      try {
        this.stats.requests++;
        return await gate.run(() => post<T>(url, method, params));
      } catch (err) {
        last = err;
        if (err instanceof RpcError && !err.retryable) throw new Error(`${this.cfg.name} ${method}: ${err.message}`);
        this.stats.retries++;
        await sleep(Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
      }
    }
    throw new Error(`${this.cfg.name} ${method} failed after ${attempts} attempts: ${String(last)}`);
  }

  async head(): Promise<bigint> {
    if (this.headCache === undefined) this.headCache = BigInt(await this.request<Hex>("eth_blockNumber", [], false));
    return this.headCache;
  }

  /** Forgets the head read at the start of the run, for a re-read moments later. */
  resetHead(): void {
    this.headCache = undefined;
  }

  async receipt(hash: Hex): Promise<RawReceipt> {
    const r = await this.request<RawReceipt | null>("eth_getTransactionReceipt", [hash], true);
    if (r === null) throw new Error(`no receipt for ${hash} on ${this.cfg.name}`);
    return r;
  }

  async tx(hash: Hex): Promise<{ gasPrice: Hex; from: Hex; to: Hex | null }> {
    const t = await this.request<{ gasPrice: Hex; from: Hex; to: Hex | null } | null>("eth_getTransactionByHash", [hash], true);
    if (t === null) throw new Error(`no transaction ${hash} on ${this.cfg.name}`);
    return t;
  }

  async block(n: bigint): Promise<RawBlock> {
    const b = await this.request<RawBlock | null>("eth_getBlockByNumber", [hex(n), false], true);
    if (b === null) throw new Error(`no block ${n} on ${this.cfg.name}`);
    return b;
  }

  /** The block's own clock: Base Sepolia's `timestampMs`, else whole seconds. A chain configured for ms that
   * returns no ms stamp is an error, not a silent fallback. */
  async stamp(n: bigint): Promise<Stamp> {
    const b = await this.block(n);
    if (b.timestampMs !== undefined && b.timestampMs !== null) return { ms: Number(BigInt(b.timestampMs)), clock: "ms" };
    if (this.cfg.clock === "ms") throw new Error(`${this.cfg.name} block ${n} has no timestampMs`);
    return { ms: Number(BigInt(b.timestamp)) * 1000, clock: "s" };
  }

  /** eth_getLogs over [from, to] in provider-sized chunks, issued together and throttled by the endpoint gate. */
  async logs(filter: { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[] }, from: bigint, to: bigint): Promise<RawLog[]> {
    const head = await this.head();
    const chunks: Promise<RawLog[]>[] = [];
    for (let start = from; start <= to; start += this.cfg.logSpan) {
      const end = start + this.cfg.logSpan - 1n < to ? start + this.cfg.logSpan - 1n : to;
      // Ranges well under head are final; the last few hundred blocks are re-read every run.
      const final = end + 600n < head;
      const f: Record<string, unknown> = { topics: filter.topics ?? [], fromBlock: hex(start), toBlock: hex(end) };
      if (filter.address !== undefined) f.address = filter.address;
      chunks.push(this.request<RawLog[]>("eth_getLogs", [f], final));
    }
    return (await Promise.all(chunks)).flat();
  }

  async call(to: Address, data: Hex, block: bigint): Promise<Hex> {
    return this.request<Hex>("eth_call", [{ to, data }, hex(block)], true);
  }

  async balance(a: Address, block: bigint): Promise<bigint> {
    return BigInt(await this.request<Hex>("eth_getBalance", [a, hex(block)], true));
  }

  async code(a: Address): Promise<Hex> {
    return this.request<Hex>("eth_getCode", [a, "latest"], false);
  }

  /** Largest block whose timestamp is at or before `unixSeconds`, searched below `upper` (default head). With a
   * fixed `upper` every probe is the same block on every run, so the search is answered from the cache. */
  async blockAtOrBefore(unixSeconds: number, upper?: bigint): Promise<bigint> {
    let hi = upper ?? (await this.head());
    const top = upper === undefined ? await this.request<RawBlock>("eth_getBlockByNumber", [hex(hi), false], false) : await this.block(hi);
    const topTs = Number(BigInt(top.timestamp));
    if (topTs <= unixSeconds) return hi;
    const perSec = this.cfg.clock === "ms" ? 5n : 1n;
    const back = BigInt(topTs - unixSeconds + 900) * perSec * 2n;
    let lo = hi > back ? hi - back : 0n;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      const ts = Number(BigInt((await this.block(mid)).timestamp));
      if (ts <= unixSeconds) lo = mid;
      else hi = mid - 1n;
    }
    return lo;
  }
}

async function post<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    throw new RpcError(`network: ${String(err)}`, true);
  }
  if (res.status === 429 || res.status >= 500) throw new RpcError(`HTTP ${res.status}`, true);
  if (!res.ok) throw new RpcError(`HTTP ${res.status}`, true);
  let body: { result?: T; error?: { code: number; message: string } };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new RpcError(`bad JSON: ${String(err)}`, true);
  }
  if (body.error !== undefined) {
    const msg = `${body.error.code} ${body.error.message}`;
    // Reverts and malformed requests are answers; rate limits, timeouts and pruned state are worth another try.
    const retryable = !/revert|invalid argument|invalid params/i.test(body.error.message);
    throw new RpcError(msg, retryable);
  }
  return body.result as T;
}

const payableAbi = parseAbi([
  "function debt(address) view returns (uint256)",
  "function reserves(address) view returns (uint256)",
]);

async function readUint(rpc: Rpc, to: Address, fn: "debt" | "reserves", who: Address, block: bigint): Promise<bigint> {
  const data = encodeFunctionData({ abi: payableAbi, functionName: fn, args: [who] });
  return decodeFunctionResult({ abi: payableAbi, functionName: fn, data: await rpc.call(to, data, block) });
}

/** balance + reserves - debt of a payer at a block: what it can still spend on Reactive fees (economy.md). */
export async function funds(rpc: Rpc, payer: Address, service: Address, block: bigint): Promise<bigint> {
  const [bal, res, debt] = await Promise.all([
    rpc.balance(payer, block),
    readUint(rpc, service, "reserves", payer, block),
    readUint(rpc, service, "debt", payer, block),
  ]);
  return bal + res - debt;
}

/** Fee charged to a payer in a block (drop in spendable funds across it) and how many distinct transactions in
 * that block emitted logs from the payer, since the drop then covers all of them. */
export async function feeAcross(
  rpc: Rpc,
  payer: Address,
  service: Address,
  block: bigint,
): Promise<{ fee: bigint; txs: number }> {
  const [before, after, logs] = await Promise.all([
    funds(rpc, payer, service, block - 1n),
    funds(rpc, payer, service, block),
    rpc.logs({ address: payer }, block, block),
  ]);
  return { fee: before - after, txs: new Set(logs.map((l) => l.transactionHash)).size };
}

export const txCost = (r: RawReceipt): bigint =>
  BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? "0x0") + BigInt(r.l1Fee ?? "0x0");
