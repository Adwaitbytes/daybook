import "server-only";
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

// The driver's default rewrites ep-….c-3.<region> to api.c-3.<region>, which does not resolve for this
// project's endpoints; the endpoint host itself serves the same SQL-over-HTTP API.
neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;

let db: Db | null | undefined;

/** The database, or null when DATABASE_URL is unset. Nothing on the site requires it. */
export function getDb(): Db | null {
  if (db !== undefined) return db;
  const url = process.env.DATABASE_URL;
  db = url === undefined || url === "" ? null : drizzle(neon(url), { schema });
  return db;
}

/** Reported once per process so an outage is visible in logs without flooding them. */
let reported = false;

export type DbOutcome<T> = { ok: true; value: T } | { ok: false; reason: "unconfigured" | "unavailable" };

/**
 * Runs a query with a hard deadline. Any failure (unset URL, network, timeout, SQL error) comes back as a value,
 * never a throw, so callers fall back to chain-only behaviour: the chain is the source of truth.
 */
export async function withDb<T>(fn: (db: Db) => Promise<T>, timeoutMs = 3_000): Promise<DbOutcome<T>> {
  const d = getDb();
  if (d === null) return { ok: false, reason: "unconfigured" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`database did not answer in ${timeoutMs} ms`)), timeoutMs);
    });
    return { ok: true, value: await Promise.race([fn(d), deadline]) };
  } catch (err) {
    if (!reported) {
      reported = true;
      console.warn("daybook: database unavailable, serving from chain only:", err instanceof Error ? err.message : err);
    }
    return { ok: false, reason: "unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test hook: forget the cached client so a changed DATABASE_URL takes effect. */
export function resetDbForTests(): void {
  db = undefined;
  reported = false;
}
