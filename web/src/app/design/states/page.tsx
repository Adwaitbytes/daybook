import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import type { ReactNode } from "react";
import { DemoFailure } from "@/components/demo-strip";
import { PayView } from "@/components/pay-view";
import { ChainError, NotDeployed, RuledSkeleton } from "@/components/states";
import { WalletNotice } from "@/components/wallet-notice";
import { toTokenUnits } from "@/lib/format";
import { erc20TransferUri } from "@/lib/qr-payload";
import { FIXTURES } from "./fixtures";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "State gallery", robots: { index: false, follow: false } };

const STATES = [
  "waiting",
  "overdue",
  "part-paid",
  "payment-seen",
  "wrong-token",
  "expired",
  "loading",
  "rpc-error",
  "not-deployed",
  "rate-limited",
  "demo-unconfigured",
  "no-wallet",
  "wrong-network",
  "smart-transactions",
] as const;

export default async function StatesPage({ searchParams }: PageProps<"/design/states">) {
  if (process.env.DAYBOOK_STATE_GALLERY !== "1") notFound();
  const sp = await searchParams;
  const s = typeof sp.s === "string" ? sp.s : "waiting";
  return (
    <>
      <div className="no-print border-b border-red bg-band">
        <p className="wrap m-0 py-2 text-[14px] text-red">
          State gallery for design review. Fixture data, not chain data: {s}.{" "}
          {STATES.map((x) => (
            <a key={x} href={`/design/states?s=${x}`} className="mr-2 text-ink-2">
              {x}
            </a>
          ))}
        </p>
      </div>
      <Body s={s} />
    </>
  );
}

async function Body({ s }: { s: string }) {
  const fixture = FIXTURES[s];
  if (fixture !== undefined) {
    const due = BigInt(fixture.amount) - BigInt(fixture.paid);
    const qrs =
      fixture.status !== "Open"
        ? []
        : await Promise.all(
            fixture.accepted.map(async (a) => {
              const amountRaw = toTokenUnits(due, a.decimals);
              const uri = erc20TransferUri({ chainId: a.chainId, token: a.token, to: fixture.payAddress, amountRaw });
              const svg = await QRCode.toString(uri, {
                type: "svg",
                margin: 4,
                color: { dark: "#18221bff", light: "#fbfaf5ff" },
              });
              return { chainId: a.chainId, uri, svg, amountRaw: amountRaw.toString() };
            }),
          );
    return <PayView live={false} initial={{ kind: "ok", snapshot: fixture, qrs, details: { kind: "none" } }} />;
  }
  const wrap = (node: ReactNode) => <div className="wrap max-w-[760px] pt-12">{node}</div>;
  switch (s) {
    case "loading":
      return wrap(<RuledSkeleton lines={8} label="Reading the invoice from chain" />);
    case "rpc-error":
      return wrap(<ChainError network="Reactive Lasna" retryHref="/design/states?s=rpc-error" />);
    case "not-deployed":
      return wrap(<NotDeployed what="This pay page" />);
    case "rate-limited":
      return wrap(
        <DemoFailure
          f={{
            ok: false,
            code: "rate-limited",
            message: "You have paid the demo invoices this visitor allowance covers for now.",
            retryAfterSeconds: 412,
          }}
        />,
      );
    case "demo-unconfigured":
      return wrap(
        <DemoFailure
          f={{
            ok: false,
            code: "not-configured",
            message:
              "The demo relayer is not set up on this deployment (DEMO_RELAYER_PK is missing), so no demo payment can be sent.",
          }}
        />,
      );
    case "no-wallet":
    case "wrong-network":
    case "smart-transactions":
      return wrap(<WalletNotice kind={s} />);
    default:
      notFound();
  }
}
