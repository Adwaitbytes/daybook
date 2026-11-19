import { describe, expect, it } from "vitest";
import { deriveStatus } from "./status";
import type { InvoiceSnapshot, LedgerLine, SettlementLine } from "./types";

const T0 = Date.UTC(2026, 10, 19, 9, 0, 0);

function snap(over: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    id: "2",
    reactive: "0x182BA62E240433B54136712d8840Ccc354bb78d3",
    payAddress: "0x9cD2d5DFfd3D1e119d04898872bbd47C38878a6e",
    payAddressVerified: true,
    amount: "2000000",
    paid: "0",
    status: "Open",
    overdue: false,
    dueAt: null,
    expiresAt: null,
    createdAt: T0,
    policyId: 1,
    detailsHash: `0x${"0".repeat(64)}`,
    accepted: [{ chainId: 84532, token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, symbol: "USDC" }],
    entries: [],
    settlements: [],
    readAt: T0,
    ...over,
  };
}

function entry(over: Partial<LedgerLine> = {}): LedgerLine {
  return {
    index: 0,
    invoiceId: "2",
    kind: "Payment",
    chainId: 84532,
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    symbol: "USDC",
    decimals: 6,
    payer: "0x4d96Ec766088D952D62255227902eeEe1C58276c",
    amount: "750000",
    excess: "0",
    originTx: "0xaa",
    logIndex: 0,
    originAt: T0 + 1000,
    originClock: "ms",
    reactive: { chainId: 5318007, tx: "0xbb", at: T0 + 2000, clock: "s" },
    ...over,
  };
}

const settled: SettlementLine = {
  seq: "2",
  chainId: 84532,
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "2000000",
  excess: "0",
  status: "Acked",
  requested: { chainId: 5318007, tx: "0xcc", at: T0 + 2000, clock: "s" },
  callback: { chainId: 84532, tx: "0xdd", at: T0 + 3400, clock: "ms" },
  ack: { chainId: 5318007, tx: "0xee", at: T0 + 5000, clock: "s" },
  receiptUid: null,
};

describe("deriveStatus", () => {
  it("waits with nothing received", () => {
    const d = deriveStatus(snap());
    expect(d.phase).toBe("waiting");
    expect(d.remaining).toBe(2_000_000n);
    expect(d.stations.map((s) => s.state)).toEqual(["now", "todo", "todo"]);
    expect(d.stations[0].title).toBe("Waiting for a transfer");
  });

  it("shows part paid with the balance still due", () => {
    const d = deriveStatus(snap({ paid: "750000", entries: [entry()] }));
    expect(d.phase).toBe("part-paid");
    expect(d.remaining).toBe(1_250_000n);
    expect(d.stations[0].title).toBe("Received 0.75 of 2.00");
    expect(d.stations[1].state).toBe("todo");
  });

  it("says payment seen, not paid, while the contract status is Paid but not Settled", () => {
    const d = deriveStatus(snap({ status: "Paid", paid: "2000000", entries: [entry({ amount: "2000000" })] }));
    expect(d.phase).toBe("payment-seen");
    expect(d.stations.map((s) => s.state)).toEqual(["done", "done", "now"]);
    expect(d.settledAt).toBeNull();
  });

  it("is settled only on Settled, with the loop time from the ms clocks", () => {
    const d = deriveStatus(
      snap({ status: "Settled", paid: "2000000", entries: [entry({ amount: "2000000" })], settlements: [settled] }),
    );
    expect(d.phase).toBe("settled");
    expect(d.stations.map((s) => s.state)).toEqual(["done", "done", "done"]);
    expect(d.stations[2].hop?.tx).toBe("0xdd");
    expect(d.loopMs).toBe(2400);
  });

  it("does not compute a loop time when the origin clock is whole seconds", () => {
    const d = deriveStatus(
      snap({
        status: "Settled",
        paid: "2000000",
        entries: [entry({ originClock: "s" })],
        settlements: [settled],
      }),
    );
    expect(d.loopMs).toBeNull();
  });

  it("flags a wrong-token transfer without counting it", () => {
    const d = deriveStatus(snap({ entries: [entry({ kind: "WrongToken", amount: "1000000" })] }));
    expect(d.phase).toBe("waiting");
    expect(d.flagged).toHaveLength(1);
    expect(d.received).toBe(0n);
  });

  it("voids the remaining stations when the invoice expires unpaid", () => {
    const d = deriveStatus(snap({ status: "Expired" }));
    expect(d.phase).toBe("expired");
    expect(d.stations.map((s) => s.state)).toEqual(["void", "void", "void"]);
  });

  it("keeps a part payment visible on a cancelled invoice", () => {
    const d = deriveStatus(snap({ status: "Cancelled", paid: "750000", entries: [entry()] }));
    expect(d.phase).toBe("cancelled");
    expect(d.stations[0].state).toBe("done");
    expect(d.stations[1].state).toBe("void");
  });

  it("passes the overdue flag through", () => {
    expect(deriveStatus(snap({ overdue: true })).overdue).toBe(true);
  });

  it("records late transfers separately", () => {
    const d = deriveStatus(snap({ status: "Settled", paid: "2000000", entries: [entry({ kind: "Late" })] }));
    expect(d.late).toHaveLength(1);
  });
});
