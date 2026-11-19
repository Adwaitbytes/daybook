import "server-only";
import { createPublicClient, http, type PublicClient } from "viem";
import { LASNA, type PaymentChain } from "@/lib/chains";

const clients = new Map<number, PublicClient>();

function make(id: number, url: string): PublicClient {
  const existing = clients.get(id);
  if (existing !== undefined) return existing;
  const c = createPublicClient({
    transport: http(url, { batch: { batchSize: 40, wait: 8 }, retryCount: 2, retryDelay: 400, timeout: 15_000 }),
  });
  clients.set(id, c);
  return c;
}

function urlFor(envKey: string, fallback: string): string {
  const v = process.env[envKey];
  return v !== undefined && v !== "" ? v : fallback;
}

export function lasna(): PublicClient {
  return make(LASNA.id, urlFor(LASNA.rpcEnv, LASNA.rpcDefault));
}

export function chainClient(c: PaymentChain): PublicClient {
  return make(c.id, urlFor(c.rpcEnv, c.rpcDefault));
}

/** An RPC failure the page can explain: which network did not answer. */
export class RpcError extends Error {
  constructor(
    readonly network: string,
    cause: unknown,
  ) {
    super(`${network} did not answer`, { cause });
    this.name = "RpcError";
  }
}

export async function onNetwork<T>(network: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw new RpcError(network, err);
  }
}
