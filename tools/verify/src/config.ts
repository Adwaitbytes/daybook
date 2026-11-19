import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, getAddress } from "viem";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const EVIDENCE = join(REPO, "evidence");
export const DOCS = join(REPO, "docs");
export const CACHE_DIR = join(REPO, "tools", "verify", ".cache");
export const LOOPS_CSV = join(EVIDENCE, "loops.csv");
export const SUMMARY_JSON = join(EVIDENCE, "summary.json");
export const REPORT_JSON = join(EVIDENCE, "verify-report.json");
export const SITE = "https://daybook-omni.vercel.app";

export type ChainConfig = {
  id: number;
  name: string;
  /** Public endpoints, tried in order; a failing endpoint hands the request to the next. */
  rpcs: string[];
  /** eth_getLogs block span every listed provider accepts. */
  logSpan: bigint;
  /** Resolution of the chain's own block clock. Base Sepolia serves `timestampMs`; the others whole seconds. */
  clock: "ms" | "s";
  /** Requests in flight per endpoint. */
  concurrency: number;
  explorerTx: string;
  explorerAddress: string;
};

export const LASNA: ChainConfig = {
  id: 5_318_007,
  name: "Reactive Lasna",
  rpcs: ["https://lasna-rpc.rnk.dev/"],
  logSpan: 30_000n,
  clock: "s",
  concurrency: 6,
  explorerTx: "https://lasna.reactscan.net/tx/",
  explorerAddress: "https://lasna.reactscan.net/address/",
};

export const BASE_SEPOLIA: ChainConfig = {
  id: 84_532,
  name: "Base Sepolia",
  // Only sepolia.base.org: every Base latency rests on its `timestampMs` field, and a provider that drops it would
  // turn a clock check into a false mismatch.
  rpcs: ["https://sepolia.base.org"],
  logSpan: 200n,
  clock: "ms",
  concurrency: 8,
  explorerTx: "https://sepolia.basescan.org/tx/",
  explorerAddress: "https://sepolia.basescan.org/address/",
};

export const UNICHAIN_SEPOLIA: ChainConfig = {
  id: 1301,
  name: "Unichain Sepolia",
  rpcs: ["https://sepolia.unichain.org", "https://unichain-sepolia-rpc.publicnode.com"],
  logSpan: 1_000n,
  clock: "s",
  concurrency: 6,
  explorerTx: "https://unichain-sepolia.blockscout.com/tx/",
  explorerAddress: "https://unichain-sepolia.blockscout.com/address/",
};

export const CHAINS = [LASNA, BASE_SEPOLIA, UNICHAIN_SEPOLIA] as const;
export const PAYMENT_CHAINS = [BASE_SEPOLIA, UNICHAIN_SEPOLIA] as const;

export function chain(id: number): ChainConfig {
  const c = CHAINS.find((x) => x.id === id);
  if (c === undefined) throw new Error(`unknown chain ${id}`);
  return c;
}

/** Explorer host to chain, for transaction links found in the docs. */
export const EXPLORER_HOSTS: Record<string, number> = {
  "lasna.reactscan.net": LASNA.id,
  "sepolia.basescan.org": BASE_SEPOLIA.id,
  "unichain-sepolia.blockscout.com": UNICHAIN_SEPOLIA.id,
};

export const SYSTEM_CONTRACT = getAddress("0x8888888888888888888888888888888888888888");
/** Callback proxies (ref/FACTS.md), which hold each till's callback fee reserves. */
export const CALLBACK_PROXY: Record<number, Address> = {
  [BASE_SEPOLIA.id]: getAddress("0x476F44b11F5C942c58f4c8E3d0300E5710743585"),
  [UNICHAIN_SEPOLIA.id]: getAddress("0x775c9B990ADe401060B78D0e98684eEf8d2466C1"),
};
export const USDC: Record<number, Address> = {
  [BASE_SEPOLIA.id]: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  [UNICHAIN_SEPOLIA.id]: getAddress("0x31d0220469e10c4E71834a79b1f276d740d3768F"),
};
export const DEPLOYER = getAddress("0x4d96Ec766088D952D62255227902eeEe1C58276c");
/** Lasna charges reactions at this gas price with K = 100,000 gas of system overhead (economy.md). */
export const LASNA_GAS_PRICE = 100_000_000_000n;
export const REACTION_OVERHEAD_GAS = 100_000n;

