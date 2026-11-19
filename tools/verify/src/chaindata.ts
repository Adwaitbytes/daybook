import {
  type Address,
  type Hex,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
} from "viem";
import { LEDGER_KINDS, type LedgerKind, TOPIC, erc20Abi, reactiveAbi, tillAbi } from "./abi.ts";
import { CALLBACK_PROXY, LASNA, type ReactiveDeployment, SYSTEM_CONTRACT } from "./config.ts";
import { type RawLog, type RawReceipt, type Rpc, type Stamp, feeAcross, topicOf } from "./rpc.ts";

/**
 * Everything verify and summary read from chain about one reactive deployment, decoded once. Every list is built
 * from event logs up to a fixed block, so the same snapshot can be rebuilt later from logs alone.
 */

export type Accepted = { chainId: number; token: Address; decimals: number };
export type InvoiceEv = {
  id: bigint;
  payAddress: Address;
  amount: bigint;
  policyId: number;
  watchAll: boolean;
  accepted: Accepted[];
  block: bigint;
  tx: Hex;
};
export type LedgerEv = {
  index: bigint;
  invoiceId: bigint;
  kind: LedgerKind;
  chainId: number;
  token: Address;
  payer: Address;
  amount: bigint;
  excess: bigint;
  originTx: Hex;
  logIndex: number;
  block: bigint;
  tx: Hex;
};
export type RequestEv = {
  seq: bigint;
  invoiceId: bigint;
  chainId: number;
  token: Address;
  amount: bigint;
  excess: bigint;
  attempt: number;
  block: bigint;
  tx: Hex;
};
export type SimpleEv = { id: bigint; block: bigint; tx: Hex };
export type DupEv = { invoiceId: bigint; chainId: number; originTx: Hex; logIndex: number; block: bigint; tx: Hex };

export type ReactiveSnapshot = {
  dep: ReactiveDeployment;
  deployBlock: bigint;
  to: bigint;
  invoices: InvoiceEv[];
  ledger: LedgerEv[];
  duplicates: DupEv[];
  requests: RequestEv[];
  acks: { seq: bigint; invoiceId: bigint; block: bigint; tx: Hex }[];
  paid: SimpleEv[];
  settled: SimpleEv[];
  cancelled: SimpleEv[];
  expired: SimpleEv[];
};

const topics = (l: RawLog) => l.topics as [signature: Hex, ...args: Hex[]];

export async function deployBlockOf(lasna: Rpc, dep: ReactiveDeployment): Promise<bigint> {
  const r = await lasna.receipt(dep.deployTx);
  if (r.contractAddress === null || getAddress(r.contractAddress) !== dep.reactive) {
    throw new Error(`${dep.deployTx} did not create ${dep.reactive}`);
  }
  return BigInt(r.blockNumber);
}

export async function reactiveSnapshot(lasna: Rpc, dep: ReactiveDeployment, to: bigint): Promise<ReactiveSnapshot> {
  const deployBlock = await deployBlockOf(lasna, dep);
  const logs = await lasna.logs(
    {
      address: dep.reactive,
      topics: [
        [
          TOPIC.invoiceCreated,
          TOPIC.ledgerRecorded,
          TOPIC.duplicateDelivery,
          TOPIC.settlementRequested,
          TOPIC.settlementAcked,
          TOPIC.invoicePaid,
          TOPIC.invoiceSettled,
          TOPIC.invoiceCancelled,
          TOPIC.invoiceExpired,
        ],
      ],
    },
    deployBlock,
    to,
  );
  const s: ReactiveSnapshot = {
    dep,
    deployBlock,
    to,
    invoices: [],
    ledger: [],
    duplicates: [],
    requests: [],
    acks: [],
    paid: [],
    settled: [],
    cancelled: [],
    expired: [],
  };
  logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  for (const l of logs) {
    const block = BigInt(l.blockNumber);
    const tx = l.transactionHash;
    const t0 = l.topics[0];
    if (t0 === TOPIC.invoiceCreated) {
      const d = decodeEventLog({ abi: reactiveAbi, eventName: "InvoiceCreated", data: l.data, topics: topics(l) });
      s.invoices.push({
        id: d.args.invoiceId,
        payAddress: getAddress(d.args.payAddress),
        amount: d.args.amount,
        policyId: d.args.policyId,
        watchAll: d.args.watchAllTokens,
        accepted: d.args.accepted.map((a) => ({ chainId: Number(a.chainId), token: getAddress(a.token), decimals: a.decimals })),
        block,
        tx,
      });
    } else if (t0 === TOPIC.ledgerRecorded) {
      const d = decodeEventLog({ abi: reactiveAbi, eventName: "LedgerRecorded", data: l.data, topics: topics(l) });
      const kind = LEDGER_KINDS[d.args.kind];
      if (kind === undefined) throw new Error(`ledger entry ${d.args.index} has unknown kind ${d.args.kind}`);
      s.ledger.push({
        index: d.args.index,
        invoiceId: d.args.invoiceId,
        kind,
        chainId: Number(d.args.chainId),
        token: getAddress(d.args.token),
        payer: getAddress(d.args.payer),
        amount: d.args.amount,
        excess: d.args.excess,
        originTx: topicOf(d.args.txHash),
        logIndex: Number(d.args.logIndex),
        block,
        tx,
      });
    } else if (t0 === TOPIC.duplicateDelivery) {
      const d = decodeEventLog({ abi: reactiveAbi, eventName: "DuplicateDelivery", data: l.data, topics: topics(l) });
      s.duplicates.push({
        invoiceId: d.args.invoiceId,
        chainId: Number(d.args.chainId),
        originTx: topicOf(d.args.txHash),
        logIndex: Number(d.args.logIndex),
        block,
        tx,
      });
    } else if (t0 === TOPIC.settlementRequested) {
      const d = decodeEventLog({ abi: reactiveAbi, eventName: "SettlementRequested", data: l.data, topics: topics(l) });
      s.requests.push({
        seq: d.args.seq,
        invoiceId: d.args.invoiceId,
        chainId: Number(d.args.chainId),
        token: getAddress(d.args.token),
        amount: d.args.amount,
        excess: d.args.excess,
        attempt: d.args.attempt,
        block,
        tx,
      });
    } else if (t0 === TOPIC.settlementAcked) {
      const d = decodeEventLog({ abi: reactiveAbi, eventName: "SettlementAcked", data: l.data, topics: topics(l) });
      s.acks.push({ seq: d.args.seq, invoiceId: d.args.invoiceId, block, tx });
    } else {
      const id = BigInt(l.topics[1] ?? "0x0");
      const ev = { id, block, tx };
      if (t0 === TOPIC.invoicePaid) s.paid.push(ev);
      else if (t0 === TOPIC.invoiceSettled) s.settled.push(ev);
      else if (t0 === TOPIC.invoiceCancelled) s.cancelled.push(ev);
      else if (t0 === TOPIC.invoiceExpired) s.expired.push(ev);
    }
  }
  return s;
}

