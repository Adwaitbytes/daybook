import "server-only";
import { type Address, createWalletClient, erc20Abi, type Hex, http, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { daybookReactiveAbi } from "@/generated/abis";
import { BASE_SEPOLIA, LASNA } from "@/lib/chains";
import type { DemoPayResult } from "@/lib/demo-types";
import { deployment } from "./config";
import { readCore } from "./indexer";
import { chainClient, lasna } from "./rpc";
import { rateLimit } from "./store";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Per visitor and site-wide caps. Each demo payment spends real test USDC and gas from the relayer. */
export function demoWindows(ip: string) {
  return [
    { key: `demo:ip:${ip}`, limit: 2, windowMs: 10 * MIN },
    { key: `demo:ip-day:${ip}`, limit: 6, windowMs: 24 * HOUR },
    { key: "demo:global", limit: 30, windowMs: HOUR },
    { key: "demo:global-day", limit: 200, windowMs: 24 * HOUR },
  ];
}

export function relayerConfigured(): boolean {
  const pk = process.env.DEMO_RELAYER_PK;
  return pk !== undefined && pk !== "";
}

function relayerKey(): Hex | null {
  const pk = process.env.DEMO_RELAYER_PK;
  if (pk === undefined || pk === "") return null;
  const k = pk.startsWith("0x") ? pk : `0x${pk}`;
  if (!isHex(k) || k.length !== 66) throw new Error("DEMO_RELAYER_PK is set but is not a 32-byte hex key");
  return k;
}

function demoAmount(): bigint {
  const raw = process.env.DEMO_AMOUNT_UNITS ?? "100000"; // 0.10 USDC
  if (!/^\d{1,12}$/.test(raw) || BigInt(raw) === 0n) throw new Error("DEMO_AMOUNT_UNITS must be a positive integer");
  return BigInt(raw);
}

function demoInvoicePool(): bigint[] {
  return (process.env.DEMO_INVOICE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[1-9]\d{0,15}$/.test(s))
    .map(BigInt);
}

// One relayer, one nonce sequence: payments from this instance go out one at a time.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Creates (when the relayer owns the demo contract) or picks an open demo invoice, then pays it in test USDC on
 * Base Sepolia from the relayer. Returns as soon as the transfer is mined; the page traces the rest live.
 */
export async function demoPay(ip: string): Promise<DemoPayResult> {
  let key: Hex | null;
  try {
    key = relayerKey();
  } catch (err) {
    return {
      ok: false,
      code: "not-configured",
      message: err instanceof Error ? err.message : "Relayer key is invalid",
    };
  }
  if (key === null) {
    return {
      ok: false,
      code: "not-configured",
      message:
        "The demo relayer is not set up on this deployment (DEMO_RELAYER_PK is missing), so no demo payment can be sent.",
    };
  }
  const d = deployment();
  if (d.kind === "not-deployed") {
    return { ok: false, code: "not-deployed", message: "Daybook is not deployed on this site yet." };
  }

  const verdict = await rateLimit(demoWindows(ip));
  if (!verdict.ok) {
    const s = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
    return {
      ok: false,
      code: "rate-limited",
      message: verdict.key.includes("global")
        ? "The demo has paid as many invoices as it can for now. Each one spends real test funds."
        : "You have paid the demo invoices this visitor allowance covers for now.",
      retryAfterSeconds: s,
    };
  }

  const account = privateKeyToAccount(key);
  return serial(async () => {
    try {
      const core = await readCore(d.reactive);
      const lc = lasna();
      const r = { address: d.reactive, abi: daybookReactiveAbi } as const;
      const amount = demoAmount();

      let invoiceId: bigint | null = null;
      let due = 0n;
      let created = false;
      for (const id of demoInvoicePool()) {
        const inv = await lc.readContract({ ...r, functionName: "getInvoice", args: [id] });
        if (inv.status === 1 && inv.paid < inv.amount) {
          invoiceId = id;
          due = inv.amount - inv.paid;
          break;
        }
      }
      if (invoiceId === null && core.owner.toLowerCase() === account.address.toLowerCase()) {
        const wallet = createWalletClient({ account, transport: http(process.env[LASNA.rpcEnv] || LASNA.rpcDefault) });
        const hash = await wallet.writeContract({
          ...r,
          chain: {
            id: LASNA.id,
            name: LASNA.name,
            nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 },
            rpcUrls: { default: { http: [LASNA.rpcDefault] } },
          },
          functionName: "createInvoice",
          args: [
            {
              amount,
              dueAt: 0n,
              expiresAt: 0n,
              policyId: Number(process.env.DEMO_POLICY_ID ?? "1"),
              watchAllTokens: false,
              detailsHash: `0x${"0".repeat(64)}`,
              accepted: [{ chainId: BigInt(BASE_SEPOLIA.id), token: BASE_SEPOLIA.usdc, decimals: 6 }],
            },
          ],
        });
        const receipt = await lc.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt.status !== "success")
          return { ok: false, code: "failed", message: "Creating the demo invoice reverted on Lasna." };
        invoiceId = await lc.readContract({ ...r, functionName: "nextInvoiceId" });
        due = amount;
        created = true;
      }
      if (invoiceId === null) {
        return {
          ok: false,
          code: "no-demo-invoice",
          message:
            "Every demo invoice set aside for this site is already paid. The owner tops the pool up from the CLI.",
        };
      }

      const payAddress = (await lc.readContract({ ...r, functionName: "payAddressOf", args: [invoiceId] })) as Address;
      const bc = chainClient(BASE_SEPOLIA);
      const [usdc, eth] = await Promise.all([
        bc.readContract({
          address: BASE_SEPOLIA.usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        }),
        bc.getBalance({ address: account.address }),
      ]);
      if (usdc < due || eth < 20_000_000_000_000n) {
        return {
          ok: false,
          code: "relayer-empty",
          message: "The demo relayer is out of test USDC or gas on Base Sepolia. It is topped up from faucets by hand.",
        };
      }
      const wallet = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(process.env[BASE_SEPOLIA.rpcEnv] || BASE_SEPOLIA.rpcDefault),
      });
      const payTx = await wallet.writeContract({
        address: BASE_SEPOLIA.usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [payAddress, due],
      });
      const receipt = await bc.waitForTransactionReceipt({ hash: payTx, timeout: 30_000 });
      if (receipt.status !== "success") {
        return { ok: false, code: "failed", message: "The demo USDC transfer reverted on Base Sepolia." };
      }
      return {
        ok: true,
        invoiceId: invoiceId.toString(),
        created,
        payTx,
        chainId: BASE_SEPOLIA.id,
        amount: due.toString(),
      };
    } catch (err) {
      return {
        ok: false,
        code: "rpc-error",
        message: `A network call failed while sending the demo payment: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}`,
      };
    }
  });
}
