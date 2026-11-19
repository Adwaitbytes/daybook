import { addressUrl } from "@/lib/chains";
import { shortHex } from "@/lib/format";

/** A short address that links to the explorer and prints in full. */
export function Addr({ chainId, address, label }: { chainId: number; address: string; label?: string }) {
  const url = addressUrl(chainId, address);
  const text = `${label === undefined ? "" : `${label} `}${shortHex(address, 6, 4)}`;
  if (url === null) return <span className="num">{text}</span>;
  return (
    <a className="num print-full" data-full={address} href={url} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
}
