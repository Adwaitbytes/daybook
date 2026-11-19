import type { ReactNode } from "react";

export type WalletNoticeKind = "no-wallet" | "wrong-network" | "smart-transactions";

/** The three wallet states the wizard can hit, each saying exactly what to do next. */
export function WalletNotice({
  kind,
  network = "Reactive Lasna",
  action,
}: {
  kind: WalletNoticeKind;
  network?: string;
  action?: ReactNode;
}) {
  if (kind === "no-wallet") {
    return (
      <div className="sheet sheet-pad" role="status">
        <h2 className="t-title m-0">No browser wallet found</h2>
        <p className="t-small mt-2 max-w-[34em] text-ink-2">
          Deploying your own Daybook signs a few transactions on Reactive Lasna and Base Sepolia, so it needs a browser
          wallet such as MetaMask or Rabby. Paying an invoice never needs one: any wallet or exchange can send the
          transfer.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {action}
          <a className="btn btn-ghost" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
            Get MetaMask
          </a>
        </div>
      </div>
    );
  }
  if (kind === "wrong-network") {
    return (
      <div className="sheet sheet-pad" role="status">
        <div className="callout callout-amber">
          <h2 className="t-title m-0">Switch your wallet to {network}</h2>
          <p className="t-small mt-2 max-w-[34em] text-ink-2">
            This step sends a transaction on {network}, and your wallet is on another network. Switching adds the
            network to your wallet if it is not there yet.
          </p>
        </div>
        {action === undefined ? null : <div className="mt-5 flex flex-wrap gap-3">{action}</div>}
      </div>
    );
  }
  return (
    <div className="sheet sheet-pad" role="alert">
      <div className="callout">
        <h2 className="t-title m-0">Your wallet dropped the transaction</h2>
        <p className="t-small mt-2 max-w-[36em] text-ink-2">
          MetaMask Smart Transactions can drop transactions sent to Reactive Network: the wallet reports a hash, but the
          transaction never reaches a block. Turn it off, then send the step again.
        </p>
        <ol className="t-small mt-3 list-decimal pl-5">
          <li>Open MetaMask and go to Settings, then Advanced.</li>
          <li>Turn off Smart Transactions.</li>
          <li>Come back here and press the step&rsquo;s button again.</li>
        </ol>
      </div>
      {action === undefined ? null : <div className="mt-5 flex flex-wrap gap-3">{action}</div>}
    </div>
  );
}
