"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/ledger", label: "Ledger" },
  { href: "/rules", label: "Rules" },
  { href: "/health", label: "Health" },
  { href: "/make", label: "Make your own" },
] as const;

export function NavLinks() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="-mx-2 flex max-w-full flex-wrap gap-x-2 md:gap-x-3">
      {LINKS.map((l) => {
        const current = path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={current ? "page" : undefined}
            className={`whitespace-nowrap px-2 py-2.5 text-[15px] leading-5 no-underline decoration-red underline-offset-[6px] hover:text-ink hover:underline ${current ? "text-ink underline" : "text-ink-2"}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
