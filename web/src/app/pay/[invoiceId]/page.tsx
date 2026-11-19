import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PayView } from "@/components/pay-view";
import { ChainError, EmptyRecord, NotDeployed, RuledSkeleton } from "@/components/states";
import { parseInvoiceId, payPayload } from "@/lib/server/pay";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/pay/[invoiceId]">): Promise<Metadata> {
  const { invoiceId } = await params;
  return {
    title: `Invoice ${invoiceId}`,
    description: "Pay this invoice in USDC from any wallet. The page marks it paid when the loop closes on chain.",
    robots: { index: false },
  };
}

export default async function PayPage({ params }: PageProps<"/pay/[invoiceId]">) {
  const { invoiceId } = await params;
  const id = parseInvoiceId(invoiceId);
  if (id === null) notFound();
  return (
    <Suspense fallback={<PaySkeleton />}>
      <PayLoader id={id} />
    </Suspense>
  );
}

function PaySkeleton() {
  return (
    <div className="wrap grid items-start gap-8 pt-8 md:pt-12 lg:grid-cols-[7fr_5fr] lg:gap-12">
      <div className="order-2 lg:order-1">
        <RuledSkeleton lines={9} label="Reading the invoice from chain" />
      </div>
      <div className="order-1 lg:order-2">
        <RuledSkeleton lines={6} label="Reading the pay address" />
      </div>
    </div>
  );
}

async function PayLoader({ id }: { id: bigint }) {
  const p = await payPayload(id);
  if (p.kind === "ok") return <PayView initial={p} />;
  return (
    <div className="wrap max-w-[760px] pt-12">
      {p.kind === "not-deployed" ? (
        <NotDeployed what="This pay page" />
      ) : p.kind === "rpc-error" ? (
        <ChainError network={p.network} retryHref={`/pay/${id}`} />
      ) : (
        <EmptyRecord
          title={`There is no invoice ${id}`}
          action={
            <Link className="btn btn-ghost" href="/ledger">
              Open the ledger
            </Link>
          }
        >
          <p className="m-0">
            The Daybook contract has no invoice with that number. Check the link you were sent. Do not send money to an
            address from a page that does not show the invoice.
          </p>
        </EmptyRecord>
      )}
    </div>
  );
}
