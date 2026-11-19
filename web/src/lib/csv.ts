import { chainName } from "./chains";
import { formatUnitsFixed } from "./format";
import type { LedgerLine } from "./types";

export const LEDGER_CSV_COLUMNS = [
  "entry",
  "time_utc",
  "invoice",
  "kind",
  "status",
  "chain",
  "chain_id",
  "token",
  "token_address",
  "payer",
  "amount",
  "excess",
  "origin_tx",
  "origin_log_index",
  "reactive_tx",
] as const;

/** RFC 4180 field: quoted when it holds a comma, quote or newline; a leading formula sign is neutralized. */
export function csvField(value: string): string {
  // Spreadsheets run a cell that starts with = + - @ as a formula; prefix a quote so a payer-controlled
  // string can never execute in an accountant's spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function ledgerStatus(kind: LedgerLine["kind"]): "matched" | "flagged" | "forwarded" {
  if (kind === "Payment") return "matched";
  if (kind === "WrongToken") return "flagged";
  return "forwarded";
}

function amountText(raw: string, decimals: number | null): string {
  return decimals === null ? `${raw} raw` : formatUnitsFixed(BigInt(raw), decimals, decimals).replaceAll(",", "");
}

export function ledgerToCsv(lines: readonly LedgerLine[]): string {
  const rows = [LEDGER_CSV_COLUMNS.join(",")];
  for (const l of lines) {
    rows.push(
      [
        String(l.index),
        l.originAt === null ? "" : new Date(l.originAt).toISOString(),
        l.invoiceId,
        l.kind,
        ledgerStatus(l.kind),
        chainName(l.chainId),
        String(l.chainId),
        l.symbol ?? "",
        l.token,
        l.payer,
        amountText(l.amount, l.decimals),
        amountText(l.excess, l.decimals),
        l.originTx,
        String(l.logIndex),
        l.reactive?.tx ?? "",
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${rows.join("\r\n")}\r\n`;
}
