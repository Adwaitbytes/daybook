"use client";

import { useEffect, useState } from "react";
import { groupAddress, groupedText } from "@/lib/address";

/** The pay address in 4-character groups on two deliberate lines, ends in full ink: people check the ends. */
export function AddressBlock({ address }: { address: string }) {
  const g = groupAddress(address);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const t = setTimeout(() => setCopied("idle"), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="flex flex-col gap-2 min-[400px]:flex-row min-[400px]:items-stretch">
      <div className="min-w-0 flex-1 rounded-[3px] border border-rule-strong bg-sheet px-3.5 py-2.5 font-mono text-[16px] leading-[26px] tracking-[0.02em] sm:text-[17px] md:text-[18px]">
        <span className="sr-only">Pay address {groupedText(address)}</span>
        {g.lines.map((line, li) => (
          <span key={li === 0 ? "first" : "second"} className="block whitespace-nowrap" aria-hidden="true">
            {li === 0 ? <span className="font-medium text-ink">0x </span> : <span className="invisible">0x </span>}
            {line.map((group) => (
              <span key={group.start}>
                {group.start % 20 === 0 ? "" : " "}
                {group.parts.map((p) => (
                  <span key={p.start} className={p.strong ? "font-medium text-ink" : "text-ink-2"}>
                    {p.text}
                  </span>
                ))}
              </span>
            ))}
          </span>
        ))}
      </div>
      <button type="button" className="btn btn-ghost no-print min-w-[92px] min-[400px]:self-stretch" onClick={copy}>
        {copied === "copied" ? "Copied" : copied === "failed" ? "Select it" : "Copy"}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied === "copied" ? "Address copied" : copied === "failed" ? "Copy failed, select the address instead" : ""}
      </span>
    </div>
  );
}
