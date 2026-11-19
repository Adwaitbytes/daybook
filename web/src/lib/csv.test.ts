import { describe, expect, it } from "vitest";
import { csvField, LEDGER_CSV_COLUMNS, ledgerToCsv } from "./csv";
import type { LedgerLine } from "./types";

const line: LedgerLine = {
  index: 0,
  invoiceId: "1",
  kind: "Payment",
  chainId: 84532,
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  symbol: "USDC",
  decimals: 6,
  payer: "0x4d96Ec766088D952D62255227902eeEe1C58276c",
  amount: "1250000",
  excess: "0",
  originTx: "0x83f977cbdfafa67375d522af4875de0e09c0a67a75a79923f967e168122aad6b",
  logIndex: 8,
  originAt: Date.UTC(2026, 10, 19, 8, 56, 10, 600),
  originClock: "ms",
  reactive: {
    chainId: 5318007,
    tx: "0xc4088634fc23911523f4416d44aeeb0bfd01f42300825201a7b541cb87fd049e",
    at: null,
    clock: "s",
  },
};

describe("ledgerToCsv", () => {
  it("writes a header and one CRLF-terminated row per entry with exact decimal amounts", () => {
    const csv = ledgerToCsv([line]);
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe(LEDGER_CSV_COLUMNS.join(","));
    expect(rows[1]).toBe(
      "0,2026-11-19T08:56:10.600Z,1,Payment,matched,Base Sepolia,84532,USDC,0x036CbD53842c5426634e7929541eC2318f3dCF7e,0x4d96Ec766088D952D62255227902eeEe1C58276c,1.250000,0.000000,0x83f977cbdfafa67375d522af4875de0e09c0a67a75a79923f967e168122aad6b,8,0xc4088634fc23911523f4416d44aeeb0bfd01f42300825201a7b541cb87fd049e",
    );
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("flags wrong-token lines and leaves unknown-decimal amounts raw", () => {
    const csv = ledgerToCsv([{ ...line, kind: "WrongToken", symbol: null, decimals: null, amount: "42" }]);
    expect(csv).toContain(",WrongToken,flagged,");
    expect(csv).toContain(",42 raw,");
  });

  it("does not group thousands, so spreadsheets read numbers", () => {
    const csv = ledgerToCsv([{ ...line, amount: "1234567890000" }]);
    expect(csv).toContain(",1234567.890000,");
  });

  it("writes an empty time when the block time is unknown", () => {
    expect(
      ledgerToCsv([{ ...line, originAt: null }])
        .split("\r\n")[1]
        ?.startsWith("0,,1,"),
    ).toBe(true);
  });
});

describe("csvField", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("x\ny")).toBe('"x\ny"');
  });

  it("neutralizes spreadsheet formulas", () => {
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("@x")).toBe("'@x");
  });
});
