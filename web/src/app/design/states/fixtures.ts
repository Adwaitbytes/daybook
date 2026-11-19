import "server-only";
import type { InvoiceSnapshot, LedgerLine } from "@/lib/types";

// Fixture data for design review of states the live demo may not be in right now. Rendered only when
// DAYBOOK_STATE_GALLERY=1, under a banner that says so. The pay address is the burn address, never a real one.
const T0 = Date.UTC(2026, 10, 19, 9, 0, 0);
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const base: InvoiceSnapshot = {
  id: "0",
  reactive: "0x0000000000000000000000000000000000000000",
  payAddress: "0x000000000000000000000000000000000000dEaD",
  payAddressVerified: true,
  amount: "480000000",
  paid: "0",
  status: "Open",
  overdue: false,
  dueAt: T0 + 14 * 86_400_000,
  expiresAt: null,
  createdAt: T0,
  policyId: 1,
  detailsHash: `0x${"0".repeat(64)}`,
  accepted: [
    { chainId: 84532, token: USDC, decimals: 6, symbol: "USDC" },
    { chainId: 1301, token: "0x31d0220469e10c4E71834a79b1f276d740d3768F", decimals: 6, symbol: "USDC" },
  ],
  entries: [],
  settlements: [],
  readAt: T0 + 60_000,
};

const pay = (over: Partial<LedgerLine>): LedgerLine => ({
  index: 0,
  invoiceId: "0",
  kind: "Payment",
  chainId: 84532,
  token: USDC,
  symbol: "USDC",
  decimals: 6,
  payer: "0x000000000000000000000000000000000000bEEF",
  amount: "200000000",
  excess: "0",
  originTx: `0x${"1".repeat(64)}`,
  logIndex: 0,
  originAt: T0 + 30_000,
  originClock: "ms",
  reactive: { chainId: 5318007, tx: `0x${"2".repeat(64)}`, at: T0 + 31_000, clock: "s" },
  ...over,
});

export const FIXTURES: Record<string, InvoiceSnapshot> = {
  waiting: base,
  overdue: { ...base, overdue: true, dueAt: T0 - 86_400_000 },
  "part-paid": { ...base, paid: "200000000", entries: [pay({})] },
  "payment-seen": { ...base, status: "Paid", paid: "480000000", entries: [pay({ amount: "480000000" })] },
  "wrong-token": {
    ...base,
    entries: [
      pay({
        kind: "WrongToken",
        token: "0x000000000000000000000000000000000000c0DE",
        symbol: null,
        decimals: null,
        amount: "1000000",
      }),
    ],
  },
  expired: { ...base, status: "Expired", expiresAt: T0 + 7 * 86_400_000, dueAt: null },
};
