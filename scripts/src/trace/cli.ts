import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getAddress, isHash } from "viem";
import { appendLoopRow, emptyRow } from "./evidence.ts";
import { traceOrigin } from "./trace.ts";

const USAGE = `trace --loop <label> --chain <origin chain id> --tx <origin tx hash> --reactive <addr>
      [--wait <seconds, default 300>] [--csv <path, default ../evidence/loops.csv>] [--notes <text>]

Finds the reactive transaction that recorded each Daybook payment in the origin transaction, the settlement
callback on the destination chain and the acknowledgement on Lasna, prints them as JSON and appends one row per
payment and settlement to the evidence CSV. A loop that does not close within --wait is still recorded, with
loop_status naming the stage that is missing; a trace that fails outright is recorded as trace_error.`;

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      loop: { type: "string" },
      chain: { type: "string" },
      tx: { type: "string" },
      reactive: { type: "string" },
      wait: { type: "string", default: "300" },
      csv: { type: "string", default: "../evidence/loops.csv" },
      notes: { type: "string", default: "" },
    },
    strict: true,
  });
  const { loop, chain, tx, reactive } = values;
  if (loop === undefined || chain === undefined || tx === undefined || reactive === undefined) {
    throw new UsageError("missing --loop, --chain, --tx or --reactive");
  }
  if (!isHash(tx)) throw new UsageError("--tx must be a 32-byte hash");
  const wait = Number(values.wait);
  if (!Number.isInteger(wait) || wait < 0) throw new UsageError("--wait must be a whole number of seconds");
  const csv = resolve(values.csv ?? "../evidence/loops.csv");
  const notes = values.notes ?? "";

  try {
    const rows = await traceOrigin({
      loop,
      originChain: Number(chain),
      originTx: tx,
      reactive: getAddress(reactive),
      waitSeconds: wait,
      notes,
    });
    for (const row of rows) appendLoopRow(csv, row);
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    // Never drop a loop: a trace that cannot finish still leaves a row saying so.
    const row = emptyRow();
    row.loop = loop;
    row.origin_chain = chain;
    row.origin_tx = tx;
    row.loop_status = "trace_error";
    row.notes = `${notes}${notes ? "; " : ""}${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    row.traced_at = new Date().toISOString();
    appendLoopRow(csv, row);
    throw err;
  }
}

class UsageError extends Error {}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
