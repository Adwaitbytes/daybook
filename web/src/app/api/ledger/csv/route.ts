import { ledgerToCsv } from "@/lib/csv";
import { ledgerView } from "@/lib/server/views";

export const dynamic = "force-dynamic";

export async function GET() {
  const v = await ledgerView();
  if (v.kind === "not-deployed") {
    return new Response("Daybook is not deployed on this site yet, so there is no ledger to export.\n", {
      status: 409,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (v.kind === "rpc-error") {
    return new Response(`${v.network} did not answer. Try the export again in a moment.\n`, {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "10" },
    });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  // Oldest first, the order an accountant reads a day book in.
  return new Response(ledgerToCsv([...v.value.lines].reverse()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="daybook-ledger-${v.value.reactive.slice(0, 8)}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
