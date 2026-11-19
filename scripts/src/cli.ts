import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isHex,
  parseUnits,
} from "viem";
import { daybookReactiveAbi, invoiceStatus } from "./abi.ts";
import { payAddress } from "./payAddress.ts";

const USAGE = `daybook <command> [options]

  pay-address     --factory <addr> --reactive <addr> --id <n>
                  Print an invoice's pay address (offline, same on every chain).

  invoice         --rpc <url> --reactive <addr> --id <n>
                  Read an invoice from the reactive contract.

  create-invoice  --rpc <url> --reactive <addr> --policy <id> --amount <usd, e.g. 1250.00>
                  --accept <chainId:token:decimals>[,...] [--due <unix>] [--expires <unix>]
                  [--strict] [--details-hash <bytes32>] [--send] [--account <keystore>]
                  Encode createInvoice; with --send, submit it through \`cast send\` using the Foundry keystore
                  (default omni-deployer), so no private key ever passes through this tool.`;

class UsageError extends Error {}

function required(values: Record<string, unknown>, key: string): string {
  const v = values[key];
  if (typeof v !== "string" || v.length === 0) throw new UsageError(`missing --${key}`);
  return v;
}

function address(values: Record<string, unknown>, key: string): Address {
  const raw = required(values, key);
  try {
    return getAddress(raw);
  } catch {
    throw new UsageError(`--${key} is not an address: ${raw}`);
  }
}

function positiveInt(raw: string, label: string): bigint {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${label} must be a non-negative integer`);
  return BigInt(raw);
}

type Accepted = { chainId: bigint; token: Address; decimals: number };

export function parseAccepted(raw: string): Accepted[] {
  const items = raw.split(",").map((part) => {
    const [chain, token, decimals] = part.split(":");
    if (chain === undefined || token === undefined || decimals === undefined) {
      throw new UsageError(`--accept entry must be chainId:token:decimals, got ${part}`);
    }
    const d = Number(decimals);
    if (!Number.isInteger(d) || d < 0 || d > 30) throw new UsageError(`bad decimals in ${part}`);
    return { chainId: positiveInt(chain, "chainId"), token: getAddress(token), decimals: d };
  });
  if (items.length === 0 || items.length > 8) throw new UsageError("--accept takes 1 to 8 entries");
  return items;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      factory: { type: "string" },
      reactive: { type: "string" },
      id: { type: "string" },
      rpc: { type: "string" },
      policy: { type: "string" },
      amount: { type: "string" },
      accept: { type: "string" },
      due: { type: "string" },
      expires: { type: "string" },
      strict: { type: "boolean", default: false },
      "details-hash": { type: "string" },
      send: { type: "boolean", default: false },
      account: { type: "string", default: "omni-deployer" },
    },
    strict: true,
  });

  switch (command) {
    case "pay-address": {
      const id = positiveInt(required(values, "id"), "--id");
      console.log(payAddress(address(values, "factory"), address(values, "reactive"), id));
      return;
    }
    case "invoice": {
      const reactive = address(values, "reactive");
      const id = positiveInt(required(values, "id"), "--id");
      const client = createPublicClient({ transport: http(required(values, "rpc")) });
      const [inv, accepted] = await Promise.all([
        client.readContract({ address: reactive, abi: daybookReactiveAbi, functionName: "getInvoice", args: [id] }),
        client.readContract({ address: reactive, abi: daybookReactiveAbi, functionName: "acceptedOf", args: [id] }),
      ]);
      if (inv.status === 0) throw new UsageError(`invoice ${id} does not exist`);
      console.log(
        JSON.stringify(
          {
            id: id.toString(),
            status: invoiceStatus[inv.status] ?? `unknown(${inv.status})`,
            payAddress: inv.payAddress,
            amount: formatUnits(inv.amount, 6),
            paid: formatUnits(inv.paid, 6),
            overdue: inv.overdue,
            dueAt: Number(inv.dueAt),
            expiresAt: Number(inv.expiresAt),
            openSettlements: inv.openSettlements,
            accepted: accepted.map((a) => ({ chainId: Number(a.chainId), token: a.token, decimals: a.decimals })),
          },
          null,
          2,
        ),
      );
      return;
    }
    case "create-invoice": {
      const reactive = address(values, "reactive");
      const detailsRaw = values["details-hash"];
      let detailsHash: Hex = `0x${"0".repeat(64)}`;
      if (detailsRaw !== undefined) {
        if (!isHex(detailsRaw) || detailsRaw.length !== 66) throw new UsageError("--details-hash must be bytes32");
        detailsHash = detailsRaw;
      }
      const amountRaw = required(values, "amount");
      if (!/^\d+(\.\d{1,6})?$/.test(amountRaw)) throw new UsageError("--amount must be a decimal with up to 6 places");
      const amount = parseUnits(amountRaw, 6);
      if (amount === 0n) throw new UsageError("--amount must be above zero");
      const data = encodeFunctionData({
        abi: daybookReactiveAbi,
        functionName: "createInvoice",
        args: [
          {
            amount,
            dueAt: values.due === undefined ? 0n : positiveInt(values.due, "--due"),
            expiresAt: values.expires === undefined ? 0n : positiveInt(values.expires, "--expires"),
            policyId: Number(positiveInt(required(values, "policy"), "--policy")),
            strictTokens: values.strict === true,
            detailsHash,
            accepted: parseAccepted(required(values, "accept")),
          },
        ],
      });
      const rpc = required(values, "rpc");
      const castArgs = ["send", reactive, data, "--rpc-url", rpc, "--account", values.account ?? "omni-deployer"];
      if (values.send !== true) {
        console.log(`calldata: ${data}`);
        console.log(`to submit: cast ${castArgs.join(" ")}`);
        return;
      }
      // execFile, not a shell: no argument is ever interpreted by /bin/sh. cast prompts for the keystore password.
      execFileSync("cast", castArgs, { stdio: "inherit" });
      return;
    }
    default:
      throw new UsageError(command === undefined ? "no command" : `unknown command ${command}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
