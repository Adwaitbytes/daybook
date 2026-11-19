import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHead } from "@/components/page-head";
import { ChainError, EmptyRecord, NotDeployed, RuledSkeleton } from "@/components/states";
import { TxLink } from "@/components/tx-link";
import { chainName } from "@/lib/chains";
import { ledgerStatus } from "@/lib/csv";
import { formatDate, formatTime, formatUnitsFixed, shortHex } from "@/lib/format";
import { ledgerView } from "@/lib/server/views";
import type { LedgerLine } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Ledger",
  description: "Every transfer into a Daybook pay address, across chains, matched to its invoice or flagged.",
};

export default function LedgerPage() {
  return (
    <>
      <PageHead
        title="Ledger"
        aside={
          <a className="btn btn-ghost" href="/api/ledger/csv" download>
            Export CSV
          </a>
        }
      >
        <p className="m-0">
          Every transfer into a pay address, on every chain, as the contract wrote it down. Matched lines count toward
          their invoice; flagged ones arrived in a token the invoice does not take and wait at the pay address for the
          owner.
        </p>
      </PageHead>
      <div className="wrap">
        <Suspense fallback={<RuledSkeleton lines={10} label="Reading the ledger from Lasna" />}>
          <LedgerBody />
        </Suspense>
      </div>
    </>
  );
}

function particulars(l: LedgerLine): string {
  switch (l.kind) {
    case "Payment":
      return BigInt(l.excess) > 0n ? "Received, part over the amount forwarded" : "Received";
    case "Late":
      return "Arrived after the invoice was covered, forwarded";
    case "Orphaned":
      return "Arrived after the invoice closed, forwarded";
    default:
      return "Wrong token, flagged and left at the pay address";
  }
}

function amount(l: LedgerLine): string {
  const raw = BigInt(l.amount) + BigInt(l.excess);
  return l.decimals === null ? `${formatUnitsFixed(raw, 0, 0)} raw units` : formatUnitsFixed(raw, l.decimals);
}

async function LedgerBody() {
  const v = await ledgerView();
  if (v.kind === "not-deployed") return <NotDeployed what="The ledger" />;
  if (v.kind === "rpc-error") return <ChainError network={v.network} retryHref="/ledger" />;
  const { lines, invoices } = v.value;
  if (lines.length === 0) {
    return (
      <EmptyRecord
        title="Nothing written in the ledger yet"
        action={
          <Link className="btn" href="/#demo">
            Pay a demo invoice
          </Link>
        }
      >
        <p className="m-0">
          {invoices === 0
            ? "No invoices have been issued yet."
            : `${invoices} invoices are open and none has been paid.`}{" "}
          The first transfer into a pay address appears here within seconds.
        </p>
      </EmptyRecord>
    );
  }
  const matched = lines.filter((l) => l.kind === "Payment").length;
  const flagged = lines.filter((l) => l.kind === "WrongToken").length;
  return (
    <div className="sheet sheet-ruled">
      <div className="flex h-[var(--line)] items-baseline justify-between gap-3">
        <h2 className="m-0 text-[17px] font-bold leading-[var(--line)]">Day book</h2>
        <span className="t-meta">
          {lines.length} lines, {matched} matched, {flagged} flagged, {invoices} invoices
        </span>
      </div>
      <div className="-mx-1 overflow-x-auto">
        <table className="ledger">
          <caption className="sr-only">Ledger lines, newest first</caption>
          <thead>
            <tr>
              <th scope="col" className="hidden md:table-cell">
                Date
              </th>
              <th scope="col">Particulars</th>
              <th scope="col" className="hidden md:table-cell">
                Chain
              </th>
              <th scope="col" className="hidden lg:table-cell">
                Transfer
              </th>
              <th scope="col" className="col-amt">
                USDC
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const status = ledgerStatus(l.kind);
              return (
                <tr key={l.index} className={status === "flagged" ? "text-red" : undefined}>
                  <td className="col-dim num hidden md:table-cell">
                    {l.originAt === null ? "" : `${formatDate(l.originAt)} ${formatTime(l.originAt)}`}
                  </td>
                  <td className="wrap-cell">
                    <Link href={`/pay/${l.invoiceId}`} className="num mr-2 text-[14px]">
                      No. {l.invoiceId}
                    </Link>
                    {particulars(l)}
                    <span className="t-meta block md:hidden">
                      {chainName(l.chainId)}
                      {l.originAt === null ? "" : `, ${formatDate(l.originAt)} ${formatTime(l.originAt)}`}
                    </span>
                    <span className="t-meta block">from {shortHex(l.payer)}</span>
                  </td>
                  <td className="col-dim hidden md:table-cell">{chainName(l.chainId)}</td>
                  <td className="hidden lg:table-cell">
                    <TxLink chainId={l.chainId} hash={l.originTx} showChain={false} />
                  </td>
                  <td className="col-amt num">
                    {status === "flagged" ? `[${amount(l)}]` : status === "forwarded" ? `(${amount(l)})` : amount(l)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="t-meta m-0 mt-[var(--line)]">
        Square brackets: flagged, not counted. Round brackets: forwarded to the treasury unsplit. Times are the
        transfer&rsquo;s block time in UTC.
      </p>
    </div>
  );
}
