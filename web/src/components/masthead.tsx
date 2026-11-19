import Link from "next/link";
import { NavLinks } from "./nav-links";
import { Wordmark } from "./wordmark";

export function Masthead() {
  return (
    <header className="no-print border-b border-rule-strong">
      <div className="wrap flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3 md:py-4">
        <Link href="/" className="no-underline text-ink" aria-label="Daybook home">
          <Wordmark />
        </Link>
        <NavLinks />
      </div>
    </header>
  );
}
