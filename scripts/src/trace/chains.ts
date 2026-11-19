import { type Address, getAddress } from "viem";

/** Clock a timestamp came from. Base Sepolia (Denim, 200 ms blocks) exposes `blockTimestampMs` on logs;
 * Unichain Sepolia and Lasna only have whole-second block timestamps. */
export type ClockPrecision = "ms" | "s";

export type PaymentChain = {
  id: number;
  name: string;
  rpc: string;
  callbackProxy: Address;
  explorerTx: string;
};

export const LASNA = {
  id: 5_318_007,
  rpc: "https://lasna-rpc.rnk.dev/",
  system: getAddress("0x8888888888888888888888888888888888888888"),
  explorerTx: "https://lasna.reactscan.net/tx/",
} as const;

export const PAYMENT_CHAINS: readonly PaymentChain[] = [
  {
    id: 84_532,
    name: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    callbackProxy: getAddress("0x476F44b11F5C942c58f4c8E3d0300E5710743585"),
    explorerTx: "https://sepolia.basescan.org/tx/",
  },
  {
    id: 1301,
    name: "Unichain Sepolia",
    rpc: "https://sepolia.unichain.org",
    callbackProxy: getAddress("0x775c9B990ADe401060B78D0e98684eEf8d2466C1"),
    explorerTx: "https://unichain-sepolia.blockscout.com/tx/",
  },
];

export function paymentChain(id: number): PaymentChain {
  const c = PAYMENT_CHAINS.find((x) => x.id === id);
  if (c === undefined) throw new Error(`unknown payment chain ${id}`);
  return c;
}
