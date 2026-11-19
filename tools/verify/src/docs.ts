import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Hex, decodeEventLog, getAddress } from "viem";
import { TOPIC, reactiveAbi } from "./abi.ts";
import { CONTRACTS, DOCS, EXPLORER_HOSTS, KNOWN_ACCOUNTS, LASNA, LASNA_GAS_PRICE, REACTION_OVERHEAD_GAS, REPO, SYSTEM_CONTRACT, V1 } from "./config.ts";
import { type Ctx, type RebuiltLoop, rpcFor } from "./loops.ts";
import type { Report } from "./report.ts";
import { feeAcross } from "./rpc.ts";

const read = (p: string) => readFileSync(p, "utf8");

/** README.md, JUDGE.md and docs/*.md: every published Markdown file whose numbers come from chain. */
export function publishedDocs(): { name: string; text: string }[] {
  const names = ["README.md", "JUDGE.md"].map((n) => ({ name: n, path: join(REPO, n) }));
  for (const f of readdirSync(DOCS).filter((n) => n.endsWith(".md")).sort()) names.push({ name: `docs/${f}`, path: join(DOCS, f) });
  return names.flatMap(({ name, path }) => {
    try {
      return [{ name, text: read(path) }];
    } catch {
      return [];
    }
  });
}

/** lREACT (18 decimals) rounded half up to `dp` decimals. */
export function roundUnits(wei: bigint, dp: number): string {
  const scale = 10n ** BigInt(18 - dp);
  const q = (wei + scale / 2n) / scale;
  const s = q.toString().padStart(dp + 1, "0");
  return `${s.slice(0, -dp)}.${s.slice(-dp)}`;
}

