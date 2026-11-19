import { CONTRACTS, type ContractRecord, chain } from "./config.ts";
import { type Ctx, rpcFor } from "./loops.ts";
import type { Report } from "./report.ts";

export type ContractStatus = ContractRecord & { hasCode: boolean; sourcifyNow: string; explorer: string; sourcifyUrl: string };

const SECTION = "contracts";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sourcify's v2 lookup: `exact_match`, `match`, or null when the address is not verified. */
async function sourcifyMatch(chainId: number, address: string): Promise<string> {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return "null";
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { match?: string | null };
      return body.match ?? "null";
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error("unreachable");
}

/** Every contract in docs/DEPLOYMENTS.md: it has code on its chain and Sourcify reports the status the doc states. */
export async function checkContracts(ctx: Ctx, report: Report): Promise<ContractStatus[]> {
  const sec = report.section(SECTION);
  sec.rows = CONTRACTS.length;
  const out: ContractStatus[] = [];
  for (const c of CONTRACTS) {
    const item = `${c.deployment} ${c.name} on ${chain(c.chainId).name} ${c.address}`;
    try {
      const code = await rpcFor(ctx, c.chainId).code(c.address);
      const hasCode = code !== "0x" && code.length > 2;
      report.eq(SECTION, item, "has code", "yes", hasCode ? "yes" : "no");
      const now = await sourcifyMatch(c.chainId, c.address);
      if (c.sourcify === "unstated") sec.notes.push(`${item}: Sourcify ${now} (DEPLOYMENTS.md states no status)`);
      else report.eq(SECTION, item, "Sourcify status", c.sourcify === null ? "null" : c.sourcify, now);
      out.push({
        ...c,
        hasCode,
        sourcifyNow: now,
        explorer: `${chain(c.chainId).explorerAddress}${c.address}`,
        sourcifyUrl: `https://repo.sourcify.dev/${c.chainId}/${c.address}`,
      });
    } catch (err) {
      report.error(SECTION, item, err);
    }
  }
  return out;
}
