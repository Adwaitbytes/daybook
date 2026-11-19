import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { Addr } from "@/components/addr";
import { DemoStrip } from "@/components/demo-strip";
import { Stamp } from "@/components/stamp";
import { ChainError, NotDeployed } from "@/components/states";
import { TxLink } from "@/components/tx-link";
import { chainName } from "@/lib/chains";
import { formatAmount, formatBps, formatDate, formatElapsed, formatTime, shortHex } from "@/lib/format";
import { heroLoop } from "@/lib/server/views";
import { split } from "@/lib/split";
import { deriveStatus } from "@/lib/status";

// Static shell, refreshed from chain every 30 s: the home page is read far more often than loops close.
export const revalidate = 30;

export default function Home() {
  return (
    <>
      <section className="wrap pb-16 pt-12 md:pb-24 md:pt-20">
        <h1 className="t-display m-0 max-w-[11em]">Invoices that mark themselves paid</h1>
        <div className="mt-6 grid gap-6 md:mt-8 md:grid-cols-[minmax(0,34em)_1fr] md:items-end md:gap-12">
          <p className="t-lede m-0">
            Your client sends USDC to one address, on whichever chain they like. A contract on Reactive Network sees it,
            writes it in the ledger, issues the receipt, sets the tax aside and pays the team. You find out when you
            look.
          </p>
          <div className="flex flex-wrap gap-3 md:justify-end">
            <a className="btn" href="#demo">
              Pay a demo invoice
            </a>
            <Link className="btn btn-ghost" href="/ledger">
              Read the ledger
            </Link>
          </div>
        </div>
        <div className="mt-12 md:mt-16">
          <Suspense fallback={<HeroSkeleton />}>
            <HeroLedger />
          </Suspense>
        </div>
        <p className="t-small m-0 mt-8 max-w-[36em] text-ink-2">
          I built it for my own company&rsquo;s invoices at Aarambh Labs. Nothing of mine has to be running for an
          invoice to settle: no server, no bot, no tab left open.
        </p>
      </section>

      <section id="demo" className="scroll-mt-6 border-t border-rule-strong bg-band/60">
        <div className="wrap py-16 md:py-24">
          <DemoStrip />
        </div>
      </section>

      <section className="border-t border-rule-strong">
        <div className="wrap py-16 md:py-24">
          <h2 className="t-section m-0">Three transactions close the loop</h2>
          <p className="mt-3 max-w-[38em] text-[17px] leading-7 text-ink-2">
            Every settled invoice leaves the same three entries on chain. The pay page links all three, so your client
            and your accountant can check them without asking you.
          </p>
          <ol className="m-0 mt-10 grid list-none gap-0 border-t-2 border-ink p-0 md:grid-cols-3">
            {[
              {
                h: "The client pays",
                p: "A plain USDC transfer to the invoice's pay address, from any wallet or exchange. The address is the same on every supported chain and holds no code until it is swept.",
                w: "Base Sepolia or Unichain Sepolia",
              },
              {
                h: "The contract matches it",
                p: "DaybookReactive is subscribed to transfers into that address. It counts the payment, handles part payments and overpayments, and when the invoice is covered it asks the chain where the money is to settle.",
                w: "Reactive Network",
              },
              {
                h: "The till settles",
                p: "DaybookTill sweeps the address, moves the tax share to a savings vault, pays each team share, sends the rest to the treasury and attests a receipt to the payer.",
                w: "Same chain as the payment",
              },
            ].map((s, i) => (
              <li
                key={s.h}
                className="relative border-b border-rule-strong py-6 md:border-b-0 md:border-r md:px-6 md:first:pl-0 md:last:border-r-0"
              >
                <span className="num block text-[13px] text-red">{i + 1} of 3</span>
                <h3 className="mt-3 text-[20px] font-bold leading-7">{s.h}</h3>
                <p className="mt-2 text-[16px] leading-[26px] text-ink-2">{s.p}</p>
                <p className="t-meta mt-4 text-ink">{s.w}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t border-rule-strong">
        <div className="wrap grid gap-8 py-16 md:grid-cols-2 md:py-24">
          <Link
            href="/rules"
            className="sheet sheet-pad block no-underline transition-transform hover:-translate-y-0.5"
          >
            <h2 className="t-title m-0">Rules you set once</h2>
            <p className="t-small mt-2 text-ink-2">
              A split policy is fixed when you create it, so an invoice always settles the way it said it would. Tax
              plus team shares can be at most 100%, with up to five people on the team.
            </p>
            <span className="mt-4 inline-block text-[16px] underline decoration-rule-strong underline-offset-4">
              Read the live rules
            </span>
          </Link>
          <Link
            href="/health"
            className="sheet sheet-pad block no-underline transition-transform hover:-translate-y-0.5"
          >
            <h2 className="t-title m-0">Is it still running</h2>
            <p className="t-small mt-2 text-ink-2">
              How long it has been live, how many invoices it settled, what its reactions cost and how many more its
              balance pays for. Read from chain when you open it.
            </p>
            <span className="mt-4 inline-block text-[16px] underline decoration-rule-strong underline-offset-4">
              Check its health
            </span>
          </Link>
        </div>
      </section>
    </>
  );
}

const HERO_LINES = 11;

function HeroSkeleton() {
  return (
    <div className="sheet sheet-ruled" role="status" aria-live="polite">
      <p className="m-0 h-[var(--line)] text-[15px] italic leading-[var(--line)] text-ink-2">
        Reading the latest settled invoice from chain
        <span className="caret" aria-hidden="true" />
      </p>
      <div style={{ height: `calc(var(--line) * ${HERO_LINES})` }} aria-hidden="true" />
    </div>
  );
}

async function HeroLedger() {
  const v = await heroLoop();
  if (v.kind === "not-deployed") return <NotDeployed what="This ledger page" />;
  if (v.kind === "rpc-error") return <ChainError network={v.network} retryHref="/" />;
  if (v.value === null) {
    return (
      <div className="sheet sheet-ruled">
        <p className="m-0 h-[var(--line)] text-[17px] font-bold leading-[var(--line)]">No invoice settled yet</p>
        <p className="m-0 text-[16px] leading-[var(--line)] text-ink-2">
          The first settled invoice is written out here, line by line, from chain data. Pay the demo invoice below to
          make one.
        </p>
        <div style={{ height: `calc(var(--line) * ${HERO_LINES - 2})` }} aria-hidden="true" />
      </div>
    );
  }
  const { snapshot: s, policy, leftAtPayAddress } = v.value;
  const d = deriveStatus(s);
  // Each chain's money settles on its own chain, so the split is computed per settlement and summed.
  const settled = s.settlements.filter((x) => x.callback !== null);
  const sp =
    policy === null || settled.length === 0
      ? null
      : settled
          .map((x) =>
            split(
              BigInt(x.amount),
              policy.taxBps,
              policy.team.map((m) => m.bps),
              BigInt(x.excess),
            ),
          )
          .reduce((a, b) => ({
            tax: a.tax + b.tax,
            team: a.team.map((t, i) => t + (b.team[i] ?? 0n)),
            treasury: a.treasury + b.treasury,
          }));
  const payments = s.entries.filter((e) => e.kind === "Payment");
  const firstCallback = settled
    .map((x) => x.callback)
    .filter((h) => h !== null)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0];
  const cb = d.stations[2].hop;
  const match = d.stations[1].hop;
  const place = [...new Set(settled.map((x) => chainName(x.chainId)))].join(", ");
  const uid = s.settlements.find((x) => x.receiptUid !== null)?.receiptUid ?? null;

  type Row = { id: string; time: string; text: ReactNode; chain: string; amt: string; total?: boolean };
  const rows: Row[] = [
    ...payments.map((p) => ({
      id: `pay-${p.index}`,
      time: p.originAt === null ? "" : formatTime(p.originAt),
      text: (
        <>
          Received<span className="hidden md:inline"> from {shortHex(p.payer)}</span>
        </>
      ),
      chain: chainName(p.chainId),
      amt: formatAmount(BigInt(p.amount)),
    })),
    {
      id: "match",
      time: match?.at == null ? "" : formatTime(match.at),
      text: "Matched, invoice covered",
      chain: "Reactive",
      amt: "",
    },
  ];
  if (sp !== null && policy !== null) {
    rows.push({
      id: "tax",
      time: firstCallback?.at == null ? "" : formatTime(firstCallback.at),
      text: `Tax reserve, ${formatBps(policy.taxBps)}`,
      chain: place,
      amt: `(${formatAmount(sp.tax)})`,
    });
    policy.team.forEach((m, i) => {
      rows.push({
        id: `team-${m.account}`,
        time: "",
        text: (
          <>
            Team<span className="hidden md:inline">, {shortHex(m.account)}</span>
          </>
        ),
        chain: place,
        amt: `(${formatAmount(sp.team[i] ?? 0n)})`,
      });
    });
    rows.push({ id: "treasury", time: "", text: "Treasury", chain: place, amt: `(${formatAmount(sp.treasury)})` });
  }
  rows.push({
    id: "receipt",
    time: "",
    text: uid === null ? "Receipt event to payer" : "Receipt attested to payer",
    chain: place,
    amt: "",
  });
  rows.push({
    id: "left",
    time: "",
    text: "Left in pay address, read now",
    chain: "",
    amt: leftAtPayAddress === null ? "" : formatAmount(leftAtPayAddress),
    total: true,
  });

  return (
    <div className="sheet sheet-ruled relative" style={{ minHeight: `calc(var(--line) * ${HERO_LINES + 3})` }}>
      <div className="flex min-h-[var(--line)] flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="m-0 text-[17px] font-bold leading-[var(--line)]">
          Invoice {s.id}
          <span className="hidden font-normal text-ink-2 sm:inline">, the latest to settle</span>
        </h2>
        <Link href={`/pay/${s.id}`} className="t-meta text-ink">
          Its pay page
        </Link>
      </div>
      <table className="ledger">
        <caption className="sr-only">
          The ledger page for invoice {s.id}: payment, match and settlement, read from chain
        </caption>
        <thead>
          <tr>
            <th scope="col" className="hidden w-[1%] sm:table-cell">
              Time
            </th>
            <th scope="col">Particulars</th>
            <th scope="col" className="hidden w-[1%] sm:table-cell">
              Chain
            </th>
            <th scope="col" className="col-amt">
              USDC
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={`ink-row ${r.total === true ? "total" : ""}`} style={{ ["--i" as string]: i }}>
              <td className="col-dim num hidden text-[13px]! sm:table-cell">{r.time}</td>
              <td className="wrap-cell">{r.text}</td>
              <td className="col-dim hidden sm:table-cell">{r.chain}</td>
              <td className="col-amt num">{r.amt}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pointer-events-none relative -mt-[48px] ml-auto mr-16 w-fit mix-blend-multiply md:absolute md:bottom-[calc(var(--line)*2.2)] md:right-[150px] md:m-0 dark:mix-blend-normal">
        <Stamp
          className="w-[112px] md:w-[148px]"
          delay={rows.length * 0.36 + 0.4}
          word="Paid"
          ring={`PAID IN FULL / INVOICE ${s.id} / ${d.settledAt === null ? "" : formatDate(d.settledAt).toUpperCase()} / `}
          label={`Paid in full, invoice ${s.id}`}
        />
      </div>
      <div className="mt-[var(--line)] flex flex-wrap gap-x-6 gap-y-1">
        {d.stations.map((st) =>
          st.hop === null ? null : <TxLink key={st.key} chainId={st.hop.chainId} hash={st.hop.tx} />,
        )}
        {d.loopMs === null ? null : (
          <span className="t-meta">transfer to settlement {formatElapsed(d.loopMs).slice(1)}</span>
        )}
        {policy === null ? null : (
          <span className="t-meta">
            policy {policy.id}, treasury <Addr chainId={cb?.chainId ?? 84532} address={policy.treasury} />
          </span>
        )}
      </div>
    </div>
  );
}