/** One reactive deployment and the payment-chain contracts it settles through. */
export type ReactiveDeployment = {
  label: "v1" | "v0";
  reactive: Address;
  deployTx: Hex;
  factory: Address;
  tills: Record<number, Address>;
};

export const V1: ReactiveDeployment = {
  label: "v1",
  reactive: getAddress("0x182BA62E240433B54136712d8840Ccc354bb78d3"),
  deployTx: "0x55634caeec6d0ec849a3f190ae50c037530ae23ffd452aa740a10ceafe9e5369",
  factory: getAddress("0xA7984241CC7596B0ED7C3b71409Bda7cf6E0D33c"),
  tills: {
    [BASE_SEPOLIA.id]: getAddress("0x4Bd6fE154dF715608eE3294BB3EcA4028703bba9"),
    [UNICHAIN_SEPOLIA.id]: getAddress("0xAea11aFA4f56f8f7952cE543Ea49421D70d5EFCf"),
  },
};

export const V0: ReactiveDeployment = {
  label: "v0",
  reactive: getAddress("0x16d3b2d6e397B9b047eaec44e3d23ac016f462f0"),
  deployTx: "0x496fbf0db541200a87ef8a1bad935d9f89cac1b931dbb704d36722a3320aecb7",
  factory: getAddress("0x76c0f35aB702D1c457766a4d9afE96dD960852C9"),
  tills: {
    [BASE_SEPOLIA.id]: getAddress("0xA4294ae5531Fc2C6d846bD2310cd242eB4e6Bda6"),
    [UNICHAIN_SEPOLIA.id]: getAddress("0xA4294ae5531Fc2C6d846bD2310cd242eB4e6Bda6"),
  },
};

export const REACTIVES = [V1, V0] as const;

/** `null`: the doc says not verified (or Sourcify failed on it). "unstated": the doc makes no claim; verify records
 * the status without comparing. */
export type SourcifyClaim = "exact_match" | "match" | null | "unstated";

/** Every contract docs/DEPLOYMENTS.md lists, with the Sourcify status it states. `null` means the doc says the
 * contract is not verified. docs.ts checks this list against the file both ways. */
export type ContractRecord = {
  name: string;
  deployment: "v1" | "v1-a" | "v0" | "fixture";
  chainId: number;
  address: Address;
  sourcify: SourcifyClaim;
};

const c = (
  name: string,
  deployment: ContractRecord["deployment"],
  chainId: number,
  address: string,
  sourcify: SourcifyClaim,
): ContractRecord => ({ name, deployment, chainId, address: getAddress(address), sourcify });

const B = BASE_SEPOLIA.id;
const U = UNICHAIN_SEPOLIA.id;
const L = LASNA.id;

