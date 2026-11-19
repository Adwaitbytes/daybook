"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { type Address, concat, encodeAbiParameters, getAddress, type Hex, isAddress, parseEther } from "viem";
import { baseSepolia } from "viem/chains";
import { useConnect, useConnection, useConnectors, useDisconnect, WagmiProvider } from "wagmi";
import {
  deployContract,
  getBalance,
  getBytecode,
  getTransaction,
  sendTransaction,
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { TxLink } from "@/components/tx-link";
import { WalletNotice } from "@/components/wallet-notice";
import { daybookReactiveAbi, daybookTillAbi, payAddressFactoryAbi } from "@/generated/abis";
import { daybookReactiveBytecode, daybookTillBytecode, payAddressFactoryBytecode } from "@/generated/bytecode";
import { BASE_SEPOLIA, LASNA } from "@/lib/chains";
import { shortHex } from "@/lib/format";
import { CREATE2_DEPLOYER, FACTORY_SALT, payAddress, predictFactory } from "@/lib/pay-address";
import { lasnaChain, wagmiConfig } from "./wagmi";

const queryClient = new QueryClient();

/** Thrown by a step whose work is already on chain, so nothing needs sending. */
class SkipStep extends Error {}

export function MakeWizard() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Wizard />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

// ---------------------------------------------------------------- state

type StepKey = "reactive" | "factory" | "till" | "authorize" | "cap" | "wire" | "policy" | "invoice";

type Progress = {
  reactive?: Address;
  factory?: Address;
  till?: Address;
  policyId?: number;
  invoiceId?: string;
  txs: Partial<Record<StepKey, { chainId: number; hash: Hex }>>;
};

type Policy = { treasury: string; taxPct: string; team: string; teamPct: string };

type Problem =
  | { kind: "wrong-network"; chainId: number }
  | { kind: "smart-transactions" }
  | { kind: "rejected" }
  | { kind: "funds"; chainId: number }
  | { kind: "error"; message: string };

const STORAGE = "daybook.make.v1";

function load(account: string): Progress {
  try {
    const raw = window.localStorage.getItem(`${STORAGE}.${account.toLowerCase()}`);
    if (raw !== null) return JSON.parse(raw) as Progress;
  } catch {
    // Storage blocked or corrupt: start fresh; the chain is what matters.
  }
  return { txs: {} };
}

function save(account: string, p: Progress) {
  try {
    window.localStorage.setItem(`${STORAGE}.${account.toLowerCase()}`, JSON.stringify(p));
  } catch {
    // A private window can refuse storage; progress then lasts only for this tab.
  }
}

const LASNA_ID = 5_318_007 as const;
const BASE_ID = 84_532 as const;
type SupportedId = typeof LASNA_ID | typeof BASE_ID;

const REACTIVE_FUND = "0.5"; // lREACT sent with the deploy, so the first reactions are paid for
const TILL_FUND = "0.0005"; // Base Sepolia ETH for the callback proxy

// ---------------------------------------------------------------- wizard

function Wizard() {
  const connection = useConnection();
  const connectors = useConnectors();
  const { connect, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<Progress>({ txs: {} });
  const [policy, setPolicy] = useState<Policy>({ treasury: "", taxPct: "20", team: "", teamPct: "0" });
  const [amount, setAmount] = useState("1.00");
  const [busy, setBusy] = useState<StepKey | null>(null);
  const [problem, setProblem] = useState<{ step: StepKey; p: Problem } | null>(null);
  const account = connection.address;

  useEffect(() => {
    setHasWallet(typeof window !== "undefined" && "ethereum" in window && window.ethereum !== undefined);
  }, []);

  useEffect(() => {
    if (account === undefined) return;
    setProgress(load(account));
    setPolicy((p) => (p.treasury === "" ? { ...p, treasury: account } : p));
  }, [account]);

  const update = useCallback(
    (fn: (p: Progress) => Progress) => {
      setProgress((prev) => {
        const next = fn(prev);
        if (account !== undefined) save(account, next);
        return next;
      });
    },
    [account],
  );

  if (hasWallet === null) return <div className="sheet sheet-pad h-[180px]" aria-hidden="true" />;

  const injectedConnector = connectors[0];
  if (account === undefined) {
    if (!hasWallet) {
      return <WalletNotice kind="no-wallet" />;
    }
    return (
      <div className="sheet sheet-pad">
        <h2 className="t-title m-0">Connect the wallet that will own it</h2>
        <p className="t-small mt-2 max-w-[34em] text-ink-2">
          The wallet you connect owns the new contracts: it creates invoices and policies. You need some lREACT on Lasna
          and a little Base Sepolia ETH; both come from faucets.
        </p>
        <button
          type="button"
          className="btn mt-5"
          disabled={connecting || injectedConnector === undefined}
          onClick={() => injectedConnector !== undefined && connect({ connector: injectedConnector })}
        >
          {connecting ? "Waiting for your wallet" : "Connect wallet"}
        </button>
        {connectError === null ? null : (
          <p className="t-small mt-3 text-red" role="alert">
            {/rejected|denied/i.test(connectError.message)
              ? "You declined the connection."
              : connectError.message.split("\n")[0]}
          </p>
        )}
      </div>
    );
  }

  const owner = getAddress(account);
  const predictedFactory = predictFactory(payAddressFactoryBytecode, owner);

  /** Runs one step: switch network, send, wait, and turn every failure into a state the page can explain. */
  async function run(
    step: StepKey,
    chainId: SupportedId,
    send: () => Promise<Hex>,
    after: (hash: Hex) => Promise<void>,
  ) {
    setProblem(null);
    setBusy(step);
    try {
      if (connection.chainId !== chainId) {
        try {
          await switchChain(wagmiConfig, { chainId });
        } catch {
          setProblem({ step, p: { kind: "wrong-network", chainId } });
          return;
        }
      }
      const hash = await send();
      update((p) => ({ ...p, txs: { ...p.txs, [step]: { chainId, hash } } }));
      try {
        const receipt = await waitForTransactionReceipt(wagmiConfig, {
          hash,
          chainId,
          timeout: 120_000,
        });
        if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
        await after(hash);
      } catch (err) {
        // A hash the network has never heard of after two minutes is the Smart Transactions failure mode.
        if (chainId === LASNA.id) {
          const tx = await getTransaction(wagmiConfig, { hash, chainId: LASNA_ID }).catch(() => null);
          if (tx === null) {
            setProblem({ step, p: { kind: "smart-transactions" } });
            return;
          }
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof SkipStep) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (/smart transaction/i.test(msg)) setProblem({ step, p: { kind: "smart-transactions" } });
      else if (/rejected|denied|user cancel/i.test(msg)) setProblem({ step, p: { kind: "rejected" } });
      else if (/insufficient funds/i.test(msg)) setProblem({ step, p: { kind: "funds", chainId } });
      else setProblem({ step, p: { kind: "error", message: msg.split("\n")[0] ?? msg } });
    } finally {
      setBusy(null);
    }
  }

  const deployReactive = () =>
    run(
      "reactive",
      LASNA_ID,
      async () => {
        const bal = await getBalance(wagmiConfig, { address: owner, chainId: LASNA_ID });
        if (bal.value < parseEther(REACTIVE_FUND) + parseEther("0.05")) {
          throw new Error(`insufficient funds: needs ${REACTIVE_FUND} lREACT plus gas`);
        }
        return deployContract(wagmiConfig, {
          abi: daybookReactiveAbi,
          bytecode: daybookReactiveBytecode,
          args: [owner, predictedFactory, BigInt(LASNA.cron100)],
          value: parseEther(REACTIVE_FUND),
          chainId: LASNA_ID,
        });
      },
      async (hash) => {
        const r = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: LASNA_ID });
        if (r.contractAddress === null || r.contractAddress === undefined)
          throw new Error("No contract address in the receipt.");
        const reactive = getAddress(r.contractAddress);
        update((p) => ({ ...p, reactive }));
      },
    );

  const deployFactory = () =>
    run(
      "factory",
      BASE_ID,
      async () => {
        const code = await getBytecode(wagmiConfig, { address: predictedFactory, chainId: BASE_ID });
        if (code !== undefined && code !== "0x") {
          // Already there from an earlier run with this owner: nothing to send.
          update((p) => ({ ...p, factory: predictedFactory }));
          throw new SkipStep();
        }
        const init = concat([payAddressFactoryBytecode, encodeAbiParameters([{ type: "address" }], [owner])]);
        return sendTransaction(wagmiConfig, {
          to: CREATE2_DEPLOYER,
          data: concat([FACTORY_SALT, init]),
          chainId: BASE_ID,
        });
      },
      async () => {
        update((p) => ({ ...p, factory: predictedFactory }));
      },
    );

  const deployTill = () =>
    run(
      "till",
      BASE_ID,
      async () => {
        if (progress.reactive === undefined) throw new Error("Deploy the contract on Lasna first.");
        return deployContract(wagmiConfig, {
          abi: daybookTillAbi,
          bytecode: daybookTillBytecode,
          args: [BASE_SEPOLIA.callbackProxy, progress.reactive, predictedFactory, owner],
          value: parseEther(TILL_FUND),
          chainId: BASE_ID,
        });
      },
      async (hash) => {
        const r = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: BASE_ID });
        if (r.contractAddress === null || r.contractAddress === undefined)
          throw new Error("No contract address in the receipt.");
        const till = getAddress(r.contractAddress);
        update((p) => ({ ...p, till }));
      },
    );

  const authorize = () =>
    run(
      "authorize",
      BASE_ID,
      () =>
        writeContract(wagmiConfig, {
          address: predictedFactory,
          abi: payAddressFactoryAbi,
          functionName: "setTill",
          args: [progress.till as Address, true],
          chainId: BASE_ID,
        }),
      async () => undefined,
    );

  const setCap = () =>
    run(
      "cap",
      BASE_ID,
      () =>
        writeContract(wagmiConfig, {
          address: progress.till as Address,
          abi: daybookTillAbi,
          functionName: "setMaxSettlement",
          args: [BASE_SEPOLIA.usdc, 20_000_000n],
          chainId: BASE_ID,
        }),
      async () => undefined,
    );

  const wire = () =>
    run(
      "wire",
      LASNA_ID,
      () =>
        writeContract(wagmiConfig, {
          address: progress.reactive as Address,
          abi: daybookReactiveAbi,
          functionName: "setTill",
          args: [BigInt(BASE_SEPOLIA.id), progress.till as Address],
          chainId: LASNA_ID,
        }),
      async () => undefined,
    );

  const policyError = validatePolicy(policy);
  const createPolicy = () =>
    run(
      "policy",
      LASNA_ID,
      () => {
        if (policyError !== null) throw new Error(policyError);
        const team =
          policy.team.trim() === ""
            ? []
            : [{ account: getAddress(policy.team.trim()), bps: Math.round(Number(policy.teamPct) * 100) }];
        return writeContract(wagmiConfig, {
          address: progress.reactive as Address,
          abi: daybookReactiveAbi,
          functionName: "createPolicy",
          args: [getAddress(policy.treasury.trim()), Math.round(Number(policy.taxPct) * 100), team],
          chainId: LASNA_ID,
        });
      },
      async () => {
        update((p) => ({ ...p, policyId: (p.policyId ?? 0) + 1 }));
      },
    );

  const amountUnits = /^\d{1,7}(\.\d{1,6})?$/.test(amount) ? BigInt(Math.round(Number(amount) * 1e6)) : null;
  const createInvoice = () =>
    run(
      "invoice",
      LASNA_ID,
      () => {
        if (amountUnits === null || amountUnits === 0n) throw new Error("Enter an amount such as 1.00");
        return writeContract(wagmiConfig, {
          address: progress.reactive as Address,
          abi: daybookReactiveAbi,
          functionName: "createInvoice",
          args: [
            {
              amount: amountUnits,
              dueAt: 0n,
              expiresAt: 0n,
              policyId: progress.policyId ?? 1,
              watchAllTokens: false,
              detailsHash: `0x${"0".repeat(64)}`,
              accepted: [{ chainId: BigInt(BASE_SEPOLIA.id), token: BASE_SEPOLIA.usdc, decimals: 6 }],
            },
          ],
          chainId: LASNA_ID,
        });
      },
      async () => {
        update((p) => ({ ...p, invoiceId: String(Number(p.invoiceId ?? "0") + 1) }));
      },
    );

  const done = {
    reactive: progress.reactive !== undefined,
    factory: progress.factory !== undefined,
    till: progress.till !== undefined,
    authorize: progress.txs.authorize !== undefined,
    cap: progress.txs.cap !== undefined,
    wire: progress.txs.wire !== undefined,
    policy: progress.policyId !== undefined,
    invoice: progress.invoiceId !== undefined,
  };

  const steps: {
    key: StepKey;
    title: string;
    where: string;
    body: ReactNode;
    ready: boolean;
    act: () => void;
    label: string;
  }[] = [
    {
      key: "reactive",
      title: "Deploy DaybookReactive",
      where: LASNA.name,
      ready: true,
      act: deployReactive,
      label: "Deploy on Lasna",
      body: (
        <>
          The contract that holds your invoices and ledger. It is funded with {REACTIVE_FUND} lREACT so the network can
          bill its reactions. Your pay-address factory will live at{" "}
          <span className="num">{shortHex(predictedFactory)}</span> on every payment chain, so it is set now.{" "}
          <a href={LASNA.faucet} target="_blank" rel="noreferrer">
            Get lREACT
          </a>
        </>
      ),
    },
    {
      key: "factory",
      title: "Deploy the pay-address factory",
      where: BASE_SEPOLIA.name,
      ready: done.reactive,
      act: deployFactory,
      label: "Deploy factory",
      body: "Sent through the standard CREATE2 deployer, so it lands at the same address on every chain you add later.",
    },
    {
      key: "till",
      title: "Deploy your till",
      where: BASE_SEPOLIA.name,
      ready: done.factory,
      act: deployTill,
      label: "Deploy till",
      body: `It sweeps pay addresses and splits the money when your contract asks. Funded with ${TILL_FUND} ETH for callback fees.`,
    },
    {
      key: "authorize",
      title: "Let the till sweep pay addresses",
      where: BASE_SEPOLIA.name,
      ready: done.till,
      act: authorize,
      label: "Authorize till",
      body: "The factory only moves money for tills you approve.",
    },
    {
      key: "cap",
      title: "Set the largest settlement",
      where: BASE_SEPOLIA.name,
      ready: done.authorize,
      act: setCap,
      label: "Set 20 USDC cap",
      body: "A till refuses to settle a token without a cap. This sets 20 test USDC, enough for the demo.",
    },
    {
      key: "wire",
      title: "Point your contract at the till",
      where: LASNA.name,
      ready: done.cap,
      act: wire,
      label: "Wire on Lasna",
      body: "Your contract subscribes to the till's Settled event, which is how a loop is acknowledged.",
    },
    {
      key: "policy",
      title: "Create a split policy",
      where: LASNA.name,
      ready: done.wire,
      act: createPolicy,
      label: "Create policy",
      body: <PolicyForm policy={policy} onChange={setPolicy} error={policyError} />,
    },
    {
      key: "invoice",
      title: "Issue your first invoice",
      where: LASNA.name,
      ready: done.policy,
      act: createInvoice,
      label: "Create invoice",
      body: <AmountField amount={amount} onChange={setAmount} />,
    },
  ];

  const firstOpen = steps.findIndex((s) => !done[s.key]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="t-small m-0">
          Owner <span className="num">{shortHex(owner)}</span>
          {connection.chain === undefined ? " on an unsupported network" : ` on ${connection.chain.name}`}
        </p>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>

      <ol className="m-0 list-none border-t-2 border-ink p-0">
        {steps.map((s, i) => {
          const isDone = done[s.key];
          const isCurrent = i === firstOpen;
          const tx = progress.txs[s.key];
          const prob = problem?.step === s.key ? problem.p : null;
          return (
            <li
              key={s.key}
              className="grid grid-cols-[2.2em_1fr] gap-x-3 border-b border-rule py-5"
              aria-current={isCurrent ? "step" : undefined}
            >
              <span
                className={`num text-[14px] leading-7 ${isDone ? "text-ink" : isCurrent ? "text-red" : "text-ink-3"}`}
              >
                {isDone ? "✓" : `${i + 1}`}
              </span>
              <div>
                <h3 className={`m-0 text-[19px] leading-7 ${isDone || isCurrent ? "text-ink" : "text-ink-2"}`}>
                  {s.title}
                  <span className="t-meta ml-2">{s.where}</span>
                </h3>
                {isCurrent || isDone ? <div className="t-small mt-1 max-w-[40em] text-ink-2">{s.body}</div> : null}
                {tx === undefined ? null : (
                  <div className="mt-2">
                    <TxLink chainId={tx.chainId} hash={tx.hash} />
                  </div>
                )}
                {isCurrent && s.ready ? (
                  <button type="button" className="btn mt-4" onClick={s.act} disabled={busy !== null}>
                    {busy === s.key ? "Confirm in your wallet, then wait" : s.label}
                    {busy === s.key ? <span className="caret bg-paper!" aria-hidden="true" /> : null}
                  </button>
                ) : null}
                {prob === null ? null : (
                  <div className="mt-4">
                    <ProblemNotice p={prob} retry={s.act} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {done.invoice && progress.reactive !== undefined ? (
        <div className="slip">
          <p className="m-0 text-[17px] leading-7">Your Daybook is live on Lasna and Base Sepolia</p>
          <p className="t-small m-0 mt-2 text-ink-2">
            Invoice {progress.invoiceId} pays to{" "}
            <span className="num text-ink">
              {payAddress(predictedFactory, progress.reactive, BigInt(progress.invoiceId ?? "1"))}
            </span>{" "}
            on Base Sepolia. Send it test USDC from any wallet and watch your contract on{" "}
            <a href={`${LASNA.explorer}/address/${progress.reactive}`} target="_blank" rel="noreferrer">
              Reactscan
            </a>
            .
          </p>
        </div>
      ) : null}
    </div>
  );
}

function validatePolicy(p: Policy): string | null {
  if (!isAddress(p.treasury.trim())) return "The treasury must be an address.";
  const tax = Number(p.taxPct);
  if (!Number.isFinite(tax) || tax < 0 || tax > 100) return "Tax must be between 0 and 100%.";
  const hasTeam = p.team.trim() !== "";
  if (hasTeam && !isAddress(p.team.trim())) return "The team member must be an address.";
  const team = hasTeam ? Number(p.teamPct) : 0;
  if (hasTeam && (!Number.isFinite(team) || team <= 0)) return "Give the team member a share above 0%.";
  if (tax + team > 100) return "Tax and team together can be at most 100%.";
  return null;
}

function PolicyForm({
  policy,
  onChange,
  error,
}: {
  policy: Policy;
  onChange: (p: Policy) => void;
  error: string | null;
}) {
  const id = useId();
  const field = (k: keyof Policy, label: string, mono = false, hint?: string) => (
    <label htmlFor={`${id}-${k}`} className="grid gap-1">
      <span className="t-label">{label}</span>
      <input
        id={`${id}-${k}`}
        className={`field ${mono ? "mono" : ""}`}
        value={policy[k]}
        inputMode={mono ? "text" : "decimal"}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange({ ...policy, [k]: e.target.value })}
      />
      {hint === undefined ? null : <span className="t-meta">{hint}</span>}
    </label>
  );
  return (
    <div className="mt-3 grid gap-4">
      {field("treasury", "Treasury, gets the rest", true)}
      <div className="grid gap-4 sm:grid-cols-[1fr_8em]">
        {field("team", "Team member, optional", true)}
        {field("teamPct", "Their share, %")}
      </div>
      <div className="max-w-[10em]">{field("taxPct", "Tax set aside, %")}</div>
      {error === null ? null : (
        <p className="m-0 text-red" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AmountField({ amount, onChange }: { amount: string; onChange: (a: string) => void }) {
  const id = useId();
  return (
    <label htmlFor={id} className="mt-3 grid max-w-[14em] gap-1">
      <span className="t-label">Amount, USDC on Base Sepolia</span>
      <input
        id={id}
        className="field mono"
        value={amount}
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ProblemNotice({ p, retry }: { p: Problem; retry: () => void }) {
  const again = (
    <button type="button" className="btn btn-small" onClick={retry}>
      Send it again
    </button>
  );
  switch (p.kind) {
    case "wrong-network":
      return (
        <WalletNotice
          kind="wrong-network"
          network={p.chainId === LASNA.id ? lasnaChain.name : baseSepolia.name}
          action={
            <button type="button" className="btn btn-small" onClick={retry}>
              Switch and continue
            </button>
          }
        />
      );
    case "smart-transactions":
      return <WalletNotice kind="smart-transactions" action={again} />;
    case "rejected":
      return <p className="t-small m-0 text-ink-2">You declined it in your wallet. Nothing was sent.</p>;
    case "funds":
      return (
        <p className="t-small m-0 text-red" role="alert">
          Not enough {p.chainId === LASNA.id ? "lREACT" : "Base Sepolia ETH"} for this step.{" "}
          {p.chainId === LASNA.id ? (
            <a href={LASNA.faucet} target="_blank" rel="noreferrer">
              Get lREACT from the faucet
            </a>
          ) : (
            "Top up from a Base Sepolia faucet."
          )}{" "}
          Needs {p.chainId === LASNA.id ? `${REACTIVE_FUND} lREACT plus gas` : `${TILL_FUND} ETH plus gas`}, balance
          shown in your wallet.
        </p>
      );
    default:
      return (
        <p className="t-small m-0 text-red" role="alert">
          {p.message}
        </p>
      );
  }
}
