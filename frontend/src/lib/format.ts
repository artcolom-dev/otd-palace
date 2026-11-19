const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const RAX = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 1234567 -> "1,234,567" */
export function formatRax(n: number): string {
  return RAX.format(n);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Time left, in its two largest units: "2d 4h", "3h 12m", "1m 05s", "45s"; "Ended" at zero or below;
 * an em dash when there is no usable time (NaN, infinity).
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "Ended";
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((ms % MINUTE_MS) / 1000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
  return `${seconds}s`;
}

/** 0.286 -> "29%" */
export function formatPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
