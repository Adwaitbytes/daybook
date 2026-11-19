import "server-only";
import { type Address, getAddress, isAddress } from "viem";
import { generatedDeployments } from "@/generated/deployments";

export type Deployment =
  | { kind: "deployed"; reactive: Address; deployBlock: bigint | null; source: string }
  | { kind: "not-deployed" };

/**
 * The Lasna deployment the public demo reads. The generated record (from contracts/deployments or
 * docs/DEPLOYMENTS.md) wins. DAYBOOK_REACTIVE_ADDRESS is only for previewing a deployment before its record is
 * published; it must name a real deployed contract, and every figure is still read from chain.
 */
export function deployment(): Deployment {
  const rec = generatedDeployments.lasna;
  if (rec !== null) {
    return {
      kind: "deployed",
      reactive: getAddress(rec.reactive),
      deployBlock: rec.deployBlock === null ? null : BigInt(rec.deployBlock),
      source: rec.source,
    };
  }
  const env = process.env.DAYBOOK_REACTIVE_ADDRESS;
  if (env !== undefined && env !== "") {
    if (!isAddress(env)) throw new Error("DAYBOOK_REACTIVE_ADDRESS is set but is not an address");
    return { kind: "deployed", reactive: getAddress(env), deployBlock: null, source: "env DAYBOOK_REACTIVE_ADDRESS" };
  }
  return { kind: "not-deployed" };
}
