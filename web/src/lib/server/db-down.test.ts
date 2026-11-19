import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests, withDb } from "./db/client";
import { loadCallback, loadDetails, rateLimit } from "./store";

// "Database-down test": with Postgres unreachable, every store call degrades to chain-only behaviour quickly
// and never throws, which is what keeps pay pages and status rendering.
const REACTIVE = "0x182BA62E240433B54136712d8840Ccc354bb78d3";
const HASH = `0x${"ab".repeat(32)}` as const;

describe("database down", () => {
  const saved = process.env.DATABASE_URL;
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:9/daybook";
    resetDbForTests();
  });
  afterEach(() => {
    process.env.DATABASE_URL = saved;
    resetDbForTests();
  });

  it("withDb returns unavailable instead of throwing, within its deadline", async () => {
    const t = Date.now();
    const r = await withDb(async (db) => db.execute("select 1"), 1_500);
    expect(r).toEqual({ ok: false, reason: "unavailable" });
    expect(Date.now() - t).toBeLessThan(2_500);
  });

  it("off-chain details report unavailable; the pay page then shows chain data only", async () => {
    expect(await loadDetails(REACTIVE, "1", HASH)).toEqual({ kind: "unavailable" });
  });

  it("a zero details hash needs no database at all", async () => {
    expect(await loadDetails(REACTIVE, "1", `0x${"0".repeat(64)}`)).toEqual({ kind: "none" });
  });

  it("traced-hop cache misses fall through to a chain scan", async () => {
    expect(await loadCallback(REACTIVE, "1")).toBeNull();
  });

  it("rate limiting keeps working in memory and says it is not durable", async () => {
    const w = [{ key: `test-${Date.now()}`, limit: 1, windowMs: 60_000 }];
    expect(await rateLimit(w)).toEqual({ ok: true, durable: false });
    const second = await rateLimit(w);
    expect(second.ok).toBe(false);
  });
});

describe("database unset", () => {
  it("reports unconfigured without trying to connect", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    resetDbForTests();
    expect(await withDb(async () => 1)).toEqual({ ok: false, reason: "unconfigured" });
    process.env.DATABASE_URL = saved;
    resetDbForTests();
  });
});
