import { parseAbi } from "viem";

/** Events and views the tracer reads. Signatures copied from contracts/src; a test pins the topic hashes. */
export const reactiveAbi = parseAbi([
  "event LedgerRecorded(uint256 indexed index, uint256 indexed invoiceId, uint8 indexed kind, uint256 chainId, address token, address payer, uint256 amount, uint256 excess, uint256 txHash, uint256 logIndex)",
  "event DuplicateDelivery(uint256 indexed invoiceId, uint256 chainId, uint256 txHash, uint256 logIndex)",
  "event SettlementRequested(uint256 indexed seq, uint256 indexed invoiceId, uint256 chainId, address token, uint256 amount, uint256 excess, uint8 attempt)",
  "event SettlementAcked(uint256 indexed seq, uint256 indexed invoiceId)",
  "event InvoicePaid(uint256 indexed invoiceId)",
  "event InvoiceSettled(uint256 indexed invoiceId)",
  "function invoiceOfPayAddress(address) view returns (uint256)",
  "function tillOf(uint256) view returns (address)",
]);

export const tillAbi = parseAbi([
  "event Settled(uint256 indexed invoiceId, uint256 indexed seq, address indexed token, uint256 amount, uint256 excess, address payer, uint256 chainId, bytes32 uid)",
  "event Receipt(uint256 indexed invoiceId, uint256 indexed seq, address indexed payer, address token, uint256 amount, bytes32 uid)",
  "event ReceiptFailed(uint256 indexed invoiceId, uint256 indexed seq)",
  "event DuplicateSettlement(uint256 indexed invoiceId, uint256 indexed seq)",
]);

export const erc20Abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/** System contract on Reactive and callback proxies on payment chains share these accounting views. */
export const payableAbi = parseAbi([
  "function reserves(address) view returns (uint256)",
  "function debt(address) view returns (uint256)",
]);

export const systemAbi = parseAbi([
  "struct CallbackRecord { uint256 blockNumber; address rc; uint256 index; uint256 chainId; uint256 txHash; bytes err; }",
  "function getCallbacks(uint256 txHash) view returns (CallbackRecord[])",
]);

export const ledgerKinds = ["Payment", "Late", "Orphaned", "WrongToken"] as const;
