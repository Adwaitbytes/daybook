import { type AbiEvent, getAbiItem, parseAbi, toEventSelector } from "viem";

/** Signatures copied from contracts/src (v0 and v1 share every one used here; v0's `strictTokens` occupies the
 * slot v1 calls `watchAllTokens`, same type). */
export const reactiveAbi = parseAbi([
  "struct AcceptedToken { uint64 chainId; address token; uint8 decimals; }",
  "struct Recipient { address account; uint16 bps; }",
  "struct SplitPolicy { address treasury; uint16 taxBps; Recipient[] team; }",
  "struct Invoice { address payAddress; uint64 dueAt; uint32 policyId; uint64 expiresAt; uint64 createdAt; uint8 status; bool overdue; bool watchAllTokens; uint16 openSettlements; uint256 amount; uint256 paid; bytes32 detailsHash; }",
  "event InvoiceCreated(uint256 indexed invoiceId, address indexed payAddress, uint256 amount, uint64 dueAt, uint64 expiresAt, uint32 policyId, bool watchAllTokens, bytes32 detailsHash, AcceptedToken[] accepted)",
  "event LedgerRecorded(uint256 indexed index, uint256 indexed invoiceId, uint8 indexed kind, uint256 chainId, address token, address payer, uint256 amount, uint256 excess, uint256 txHash, uint256 logIndex)",
  "event DuplicateDelivery(uint256 indexed invoiceId, uint256 chainId, uint256 txHash, uint256 logIndex)",
  "event InvoicePaid(uint256 indexed invoiceId)",
  "event InvoiceSettled(uint256 indexed invoiceId)",
  "event InvoiceCancelled(uint256 indexed invoiceId)",
  "event InvoiceExpired(uint256 indexed invoiceId)",
  "event WatchNarrowed(uint256 indexed invoiceId)",
  "event SettlementRequested(uint256 indexed seq, uint256 indexed invoiceId, uint256 chainId, address token, uint256 amount, uint256 excess, uint8 attempt)",
  "event SettlementAcked(uint256 indexed seq, uint256 indexed invoiceId)",
  "function invoiceOfPayAddress(address) view returns (uint256)",
  "function tillOf(uint256) view returns (address)",
  "function getInvoice(uint256) view returns (Invoice)",
  "function getPolicy(uint32) view returns (SplitPolicy)",
  "function maxInvoiceAmount() view returns (uint256)",
]);

export const tillAbi = parseAbi([
  "event Settled(uint256 indexed invoiceId, uint256 indexed seq, address indexed token, uint256 amount, uint256 excess, address payer, uint256 chainId, bytes32 uid)",
  "event Receipt(uint256 indexed invoiceId, uint256 indexed seq, address indexed payer, address token, uint256 amount, bytes32 uid)",
  "event PayoutRedirected(uint256 indexed invoiceId, address indexed token, address indexed intended, uint256 amount)",
  "function reserve() view returns (address)",
  "function maxSettlement(address) view returns (uint256)",
]);

export const erc20Abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

function sel(abi: readonly unknown[], name: string): `0x${string}` {
  const e = getAbiItem({ abi: abi as readonly AbiEvent[], name });
  if (e === undefined || e.type !== "event") throw new Error(`no event ${name}`);
  return toEventSelector(e);
}

export const TOPIC = {
  invoiceCreated: sel(reactiveAbi, "InvoiceCreated"),
  ledgerRecorded: sel(reactiveAbi, "LedgerRecorded"),
  duplicateDelivery: sel(reactiveAbi, "DuplicateDelivery"),
  invoicePaid: sel(reactiveAbi, "InvoicePaid"),
  invoiceSettled: sel(reactiveAbi, "InvoiceSettled"),
  invoiceCancelled: sel(reactiveAbi, "InvoiceCancelled"),
  invoiceExpired: sel(reactiveAbi, "InvoiceExpired"),
  settlementRequested: sel(reactiveAbi, "SettlementRequested"),
  settlementAcked: sel(reactiveAbi, "SettlementAcked"),
  settled: sel(tillAbi, "Settled"),
  receipt: sel(tillAbi, "Receipt"),
  payoutRedirected: sel(tillAbi, "PayoutRedirected"),
  transfer: sel(erc20Abi, "Transfer"),
  // Both till generations: v0 emitted ReceiptFailed(invoiceId, seq); v1 adds gasLeft.
  receiptFailedV0: toEventSelector("event ReceiptFailed(uint256 indexed invoiceId, uint256 indexed seq)"),
  receiptFailedV1: toEventSelector("event ReceiptFailed(uint256 indexed invoiceId, uint256 indexed seq, uint256 gasLeft)"),
} as const;

export const LEDGER_KINDS = ["Payment", "Late", "Orphaned", "WrongToken"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
