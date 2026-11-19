import assert from "node:assert/strict";
import { test } from "node:test";
import { TOPIC } from "./abi.ts";
import { parseCsv } from "./csv.ts";
import { cellMatches, roundUnits } from "./docs.ts";
import { formatDate, pageText, react4 } from "./health.ts";
import { payAddress } from "./payaddress.ts";
import { dist, percentile } from "./stats.ts";

test("pay address matches the vector scripts/src/payAddress.test.ts pins", () => {
  assert.equal(
    payAddress("0xcd8B4366d57968e186a9BE0041d96fb51294CCed", "0x5FbDB2315678afecb367f032d93F642f64180aa3", 1n),
    "0x21fad6bcBF1Cb76f20a406534879624884017736",
  );
});

test("event topics match the ones seen live", () => {
  // Same pins as scripts/src/trace/trace.test.ts.
  assert.equal(TOPIC.transfer, "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  assert.match(TOPIC.ledgerRecorded, /^0x[0-9a-f]{64}$/);
  assert.notEqual(TOPIC.receiptFailedV0, TOPIC.receiptFailedV1);
});

test("parseCsv keeps quoted commas, quotes and newlines", () => {
  const rows = parseCsv('a,b\n1,"x, ""y""\nz"\n2,\n');
  assert.deepEqual(rows, [
    { a: "1", b: 'x, "y"\nz' },
    { a: "2", b: "" },
  ]);
});

test("nearest-rank percentiles", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6], 0.5), 3);
  assert.equal(percentile([10], 0.9), 10);
  assert.deepEqual(dist([1000, 1400, 1800, 1200, 1000]), { n: 5, min: 1000, p50: 1200, p90: 1800, max: 1800 });
  assert.equal(dist([]), null);
});

test("lREACT rounding and the Health page's truncation", () => {
  assert.equal(roundUnits(32_149_900_000_000_000n, 4), "0.0321");
  assert.equal(roundUnits(44_265_700_000_000_000n, 4), "0.0443");
  assert.equal(roundUnits(502_353_300_000_000_000n, 4), "0.5024");
  assert.equal(react4(514_499_999_999_999_999n), "0.5144");
  assert.equal(react4(2_000_000_000_000_000_000n), "2.0000");
});

test("cost table cells: one value, a pair, a range", () => {
  assert.ok(cellMatches("0.0321", ["0.0321", "0.0321"]));
  assert.ok(cellMatches("282,423 / 282,435", ["282,435", "282,423"]));
  assert.ok(cellMatches("398,793 to 469,193", ["434,993", "398,793", "469,193"]));
  assert.ok(!cellMatches("398,793 to 469,193", ["398,793", "469,194"]));
  assert.ok(!cellMatches("0.0321", ["0.0321", "0.0322"]));
});

test("Health page text and date", () => {
  assert.equal(formatDate(Date.UTC(2026, 10, 19, 8, 0)), "19 Nov 2026");
  assert.equal(pageText("<dt>Invoices settled</dt><dd>6</dd><script>x</script>"), "|Invoices settled|6|");
});
