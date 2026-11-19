import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Address } from "viem";
import { detailsHashOf, type InvoiceDetails } from "@/lib/details";
import { MemoryLimiter, type Verdict, type Window, windowStart } from "@/lib/rate-limit";
import type { Clock, Hex, Hop } from "@/lib/types";
import { withDb } from "./db/client";
import { demoRate, invoiceDetails, tracedCallback } from "./db/schema";

// ---------------------------------------------------------------- rate limits

const memory = new MemoryLimiter();

export type RateVerdict = Verdict & { durable: boolean };

/**
 * In-memory windows first (cheap, per instance), then the same windows in Postgres so limits hold across
 * restarts and instances. If the database is down the in-memory limits still apply and the result says so.
 */
export async function rateLimit(windows: readonly Window[]): Promise<RateVerdict> {
  const local = memory.hit(windows);
  if (!local.ok) return { ...local, durable: false };
  const t = Date.now();
  const durable = await withDb(async (db) => {
    for (const w of windows) {
      const start = windowStart(t, w.windowMs);
      const [row] = await db
        .insert(demoRate)
        .values({ bucket: `${w.key}@${w.windowMs}`, windowStart: start, count: 1 })
        .onConflictDoUpdate({
          target: [demoRate.bucket, demoRate.windowStart],
          set: { count: sql`${demoRate.count} + 1` },
        })
        .returning({ count: demoRate.count });
      if (row !== undefined && row.count > w.limit) {
        return { ok: false as const, key: w.key, retryAfterMs: start + w.windowMs - t };
      }
    }
    return { ok: true as const };
  });
  if (!durable.ok) return { ok: true, durable: false };
  return { ...durable.value, durable: true };
}

// ---------------------------------------------------------------- traced callbacks

export async function loadCallback(reactive: Address, seq: string): Promise<{ hop: Hop; uid: Hex } | null> {
  const r = await withDb(
    (db) =>
      db
        .select()
        .from(tracedCallback)
        .where(and(eq(tracedCallback.reactive, reactive.toLowerCase()), eq(tracedCallback.seq, BigInt(seq))))
        .limit(1),
    2_500,
  );
  const row = r.ok ? r.value[0] : undefined;
  if (row === undefined) return null;
  return {
    hop: { chainId: row.chainId, tx: row.tx as Hex, at: row.atMs, clock: row.clock as Clock },
    uid: row.receiptUid as Hex,
  };
}

export async function saveCallback(reactive: Address, seq: string, hop: Hop, uid: Hex): Promise<void> {
  await withDb((db) =>
    db
      .insert(tracedCallback)
      .values({
        reactive: reactive.toLowerCase(),
        seq: BigInt(seq),
        chainId: hop.chainId,
        tx: hop.tx,
        atMs: hop.at,
        clock: hop.clock,
        receiptUid: uid,
      })
      .onConflictDoNothing(),
  );
}

// ---------------------------------------------------------------- invoice details

export type DetailsRead =
  | { kind: "ok"; details: InvoiceDetails }
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "mismatch" };

/** Off-chain details for an invoice, shown only when they hash to the invoice's on-chain detailsHash. */
export async function loadDetails(reactive: Address, invoiceId: string, chainHash: Hex): Promise<DetailsRead> {
  if (/^0x0+$/.test(chainHash)) return { kind: "none" };
  const r = await withDb((db) =>
    db
      .select()
      .from(invoiceDetails)
      .where(and(eq(invoiceDetails.reactive, reactive.toLowerCase()), eq(invoiceDetails.invoiceId, BigInt(invoiceId))))
      .limit(1),
  );
  if (!r.ok) return { kind: "unavailable" };
  const row = r.value[0];
  if (row === undefined) return { kind: "none" };
  const details = { clientName: row.clientName, notes: row.notes, pdfSha256: row.pdfSha256 };
  return detailsHashOf(details).toLowerCase() === chainHash.toLowerCase()
    ? { kind: "ok", details }
    : { kind: "mismatch" };
}
