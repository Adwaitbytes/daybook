import { chainName } from "@/lib/chains";
import { formatElapsed, formatTime, formatUnitsFixed } from "@/lib/format";
import type { DerivedStatus, Station } from "@/lib/status";
import { TxLink } from "./tx-link";

function Mark({ s }: { s: Station }) {
  if (s.state === "done")
    return (
      <span aria-hidden="true" className="font-mono text-[15px] text-ink">
        ✓
      </span>
    );
  if (s.state === "void")
    return (
      <span aria-hidden="true" className="font-mono text-[15px] text-red">
        ×
      </span>
    );
  return (
    <span aria-hidden="true" className="font-mono text-[15px] text-ink-3">
      ○
    </span>
  );
}

const STATE_TEXT: Record<Station["state"], string> = {
  done: "done",
  now: "in progress",
  todo: "not yet",
  void: "will not happen",
};

/** The carbon copy: each station of the loop written in as it happens, with block times and elapsed seconds. */
export function StatusSlip({ status, invoiceId }: { status: DerivedStatus; invoiceId: string }) {
  const first = status.stations[0].at;
  return (
    <section className="slip print-break-avoid" aria-labelledby="slip-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="slip-title" className="m-0 text-[15px] italic leading-6 text-ink-2">
          Carbon copy, written as the loop moves
        </h2>
        <span className="t-meta">No. {invoiceId}</span>
      </div>
      <ol className="m-0 mt-2 list-none p-0">
        {status.stations.map((s, i) => (
          <li
            key={s.key}
            className="grid grid-cols-[18px_1fr_auto] items-baseline gap-x-2.5 border-b border-rule py-2.5 last:border-b-0"
          >
            <Mark s={s} />
            <div
              className={
                s.state === "todo"
                  ? "text-ink-2"
                  : s.state === "void"
                    ? "text-ink-2 line-through decoration-red"
                    : "text-ink"
              }
            >
              <span className="block text-[16px] leading-6">
                {s.title}
                {s.state === "now" ? <span className="caret" aria-hidden="true" /> : null}
                <span className="sr-only">, {STATE_TEXT[s.state]}</span>
              </span>
              <span className="t-meta block">
                {i + 1} of 3, {s.place}
              </span>
              {s.hop === null ? null : (
                <span className="mt-0.5 block">
                  <TxLink chainId={s.hop.chainId} hash={s.hop.tx} showChain={false} />
                </span>
              )}
            </div>
            <span className="t-meta text-right">
              {s.at === null ? "" : formatTime(s.at)}
              {s.at !== null && first !== null && i > 0 && s.hop?.clock === "ms" ? (
                <span className="block text-ink">{formatElapsed(s.at - first)}</span>
              ) : null}
            </span>
          </li>
        ))}
        {status.flagged.map((f) => (
          <li
            key={`flag-${f.index}`}
            className="grid grid-cols-[18px_1fr_auto] items-baseline gap-x-2.5 border-t border-rule py-2.5 text-red"
          >
            <span aria-hidden="true" className="font-mono text-[15px]">
              !
            </span>
            <div>
              <span className="block text-[16px] leading-6">
                Flagged: {f.decimals === null ? `${f.amount} units` : formatUnitsFixed(BigInt(f.amount), f.decimals)} of{" "}
                {f.symbol ?? "a token this invoice does not take"} on {chainName(f.chainId)}
              </span>
              <TxLink chainId={f.chainId} hash={f.originTx} showChain={false} />
            </div>
            <span className="t-meta text-right">{f.originAt === null ? "" : formatTime(f.originAt)}</span>
          </li>
        ))}
      </ol>
      <p className="t-meta m-0 mt-2">
        Times are block times in UTC. Base Sepolia stamps milliseconds; Lasna and Unichain whole seconds.
      </p>
    </section>
  );
}
