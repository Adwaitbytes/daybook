/** Fixed-window counter kept in process memory. The first line of defence; a durable copy lives in Postgres. */
export type Window = { key: string; limit: number; windowMs: number };
export type Verdict = { ok: true } | { ok: false; key: string; retryAfterMs: number };

export class MemoryLimiter {
  private readonly counts = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one hit against every window; denies (without counting) if any window is already full. */
  hit(windows: readonly Window[]): Verdict {
    const t = this.now();
    for (const w of windows) {
      const c = this.current(w, t);
      if (c.count >= w.limit) return { ok: false, key: w.key, retryAfterMs: c.start + w.windowMs - t };
    }
    for (const w of windows) this.current(w, t).count += 1;
    this.sweep(t);
    return { ok: true };
  }

  private current(w: Window, t: number): { start: number; count: number } {
    const start = Math.floor(t / w.windowMs) * w.windowMs;
    const id = `${w.key}@${w.windowMs}`;
    let c = this.counts.get(id);
    if (c === undefined || c.start !== start) {
      c = { start, count: 0 };
      this.counts.set(id, c);
    }
    return c;
  }

  /** Bounds memory: drop windows that have ended once the map grows. */
  private sweep(t: number): void {
    if (this.counts.size < 5_000) return;
    for (const [k, v] of this.counts) if (v.start + 86_400_000 < t) this.counts.delete(k);
  }
}

export function windowStart(t: number, windowMs: number): number {
  return Math.floor(t / windowMs) * windowMs;
}
