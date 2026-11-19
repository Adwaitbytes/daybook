import { describe, expect, it } from "vitest";
import { resetDbForTests } from "./db/client";
import { rateLimit } from "./store";

// Runs only with a real DATABASE_URL (from .env.local via `pnpm test:db`): proves the durable path works end to end.
describe.skipIf(process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "")("database up", () => {
  it("counts rate-limit hits durably in Postgres", async () => {
    resetDbForTests();
    const w = [{ key: `test-live-${Date.now()}-${Math.random()}`, limit: 5, windowMs: 60_000 }];
    const v = await rateLimit(w);
    expect(v).toEqual({ ok: true, durable: true });
  });
});
