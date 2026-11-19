import "server-only";
import type { Address } from "viem";
import { daybookReactiveAbi, daybookTillAbi } from "@/generated/abis";
import { PAYMENT_CHAINS, type PaymentChain } from "@/lib/chains";
import { deriveStatus } from "@/lib/status";
import type { InvoiceSnapshot, LedgerLine } from "@/lib/types";
import { deployment } from "./config";
import {
  lasnaBlockTimeOf,
  measuredReactionFees,
  readCore,
  readInvoice,
  readInvoiceStatuses,
  readRunway,
  synced,
} from "./indexer";
import { chainClient, lasna, onNetwork, RpcError } from "./rpc";

export type View<T> = { kind: "ok"; value: T } | { kind: "not-deployed" } | { kind: "rpc-error"; network: string };

async function guard<T>(fn: (reactive: Address, deployBlock: bigint | null) => Promise<T>): Promise<View<T>> {
  const d = deployment();
  if (d.kind === "not-deployed") return { kind: "not-deployed" };
  try {
    return { kind: "ok", value: await fn(d.reactive, d.deployBlock) };
  } catch (err) {
    if (err instanceof RpcError) return { kind: "rpc-error", network: err.network };
    throw err;
  }
}

// ---------------------------------------------------------------- ledger

export type LedgerView = { lines: LedgerLine[]; invoices: number; reactive: Address };

export function ledgerView(): Promise<View<LedgerView>> {
  return guard(async (reactive, deployBlock) => {
    const [cache, core] = await Promise.all([synced(reactive, deployBlock, true), readCore(reactive)]);
    return {
      lines: [...cache.ledger].reverse().map((l) => ({ ...l })),
      invoices: Number(core.invoiceCount),
      reactive,
    };
  });
}

// ---------------------------------------------------------------- rules

export type PolicyView = {
  id: number;
  treasury: Address;
  taxBps: number;
  team: { account: Address; bps: number }[];
};

export type TillView = {
  chain: PaymentChain;
  till: Address | null;
  reserve: Address | null;
  receiptIssuer: Address | null;
  maxSettlement: bigint | null;
  paused: boolean | null;
};

export type RulesView = {
  reactive: Address;
  owner: Address;
  policies: PolicyView[];
  tills: TillView[];
  maxInvoiceAmount: bigint;
  callbackGasLimit: bigint;
  resendAfter: bigint;
};

export function rulesView(): Promise<View<RulesView>> {
  return guard(async (reactive) => {
    const core = await readCore(reactive);
    const c = lasna();
    const r = { address: reactive, abi: daybookReactiveAbi } as const;
    const ids = Array.from({ length: core.policyCount }, (_, i) => i + 1);
    const [policies, maxInvoiceAmount, callbackGasLimit, resendAfter] = await onNetwork("Reactive Lasna", () =>
      Promise.all([
        Promise.all(ids.map((id) => c.readContract({ ...r, functionName: "getPolicy", args: [id] }))),
        c.readContract({ ...r, functionName: "maxInvoiceAmount" }),
        c.readContract({ ...r, functionName: "callbackGasLimit" }),
        c.readContract({ ...r, functionName: "resendAfter" }),
      ]),
    );
    const tills = await Promise.all(
      core.tills.map(async ({ chain, till }): Promise<TillView> => {
        if (till === null)
          return { chain, till, reserve: null, receiptIssuer: null, maxSettlement: null, paused: null };
        try {
          const cc = chainClient(chain);
          const t = { address: till, abi: daybookTillAbi } as const;
          const [reserve, receiptIssuer, maxSettlement, paused] = await Promise.all([
            cc.readContract({ ...t, functionName: "reserve" }),
            cc.readContract({ ...t, functionName: "receiptIssuer" }),
            cc.readContract({ ...t, functionName: "maxSettlement", args: [chain.usdc] }),
            cc.readContract({ ...t, functionName: "paused" }),
          ]);
          const nz = (a: Address) => (/^0x0+$/.test(a) ? null : a);
          return { chain, till, reserve: nz(reserve), receiptIssuer: nz(receiptIssuer), maxSettlement, paused };
        } catch {
          // One payment chain's RPC failing leaves its till details blank instead of failing the page.
          return { chain, till, reserve: null, receiptIssuer: null, maxSettlement: null, paused: null };
        }
      }),
    );
    return {
      reactive,
      owner: core.owner,
      policies: policies.map((p, i) => ({
        id: ids[i] ?? 0,
        treasury: p.treasury,
        taxBps: p.taxBps,
        team: p.team.map((m) => ({ account: m.account, bps: m.bps })),
      })),
      tills,
      maxInvoiceAmount,
      callbackGasLimit,
      resendAfter,
    };
  });
}

