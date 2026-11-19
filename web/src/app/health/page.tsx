import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHead } from "@/components/page-head";
import { ChainError, NotDeployed, RuledSkeleton } from "@/components/states";
import { LASNA } from "@/lib/chains";
import { formatDate, formatDuration, formatElapsed, formatTime, formatUnitsFixed } from "@/lib/format";
import { healthView } from "@/lib/server/views";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Health",
  description: "How long Daybook has been running, how many invoices it settled and what it costs, read from chain.",
};

export default function HealthPage() {
  return (
    <>
      <PageHead title="Is it still running">
        <p className="m-0">
          Read from chain when you open this page: how long the contract has been live, how many invoices it settled,
          what its reactions cost and how many more its balance pays for.
        </p>
      </PageHead>
      <div className="wrap">
        <div className="max-w-[880px]">
          <Suspense fallback={<RuledSkeleton lines={7} label="Reading the contract&rsquo;s balance and history" />}>
            <HealthBody />
          </Suspense>
        </div>
      </div>
    </>
  );
}

const react = (wei: bigint) => `${formatUnitsFixed(wei, 18, 4)} ${LASNA.nativeSymbol}`;

async function HealthBody() {
  const v = await healthView();
  if (v.kind === "not-deployed") return <NotDeployed what="The health page" />;
  if (v.kind === "rpc-error") return <ChainError network={v.network} retryHref="/health" />;
  const h = v.value;
  const rows: { label: string; value: string; note: string; tone?: "red" | "amber" }[] = [
    {
      label: "Running since",
      value: h.since === null ? "No invoices yet" : formatDate(h.since.at),
      note:
        h.since === null
          ? "Fills in when the first invoice is issued"
          : `${formatDuration(h.readAt - h.since.at)}, counted from the ${h.since.basis}`,
    },
    {
      label: "Invoices settled",
      value: `${h.settled}`,
      note: `of ${h.invoices} issued, ${h.open} still open`,
    },
    {
      label: "REACT spent",
      value: react(h.spent.total),
      note:
        h.spent.samples === 0
          ? "No reaction measured yet"
          : `measured on ${h.spent.samples} of ${h.spent.reactions} reactions that wrote an event; cron ticks are not counted`,
    },
    {
      label: "Balance for reactions",
      value: react(h.spendable),
      note:
        h.debt > 0n
          ? `in debt by ${react(h.debt)}: the network stops calling the contract until it is paid`
          : "balance plus reserves at the system contract, less debt",
      tone: h.debt > 0n ? "red" : undefined,
    },
    {
      label: "Reactions left",
      value: h.reactionsLeft === null ? "Not measured yet" : h.reactionsLeft.toLocaleString("en-GB"),
      note:
        h.reactionsLeft === null
          ? "Needs at least one measured reaction"
          : `at the mean measured cost, ${react(h.spent.samples === 0 ? 0n : h.spent.total / BigInt(h.spent.samples))} each`,
      tone: h.reactionsLeft !== null && h.reactionsLeft < 50n ? "amber" : undefined,
    },
    {
      label: "Last loop",
      value: h.lastLoop === null ? "No settled loop yet" : formatElapsed(h.lastLoop.ms).slice(1),
      note:
        h.lastLoop === null
          ? "Transfer to settlement, from block times"
          : `invoice ${h.lastLoop.invoiceId}, transfer to settlement callback on Base Sepolia, millisecond block times${h.lastLoop.settledAt === null ? "" : `, ${formatDate(h.lastLoop.settledAt)}`}`,
    },
  ];
  return (
    <div className="sheet sheet-ruled">
      <div className="flex h-[var(--line)] items-baseline justify-between gap-3">
        <h2 className="m-0 text-[17px] font-bold leading-[var(--line)]">Health</h2>
        <span className="t-meta">read {formatTime(h.readAt)} UTC</span>
      </div>
      <dl className="m-0">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 leading-[var(--line)]"
          >
            <dt className="text-[16px]">{r.label}</dt>
            <dd
              className={`num m-0 text-right text-[15px] md:text-[17px] ${r.tone === "red" ? "text-red" : r.tone === "amber" ? "text-amber" : ""}`}
            >
              {r.value}
            </dd>
            <dd className="t-meta col-span-2 m-0 leading-[var(--line)]!">{r.note}</dd>
          </div>
        ))}
      </dl>
      <p className="t-meta m-0 mt-[var(--line)]">
        Cron is{" "}
        {h.cronActive
          ? "subscribed: open invoices have due or expiry times"
          : "off: nothing timed is open, so no ticks are billed"}
        .{" "}
        {h.pendingSettlements > 0n
          ? `${h.pendingSettlements} settlements are waiting for their acknowledgement.`
          : "No settlement is waiting."}
      </p>
    </div>
  );
}