export type InvoiceState = "Open" | "Paid" | "Settled" | "Cancelled" | "Expired";

/** Status as of the snapshot block, from the invoice's lifecycle events. */
export function stateAt(s: ReactiveSnapshot, id: bigint): InvoiceState {
  const has = (list: SimpleEv[]) => list.some((e) => e.id === id);
  if (has(s.settled)) return "Settled";
  if (has(s.cancelled)) return "Cancelled";
  if (has(s.expired)) return "Expired";
  if (has(s.paid)) return "Paid";
  return "Open";
}

// ---------------------------------------------------------------- contract reads

const STATUS_NAMES = ["None", "Open", "Paid", "Settled", "Cancelled", "Expired"] as const;

async function readFn<T>(rpc: Rpc, to: Address, abi: readonly unknown[], functionName: string, args: unknown[], block: bigint): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const out = await rpc.call(to, data, block);
  return decodeFunctionResult({ abi, functionName, data: out } as Parameters<typeof decodeFunctionResult>[0]) as T;
}

export type InvoiceView = { payAddress: Address; amount: bigint; paid: bigint; status: (typeof STATUS_NAMES)[number]; createdAt: number; policyId: number };

export async function getInvoice(lasna: Rpc, reactive: Address, id: bigint, block: bigint): Promise<InvoiceView> {
  const v = await readFn<{ payAddress: Address; amount: bigint; paid: bigint; status: number; createdAt: bigint; policyId: number }>(
    lasna,
    reactive,
    reactiveAbi,
    "getInvoice",
    [id],
    block,
  );
  return {
    payAddress: getAddress(v.payAddress),
    amount: v.amount,
    paid: v.paid,
    status: STATUS_NAMES[v.status] ?? "None",
    createdAt: Number(v.createdAt),
    policyId: v.policyId,
  };
}

export type Policy = { treasury: Address; taxBps: number; team: { account: Address; bps: number }[] };

export async function getPolicy(lasna: Rpc, reactive: Address, id: number, block: bigint): Promise<Policy> {
  const p = await readFn<{ treasury: Address; taxBps: number; team: readonly { account: Address; bps: number }[] }>(
    lasna,
    reactive,
    reactiveAbi,
    "getPolicy",
    [id],
    block,
  );
  return { treasury: getAddress(p.treasury), taxBps: p.taxBps, team: p.team.map((m) => ({ account: getAddress(m.account), bps: m.bps })) };
}

export async function invoiceOfPayAddress(lasna: Rpc, reactive: Address, pay: Address, block: bigint): Promise<bigint> {
  return readFn<bigint>(lasna, reactive, reactiveAbi, "invoiceOfPayAddress", [pay], block);
}

export async function tillReserve(rpc: Rpc, till: Address, block: bigint): Promise<Address> {
  return getAddress(await readFn<Address>(rpc, till, tillAbi, "reserve", [], block));
}

