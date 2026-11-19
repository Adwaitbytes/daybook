import { readFileSync } from "node:fs";
import { caps, reactiveSnapshot } from "./chaindata.ts";
import { CHAINS, CONTRACTS, LASNA, LOOPS_CSV, PAYMENT_CHAINS, SITE, USDC, V0, V1 } from "./config.ts";
import { parseCsv } from "./csv.ts";
import { type Health, health } from "./health.ts";
import { type LedgerSummary, type Pins, rebuildLedger } from "./ledger.ts";
import type { Ctx } from "./loops.ts";
import { Report } from "./report.ts";
import { Rpc } from "./rpc.ts";
import { type LoopStats, loopStats } from "./stats.ts";

export type TestCounts = {
  command: string;
  forge: { total: number; passed: number; unit: number; fuzz: number; invariant: number; suites: number };
  web: { total: number; passed: number; skipped: number; files: number };
  scripts: { total: number; passed: number };
  verify: { total: number; passed: number };
};

/** A settlement on chain whose payment is not in evidence/loops.csv (the live demo pays invoices on its own). */
export type UntracedLoop = LedgerSummary["loops"][number];

export type Summary = {
  schema: 1;
  generatedBy: string;
  site: string;
  asOf: Pins & { lasnaTime: string };
  loops: LoopStats;
  chain: {
    health: Health;
    caps: Awaited<ReturnType<typeof caps>>;
    v1: LedgerSummary;
    v0: LedgerSummary;
    untraced: UntracedLoop[];
  };
  contracts: { name: string; deployment: string; chainId: number; address: string; sourcify: string | null }[];
  tests: TestCounts;
};

export function makeCtx(fresh: boolean): Ctx {
  const byChain = new Map(CHAINS.map((c) => [c.id, new Rpc(c, fresh)]));
  const lasna = byChain.get(LASNA.id) as Rpc;
  return { lasna, byChain, fresh };
}

export function readLoops() {
  const text = readFileSync(LOOPS_CSV, "utf8");
  return parseCsv(text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1));
}

/** Lasna block to pin a new summary at, and each payment chain's block one minute earlier. */
export async function pinAt(ctx: Ctx, lasnaBlock: bigint): Promise<Summary["asOf"]> {
  const stamp = await ctx.lasna.stamp(lasnaBlock);
  const payment: Record<string, string> = {};
  for (const ch of PAYMENT_CHAINS) {
    const rpc = ctx.byChain.get(ch.id) as Rpc;
    payment[String(ch.id)] = (await rpc.blockAtOrBefore(Math.floor(stamp.ms / 1000) - 60)).toString();
  }
  return { lasnaBlock: lasnaBlock.toString(), lasnaTimeMs: stamp.ms, lasnaTime: new Date(stamp.ms).toISOString(), payment };
}

/** The chain half of the summary: ledgers of both deployments, the Health numbers and loops not in loops.csv. */
export async function chainSection(ctx: Ctx, pins: Pins, report: Report): Promise<Summary["chain"]> {
  const n = BigInt(pins.lasnaBlock);
  const [s1, s0] = [await reactiveSnapshot(ctx.lasna, V1, n), await reactiveSnapshot(ctx.lasna, V0, n)];
  const v1 = await rebuildLedger(ctx, s1, pins, report);
  const v0 = await rebuildLedger(ctx, s0, pins, report);
  const h = await health(ctx, s1);
  const traced = new Set(readLoops().map((r) => r.origin_tx?.toLowerCase()));
  const untraced = v1.loops.filter((l) => l.origins.every((o) => !traced.has(o.tx.toLowerCase())));
  const limits = await caps(
    ctx.lasna,
    V1.reactive,
    n,
    PAYMENT_CHAINS.map((ch) => ({
      rpc: ctx.byChain.get(ch.id) as Rpc,
      chainId: ch.id,
      till: V1.tills[ch.id] as `0x${string}`,
      token: USDC[ch.id] as `0x${string}`,
      block: BigInt(pins.payment[String(ch.id)] ?? "0"),
    })),
  );
  return { health: h, caps: limits, v1, v0, untraced };
}

export function contractsSection(): Summary["contracts"] {
  return CONTRACTS.map((c) => ({ name: c.name, deployment: c.deployment, chainId: c.chainId, address: c.address, sourcify: c.sourcify }));
}

// ---------------------------------------------------------------- test counts

type ForgeJson = Record<string, { test_results: Record<string, { status: string; kind: Record<string, unknown> }> }>;
type VitestJson = { numTotalTests: number; numPassedTests: number; numPendingTests: number; numTodoTests: number; testResults: unknown[] };

/** Counts from `forge test --json`, vitest's JSON reporter and node:test's TAP summary lines. */
export function testCounts(forgePath: string, vitestPath: string, scriptsTap: string, verifyTap: string): TestCounts {
  const forge = JSON.parse(readFileSync(forgePath, "utf8")) as ForgeJson;
  const f = { total: 0, passed: 0, unit: 0, fuzz: 0, invariant: 0, suites: Object.keys(forge).length };
  for (const suite of Object.values(forge)) {
    for (const t of Object.values(suite.test_results)) {
      f.total++;
      if (t.status === "Success") f.passed++;
      const kind = Object.keys(t.kind)[0];
      if (kind === "Unit") f.unit++;
      else if (kind === "Fuzz") f.fuzz++;
      else if (kind === "Invariant") f.invariant++;
    }
  }
  const v = JSON.parse(readFileSync(vitestPath, "utf8")) as VitestJson;
  const tap = (path: string) => {
    const text = readFileSync(path, "utf8");
    const num = (k: string) => Number(new RegExp(`^# ${k} (\\d+)$`, "m").exec(text)?.[1] ?? Number.NaN);
    return { total: num("tests"), passed: num("pass") };
  };
  return {
    command: "make test",
    forge: f,
    web: { total: v.numTotalTests, passed: v.numPassedTests, skipped: v.numPendingTests + v.numTodoTests, files: v.testResults.length },
    scripts: tap(scriptsTap),
    verify: tap(verifyTap),
  };
}

export function buildSummary(asOf: Summary["asOf"], chainPart: Summary["chain"], tests: TestCounts): Summary {
  return {
    schema: 1,
    generatedBy: "make summary (tools/verify/src/summary-cli.ts)",
    site: SITE,
    asOf,
    loops: loopStats(readLoops()),
    chain: chainPart,
    contracts: contractsSection(),
    tests,
  };
}

export { Report };
