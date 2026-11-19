"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo } from "react";
import type { DemoPayResult } from "@/lib/demo-types";
import { formatAmount } from "@/lib/format";
import type { PayPayload } from "@/lib/server/pay";
import { deriveStatus } from "@/lib/status";
import { StatusSlip } from "./status-slip";
import { TxLink } from "./tx-link";

type Failure = Extract<DemoPayResult, { ok: false }>;

const FAILURE_TITLE: Record<Failure["code"], string> = {
  "not-configured": "The demo relayer is not set up here",
  "not-deployed": "Daybook is not deployed on this site yet",
  "rate-limited": "The demo needs a pause",
  "no-demo-invoice": "No demo invoice is open",
  "relayer-empty": "The demo relayer is out of test funds",
  "rpc-error": "A network did not answer",
  failed: "The demo payment did not go through",
};

function wait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * "Pay a demo invoice": a server route pays a real demo invoice in test USDC on Base Sepolia from a relayer
 * wallet, then this strip follows the loop hop by hop from chain data, with a link for each transaction.
 */
export function DemoStrip() {
  const pay = useMutation({
    mutationFn: async (): Promise<DemoPayResult> => {
      const r = await fetch("/api/demo-pay", { method: "POST" });
      try {
        return (await r.json()) as DemoPayResult;
      } catch {
        return { ok: false, code: "failed", message: `The demo route answered ${r.status} without a body.` };
      }
    },
  });
  const result = pay.data;
  const invoiceId = result?.ok === true ? result.invoiceId : null;

  const trace = useQuery({
    queryKey: ["invoice", invoiceId],
    enabled: invoiceId !== null,
    queryFn: async (): Promise<PayPayload> =>
      (await (await fetch(`/api/invoice/${invoiceId}`, { cache: "no-store" })).json()) as PayPayload,
    refetchInterval: (q) => (q.state.data?.kind === "ok" && q.state.data.snapshot.status === "Settled" ? false : 2_500),
  });
  const status = useMemo(() => (trace.data?.kind === "ok" ? deriveStatus(trace.data.snapshot) : null), [trace.data]);

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[5fr_7fr] lg:gap-12">
      <div>
        <h2 className="t-section m-0">Watch a loop close</h2>
        <p className="mt-3 max-w-[32em] text-[17px] leading-7 text-ink-2">
          This sends 0.10 test USDC on Base Sepolia from a demo wallet to a real demo invoice. You do not need a wallet.
          The contract on Lasna sees the transfer, matches it and asks the till on Base Sepolia to settle. Every hop
          below is read from chain as it happens.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn"
            onClick={() => pay.mutate()}
            disabled={pay.isPending}
            aria-describedby="demo-note"
          >
            {pay.isPending ? "Sending the transfer" : "Pay a demo invoice"}
            {pay.isPending ? <span className="caret bg-paper!" aria-hidden="true" /> : null}
          </button>
          {invoiceId === null ? null : (
            <Link className="btn btn-ghost" href={`/pay/${invoiceId}`}>
              Open its pay page
            </Link>
          )}
        </div>
        <p id="demo-note" className="t-meta mt-3">
          Two demo payments per visitor every ten minutes, and a site-wide cap, because each one spends real test funds.
        </p>
      </div>

      <div aria-live="polite">
        {pay.isPending ? (
          <div className="slip" role="status">
            <p className="m-0 text-[16px] leading-7">
              Sending 0.10 USDC on Base Sepolia from the demo wallet
              <span className="caret" aria-hidden="true" />
            </p>
            <p className="t-meta m-0 mt-1">
              Waiting for the transfer to be mined. Base Sepolia makes a block every 200 ms.
            </p>
          </div>
        ) : result === undefined ? (
          <div className="slip">
            <p className="m-0 text-[15px] italic leading-6 text-ink-2">Carbon copy, written as the loop moves</p>
            <ol className="m-0 mt-2 list-none p-0 text-ink-2">
              {["Payment on Base Sepolia", "Match on Reactive Network", "Settlement on Base Sepolia"].map((t, i) => (
                <li key={t} className="grid grid-cols-[18px_1fr] gap-x-2.5 border-b border-rule py-2.5 last:border-b-0">
                  <span aria-hidden="true" className="font-mono text-[15px] text-ink-3">
                    ○
                  </span>
                  <span className="text-[16px] leading-6">
                    {t}
                    <span className="t-meta block">{i + 1} of 3, waiting for you to press the button</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : result.ok ? (
          <div className="flex flex-col gap-3">
            <p className="t-small m-0">
              Paid {formatAmount(BigInt(result.amount))} USDC to invoice {result.invoiceId}
              {result.created ? ", created for you just now" : ""}.{" "}
              <TxLink chainId={result.chainId} hash={result.payTx} />
            </p>
            {status === null ? (
              <div className="slip" role="status">
                <p className="m-0 text-[16px] leading-7">
                  Reading the loop from chain
                  <span className="caret" aria-hidden="true" />
                </p>
              </div>
            ) : (
              <StatusSlip status={status} invoiceId={result.invoiceId} />
            )}
          </div>
        ) : (
          <DemoFailure f={result} onRetry={() => pay.reset()} />
        )}
      </div>
    </div>
  );
}

export function DemoFailure({ f, onRetry }: { f: Failure; onRetry?: () => void }) {
  return (
    <div className="sheet sheet-pad" role="alert">
      <div className={`callout ${f.code === "rate-limited" ? "callout-amber" : ""}`}>
        <h3 className="t-title m-0">{FAILURE_TITLE[f.code]}</h3>
        <p className="t-small m-0 mt-2 text-ink-2">{f.message}</p>
        {f.retryAfterSeconds === undefined ? null : (
          <p className="t-small m-0 mt-2">Try again in about {wait(f.retryAfterSeconds)}.</p>
        )}
        {f.code === "not-configured" || f.code === "not-deployed" ? (
          <p className="t-small m-0 mt-2">
            You can still see a settled loop on the <Link href="/ledger">ledger</Link>, or deploy your own on the{" "}
            <Link href="/make">Make your own</Link> page.
          </p>
        ) : null}
      </div>
      {onRetry === undefined || f.code === "not-configured" ? null : (
        <button type="button" className="btn btn-ghost btn-small mt-5" onClick={onRetry}>
          Start over
        </button>
      )}
    </div>
  );
}
