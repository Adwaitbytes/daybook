import { chainName } from "./chains";
import { formatAmount } from "./format";
import type { Hop, InvoiceSnapshot, LedgerLine } from "./types";

export type PayPhase = "waiting" | "part-paid" | "payment-seen" | "settled" | "expired" | "cancelled";
export type StationState = "todo" | "now" | "done" | "void";
export type StationKey = "payment" | "match" | "settlement";

export type Station = {
  key: StationKey;
  /** Where it happens, e.g. "Base Sepolia" or "Reactive". */
  place: string;
  title: string;
  state: StationState;
  at: number | null;
  hop: Hop | null;
};

export type DerivedStatus = {
  phase: PayPhase;
  received: bigint;
  remaining: bigint;
  overdue: boolean;
  /** Transfers that reached the pay address but do not count: wrong token, or arrived after close. */
  flagged: LedgerLine[];
  late: LedgerLine[];
  stations: [Station, Station, Station];
  /** Origin transfer to settlement callback, only when both clocks are known. */
  loopMs: number | null;
  settledAt: number | null;
};

function latest<T>(xs: T[], at: (x: T) => number | null): T | undefined {
  let best: T | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    const t = at(x) ?? Number.NEGATIVE_INFINITY;
    if (best === undefined || t >= bestAt) {
      best = x;
      bestAt = t;
    }
  }
  return best;
}

/**
 * What the pay page shows, from chain state alone. `Paid` on chain only means the payment was seen; the page
 * says "Payment seen" then and stamps Paid only when the invoice is `Settled` (every settlement acknowledged).
 */
export function deriveStatus(s: InvoiceSnapshot): DerivedStatus {
  const amount = BigInt(s.amount);
  const received = BigInt(s.paid);
  const remaining = amount > received ? amount - received : 0n;
  const payments = s.entries.filter((e) => e.kind === "Payment");
  const flagged = s.entries.filter((e) => e.kind === "WrongToken");
  const late = s.entries.filter((e) => e.kind === "Late" || e.kind === "Orphaned");

  let phase: PayPhase;
  switch (s.status) {
    case "Settled":
      phase = "settled";
      break;
    case "Paid":
      phase = "payment-seen";
      break;
    case "Cancelled":
      phase = "cancelled";
      break;
    case "Expired":
      phase = "expired";
      break;
    default:
      phase = received > 0n ? "part-paid" : "waiting";
  }

  const lastPayment = latest(payments, (e) => e.originAt);
  const covered = phase === "payment-seen" || phase === "settled";
  const closedEarly = phase === "expired" || phase === "cancelled";
  const originPlace = lastPayment !== undefined ? chainName(lastPayment.chainId) : acceptedPlace(s);

  const payment: Station = {
    key: "payment",
    place: originPlace,
    title:
      phase === "waiting"
        ? "Waiting for a transfer"
        : phase === "part-paid"
          ? `Received ${formatAmount(received)} of ${formatAmount(amount)}`
          : closedEarly && received === 0n
            ? "No transfer arrived"
            : `Transfer of ${formatAmount(received)} seen`,
    state: covered ? "done" : closedEarly ? (received > 0n ? "done" : "void") : received > 0n ? "now" : "now",
    at: lastPayment?.originAt ?? null,
    hop:
      lastPayment === undefined
        ? null
        : {
            chainId: lastPayment.chainId,
            tx: lastPayment.originTx,
            at: lastPayment.originAt,
            clock: lastPayment.originClock ?? "s",
          },
  };

  const match: Station = {
    key: "match",
    place: "Reactive",
    title: covered ? "Matched, invoice covered" : closedEarly ? "Not matched" : "Match the payment to this invoice",
    state: covered ? "done" : closedEarly ? "void" : "todo",
    at: covered ? (lastPayment?.reactive?.at ?? null) : null,
    hop: covered ? (lastPayment?.reactive ?? null) : null,
  };

  const lastCallback = latest(
    s.settlements.filter((x) => x.callback !== null),
    (x) => x.callback?.at ?? null,
  );
  const settlePlace = lastCallback !== undefined ? chainName(lastCallback.chainId) : originPlace;
  const settlement: Station = {
    key: "settlement",
    place: settlePlace,
    title:
      phase === "settled"
        ? "Settled: receipt issued, tax and team paid"
        : phase === "payment-seen"
          ? "Settling: sweep, split and receipt"
          : closedEarly
            ? "Nothing to settle for this invoice"
            : "Sweep, split and issue the receipt",
    state: phase === "settled" ? "done" : phase === "payment-seen" ? "now" : closedEarly ? "void" : "todo",
    at: phase === "settled" ? (lastCallback?.callback?.at ?? null) : null,
    hop: phase === "settled" ? (lastCallback?.callback ?? null) : null,
  };

  const loopMs =
    phase === "settled" && payment.at !== null && settlement.at !== null && payment.hop?.clock === "ms"
      ? settlement.at - payment.at
      : null;

  return {
    phase,
    received,
    remaining,
    overdue: s.overdue,
    flagged,
    late,
    stations: [payment, match, settlement],
    loopMs,
    settledAt: settlement.at,
  };
}

function acceptedPlace(s: InvoiceSnapshot): string {
  const names = [...new Set(s.accepted.map((a) => chainName(a.chainId)))];
  return names.length === 1 ? (names[0] ?? "") : "Any accepted chain";
}
