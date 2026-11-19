import { LASNA } from "@/lib/chains";

export function Footer({ reactive }: { reactive: string | null }) {
  return (
    <footer className="no-print mt-24 border-t border-rule-strong">
      <div className="wrap flex flex-col gap-2 py-8 text-[14px] leading-6 text-ink-2 md:flex-row md:justify-between">
        <p className="m-0">
          Daybook, MIT licensed. Contracts unaudited, settlements capped per invoice. Testnet twin on Lasna.
        </p>
        {reactive === null ? (
          <p className="m-0">Built on Reactive Network</p>
        ) : (
          <p className="m-0">
            Reading{" "}
            <a className="num" href={`${LASNA.explorer}/address/${reactive}`} rel="noreferrer" target="_blank">
              DaybookReactive {reactive.slice(0, 6)}…{reactive.slice(-4)}
            </a>{" "}
            on Lasna
          </p>
        )}
      </div>
    </footer>
  );
}
