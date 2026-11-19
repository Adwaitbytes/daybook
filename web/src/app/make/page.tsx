import type { Metadata } from "next";
import { MakeWizard } from "@/components/make/wizard";
import { PageHead } from "@/components/page-head";

export const metadata: Metadata = {
  title: "Make your own",
  description: "Deploy your own Daybook from your wallet: a reactive contract on Lasna and a till on Base Sepolia.",
};

export default function MakePage() {
  return (
    <>
      <PageHead title="Make your own">
        <p className="m-0">
          Deploy a Daybook you own, from your wallet, in eight transactions: the reactive contract on Lasna, a till and
          pay-address factory on Base Sepolia, the wiring between them, a split policy and a first invoice. Each step
          shows its transaction as it lands. Nothing runs on our side.
        </p>
      </PageHead>
      <div className="wrap">
        <div className="max-w-[880px]">
          <MakeWizard />
        </div>
      </div>
    </>
  );
}
