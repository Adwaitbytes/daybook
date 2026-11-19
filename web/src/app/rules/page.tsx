import type { Metadata } from "next";
import { Suspense } from "react";
import { Addr } from "@/components/addr";
import { PageHead } from "@/components/page-head";
import { ChainError, EmptyRecord, NotDeployed, RuledSkeleton } from "@/components/states";
import { LASNA } from "@/lib/chains";
import { formatAmount, formatBps, formatUnitsFixed } from "@/lib/format";
import { rulesView } from "@/lib/server/views";
import { BPS } from "@/lib/split";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Rules",
  description: "The split policies, tills and limits Daybook settles by, read from chain.",
};

export default function RulesPage() {
  return (
    <>
      <PageHead title="Rules">
        <p className="m-0">
          How every invoice settles: the tax share, the team split and where the rest goes. A policy is fixed when it is
          created, so an invoice always settles the way it said it would. This public demo is read-only; the owner sets
          rules from the command line.
        </p>
      </PageHead>
      <div className="wrap">
        <Suspense fallback={<RuledSkeleton lines={8} label="Reading the rules from chain" />}>
          <RulesBody />
        </Suspense>
      </div>
    </>
  );
}

async function RulesBody() {
  const v = await rulesView();
  if (v.kind === "not-deployed") return <NotDeployed what="The rules page" />;
  if (v.kind === "rpc-error") return <ChainError network={v.network} retryHref="/rules" />;
  const r = v.value;
  return (
    <div className="grid items-start gap-8 lg:grid-cols-2">
      <div className="flex flex-col gap-8">
        {r.policies.length === 0 ? (
          <EmptyRecord title="No split policy yet">
            <p className="m-0">
              An invoice needs a policy before it can be issued. None has been created on this contract.
            </p>
          </EmptyRecord>
        ) : (
          r.policies.map((p) => {
            const team = p.team.reduce((a, m) => a + m.bps, 0);
            const treasury = Number(BPS) - p.taxBps - team;
            return (
              <section key={p.id} className="sheet sheet-ruled" aria-labelledby={`policy-${p.id}`}>
                <div className="flex h-[var(--line)] items-baseline justify-between gap-3">
                  <h2 id={`policy-${p.id}`} className="m-0 text-[17px] font-bold leading-[var(--line)]">
                    Policy {p.id}
                  </h2>
                  <span className="t-meta">fixed at creation</span>
                </div>
                <table className="ledger">
                  <thead>
                    <tr>
                      <th scope="col">Goes to</th>
                      <th scope="col">Address</th>
                      <th scope="col" className="col-amt">
                        Share
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Tax reserve</td>
                      <td className="col-dim wrap-cell">savings vault on each chain</td>
                      <td className="col-amt num">{formatBps(p.taxBps)}</td>
                    </tr>
                    {p.team.map((m) => (
                      <tr key={m.account}>
                        <td>Team</td>
                        <td>
                          <Addr chainId={84532} address={m.account} />
                        </td>
                        <td className="col-amt num">{formatBps(m.bps)}</td>
                      </tr>
                    ))}
                    <tr className="total">
                      <td>Treasury</td>
                      <td>
                        <Addr chainId={84532} address={p.treasury} />
                      </td>
                      <td className="col-amt num">{formatBps(treasury)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="t-meta m-0 mt-[var(--line)]">
                  Overpayments and late transfers go to the treasury unsplit. Each share rounds down; the treasury takes
                  the dust.
                </p>
              </section>
            );
          })
        )}
      </div>

      <div className="flex flex-col gap-8">
        <section className="sheet sheet-pad" aria-labelledby="tills">
          <h2 id="tills" className="t-title m-0">
            Where money settles
          </h2>
          <p className="t-small mt-2 text-ink-2">
            One till per payment chain sweeps the pay address and splits the money when the contract on Lasna asks it
            to.
          </p>
          <dl className="m-0 mt-4">
            {r.tills.map((t) => (
              <div key={t.chain.id} className="border-t border-rule py-3">
                <dt className="text-[17px]">{t.chain.name}</dt>
                <dd className="t-meta m-0 mt-1 grid gap-1">
                  {t.till === null ? (
                    <span>No till set, so payments on this chain are not accepted</span>
                  ) : (
                    <>
                      <span>
                        Till <Addr chainId={t.chain.id} address={t.till} />
                        {t.paused === true ? <span className="text-red">, paused</span> : null}
                      </span>
                      <span>
                        Tax reserve{" "}
                        {t.reserve === null ? (
                          "not set, tax goes to the treasury"
                        ) : (
                          <Addr chainId={t.chain.id} address={t.reserve} />
                        )}
                      </span>
                      <span>
                        Receipts{" "}
                        {t.receiptIssuer === null ? (
                          "as a Receipt event"
                        ) : (
                          <>
                            attested through EAS by <Addr chainId={t.chain.id} address={t.receiptIssuer} />
                          </>
                        )}
                      </span>
                      <span>
                        Largest settlement{" "}
                        {t.maxSettlement === null ? "unknown" : `${formatUnitsFixed(t.maxSettlement, 6)} USDC`}
                      </span>
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="sheet sheet-pad" aria-labelledby="limits">
          <h2 id="limits" className="t-title m-0">
            Limits
          </h2>
          <dl className="m-0 mt-4 grid grid-cols-[1fr_auto] gap-x-4 text-[16px] leading-7">
            <dt className="border-t border-rule py-1.5">Largest invoice</dt>
            <dd className="num m-0 border-t border-rule py-1.5 text-right">{formatAmount(r.maxInvoiceAmount)} USDC</dd>
            <dt className="border-t border-rule py-1.5">Callback gas limit</dt>
            <dd className="num m-0 border-t border-rule py-1.5 text-right">
              {r.callbackGasLimit.toLocaleString("en-GB")}
            </dd>
            <dt className="border-t border-rule py-1.5">Resend a settlement after</dt>
            <dd className="num m-0 border-t border-rule py-1.5 text-right">{r.resendAfter.toString()} s</dd>
            <dt className="border-t border-rule py-1.5">Owner</dt>
            <dd className="m-0 border-t border-rule py-1.5 text-right">
              <Addr chainId={LASNA.id} address={r.owner} />
            </dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