export const CONTRACTS: readonly ContractRecord[] = [
  c("DaybookReactive", "v1", L, "0x182BA62E240433B54136712d8840Ccc354bb78d3", "exact_match"),
  c("PayAddressFactory", "v1", B, "0xA7984241CC7596B0ED7C3b71409Bda7cf6E0D33c", "exact_match"),
  c("PayAddressFactory", "v1", U, "0xA7984241CC7596B0ED7C3b71409Bda7cf6E0D33c", "exact_match"),
  c("InvoiceVault implementation", "v1", B, "0xCDE82FE77A96C255154341A6839cDEfe71f6e348", "exact_match"),
  c("InvoiceVault implementation", "v1", U, "0xCDE82FE77A96C255154341A6839cDEfe71f6e348", "exact_match"),
  c("DaybookTill", "v1", B, "0x4Bd6fE154dF715608eE3294BB3EcA4028703bba9", "exact_match"),
  c("SavingsVault", "v1", B, "0xb444ca6477cc594E35a5676d5f7ABa51E7c5CC26", "exact_match"),
  c("EasReceiptIssuer", "v1", B, "0xf36c602e30828881A9Aa46782fAB974584807e36", "exact_match"),
  c("DaybookTill", "v1", U, "0xAea11aFA4f56f8f7952cE543Ea49421D70d5EFCf", "exact_match"),
  c("SavingsVault", "v1", U, "0xc03A2Ce7cc50B940f063eA39FBbFE51bf1750668", "exact_match"),
  c("EasReceiptIssuer", "v1", U, "0x0c1eA9879bFEa9Ce280D2bdb1b7755989d2D64aE", "exact_match"),
  c("DBKTEST (MockERC20)", "fixture", B, "0xBF1Bfc97f7cf822113D41922c92910eAC925Dee7", "exact_match"),
  c("DoubleSubProbe", "fixture", L, "0x2C10E554FdAb44E2D85407457584b94c3CEebA05", null),
  c("PayAddressFactory (legacy build)", "v1-a", B, "0xAa4AaE051a408eb6DEB491A1D2523E8d69ED1D04", "exact_match"),
  c("DaybookTill", "v1-a", B, "0xAea11aFA4f56f8f7952cE543Ea49421D70d5EFCf", "exact_match"),
  c("SavingsVault", "v1-a", B, "0xc03A2Ce7cc50B940f063eA39FBbFE51bf1750668", "exact_match"),
  c("EasReceiptIssuer", "v1-a", B, "0x2edc3FC05EcaA02dB18eeF5d5C581E5Be4a3a37D", "exact_match"),
  c("PayAddressFactory (legacy build)", "v1-a", U, "0xAa4AaE051a408eb6DEB491A1D2523E8d69ED1D04", "unstated"),
  c("DaybookReactive", "v0", L, "0x16d3b2d6e397B9b047eaec44e3d23ac016f462f0", "exact_match"),
  c("PayAddressFactory", "v0", B, "0x76c0f35aB702D1c457766a4d9afE96dD960852C9", "exact_match"),
  c("PayAddressFactory", "v0", U, "0x76c0f35aB702D1c457766a4d9afE96dD960852C9", null),
  c("InvoiceVault implementation", "v0", B, "0x6fe8836e7519bb38ABB5Bcf90C699dA4E72f9D08", "exact_match"),
  c("InvoiceVault implementation", "v0", U, "0x6fe8836e7519bb38ABB5Bcf90C699dA4E72f9D08", "match"),
  c("DaybookTill", "v0", B, "0xA4294ae5531Fc2C6d846bD2310cd242eB4e6Bda6", "exact_match"),
  c("DaybookTill", "v0", U, "0xA4294ae5531Fc2C6d846bD2310cd242eB4e6Bda6", null),
  c("SavingsVault", "v0", B, "0xfAaD47FA1084B2DF56Cc9C64BE416ec9Fb90A5E4", "exact_match"),
  c("SavingsVault", "v0", U, "0xfAaD47FA1084B2DF56Cc9C64BE416ec9Fb90A5E4", null),
  c("EasReceiptIssuer", "v0", B, "0x5892a935d509ba8cD848e45a4E8Db4636Ea974Dc", "exact_match"),
  c("EasReceiptIssuer", "v0", U, "0x5892a935d509ba8cD848e45a4E8Db4636Ea974Dc", "exact_match"),
];

/** Accounts DEPLOYMENTS.md names that are not contracts: the deployer and the two test team recipients. */
export const KNOWN_ACCOUNTS: readonly Address[] = [
  DEPLOYER,
  getAddress("0xDb7e885B6b9EB7975f2E49794c09e3b0674940E2"),
  getAddress("0xb393f5064cD8072FB97dAFbC56dFEe195D78C133"),
];
