import { bigint, integer, pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Everything Daybook keeps off chain. The chain stays the source of truth: these tables only add detail
 * (client names, notes) or save work (traced hops, rate-limit counters), and every page works without them. */
export const daybook = pgSchema("daybook");

/** Off-chain invoice details. The contract stores only `detailsHash`; a row is shown only when its hash matches. */
export const invoiceDetails = daybook.table(
  "invoice_details",
  {
    reactive: text("reactive").notNull(),
    invoiceId: bigint("invoice_id", { mode: "bigint" }).notNull(),
    clientName: text("client_name").notNull(),
    notes: text("notes"),
    pdfName: text("pdf_name"),
    pdfSha256: text("pdf_sha256"),
    /** keccak256 of the canonical details JSON, equal to the invoice's on-chain detailsHash. */
    detailsHash: text("details_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.reactive, t.invoiceId] })],
);

/** Fixed-window counters for the demo-pay route, so limits survive restarts and hold across instances. */
export const demoRate = daybook.table(
  "demo_rate",
  {
    bucket: text("bucket").notNull(),
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
);

/** Settlement callbacks already found on a payment chain, so a cold server does not rescan logs. */
export const tracedCallback = daybook.table(
  "traced_callback",
  {
    reactive: text("reactive").notNull(),
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    chainId: integer("chain_id").notNull(),
    tx: text("tx").notNull(),
    atMs: bigint("at_ms", { mode: "number" }),
    clock: text("clock").notNull(),
    receiptUid: text("receipt_uid").notNull(),
    tracedAt: timestamp("traced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.reactive, t.seq] })],
);
