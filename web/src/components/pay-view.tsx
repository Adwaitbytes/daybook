"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { chainName, paymentChain } from "@/lib/chains";
import { formatAmount, formatDate, formatDateTime, formatElapsed, formatTime, shortHex } from "@/lib/format";
import type { PayPayload } from "@/lib/server/pay";
import { type DerivedStatus, deriveStatus } from "@/lib/status";
import type { InvoiceSnapshot } from "@/lib/types";
import { AddressBlock } from "./address-block";
import { ChainPicker } from "./chain-picker";
import { Stamp } from "./stamp";
import { StatusSlip } from "./status-slip";
import { TxLink } from "./tx-link";

type Ok = Extract<PayPayload, { kind: "ok" }>;

const TERMINAL = new Set(["Settled", "Cancelled", "Expired"]);

/** Live pay page. The server renders the first snapshot; the browser polls until the invoice is settled or closed. */
export function PayView({ initial, live = true }: { initial: Ok; live?: boolean }) {
  const id = initial.snapshot.id;
  const q = useQuery({
    queryKey: ["invoice", id],
    queryFn: async (): Promise<PayPayload> => {
      const r = await fetch(`/api/invoice/${id}`, { cache: "no-store" });
      return (await r.json()) as PayPayload;
    },
    initialData: initial,
    enabled: live,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (d?.kind === "ok" && TERMINAL.has(d.snapshot.status)) return false;
      return d?.kind === "ok" && d.snapshot.status === "Paid" ? 2_000 : 4_000;
    },
    refetchIntervalInBackground: false,
  });

  // Keep the last good snapshot on screen if one poll fails; say so instead of blanking the page.
  const lastGood = useRef<Ok>(initial);
  if (q.data?.kind === "ok") lastGood.current = q.data;
  const data = lastGood.current;
  const pollTrouble = q.data?.kind === "rpc-error" || q.isError;

  const s = data.snapshot;
  const status = useMemo(() => deriveStatus(s), [s]);

  // Announce state changes once, politely.
  const [announce, setAnnounce] = useState("");
  const prevPhase = useRef(status.phase);
  useEffect(() => {
    if (prevPhase.current === status.phase) return;
    prevPhase.current = status.phase;
    setAnnounce(
      status.phase === "settled"
        ? "Paid. The invoice is settled and your receipt is below."
        : status.phase === "payment-seen"
          ? "Payment seen. Settling now."
          : status.phase === "part-paid"
            ? `Part payment received. ${formatAmount(status.remaining)} still due.`
            : "",
    );
  }, [status.phase, status.remaining]);

  const headed = s.payAddressVerified && ["settled", "payment-seen", "expired", "cancelled"].includes(status.phase);

  return (
    <div className="wrap pb-8 pt-8 md:pt-12" data-phase={status.phase}>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {pollTrouble ? (
        <p className="no-print t-small mb-6 text-amber" role="status">
          Live updates paused: the RPC did not answer the last check. Showing chain state as of {formatTime(s.readAt)}{" "}
          UTC; it retries on its own.
        </p>
      ) : null}
      {/* DOM order is the phone order: the payment first while money is due; once the invoice is paid or
          closed, the one-line verdict first, then the stamped invoice, the carbon copy and the receipt. */}
      {headed ? (
        <div className="grid items-start gap-8 lg:grid-cols-[7fr_5fr] lg:gap-x-12 lg:gap-y-8">
          <div className="lg:col-start-2 lg:row-start-1">
            <Verdict s={s} status={status} />
          </div>
          <div className="lg:col-start-1 lg:row-span-2 lg:row-start-1">
            <InvoiceSheet s={s} status={status} details={data.details} />
          </div>
          <div className="lg:col-start-2 lg:row-span-2 lg:row-start-2">
            <StatusSlip status={status} invoiceId={s.id} links={status.phase !== "settled"} />
          </div>
          {status.phase === "settled" ? (
            <div className="lg:col-start-1 lg:row-start-3">
              <Receipt s={s} status={status} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid items-start gap-8 lg:grid-cols-[7fr_5fr] lg:gap-x-12">
          <div className="lg:col-start-2 lg:row-start-1">
            <Panel data={data} status={status} />
          </div>
          <div className="lg:sticky lg:top-8 lg:col-start-1 lg:row-start-1">
            <InvoiceSheet s={s} status={status} details={data.details} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the invoice document

function InvoiceSheet({ s, status, details }: { s: InvoiceSnapshot; status: DerivedStatus; details: Ok["details"] }) {
  const voided = status.phase === "expired" || status.phase === "cancelled";
  const payments = s.entries.filter((e) => e.kind === "Payment");
  return (
    <article className="sheet sheet-pad relative overflow-hidden" aria-label={`Invoice ${s.id}`}>
      <div className="flex items-start justify-between gap-4">
        <h1 className="m-0 text-[34px] leading-[56px] tracking-[-0.01em] md:text-[40px]">Invoice</h1>
        <dl className="m-0 grid grid-cols-[auto_auto] gap-x-3 text-right text-[14px] leading-7 text-ink-2">
          <dt>No.</dt>
          <dd className="num m-0 text-ink">{s.id}</dd>
          <dt>Issued</dt>
          <dd className="num m-0 text-ink">{formatDate(s.createdAt)}</dd>
          {s.dueAt === null ? null : (
            <>
              <dt>Due</dt>
              <dd className={`num m-0 ${status.overdue ? "text-amber" : "text-ink"}`}>{formatDate(s.dueAt)}</dd>
            </>
          )}
          {s.expiresAt === null ? null : (
            <>
              <dt>Expires</dt>
              <dd className="num m-0 text-ink">{formatDate(s.expiresAt)}</dd>
            </>
          )}
        </dl>
      </div>

      <dl className="mt-5 grid gap-x-6 gap-y-3 text-[15px] leading-6 sm:grid-cols-2">
        <div>
          <dt className="t-colhead">Pay to</dt>
          <dd className="m-0">The invoice&rsquo;s own address, same on every chain</dd>
        </div>
        <div>
          <dt className="t-colhead">For</dt>
          <dd className="m-0">
            {details.kind === "ok"
              ? details.details.clientName
              : details.kind === "unavailable"
                ? "Details are offline; amounts below are read from chain"
                : details.kind === "mismatch"
                  ? "Details on file do not match the chain, so they are hidden"
                  : "No off-chain details for this invoice"}
          </dd>
        </div>
      </dl>
      {details.kind === "ok" && details.details.notes !== null ? (
        <p className="t-small m-0 mt-3 text-ink-2">{details.details.notes}</p>
      ) : null}

      <table className="ledger ruled-rows mt-6">
        <thead>
          <tr>
            <th scope="col">Particulars</th>
            <th scope="col" className="col-amt">
              USDC
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="wrap-cell">Invoice {s.id}, as recorded on chain</td>
            <td className="col-amt num">{formatAmount(BigInt(s.amount))}</td>
          </tr>
          {payments.map((p) => (
            <tr key={p.index}>
              <td className="wrap-cell text-ink-2">
                Received on {chainName(p.chainId)}
                {p.originAt === null ? "" : `, ${formatTime(p.originAt)}`}
              </td>
              <td className="col-amt num text-ink-2">({formatAmount(BigInt(p.amount))})</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div
        className={`relative mt-7 border-t-2 border-ink pt-3 ${status.phase === "settled" ? "pb-[84px] md:pb-4" : status.phase === "part-paid" ? "pb-[76px] md:pb-4" : ""}`}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="t-colhead text-[17px]">
            {status.phase === "settled"
              ? "Amount paid"
              : status.phase === "payment-seen"
                ? "Amount received"
                : voided
                  ? "Was due"
                  : "Amount due"}
          </span>
          <span
            className={`num relative text-[clamp(34px,4vw,48px)] font-medium leading-none tracking-[-0.03em] ${voided ? "text-ink-3 line-through decoration-red decoration-2" : ""}`}
          >
            <span className="relative z-[1]">
              {formatAmount(
                status.phase === "settled" || status.phase === "payment-seen" || voided
                  ? BigInt(s.amount)
                  : status.remaining,
              )}
              <span className="ml-1.5 text-[0.42em] tracking-normal text-ink-2">USDC</span>
            </span>
            {status.phase === "settled" ? (
              <span className="pointer-events-none absolute right-0 top-[calc(100%+4px)] mix-blend-multiply md:right-[calc(100%-28px)] md:top-1/2 md:-translate-y-1/2 dark:mix-blend-normal">
                <Stamp
                  className="w-[96px] md:w-[148px]"
                  word="Paid"
                  ring={`PAID IN FULL / INVOICE ${s.id} / ${status.settledAt === null ? "" : formatDate(status.settledAt).toUpperCase()} / `}
                  label={`Paid in full, invoice ${s.id}${status.settledAt === null ? "" : `, ${formatDate(status.settledAt)}`}`}
                />
              </span>
            ) : status.phase === "part-paid" ? (
              <span className="pointer-events-none absolute right-0 top-[calc(100%+4px)] mix-blend-multiply md:right-[calc(100%-20px)] md:top-1/2 md:-translate-y-1/2 dark:mix-blend-normal">
                <Stamp
                  className="w-[88px] md:w-[112px]"
                  word="Part paid"
                  land={false}
                  ring={`PART PAID / ${formatAmount(status.received)} OF ${formatAmount(BigInt(s.amount))} / `}
                  label={`Part paid, ${formatAmount(status.received)} of ${formatAmount(BigInt(s.amount))}`}
                />
              </span>
            ) : null}
          </span>
        </div>
      </div>

      {voided ? (
        <>
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 bottom-[88px]">
            <svg className="h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden="true">
              <line
                x1="4"
                y1="96"
                x2="96"
                y2="4"
                stroke="var(--red)"
                strokeWidth="0.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>
          <p className="m-0 mt-5 font-mono text-[15px] font-medium tracking-[0.14em] text-red">
            VOID, {status.phase === "expired" ? "EXPIRED" : "CANCELLED"}
          </p>
        </>
      ) : null}

      <div className="no-print mt-6 flex flex-wrap gap-3">
        <button type="button" className="btn btn-ghost btn-small" onClick={() => window.print()}>
          {status.phase === "settled" ? "Print receipt" : "Print invoice"}
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- the payment panel

function Panel({ data, status }: { data: Ok; status: DerivedStatus }) {
  const s = data.snapshot;
  if (!s.payAddressVerified) {
    return (
      <div className="callout">
        <h2 className="m-0 text-[34px] leading-tight text-red">Do not pay this invoice</h2>
        <p className="t-small mt-2 text-ink-2">
          The address stored for invoice {s.id} does not match the one recomputed from the deployed pay-address factory.
          Something is wrong with this deployment, so no address or QR code is shown. Contact whoever sent the invoice.
        </p>
      </div>
    );
  }
  return <PayPanel data={data} status={status} />;
}

function PayPanel({ data, status }: { data: Ok; status: DerivedStatus }) {
  const s = data.snapshot;
  const chains = data.qrs.map((q) => q.chainId);
  const [chainId, setChainId] = useState<number>(chains[0] ?? s.accepted[0]?.chainId ?? 0);
  const qr = data.qrs.find((q) => q.chainId === chainId) ?? data.qrs[0];
  const chain = paymentChain(chainId);
  return (
    <div className="flex flex-col gap-6">
      <div>
        {status.overdue ? <span className="tag tag-red mb-3">Overdue</span> : null}
        <p className="t-label m-0">
          {status.phase === "part-paid" ? "Part paid. Send the balance, exactly" : "Send exactly"}
        </p>
        <p className="num m-0 mt-1 text-[clamp(56px,7vw,96px)] font-medium leading-none tracking-[-0.045em]">
          {formatAmount(status.remaining)}
          <span className="ml-2 align-baseline text-[0.28em] tracking-normal text-ink-2">USDC</span>
        </p>
        {status.phase === "part-paid" ? (
          <p className="t-small m-0 mt-2 text-ink-2">
            {formatAmount(status.received)} of {formatAmount(BigInt(s.amount))} received. Pay the rest on any accepted
            chain.
          </p>
        ) : null}
      </div>

      {status.flagged.length > 0 ? (
        <div className="callout" role="note">
          <p className="m-0 text-[17px] font-bold leading-7">Wrong token received, not counted</p>
          <p className="t-small m-0 mt-1 text-ink-2">
            It is flagged in the ledger and not counted. It stays at the pay address until the owner returns it, so
            nothing is lost. This invoice takes USDC only.
          </p>
        </div>
      ) : null}

      {chains.length > 1 ? (
        <ChainPicker chains={chains} value={chainId} onChange={setChainId} label="Pay on" />
      ) : (
        <p className="t-label m-0">
          Pay on <span className="text-ink">{chainName(chainId)}</span>
        </p>
      )}

      <div>
        <p className="t-label m-0 mb-2">To this address, the same on every chain</p>
        <AddressBlock address={s.payAddress} />
      </div>

      {qr === undefined ? null : (
        <div className="grid justify-items-center gap-5 sm:grid-cols-[200px_1fr] sm:items-start sm:justify-items-stretch">
          <div
            className="h-[200px] w-[200px] overflow-hidden rounded-[3px] border border-rule-strong [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
            role="img"
            aria-label={`QR code: pay ${formatAmount(status.remaining)} USDC on ${chainName(qr.chainId)} to the address above`}
            // The SVG is generated on our server by the qrcode library from a URI we built; it holds no user input.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, server-generated QR markup
            dangerouslySetInnerHTML={{ __html: qr.svg }}
          />
          <div className="t-small text-ink-2">
            <p className="m-0">
              Scan with a wallet that reads payment links. It fills in USDC on {chainName(qr.chainId)}, this address and
              the exact amount.
            </p>
            <p className="m-0 mt-3 text-ink">
              Send <span className="font-bold">USDC on {chain?.name ?? chainName(chainId)}</span> only. Any other token
              is flagged, not counted.
            </p>
          </div>
        </div>
      )}

      <StatusSlip status={status} invoiceId={s.id} />
    </div>
  );
}

/** The one-line verdict once the invoice is paid or closed. Only Paid is set at display size. */
function Verdict({ s, status }: { s: InvoiceSnapshot; status: DerivedStatus }) {
  const p = status.stations[0];
  if (status.phase === "settled") {
    return (
      <div>
        <h2 className="t-display m-0 text-red">Paid</h2>
        <p className="mt-4 max-w-[30em] text-[17px] leading-7 text-ink-2">
          {formatAmount(BigInt(s.amount))} USDC on {p.place}
          {status.loopMs === null ? "" : `, settled ${formatElapsed(status.loopMs).slice(1)} after your transfer`}
          {status.settledAt === null ? "" : `. Settled ${formatDateTime(status.settledAt)}`}.
        </p>
      </div>
    );
  }
  if (status.phase === "payment-seen") {
    return (
      <div>
        <h2 className="t-section m-0">Payment seen</h2>
        <p className="mt-3 max-w-[30em] text-[17px] leading-7 text-ink-2">
          {formatAmount(status.received)} USDC arrived on {p.place}
          {p.at === null ? "" : ` at ${formatTime(p.at)} UTC`}. The contract has asked the till to sweep it, split it
          and issue your receipt. This page stamps Paid when that settlement is confirmed on chain.
        </p>
      </div>
    );
  }
  const expired = status.phase === "expired";
  return (
    <div>
      <h2 className="t-display m-0 text-red">{expired ? "Expired" : "Cancelled"}</h2>
      <div className="callout mt-5">
        <p className="m-0 max-w-[30em] text-[17px] leading-7 text-ink">
          Do not send money to this invoice.{" "}
          {expired && s.expiresAt !== null ? `It closed on ${formatDate(s.expiresAt)}. ` : ""}
          Anything sent to its address now is recorded as orphaned and forwarded to the owner&rsquo;s treasury, not
          counted as a payment. Ask whoever sent it for a new invoice.
        </p>
        {status.received > 0n ? (
          <p className="t-small m-0 mt-2 text-ink-2">
            {formatAmount(status.received)} USDC received before it closed was forwarded to the treasury unsplit.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Receipt({ s, status }: { s: InvoiceSnapshot; status: DerivedStatus }) {
  const [pay, match, settle] = status.stations;
  const uid = s.settlements.find((x) => x.receiptUid !== null)?.receiptUid ?? null;
  const settleChain = settle.hop === null ? undefined : paymentChain(settle.hop.chainId);
  return (
    <section aria-labelledby="receipt-title" className="print-break-avoid">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="receipt-title" className="t-title m-0">
          Your receipt
        </h2>
        <span className="t-meta">three transactions</span>
      </div>
      <ol className="m-0 mt-3 list-none border-t-2 border-ink p-0">
        {[
          { n: 1, what: "Your payment", hop: pay.hop },
          { n: 2, what: "Matched by the Daybook contract", hop: match.hop },
          { n: 3, what: "Settled, receipt issued to you", hop: settle.hop },
        ].map((row) => (
          <li key={row.n} className="grid grid-cols-[2em_1fr] gap-x-2 border-b border-rule py-2.5">
            <span className="num text-[13px] leading-6 text-red">{row.n}</span>
            <div>
              <span className="block text-[16px] leading-6">{row.what}</span>
              {row.hop === null ? (
                <span className="t-meta">not found on chain yet</span>
              ) : (
                <TxLink chainId={row.hop.chainId} hash={row.hop.tx} />
              )}
            </div>
          </li>
        ))}
      </ol>
      {uid === null ? (
        <p className="t-meta mt-3">The receipt is the till&rsquo;s Receipt event in transaction 3.</p>
      ) : (
        <p className="t-meta mt-3">
          Attestation{" "}
          {settleChain?.easScan === null || settleChain === undefined ? (
            <span className="num text-ink">{shortHex(uid, 10, 6)}</span>
          ) : (
            <a
              className="num print-full text-ink"
              data-full={uid}
              href={`${settleChain.easScan}${uid}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortHex(uid, 10, 6)}
            </a>
          )}{" "}
          to the address you paid from
        </p>
      )}
    </section>
  );
}
