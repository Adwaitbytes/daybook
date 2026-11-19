import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Address } from "viem";
import { type ReactiveSnapshot, reactiveSnapshot } from "./chaindata.ts";
import { REPO, REPORT_JSON, SUMMARY_JSON, V0, V1 } from "./config.ts";
import { checkDocs } from "./docs.ts";
import { checkSite, health } from "./health.ts";
import { verifyLoops } from "./loops.ts";
import { Report } from "./report.ts";
import { checkContracts } from "./sourcify.ts";
import { loopStats } from "./stats.ts";
import { type Summary, chainSection, contractsSection, makeCtx, readLoops } from "./summary.ts";

/**
 * make verify: rebuilds every published Daybook number from public RPCs and Sourcify, compares it with
 * evidence/loops.csv, evidence/summary.json and the docs, writes evidence/verify-report.json and exits non-zero on
 * any mismatch. FRESH=1 ignores the receipt cache.
 */
const { values } = parseArgs({ options: { fresh: { type: "boolean", default: false }, "skip-site": { type: "boolean", default: false } } });
const started = Date.now();
const ctx = makeCtx(values.fresh ?? false);
const report = new Report();
const summary = JSON.parse(readFileSync(SUMMARY_JSON, "utf8")) as Summary;

/** Compares two JSON values leaf by leaf, so a mismatch names the exact field. */
function compareJson(section: string, path: string, committed: unknown, rebuilt: unknown): void {
  if (committed !== null && rebuilt !== null && typeof committed === "object" && typeof rebuilt === "object") {
    const keys = new Set([...Object.keys(committed), ...Object.keys(rebuilt)]);
    for (const k of keys) {
      compareJson(section, path === "" ? k : `${path}.${k}`, (committed as Record<string, unknown>)[k], (rebuilt as Record<string, unknown>)[k]);
    }
    return;
  }
  report.eq(section, "evidence/summary.json", path, JSON.stringify(committed), JSON.stringify(rebuilt));
}

const step = async (name: string, fn: () => Promise<void>) => {
  const t = Date.now();
  try {
    await fn();
  } catch (err) {
    report.error(name, "step", err);
  }
  console.log(`${name}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
};

// 1. Every loops.csv row against chain, using every event up to head.
const rows = readLoops();
const head = await ctx.lasna.head();
const headSnaps = new Map<Address, ReactiveSnapshot>();
let rebuilt: Awaited<ReturnType<typeof verifyLoops>> = [];
await step("loops.csv", async () => {
  for (const dep of [V1, V0]) headSnaps.set(dep.reactive, await reactiveSnapshot(ctx.lasna, dep, head));
  rebuilt = await verifyLoops(ctx, rows, headSnaps, report);
  // The loop statistics the docs publish are a pure function of the rows that were just checked.
  compareJson("summary.loops", "loops", summary.loops, loopStats(rows));
});

// 2. The chain snapshot (ledger, settlements, splits, pay-address balances, Health numbers) at the summary's pins.
await step("summary.chain", async () => {
  const chainPart = await chainSection(ctx, summary.asOf, report);
  compareJson("summary.chain", "chain", summary.chain, JSON.parse(JSON.stringify(chainPart)));
});

// 3. Contracts: code on chain and Sourcify status, and the list the summary publishes.
let contracts: Awaited<ReturnType<typeof checkContracts>> = [];
await step("contracts", async () => {
  contracts = await checkContracts(ctx, report);
  compareJson("summary.contracts", "contracts", summary.contracts, contractsSection());
});

// 4. Transaction links, address lists and the measured tables in the docs.
await step("docs", () => checkDocs(ctx, rebuilt, report));

// 5. The live Health page against chain at head.
if (!values["skip-site"]) {
  await step("health page", () =>
    checkSite(
      ctx,
      async () => {
        const h = await ctx.lasna.head();
        return health(ctx, await reactiveSnapshot(ctx.lasna, V1, h));
      },
      report,
    ),
  );
}

// 6. README.md and JUDGE.md are exactly what the generator makes from summary.json.
await step("generated docs", async () => {
  const sec = report.section("generated docs");
  sec.rows = 2;
  try {
    execFileSync(process.execPath, [join(REPO, "tools", "judge", "generate.mjs"), "--check"], { stdio: "pipe" });
    report.eq("generated docs", "README.md, JUDGE.md", "match the generator's output", "yes", "yes");
  } catch (err) {
    const out = err instanceof Error && "stdout" in err ? String((err as { stdout: Buffer }).stdout) : String(err);
    report.eq("generated docs", "README.md, JUDGE.md", "match the generator's output", "yes", `no: ${out.trim()}`);
  }
});

const sections = [...report.sections.values()];
const out = {
  ok: report.ok(),
  ranAt: new Date().toISOString(),
  seconds: Math.round((Date.now() - started) / 1000),
  fresh: values.fresh ?? false,
  summaryAsOf: summary.asOf,
  lasnaHead: head.toString(),
  checks: sections.reduce((a, s) => a + s.checks, 0),
  mismatches: report.mismatches,
  errors: report.errors,
  sections,
  contracts: contracts.map((c) => ({ name: c.name, deployment: c.deployment, chainId: c.chainId, address: c.address, sourcify: c.sourcifyNow, hasCode: c.hasCode })),
  rpc: Object.fromEntries([...ctx.byChain.entries()].map(([id, r]) => [id, r.stats])),
};
writeFileSync(REPORT_JSON, `${JSON.stringify(out, null, 2)}\n`);
for (const s of sections) console.log(`${s.mismatches === 0 ? "ok  " : "FAIL"} ${s.name}: ${s.rows} rows, ${s.checks} checks, ${s.mismatches} mismatches`);
for (const m of report.mismatches) console.error(`MISMATCH ${m.section} | ${m.item} | ${m.field}: committed ${m.committed}, chain ${m.chain}`);
for (const e of report.errors) console.error(`ERROR ${e.section} | ${e.item}: ${e.error}`);
console.log(`${out.checks} checks in ${out.seconds} s; report in evidence/verify-report.json`);
if (!report.ok()) {
  console.error(`verify FAILED: ${report.mismatches.length} mismatches, ${report.errors.length} errors`);
  process.exit(1);
}
console.log("verify passed");
