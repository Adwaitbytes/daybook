/** Collects every comparison verify makes. A mismatch is a committed value that the chain (or a recomputation
 * from chain data) does not reproduce; a skip is a field verify cannot check from RPC data, with the reason. */
export type Mismatch = { section: string; item: string; field: string; committed: string; chain: string };

export type Section = {
  name: string;
  rows: number;
  checks: number;
  mismatches: number;
  notes: string[];
  skipped: string[];
};

export class Report {
  readonly sections = new Map<string, Section>();
  readonly mismatches: Mismatch[] = [];
  readonly errors: { section: string; item: string; error: string }[] = [];

  section(name: string): Section {
    let s = this.sections.get(name);
    if (s === undefined) {
      s = { name, rows: 0, checks: 0, mismatches: 0, notes: [], skipped: [] };
      this.sections.set(name, s);
    }
    return s;
  }

  /** Compares as strings after normalising: "" and undefined both mean "not recorded". */
  eq(section: string, item: string, field: string, committed: unknown, chain: unknown): boolean {
    const s = this.section(section);
    s.checks++;
    const a = norm(committed);
    const b = norm(chain);
    if (a === b) return true;
    s.mismatches++;
    this.mismatches.push({ section, item, field, committed: a, chain: b });
    return false;
  }

  /** Numeric comparison within an absolute tolerance, for figures the evidence writers rounded. */
  near(section: string, item: string, field: string, committed: number, chain: number, tol: number): boolean {
    const s = this.section(section);
    s.checks++;
    if (Number.isFinite(committed) && Number.isFinite(chain) && Math.abs(committed - chain) <= tol) return true;
    s.mismatches++;
    this.mismatches.push({ section, item, field, committed: String(committed), chain: String(chain) });
    return false;
  }

  error(section: string, item: string, err: unknown): void {
    this.section(section).mismatches++;
    this.errors.push({ section, item, error: err instanceof Error ? err.message : String(err) });
  }

  ok(): boolean {
    return this.mismatches.length === 0 && this.errors.length === 0;
  }
}

function norm(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "bigint") return v.toString();
  return String(v);
}
