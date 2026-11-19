import { type NextRequest, NextResponse } from "next/server";
import type { DemoPayResult } from "@/lib/demo-types";
import { demoPay, relayerConfigured } from "@/lib/server/demo";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const STATUS: Record<Exclude<DemoPayResult, { ok: true }>["code"], number> = {
  "not-configured": 503,
  "not-deployed": 409,
  "rate-limited": 429,
  "no-demo-invoice": 409,
  "relayer-empty": 503,
  "rpc-error": 502,
  failed: 502,
};

/** The visitor's address as the platform reports it; the first hop of X-Forwarded-For is the client. */
function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "unknown";
}

export async function GET() {
  return NextResponse.json({ configured: relayerConfigured() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  // Same-origin only: a cross-site form cannot spend the relayer's funds.
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== req.nextUrl.origin) {
    return NextResponse.json(
      { ok: false, code: "failed", message: "Cross-site requests are refused." },
      { status: 403 },
    );
  }
  const r = await demoPay(clientIp(req));
  if (r.ok) return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (r.retryAfterSeconds !== undefined) headers["Retry-After"] = String(r.retryAfterSeconds);
  return NextResponse.json(r, { status: STATUS[r.code], headers });
}