// ---------------------------------------------------------------- health

export type HealthView = {
  reactive: Address;
  /** When it has been running since, and what that time is measured from. */
  since: { at: number; basis: "deploy block" | "first invoice" } | null;
  invoices: number;
  settled: number;
  open: number;
  /** Funds the contract can still spend on reactions: balance plus reserves minus debt, in wei of lREACT. */
  spendable: bigint;
  debt: bigint;
  cronActive: boolean;
  pendingSettlements: bigint;
  spent: { total: bigint; samples: number; reactions: number };
  reactionsLeft: bigint | null;
  lastLoop: { invoiceId: string; ms: number; settledAt: number | null } | null;
  readAt: number;
};

export function healthView(): Promise<View<HealthView>> {
  return guard(async (reactive, deployBlock) => {
    const [core, runway, cache] = await Promise.all([
      readCore(reactive),
      readRunway(reactive),
      synced(reactive, deployBlock, true),
    ]);
    const statuses = await readInvoiceStatuses(reactive, core.invoiceCount);
    const settled = statuses.filter((s) => s.status === "Settled");
    const open = statuses.filter((s) => s.status === "Open" || s.status === "Paid").length;
    const spent = await measuredReactionFees(reactive, cache);
    const spendable = runway.balance + runway.reserves - runway.debt;
    const reactionsLeft =
      spent.samples === 0 || spent.total === 0n ? null : (spendable * BigInt(spent.samples)) / spent.total;

    let since: HealthView["since"] = null;
    if (deployBlock !== null) since = { at: await lasnaBlockTimeOf(deployBlock), basis: "deploy block" };
    else {
      const first = statuses[statuses.length - 1];
      if (first !== undefined) since = { at: first.createdAt, basis: "first invoice" };
    }

    // The newest settled invoice with a millisecond-clocked transfer and callback gives the last loop latency.
    let lastLoop: HealthView["lastLoop"] = null;
    for (const s of settled.slice(0, 4)) {
      const r = await readInvoice(reactive, deployBlock, s.id, core);
      if (r.kind !== "ok") continue;
      const d = deriveStatus(r.snapshot);
      if (d.loopMs !== null) {
        lastLoop = { invoiceId: r.snapshot.id, ms: d.loopMs, settledAt: d.settledAt };
        break;
      }
    }

    return {
      reactive,
      since,
      invoices: statuses.length,
      settled: settled.length,
      open,
      spendable,
      debt: runway.debt,
      cronActive: runway.cron,
      pendingSettlements: runway.pending,
      spent,
      reactionsLeft,
      lastLoop,
      readAt: Date.now(),
    };
  });
}

// ---------------------------------------------------------------- the home page's real loop

export type HeroLoop = {
  snapshot: InvoiceSnapshot;
  policy: PolicyView | null;
  /** USDC left at the pay address right now, read from the payment chain. */
  leftAtPayAddress: bigint | null;
};

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** The newest settled invoice, written out as a ledger page, with the split computed from its on-chain policy. */
export function heroLoop(): Promise<View<HeroLoop | null>> {
  return guard(async (reactive, deployBlock) => {
    const core = await readCore(reactive);
    const statuses = await readInvoiceStatuses(reactive, core.invoiceCount);
    for (const s of statuses.filter((x) => x.status === "Settled").slice(0, 4)) {
      const r = await readInvoice(reactive, deployBlock, s.id, core);
      if (r.kind !== "ok" || r.snapshot.settlements.every((x) => x.callback === null)) continue;
      const snap = r.snapshot;
      const policyRaw = await onNetwork("Reactive Lasna", () =>
        lasna().readContract({
          address: reactive,
          abi: daybookReactiveAbi,
          functionName: "getPolicy",
          args: [snap.policyId],
        }),
      );
      // What is left at the pay address now, summed over every accepted chain and token.
      let left: bigint | null = 0n;
      for (const pair of snap.accepted) {
        const chain = PAYMENT_CHAINS.find((c) => c.id === pair.chainId);
        if (chain === undefined || left === null) continue;
        try {
          left += await chainClient(chain).readContract({
            address: pair.token,
            abi: erc20BalanceAbi,
            functionName: "balanceOf",
            args: [snap.payAddress],
          });
        } catch {
          left = null;
        }
      }
      return {
        snapshot: snap,
        policy: {
          id: snap.policyId,
          treasury: policyRaw.treasury,
          taxBps: policyRaw.taxBps,
          team: policyRaw.team.map((m) => ({ account: m.account, bps: m.bps })),
        },
        leftAtPayAddress: left,
      };
    }
    return null;
  });
}
