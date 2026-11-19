/** Shapes passed from the server to the browser. Amounts travel as decimal strings because JSON has no bigint. */

export const INVOICE_STATUS = ["None", "Open", "Paid", "Settled", "Cancelled", "Expired"] as const;
export type InvoiceStatusName = (typeof INVOICE_STATUS)[number];

export const ENTRY_KINDS = ["Payment", "Late", "Orphaned", "WrongToken"] as const;
export type EntryKindName = (typeof ENTRY_KINDS)[number];

export const SETTLEMENT_STATUS = ["None", "Pending", "Acked", "Stuck", "Resolved"] as const;
export type SettlementStatusName = (typeof SETTLEMENT_STATUS)[number];

export type Hex = `0x${string}`;
export type Clock = "ms" | "s";

/** One transaction in the loop, with the time its block was made. */
export type Hop = { chainId: number; tx: Hex; at: number | null; clock: Clock };

export type AcceptedPair = { chainId: number; token: Hex; decimals: number; symbol: string | null };

export type LedgerLine = {
  index: number;
  invoiceId: string;
  kind: EntryKindName;
  chainId: number;
  token: Hex;
  symbol: string | null;
  decimals: number | null;
  payer: Hex;
  /** Raw token units counted toward the invoice. */
  amount: string;
  /** Raw token units beyond the invoice amount (overpayment, late, orphaned). */
  excess: string;
  originTx: Hex;
  logIndex: number;
  /** When the origin transfer's block was made, if it could be read. */
  originAt: number | null;
  originClock: Clock | null;
  /** The reactive transaction on Lasna that wrote this line. */
  reactive: Hop | null;
};

export type SettlementLine = {
  seq: string;
  chainId: number;
  token: Hex;
  amount: string;
  excess: string;
  status: SettlementStatusName;
  requested: Hop | null;
  callback: Hop | null;
  ack: Hop | null;
  receiptUid: Hex | null;
};

export type InvoiceSnapshot = {
  id: string;
  reactive: Hex;
  payAddress: Hex;
  /** True when the pay address recomputed from the deployed factory equals the one the contract stores. */
  payAddressVerified: boolean;
  amount: string;
  paid: string;
  status: InvoiceStatusName;
  overdue: boolean;
  dueAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  policyId: number;
  /** keccak256 of the off-chain details; zero when the invoice has none. */
  detailsHash: Hex;
  accepted: AcceptedPair[];
  entries: LedgerLine[];
  settlements: SettlementLine[];
  readAt: number;
};
