import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toEventSelector } from "viem";
import { reactiveAbi, tillAbi } from "./abi.ts";
import { LOOP_COLUMNS, appendLoopRow, csvField, emptyRow } from "./evidence.ts";
import { topicOf } from "./trace.ts";

test("event signatures match the topics seen live on Lasna and Base Sepolia", () => {
  const sel = (name: string) => {
    const e = [...reactiveAbi, ...tillAbi].find((x) => x.type === "event" && x.name === name);
    assert.ok(e !== undefined && e.type === "event");
    return toEventSelector(e);
  };
  // Topic hashes read from the first live loop's receipts (docs/FIRST_LOOPS.md) and the v0 subscriptions.
  assert.equal(sel("Settled").slice(0, 10), "0x6676e00b");
  assert.equal(sel("Receipt").slice(0, 10), "0x9e05d41f");
  assert.equal(
    toEventSelector("event ReceiptFailed(uint256 indexed invoiceId, uint256 indexed seq)").slice(0, 10),
    "0x856de7b8",
  );
});

test("topicOf left-pads to 32 bytes", () => {
  assert.equal(topicOf(1n), `0x${"0".repeat(63)}1`);
  assert.equal(topicOf(0xabcn).length, 66);
});

test("csvField quotes commas, quotes and newlines only", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("x\ny"), '"x\ny"');
});

test("appendLoopRow writes the header once and only appends", () => {
  const path = join(mkdtempSync(join(tmpdir(), "loops-")), "loops.csv");
  const a = emptyRow();
  a.loop = "first";
  a.loop_status = "no_reaction";
  const b = emptyRow();
  b.loop = "second";
  b.notes = "has, comma";
  appendLoopRow(path, a);
  appendLoopRow(path, b);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], LOOP_COLUMNS.join(","));
  assert.ok(lines[1]?.startsWith("first,"));
  assert.ok(lines[2]?.includes('"has, comma"'));
});

test("appendLoopRow refuses a file with a different header", () => {
  const path = join(mkdtempSync(join(tmpdir(), "loops-")), "loops.csv");
  writeFileSync(path, "some,other,header\n");
  assert.throws(() => appendLoopRow(path, emptyRow()), /different header/);
});
