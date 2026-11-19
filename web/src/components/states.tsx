import Link from "next/link";
import type { ReactNode } from "react";

/** Empty ruled lines with a pen caret: what a page looks like while chain data is being read. */
export function RuledSkeleton({ lines = 6, label = "Reading from chain" }: { lines?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="sheet sheet-pad">
      <p className="m-0 text-[15px] italic text-ink-2">
        {label}
        <span className="caret" aria-hidden="true" />
      </p>
      <div className="skeleton-lines mt-3" style={{ height: `calc(var(--line) * ${lines})` }} aria-hidden="true" />
    </div>
  );
}

function Notice({
  title,
  children,
  tone = "red",
  action,
}: {
  title: string;
  children: ReactNode;
  tone?: "red" | "amber" | "ink";
  action?: ReactNode;
}) {
  return (
    <div className="sheet sheet-pad">
      <div className={tone === "ink" ? "" : `callout ${tone === "amber" ? "callout-amber" : ""}`}>
        <h2 className="t-title m-0">{title}</h2>
        <div className="mt-2 max-w-[38em] text-[17px] leading-7 text-ink-2">{children}</div>
      </div>
      {action === undefined ? null : <div className="mt-6 flex flex-wrap gap-3">{action}</div>}
    </div>
  );
}

export function NotDeployed({ what }: { what: string }) {
  return (
    <Notice
      tone="ink"
      title="Not deployed yet"
      action={
        <Link className="btn btn-ghost" href="/make">
          Deploy your own on Lasna
        </Link>
      }
    >
      <p className="m-0">
        {what} reads from the Daybook contract on Reactive Lasna, and no deployment has been published to this site yet.
        It fills in from chain data once the address is in{" "}
        <span className="num text-[15px]">contracts/deployments</span>. Nothing here is made up in the meantime.
      </p>
    </Notice>
  );
}

export function ChainError({ network, retryHref }: { network: string; retryHref: string }) {
  return (
    <Notice
      title={`${network} did not answer`}
      action={
        <a className="btn" href={retryHref}>
          Try again
        </a>
      }
    >
      <p className="m-0">
        The page reads everything from the chain and the public RPC for {network} did not respond in time. Nothing has
        changed on chain because of this. Reload in a moment; if you are paying an invoice, wait for this page before
        sending money.
      </p>
    </Notice>
  );
}

export function EmptyRecord({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Notice tone="ink" title={title} action={action}>
      {children}
    </Notice>
  );
}
