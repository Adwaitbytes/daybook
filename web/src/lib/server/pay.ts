import "server-only";
import QRCode from "qrcode";
import { paymentChain } from "@/lib/chains";
import { toTokenUnits } from "@/lib/format";
import { erc20TransferUri } from "@/lib/qr-payload";
import type { InvoiceSnapshot } from "@/lib/types";
import { deployment } from "./config";
import { readInvoice } from "./indexer";
import { RpcError } from "./rpc";
import { type DetailsRead, loadDetails } from "./store";

export type PayQr = { chainId: number; uri: string; svg: string; amountRaw: string };

export type PayPayload =
  | { kind: "ok"; snapshot: InvoiceSnapshot; qrs: PayQr[]; details: DetailsRead }
  | { kind: "not-deployed" }
  | { kind: "not-found" }
  | { kind: "rpc-error"; network: string };

/** Dark modules on the sheet colour; scanners need dark on light, so the QR stays light in dark mode. */
async function qrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, {
    type: "svg",
    margin: 4,
    errorCorrectionLevel: "M",
    color: { dark: "#18221bff", light: "#fbfaf5ff" },
  });
}

/** One EIP-681 QR per accepted chain, for the balance still due, sent to the verified pay address only. */
async function buildQrs(s: InvoiceSnapshot): Promise<PayQr[]> {
  if (!s.payAddressVerified) return [];
  const due = BigInt(s.amount) - BigInt(s.paid);
  if (due <= 0n || s.status !== "Open") return [];
  return Promise.all(
    s.accepted
      .filter((a) => paymentChain(a.chainId) !== undefined)
      .map(async (a) => {
        const amountRaw = toTokenUnits(due, a.decimals);
        const uri = erc20TransferUri({ chainId: a.chainId, token: a.token, to: s.payAddress, amountRaw });
        return { chainId: a.chainId, uri, svg: await qrSvg(uri), amountRaw: amountRaw.toString() };
      }),
  );
}

export function parseInvoiceId(raw: string): bigint | null {
  if (!/^[1-9]\d{0,15}$/.test(raw)) return null;
  return BigInt(raw);
}

// Settled, cancelled and expired are final, so their pages can be served from memory for a while.
const finalCache = new Map<string, { at: number; payload: PayPayload }>();
const FINAL = new Set(["Settled", "Cancelled", "Expired"]);

export async function payPayload(id: bigint): Promise<PayPayload> {
  const d = deployment();
  if (d.kind === "not-deployed") return { kind: "not-deployed" };
  const key = `${d.reactive}:${id}`;
  const hit = finalCache.get(key);
  if (hit !== undefined) {
    // Final states do not change (a late transfer only adds a ledger line), so serve the copy and refresh it
    // in the background once it is a minute old.
    if (Date.now() - hit.at > 60_000) {
      hit.at = Date.now();
      void readFresh(id).catch(() => undefined);
    }
    return hit.payload;
  }
  return readFresh(id);
}

async function readFresh(id: bigint): Promise<PayPayload> {
  const d = deployment();
  if (d.kind === "not-deployed") return { kind: "not-deployed" };
  const key = `${d.reactive}:${id}`;
  try {
    const r = await readInvoice(d.reactive, d.deployBlock, id);
    if (r.kind === "not-found") return { kind: "not-found" };
    const [qrs, details] = await Promise.all([
      buildQrs(r.snapshot),
      loadDetails(d.reactive, r.snapshot.id, r.snapshot.detailsHash),
    ]);
    const payload: PayPayload = { kind: "ok", snapshot: r.snapshot, qrs, details };
    const settledHopsKnown = r.snapshot.settlements.every((x) => x.callback !== null);
    if (FINAL.has(r.snapshot.status) && settledHopsKnown) finalCache.set(key, { at: Date.now(), payload });
    return payload;
  } catch (err) {
    if (err instanceof RpcError) return { kind: "rpc-error", network: err.network };
    throw err;
  }
}
