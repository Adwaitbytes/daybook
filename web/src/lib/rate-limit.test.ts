import { describe, expect, it } from "vitest";
import { MemoryLimiter } from "./rate-limit";

describe("MemoryLimiter", () => {
  it("allows up to the limit in a window, then denies with the time left", () => {
    let t = 1_000_000;
    const l = new MemoryLimiter(() => t);
    const w = [{ key: "ip:1", limit: 2, windowMs: 60_000 }];
    expect(l.hit(w).ok).toBe(true);
    expect(l.hit(w).ok).toBe(true);
    const v = l.hit(w);
    expect(v).toEqual({ ok: false, key: "ip:1", retryAfterMs: 20_000 });
    t += 20_000;
    expect(l.hit(w).ok).toBe(true);
  });

  it("does not spend the per-IP allowance when the global window is full", () => {
    const l = new MemoryLimiter(() => 0);
    const global = { key: "global", limit: 1, windowMs: 1000 };
    expect(l.hit([{ key: "ip:a", limit: 5, windowMs: 1000 }, global]).ok).toBe(true);
    expect(l.hit([{ key: "ip:b", limit: 5, windowMs: 1000 }, global]).ok).toBe(false);
    expect(l.hit([{ key: "ip:b", limit: 5, windowMs: 1000 }]).ok).toBe(true);
  });
});
