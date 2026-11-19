// The words a deal is shown in: plain, the same on every screen. "rating", never "pts"; a clock that says
// "listed 3 m ago" or "ends in 22 m"; a loss written with a real minus sign.
import type { Deal } from "../data/types";
import { formatRax } from "./format";

export { rarityClass, rarityLabel, rarityName, seasonLabel, sportLabel, sportName } from "../content/real";

const MINUTE = 60_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

export function endsText(leftMs: number): string {
  if (!Number.isFinite(leftMs)) return "";
  if (leftMs <= 0) return "ended";
  const s = Math.floor(leftMs / 1000);
  if (s >= 3600) return `ends in ${Math.floor(s / 3600)} h ${pad2(Math.floor((s % 3600) / 60))} m`;
  if (s >= 600) return `ends in ${Math.floor(s / 60)} m`;
  return `ends in ${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/**
 * A target deal's age ("listed 3 m ago"), or a bid's time left ("ends in 22 m", "ends in 4:10"). As a `sentence`
 * it opens with a capital, spells minutes out and ends with its period: "Listed 3 min ago.", "Ends in 22 min.";
 * no text, no period.
 */
export function clockText(deal: Deal, nowMs: number, sentence = false): string {
  const text = rawClock(deal, nowMs);
  if (!sentence || text === "") return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/(\d) m\b/g, "$1 min")}.`;
}

function rawClock(deal: Deal, nowMs: number): string {
  if (deal.kind === "target" && deal.listed_at) {
    const ago = nowMs - Date.parse(deal.listed_at);
    if (Number.isFinite(ago)) {
      if (ago < MINUTE) return "listed just now";
      if (ago < 60 * MINUTE) return `listed ${Math.floor(ago / MINUTE)} m ago`;
      return `listed ${Math.floor(ago / (60 * MINUTE))} h ago`;
    }
  }
  return endsText(Date.parse(deal.ends_at) - nowMs);
}

/** Reads older than this say when they were made. */
const SEEN_QUIET_MS = 2 * MINUTE;

/**
 * When a listing read earlier than the snapshot was read ("checked 12 m ago"), so a bid shown may have moved; nothing
 * for a read under 2 minutes old or one made at the snapshot's own moment.
 */
export function seenText(deal: Deal, nowMs: number): string {
  if (!deal.seen_at) return "";
  const ago = nowMs - Date.parse(deal.seen_at);
  if (!Number.isFinite(ago) || ago < SEEN_QUIET_MS) return "";
  if (ago < 60 * MINUTE) return `checked ${Math.floor(ago / MINUTE)} m ago`;
  return `checked ${Math.floor(ago / (60 * MINUTE))} h ago`;
}

/** A bid's clock: "hot" (orange) in its last minute, "soon" (bright) in its last ten; targets stay quiet. */
export function clockTone(deal: Deal, nowMs: number): "" | "soon" | "hot" {
  if (deal.kind !== "bid") return "";
  const left = Date.parse(deal.ends_at) - nowMs;
  if (left < MINUTE) return "hot";
  if (left < 10 * MINUTE) return "soon";
  return "";
}

/** Whether reselling a deal at its usual price leaves nothing after fees: still a deal, but not one to flip. */
export const noResaleProfit = (deal: { flip_margin: number }): boolean => deal.flip_margin <= 0;

/** What such a deal is, in plain words. */
export const NO_PROFIT_TEXT = "Below its usual price, but no profit to resell after fees";

/** +158, −12 (a true minus sign), 0. */
export function afterFeesText(margin: number): string {
  const r = Math.round(margin);
  if (r > 0) return `+${formatRax(r)}`;
  if (r < 0) return `−${formatRax(-r)}`;
  return "0";
}

/** Price per rating point: one decimal under 100, whole Rax from 100, a dash when the card has no rating. */
export function perPointText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value >= 100 ? formatRax(Math.round(value)) : value.toFixed(1);
}

/** A rating as the screens say it: "6.4 rating". */
export const ratingText = (rating: number) => `${rating.toFixed(1)} rating`;

/** The monogram on a drawn card: first and last initials. */
export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase();
}

/** The short name on a drawn card's strip: the last name. */
export function shortName(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/** Lower case without accents, for matching a typed name: "Jokić" -> "jokic". */
export function foldName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** "1 new deal", "3 new deals". */
export const plural = (n: number, one: string, many: string) => `${formatRax(n)} ${n === 1 ? one : many}`;

/**
 * What Real's own estimate says beside the usual price from sales, when the two differ a lot: "Real's own estimate
 * says 560, a third above what this card really sold for." Nothing otherwise.
 */
export function realEstimateText(deal: Deal): string {
  const est = deal.real_estimate;
  if (deal.ref_source !== "sales" || !est || est <= 0 || deal.reference <= 0) return "";
  const pct = Math.round((Math.abs(est - deal.reference) / deal.reference) * 100);
  const side = est > deal.reference ? "above" : "below";
  return `Real's own estimate says ${formatRax(est)}, ${pct}% ${side} what this card really sold for. We go by the sales.`;
}

/** "4 m ago", "3 h ago", "2 days ago": how long ago, in whole units. */
function agoText(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  const d = Math.floor(seconds / 86_400);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** The newest sales behind a usual price taken from sales: "420 · 400 · 380 Rax, the newest 1 h ago"; nothing when
 * there are none (a usual price taken from Real's own estimate). */
export function recentSalesText(deal: Deal): string {
  const sales = deal.recent_sales ?? [];
  if (sales.length === 0) return "";
  const prices = sales.map(([price]) => formatRax(price)).join(" · ");
  const ago = agoText(sales[0]![1]);
  return sales.length === 1 ? `${prices} Rax, ${ago}` : `${prices} Rax, the newest ${ago}`;
}
