import { chainName, txUrl } from "@/lib/chains";
import { shortHex } from "@/lib/format";

/** A transaction as people check it: the chain, a short hash linking to the explorer, the full hash in print. */
export function TxLink({ chainId, hash, showChain = true }: { chainId: number; hash: string; showChain?: boolean }) {
  const url = txUrl(chainId, hash);
  const text = shortHex(hash, 6, 4);
  return (
    <span className="t-meta inline-flex flex-wrap gap-x-2">
      {showChain ? <span>{chainName(chainId)}</span> : null}
      {url === null ? (
        <span className="num text-ink">{text}</span>
      ) : (
        <a
          className="num print-full text-ink"
          href={url}
          target="_blank"
          rel="noreferrer"
          data-full={hash}
          aria-label={`Transaction ${text} on ${chainName(chainId)}, opens the explorer`}
        >
          {text}
        </a>
      )}
    </span>
  );
}
