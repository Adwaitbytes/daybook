import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { SUMMARY_JSON } from "./config.ts";
import { Report, type Summary, buildSummary, chainSection, makeCtx, pinAt, testCounts } from "./summary.ts";

/**
 * make summary: writes evidence/summary.json from evidence/loops.csv, the contract list, the test runs the Makefile
 * just made, and a chain snapshot pinned at a Lasna block (default: a few blocks under head). README.md and JUDGE.md
 * are generated from this file, and make verify rebuilds it from chain.
 */
const { values } = parseArgs({
  options: {
    at: { type: "string" },
    forge: { type: "string" },
    vitest: { type: "string" },
    "scripts-tap": { type: "string" },
    "verify-tap": { type: "string" },
    fresh: { type: "boolean", default: false },
  },
});

const ctx = makeCtx(values.fresh ?? false);
const previous = existsSync(SUMMARY_JSON) ? (JSON.parse(readFileSync(SUMMARY_JSON, "utf8")) as Summary) : null;

let tests: Summary["tests"];
if (values.forge && values.vitest && values["scripts-tap"] && values["verify-tap"]) {
  tests = testCounts(values.forge, values.vitest, values["scripts-tap"], values["verify-tap"]);
} else if (previous !== null) {
  tests = previous.tests;
  console.log("test counts: kept from the previous summary (pass --forge, --vitest, --scripts-tap and --verify-tap to refresh)");
} else {
  throw new Error("no previous summary and no test runs given");
}

const lasnaBlock = values.at !== undefined ? BigInt(values.at) : (await ctx.lasna.head()) - 5n;
const asOf = await pinAt(ctx, lasnaBlock);
const report = new Report();
const chainPart = await chainSection(ctx, asOf, report);
if (!report.ok()) {
  for (const m of report.mismatches) console.error(`MISMATCH ${m.section} | ${m.item} | ${m.field}: committed ${m.committed}, chain ${m.chain}`);
  for (const e of report.errors) console.error(`ERROR ${e.section} | ${e.item}: ${e.error}`);
  console.error("summary not written: the chain snapshot does not reconcile");
  process.exit(1);
}
const summary = buildSummary(asOf, chainPart, tests);
writeFileSync(SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`);
const h = summary.chain.health;
console.log(
  `wrote evidence/summary.json at Lasna block ${asOf.lasnaBlock} (${asOf.lasnaTime}): ${summary.loops.settlementsClosed} traced settlements closed, ` +
    `${h.invoicesSettled} of ${h.invoicesIssued} invoices settled on chain, ${summary.chain.v1.entries} v1 ledger entries`,
);
