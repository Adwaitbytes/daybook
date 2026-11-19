import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** Column order of evidence/loops.csv. Append-only: a new column goes at the end so old rows stay readable. */
export const LOOP_COLUMNS = [
  "loop",
  "invoice_id",
  "origin_chain",
  "origin_tx",
  "origin_log_index",
  "token",
  "amount_raw",
  "origin_ts_ms",
  "origin_clock",
  "deliveries",
  "ledger_kind",
  "reactive_tx",
  "reactive_block",
  "reactive_ts_ms",
  "reactive_gas",
  "reactive_cost_wei",
  "settlement_seqs",
  "callback_chain",
  "callback_tx",
  "callback_status",
  "callback_ts_ms",
  "callback_clock",
  "callback_gas",
  "dest_fee_wei",
  "receipt_outcome",
  "ack_tx",
  "ack_ts_ms",
  "ack_gas",
  "ack_cost_wei",
  "origin_to_reactive_ms",
  "origin_to_callback_ms",
  "origin_to_ack_ms",
  "loop_status",
  "notes",
  "traced_at",
] as const;

export type LoopColumn = (typeof LOOP_COLUMNS)[number];
export type LoopRow = Record<LoopColumn, string>;

/** RFC 4180 quoting: a field with a comma, quote or newline is quoted and inner quotes doubled. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function csvLine(row: LoopRow): string {
  return LOOP_COLUMNS.map((c) => csvField(row[c])).join(",");
}

/** Appends one row, writing the header first if the file is new or empty. Never rewrites existing rows; a
 * file whose header differs from LOOP_COLUMNS is refused rather than silently mixed. */
export function appendLoopRow(path: string, row: LoopRow): void {
  const header = LOOP_COLUMNS.join(",");
  if (!existsSync(path) || readFileSync(path, "utf8").length === 0) {
    writeFileSync(path, `${header}\n`);
  } else {
    const first = readFileSync(path, "utf8").split("\n", 1)[0];
    if (first !== header) throw new Error(`${path} has a different header; refusing to append`);
  }
  appendFileSync(path, `${csvLine(row)}\n`);
}

export function emptyRow(): LoopRow {
  return Object.fromEntries(LOOP_COLUMNS.map((c) => [c, ""])) as LoopRow;
}
