import { NextResponse } from "next/server";
import { parseInvoiceId, payPayload } from "@/lib/server/pay";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/invoice/[id]">) {
  const { id } = await ctx.params;
  const n = parseInvoiceId(id);
  if (n === null) return NextResponse.json({ kind: "not-found" }, { status: 404 });
  const p = await payPayload(n);
  const status = p.kind === "ok" ? 200 : p.kind === "not-found" ? 404 : p.kind === "rpc-error" ? 503 : 409;
  return NextResponse.json(p, { status, headers: { "Cache-Control": "no-store" } });
}
