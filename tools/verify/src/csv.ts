import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE } from "./config.ts";

export type Row = Record<string, string>;

/** RFC 4180 CSV as the evidence writers produce it (quoted fields may hold commas, quotes and newlines). */
export function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let field = "";
  let rec: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      rec.push(field);
      field = "";
    } else if (ch === "\n") {
      rec.push(field);
      records.push(rec);
      rec = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || rec.length > 0) {
    rec.push(field);
    records.push(rec);
  }
  const [header, ...body] = records;
  if (header === undefined) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** Reads one evidence CSV. Only complete lines count: another process may be appending while this reads, and a
 * half-written last line must not become a row. */
export function readEvidenceCsv(name: string): Row[] {
  const text = readFileSync(join(EVIDENCE, name), "utf8");
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  return parseCsv(complete);
}

export function readJsonl<T>(name: string): T[] {
  const text = readFileSync(join(EVIDENCE, name), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return []; // a line still being written
      }
    });
}
