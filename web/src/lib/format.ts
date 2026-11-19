/** Invoice amounts are stored in 6-decimal units (DaybookReactive.INVOICE_DECIMALS). */
export const INVOICE_DECIMALS = 6;

/** Formats a raw token amount with grouping and a fixed number of fraction digits, truncating (never rounding up). */
export function formatUnitsFixed(raw: bigint, decimals: number, fraction = 2): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0");
  frac = fraction === 0 ? "" : frac.slice(0, fraction).padEnd(fraction, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction === 0 ? "" : `.${frac}`}`;
}

/** USDC-style amount in invoice units, with as many decimals as needed to be exact (at least two). */
export function formatAmount(units: bigint, decimals = INVOICE_DECIMALS): string {
  const exact = formatUnitsFixed(units, decimals, decimals);
  const [whole, frac = ""] = exact.split(".");
  const trimmed = frac.replace(/0+$/, "");
  return `${whole}.${trimmed.padEnd(2, "0")}`;
}

/** Converts invoice units (6 decimals) to a token's raw units. */
export function toTokenUnits(invoiceUnits: bigint, tokenDecimals: number): bigint {
  if (tokenDecimals >= INVOICE_DECIMALS) return invoiceUnits * 10n ** BigInt(tokenDecimals - INVOICE_DECIMALS);
  return invoiceUnits / 10n ** BigInt(INVOICE_DECIMALS - tokenDecimals);
}

export function shortHex(hex: string, head = 6, tail = 4): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "19 Nov 2026" in UTC, so server and client render the same string. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "14:02:07" in UTC. */
export function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/** "19 Nov 2026, 14:02 UTC". */
export function formatDateTime(ms: number): string {
  return `${formatDate(ms)}, ${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** Elapsed time between two stamps: "+1.4 s", "+52 s", "+3 min". */
export function formatElapsed(ms: number): string {
  if (ms < 0) return "+0 s";
  if (ms < 10_000) return `+${(ms / 1000).toFixed(1)} s`;
  if (ms < 120_000) return `+${Math.round(ms / 1000)} s`;
  if (ms < 7_200_000) return `+${Math.round(ms / 60_000)} min`;
  return `+${(ms / 3_600_000).toFixed(1)} h`;
}

/** "3 days", "5 h", "12 min" for running-since style durations. */
export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
