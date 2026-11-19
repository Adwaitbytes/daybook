import { keccak256, toBytes } from "viem";

export type InvoiceDetails = { clientName: string; notes: string | null; pdfSha256: string | null };

/** The hash stored on chain as `detailsHash`: keccak256 of this exact JSON (fixed key order, nulls kept). */
export function detailsHashOf(d: InvoiceDetails): `0x${string}` {
  return keccak256(toBytes(JSON.stringify({ clientName: d.clientName, notes: d.notes, pdfSha256: d.pdfSha256 })));
}