const grouped = (n: bigint | number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Checks a table cell written as one value, "a / b" (exactly those two values) or "a to b" (min and max) against the
 * values rebuilt from chain, after the same formatting.
 */
export function cellMatches(cell: string, values: string[]): boolean {
  const uniq = [...new Set(values)];
  const parts = cell.split(/\s+to\s+|\s*\/\s*/).map((s) => s.trim());
  if (/\sto\s/.test(cell)) {
    const nums = uniq.map((v) => Number(v.replace(/,/g, "")));
    const min = uniq[nums.indexOf(Math.min(...nums))];
    const max = uniq[nums.indexOf(Math.max(...nums))];
    return parts[0] === min && parts[1] === max;
  }
  return parts.length === uniq.length && parts.every((p) => uniq.includes(p));
}

const SECTION = "docs";

export async function checkDocs(ctx: Ctx, loops: RebuiltLoop[], report: Report): Promise<void> {
  const sec = report.section(SECTION);
  const docs = publishedDocs();
  sec.rows = docs.length;

  // 1. Every explorer transaction link resolves to a successful transaction on that chain.
  const seen = new Set<string>();
  const txChecks: { chainId: number; hash: Hex; where: string }[] = [];
  for (const d of docs) {
    for (const m of d.text.matchAll(/https:\/\/([a-z.-]+)\/tx\/(0x[0-9a-fA-F]{64})/g)) {
      const chainId = EXPLORER_HOSTS[m[1] ?? ""];
      if (chainId === undefined) continue;
      txChecks.push({ chainId, hash: m[2] as Hex, where: d.name });
    }
  }
  // 2. FIRST_LOOPS.md lists bare hashes in its "Every hash" table; a cell starting "Base" or "Unichain" names the
  // payment chain, every other hash there is a Lasna transaction.
  const fl = docs.find((d) => d.name === "docs/FIRST_LOOPS.md");
  if (fl !== undefined) {
    const table = section(fl.text, "## Every hash");
    for (const line of table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Loop") && !l.startsWith("|---"))) {
      for (const cell of line.split("|").slice(2)) {
        for (const m of cell.matchAll(/0x[0-9a-f]{64}/g)) {
          const chainId = /^\s*Base\b/.test(cell) ? 84_532 : /^\s*Unichain\b/.test(cell) ? 1301 : LASNA.id;
          txChecks.push({ chainId, hash: m[0] as Hex, where: "docs/FIRST_LOOPS.md (Every hash)" });
        }
      }
    }
  }
  for (const t of txChecks) {
    const k = `${t.chainId}:${t.hash.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      const r = await rpcFor(ctx, t.chainId).receipt(t.hash);
      report.eq(SECTION, `${t.where} tx ${t.hash} on ${t.chainId}`, "status", "success", r.status === "0x1" ? "success" : "reverted");
    } catch (err) {
      report.error(SECTION, `${t.where} tx ${t.hash} on ${t.chainId}`, err);
    }
  }
  sec.notes.push(`${seen.size} distinct transaction hashes linked or tabled in the docs`);

  // 3. DEPLOYMENTS.md names exactly the contracts verify checks, plus the known non-contract accounts.
  const dep = docs.find((d) => d.name === "docs/DEPLOYMENTS.md");
  if (dep !== undefined) {
    const inDoc = new Set([...dep.text.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => getAddress(m[0])));
    const known = new Set([...CONTRACTS.map((c) => c.address), ...KNOWN_ACCOUNTS]);
    for (const a of inDoc) report.eq(SECTION, `DEPLOYMENTS.md ${a}`, "address is in the verified contract list", "listed", known.has(a) ? "listed" : "not listed");
    for (const c of CONTRACTS) report.eq(SECTION, `contract list ${c.name} ${c.address}`, "named in DEPLOYMENTS.md", "named", inDoc.has(c.address) ? "named" : "missing");

    // Deploy gas stated next to a deploy link, and the deploy cost in the lREACT accounting.
    for (const m of dep.text.matchAll(/lasna\.reactscan\.net\/tx\/(0x[0-9a-f]{64})\)\)?,?\s*\(?([\d,]+) gas/g)) {
      const r = await ctx.lasna.receipt(m[1] as Hex);
      report.eq(SECTION, `DEPLOYMENTS.md deploy ${m[1]}`, "gas used", m[2], grouped(BigInt(r.gasUsed)));
      const tx = await ctx.lasna.tx(m[1] as Hex);
      const fee = roundUnits(BigInt(r.gasUsed) * BigInt(tx.gasPrice), 4);
      report.eq(SECTION, `DEPLOYMENTS.md deploy ${m[1]}`, "deploy cost in lREACT accounting", "stated", dep.text.includes(fee) ? "stated" : `missing ${fee}`);
    }
  }

  if (fl !== undefined) {
    await checkLatencyTable(fl.text, loops, report);
    await checkCostTable(ctx, fl.text, loops, report);
  }
}

function section(text: string, heading: string): string {
  const i = text.indexOf(heading);
  if (i < 0) return "";
  const rest = text.slice(i + heading.length);
  const j = rest.search(/\n## /);
  return j < 0 ? rest : rest.slice(0, j);
}

function tableRows(block: string, header: string): string[][] {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith("|")) break;
    rows.push(l.split("|").slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

/** Closed loop for a table label such as "v1-L2" or "v1-L5 seq 6 (...)". */
function closedFor(label: string, loops: RebuiltLoop[]): RebuiltLoop | undefined {
  const m = /^(v\d-L\d+)(?:.*?seq (\d+))?/.exec(label);
  if (m === null) return undefined;
  return loops.find(
    (l) => l.rebuilt.loop_status === "closed" && (l.row.loop ?? "").startsWith(`${m[1]}-`) && (m[2] === undefined || l.rebuilt.settlement_seqs === m[2]),
  );
}

async function checkLatencyTable(text: string, loops: RebuiltLoop[], report: Report): Promise<void> {
  const rows = tableRows(section(text, "## Latency"), "| Loop | Origin");
  for (const [label = "", toCallback = "", , reactToAck = "", lasnaBlocks = ""] of rows) {
    const item = `FIRST_LOOPS.md latency ${label}`;
    const l = closedFor(label, loops);
    if (l === undefined) {
      report.eq(SECTION, item, "closed loop in loops.csv", "found", "missing");
      continue;
    }
    const ms = Number(l.rebuilt.origin_to_callback_ms);
    const ms1 = /^([\d,]+) ms \((\d+)/.exec(toCallback);
    const s1 = /^([\d.]+) s/.exec(toCallback);
    if (ms1 !== null) {
      report.eq(SECTION, item, "origin to callback ms", ms1[1], grouped(ms));
      report.eq(SECTION, item, "origin to callback Base blocks (200 ms)", ms1[2], String(ms / 200));
    } else if (s1 !== null) {
      report.eq(SECTION, item, "origin to callback s", s1[1], String(ms / 1000));
    } else report.eq(SECTION, item, "origin to callback cell parses", "yes", "no");
    const ackS = (Number(l.rebuilt.ack_ts_ms) - Number(l.rebuilt.reactive_ts_ms)) / 1000;
    report.eq(SECTION, item, "reaction to ack s", reactToAck, `${ackS} s`);
    const blocks = l.ackBlock === null ? "" : String(l.ackBlock - BigInt(l.rebuilt.reactive_block ?? "0"));
    report.eq(SECTION, item, "reaction to ack Lasna blocks", lasnaBlocks, blocks);
  }
}

async function checkCostTable(ctx: Ctx, text: string, loops: RebuiltLoop[], report: Report): Promise<void> {
  const rows = tableRows(section(text, "## Cost"), "| Reaction");
  const v1 = loops.filter((l) => l.deployment === "v1");
  const perReaction = new Map<string, RebuiltLoop>();
  for (const l of v1) if (l.rebuilt.reactive_tx) perReaction.set(l.rebuilt.reactive_tx, l);
  const seqCount = (tx: string) => v1.filter((l) => l.rebuilt.reactive_tx === tx && l.rebuilt.settlement_seqs).length;
  const billed = (wei: bigint) => grouped(wei / LASNA_GAS_PRICE - REACTION_OVERHEAD_GAS);
  type Sample = { gas: bigint; fee: bigint };
  const reactions = (pred: (l: RebuiltLoop) => boolean): Sample[] =>
    [...perReaction.values()].filter(pred).map((l) => ({ gas: BigInt(l.rebuilt.reactive_gas ?? "0"), fee: BigInt(l.rebuilt.reactive_cost_wei ?? "0") }));
  const acks: Sample[] = [...new Map(v1.filter((l) => l.rebuilt.ack_tx).map((l) => [l.rebuilt.ack_tx, { gas: BigInt(l.rebuilt.ack_gas ?? "0"), fee: BigInt(l.rebuilt.ack_cost_wei ?? "0") }])).values()];

  const groups: Record<string, Sample[]> = {
    "Partial payment": reactions((l) => l.rebuilt.loop_status === "recorded_partial"),
    "Wrong-token flag": reactions((l) => l.rebuilt.loop_status === "flagged_no_settlement"),
    "Cover, one settlement": reactions((l) => seqCount(l.rebuilt.reactive_tx ?? "") === 1),
    "Cover, two settlements": reactions((l) => seqCount(l.rebuilt.reactive_tx ?? "") === 2),
    "Ack (": acks,
  };
  // Invoice creation and the probe are owner and probe transactions outside loops.csv, listed in "Every hash".
  const hashes = section(text, "## Every hash");
  const creates = [...new Set([...hashes.matchAll(/#\d+ `(0x[0-9a-f]{64})`/g)].map((m) => m[1] as Hex))];
  const createSamples: { gas: bigint; fee: bigint; pairs: number }[] = [];
  for (const h of creates) {
    const r = await ctx.lasna.receipt(h);
    const tx = await ctx.lasna.tx(h);
    // The table is about v1; the v0 invoice's creation is in the same list but cost more (older contract).
    const created = r.logs.find((l) => l.topics[0] === TOPIC.invoiceCreated && getAddress(l.address) === V1.reactive);
    if (created === undefined) continue;
    const d = decodeEventLog({ abi: reactiveAbi, eventName: "InvoiceCreated", data: created.data, topics: created.topics as [Hex, ...Hex[]] });
    createSamples.push({ gas: BigInt(r.gasUsed), fee: BigInt(r.gasUsed) * BigInt(tx.gasPrice), pairs: d.args.accepted.length });
  }
  groups["createInvoice (owner tx, one"] = createSamples.filter((s) => s.pairs === 1);
  groups["createInvoice, two chains"] = createSamples.filter((s) => s.pairs === 2);
  const probe = /probe deploy `0x[0-9a-f]{64}` \| Base `0x[0-9a-f]{64}` \| `(0x[0-9a-f]{64})`/.exec(hashes);
  if (probe !== null) {
    const r = await ctx.lasna.receipt(probe[1] as Hex);
    const f = await feeAcross(ctx.lasna, getAddress("0x2C10E554FdAb44E2D85407457584b94c3CEebA05"), SYSTEM_CONTRACT, BigInt(r.blockNumber));
    groups["Probe reaction"] = [{ gas: BigInt(r.gasUsed), fee: f.fee }];
  }

  for (const [label = "", gasCell = "", reactCell = "", billedCell = ""] of rows) {
    const key = Object.keys(groups).find((k) => label.startsWith(k));
    const item = `FIRST_LOOPS.md cost ${label}`;
    const samples = key === undefined ? undefined : groups[key];
    if (samples === undefined || samples.length === 0) {
      report.eq(SECTION, item, "samples rebuilt from chain", "some", "none");
      continue;
    }
    if (gasCell !== "n/a") report.eq(SECTION, item, "receipt gasUsed", gasCell, cellMatches(gasCell, samples.map((s) => grouped(s.gas))) ? gasCell : samples.map((s) => grouped(s.gas)).join(", "));
    report.eq(SECTION, item, "lREACT", reactCell, cellMatches(reactCell, samples.map((s) => roundUnits(s.fee, 4))) ? reactCell : samples.map((s) => roundUnits(s.fee, 4)).join(", "));
    if (billedCell !== "n/a") report.eq(SECTION, item, "billed react gas", billedCell, cellMatches(billedCell, samples.map((s) => billed(s.fee))) ? billedCell : samples.map((s) => billed(s.fee)).join(", "));
  }
}
