import { type Address, getAddress } from "viem";

/** Payment chains the testnet twin accepts, plus Lasna where DaybookReactive lives. Addresses from ref/FACTS.md. */
export type PaymentChain = {
  id: number;
  name: string;
  short: string;
  rpcEnv: string;
  rpcDefault: string;
  usdc: Address;
  callbackProxy: Address;
  explorer: string;
  /** Milliseconds per block, used to estimate a block from a timestamp before scanning logs. */
  blockMs: number;
  /** Largest eth_getLogs block span the public RPC serves. */
  logSpan: bigint;
  /** EAS explorer for receipts, where one exists for the chain. */
  easScan: string | null;
};

export const LASNA = {
  id: 5_318_007,
  name: "Reactive Lasna",
  short: "Reactive",
  rpcEnv: "LASNA_RPC_URL",
  rpcDefault: "https://lasna-rpc.rnk.dev/",
  system: getAddress("0x8888888888888888888888888888888888888888"),
  explorer: "https://lasna.reactscan.net",
  blockMs: 1060,
  logSpan: 30_000n,
  nativeSymbol: "lREACT",
  /** Cron100 topic from reactive-lib-omni, used by the "Make your own" wizard. */
  cron100: "0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70",
  faucet: "https://dev.reactive.network/reactive-mainnet#reactive-faucet",
} as const;

export const BASE_SEPOLIA: PaymentChain = {
  id: 84_532,
  name: "Base Sepolia",
  short: "Base Sepolia",
  rpcEnv: "BASE_SEPOLIA_RPC_URL",
  rpcDefault: "https://sepolia.base.org",
  usdc: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  callbackProxy: getAddress("0x476F44b11F5C942c58f4c8E3d0300E5710743585"),
  explorer: "https://sepolia.basescan.org",
  blockMs: 200,
  logSpan: 200n,
  easScan: "https://base-sepolia.easscan.org/attestation/view/",
};

export const UNICHAIN_SEPOLIA: PaymentChain = {
  id: 1301,
  name: "Unichain Sepolia",
  short: "Unichain Sepolia",
  rpcEnv: "UNICHAIN_SEPOLIA_RPC_URL",
  rpcDefault: "https://sepolia.unichain.org",
  usdc: getAddress("0x31d0220469e10c4E71834a79b1f276d740d3768F"),
  callbackProxy: getAddress("0x775c9B990ADe401060B78D0e98684eEf8d2466C1"),
  explorer: "https://unichain-sepolia.blockscout.com",
  blockMs: 1000,
  logSpan: 2000n,
  easScan: null,
};

export const PAYMENT_CHAINS: readonly PaymentChain[] = [BASE_SEPOLIA, UNICHAIN_SEPOLIA];

export function paymentChain(id: number): PaymentChain | undefined {
  return PAYMENT_CHAINS.find((c) => c.id === id);
}

export function chainName(id: number): string {
  if (id === LASNA.id) return LASNA.short;
  return paymentChain(id)?.short ?? `Chain ${id}`;
}

export function txUrl(chainId: number, hash: string): string | null {
  if (chainId === LASNA.id) return `${LASNA.explorer}/tx/${hash}`;
  const c = paymentChain(chainId);
  return c === undefined ? null : `${c.explorer}/tx/${hash}`;
}

export function addressUrl(chainId: number, address: string): string | null {
  if (chainId === LASNA.id) return `${LASNA.explorer}/address/${address}`;
  const c = paymentChain(chainId);
  return c === undefined ? null : `${c.explorer}/address/${address}`;
}

/** Known token symbols by (chain, address); anything else is shown by address. */
export function tokenSymbol(chainId: number, token: string): string | null {
  const c = paymentChain(chainId);
  if (c !== undefined && c.usdc.toLowerCase() === token.toLowerCase()) return "USDC";
  return null;
}
