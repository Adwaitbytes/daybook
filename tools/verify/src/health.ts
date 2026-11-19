import type { Hex } from "viem";
import { type ReactiveSnapshot, getInvoice, reactionFee, stateAt } from "./chaindata.ts";
import { SITE } from "./config.ts";
import type { Ctx } from "./loops.ts";
import type { Report } from "./report.ts";

/** The Health page's numbers, computed the way web/src/lib/server/views.ts computes them, from a snapshot. */
export type Health = {
  /** The page counts from the first invoice's createdAt because the deployment record has no deploy block. */
  runningSinceMs: number;
  deployedAtMs: number;
  invoicesIssued: number;
  invoicesSettled: number;
  invoicesOpen: number;
  /** Sum of measured reaction fees, wei of lREACT. */
  reactSpentWei: string;
  /** Reactions whose fee could be attributed (alone in their block). */
  samples: number;
  /** Reactive transactions that wrote a ledger line or an ack. */
  reactions: number;
};

/** The web page measures at most its 60 newest reactions; verify applies the same cap so the two agree. */
const PAGE_SAMPLE_LIMIT = 60;

export async function health(ctx: Ctx, snap: ReactiveSnapshot): Promise<Health> {
  const lasna = ctx.lasna;
  const first = snap.invoices.find((i) => i.id === 1n);
  const runningSinceMs = first === undefined ? 0 : (await getInvoice(lasna, snap.dep.reactive, 1n, await lasna.head())).createdAt * 1000;
  const deployedAtMs = (await lasna.stamp(snap.deployBlock)).ms;
  const states = snap.invoices.map((i) => stateAt(snap, i.id));
  const hops = new Map<Hex, bigint>();
  for (const e of snap.ledger) hops.set(e.tx, e.block);
  for (const a of snap.acks) hops.set(a.tx, a.block);
  const newest = [...hops.entries()].sort((a, b) => Number(b[1] - a[1])).slice(0, PAGE_SAMPLE_LIMIT);
  let total = 0n;
  let samples = 0;
  for (const [, block] of newest) {
    const f = await reactionFee(lasna, snap.dep.reactive, block);
    if (f.attributable) {
      total += f.fee;
      samples++;
    }
  }
  return {
    runningSinceMs,
    deployedAtMs,
    invoicesIssued: states.length,
    invoicesSettled: states.filter((s) => s === "Settled").length,
    invoicesOpen: states.filter((s) => s === "Open" || s === "Paid").length,
    reactSpentWei: total.toString(),
    samples,
    reactions: hops.size,
  };
}

/** lREACT with four decimals, truncated, as the page prints it (formatUnitsFixed(wei, 18, 4)). */
export function react4(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The text of the live Health page with tags removed, so its rows read "label|value|note|". */
export function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, "|")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&rsquo;/g, "'")
    .replace(/\|+/g, "|");
}

const SECTION = "health page";

/**
 * Compares the live Health page with the same numbers computed from chain at head. The page and this run read
 * the chain seconds apart and a stranger can pay a demo invoice in between, so a disagreement is re-read once
 * before it counts.
 */
export async function checkSite(ctx: Ctx, headHealth: () => Promise<Health>, report: Report): Promise<void> {
  const sec = report.section(SECTION);
  sec.rows = 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      const res = await fetch(`${SITE}/health`, { signal: AbortSignal.timeout(60_000), headers: { "cache-control": "no-cache" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = pageText(await res.text());
    } catch (err) {
      if (attempt === 1) report.error(SECTION, `${SITE}/health`, err);
      continue;
    }
    const h = await headHealth();
    const want: [string, string][] = [
      ["Running since", `Running since|${formatDate(h.runningSinceMs)}|`],
      ["Invoices settled", `Invoices settled|${h.invoicesSettled}|of ${h.invoicesIssued} issued, ${h.invoicesOpen} still open|`],
      ["REACT spent", `REACT spent|${react4(BigInt(h.reactSpentWei))} lREACT|measured on ${h.samples} of ${h.reactions} reactions`],
    ];
    const missing = want.filter(([, s]) => !text.includes(s));
    if (missing.length === 0 || attempt === 1) {
      for (const [label, s] of want) {
        const i = text.indexOf(`${label}|`);
        const seen = i < 0 ? "(row not found)" : text.slice(i, i + s.length + 20);
        report.eq(SECTION, `${SITE}/health`, label, text.includes(s) ? s : seen, s);
      }
      return;
    }
    ctx.lasna.resetHead();
  }
}