/** The caps docs/LIMITS.md states: the largest invoice the reactive contract issues and each till's settlement cap. */
export async function caps(lasna: Rpc, reactive: Address, lasnaBlock: bigint, tills: { rpc: Rpc; chainId: number; till: Address; token: Address; block: bigint }[]) {
  const maxInvoice = await readFn<bigint>(lasna, reactive, reactiveAbi, "maxInvoiceAmount", [], lasnaBlock);
  const settlement: Record<string, string> = {};
  for (const t of tills) settlement[String(t.chainId)] = (await readFn<bigint>(t.rpc, t.till, tillAbi, "maxSettlement", [t.token], t.block)).toString();
  return { maxInvoiceAmount: maxInvoice.toString(), maxSettlementUsdc: settlement };
}

const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
export async function balanceOf(rpc: Rpc, token: Address, who: Address, block: bigint): Promise<bigint> {
  return readFn<bigint>(rpc, token, balanceAbi, "balanceOf", [who], block);
}

// ---------------------------------------------------------------- logs and receipts

export type Transfer = { token: Address; from: Address; to: Address; value: bigint; logIndex: number; tx: Hex; block: bigint };

export function transfersIn(logs: RawLog[]): Transfer[] {
  return logs
    .filter((l) => l.topics[0] === TOPIC.transfer && l.topics.length === 3)
    .map((l) => {
      const d = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: l.data, topics: topics(l) });
      return {
        token: getAddress(l.address),
        from: getAddress(d.args.from),
        to: getAddress(d.args.to),
        value: d.args.value,
        logIndex: Number(BigInt(l.logIndex)),
        tx: l.transactionHash,
        block: BigInt(l.blockNumber),
      };
    });
}

/** Log stamp: Base Sepolia's per-log `blockTimestampMs` where present, else the block's clock. */
export async function logStamp(rpc: Rpc, log: RawLog & { blockTimestampMs?: Hex | null }): Promise<Stamp> {
  if (log.blockTimestampMs !== undefined && log.blockTimestampMs !== null) return { ms: Number(BigInt(log.blockTimestampMs)), clock: "ms" };
  return rpc.stamp(BigInt(log.blockNumber));
}

export type SettledEv = {
  invoiceId: bigint;
  seq: bigint;
  token: Address;
  amount: bigint;
  excess: bigint;
  payer: Address;
  uid: Hex;
  log: RawLog;
};

export function decodeSettled(l: RawLog): SettledEv {
  const d = decodeEventLog({ abi: tillAbi, eventName: "Settled", data: l.data, topics: topics(l) });
  return {
    invoiceId: d.args.invoiceId,
    seq: d.args.seq,
    token: getAddress(d.args.token),
    amount: d.args.amount,
    excess: d.args.excess,
    payer: getAddress(d.args.payer),
    uid: d.args.uid,
    log: l,
  };
}

/** The first Settled log for (invoiceId, seq) from `till` in a block window. A duplicate delivery re-emits Settled
 * for the same seq; the first one is the settlement. */
export async function firstSettled(rpc: Rpc, till: Address, invoiceId: bigint, seq: bigint, from: bigint, to: bigint): Promise<RawLog | undefined> {
  const logs = await rpc.logs({ address: till, topics: [TOPIC.settled, topicOf(invoiceId), topicOf(seq)] }, from, to);
  return logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)))[0];
}

export function receiptOutcome(r: RawReceipt, till: Address): string {
  const mine = r.logs.filter((l) => getAddress(l.address) === till);
  const failed = mine.find((l) => l.topics[0] === TOPIC.receiptFailedV0 || l.topics[0] === TOPIC.receiptFailedV1);
  if (failed !== undefined) {
    return failed.topics[0] === TOPIC.receiptFailedV1 ? `ReceiptFailed(gasLeft=${BigInt(failed.data)})` : "ReceiptFailed";
  }
  const rec = mine.find((l) => l.topics[0] === TOPIC.receipt);
  if (rec === undefined) return "none";
  const uid = `0x${rec.data.slice(-64)}`;
  return /^0x0+$/.test(uid) ? "Receipt(no uid)" : `Attested(${uid})`;
}

/** Fee a reactive contract paid for the reaction in `block` on Lasna, or null when another transaction of the same
 * contract shares the block (the drop then covers both) or the funds rose (a top-up landed in the block). */
export async function reactionFee(lasna: Rpc, reactive: Address, block: bigint): Promise<{ fee: bigint; attributable: boolean; txs: number }> {
  const f = await feeAcross(lasna, reactive, SYSTEM_CONTRACT, block);
  return { fee: f.fee, attributable: f.txs <= 1 && f.fee >= 0n, txs: f.txs };
}

export async function callbackFee(rpc: Rpc, chainId: number, till: Address, block: bigint): Promise<{ fee: bigint; txs: number }> {
  const proxy = CALLBACK_PROXY[chainId];
  if (proxy === undefined) throw new Error(`no callback proxy for chain ${chainId}`);
  return feeAcross(rpc, till, proxy, block);
}

export const isLasna = (chainId: number) => chainId === LASNA.id;
