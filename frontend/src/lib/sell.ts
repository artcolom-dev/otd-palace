// The list price helper: what a seller should ask for a card, from the usual prices the site serves and how often
// cards listed at a multiple of the usual price sold (advisor/rules.py SELL_CURVE, measured on past sales). Typical,
// never a promise.
import { bandText } from "../data/moves";
import type { Snapshot } from "../data/types";

/** One usual price: a player's cards of one season and rating band, with the sales it rests on. */
export interface UsualPrice {
  key: string;
  sport: string;
  season: number;
  player_id: number;
  player_name: string;
  bucket: string;
  band: string; // "7–9 rating"
  usual: number;
  sample: number; // the sales behind it (for "today": today's)
  /** "sales": the middle price of the last 7 days' sales; "today": the middle sale of the last 24 hours; "fmv": Real's own estimate. */
  source: "sales" | "today" | "fmv";
}

const RANK = { sales: 0, today: 1, fmv: 2 } as const;

/**
 * Every usual price the snapshot serves, one per player, season and rating band, sorted by name, then the newest
 * season, then the band. Where there are several, the sales of the week come first, then today's moves, then Real's
 * own estimate.
 */
export function usualPrices(snap: Snapshot): UsualPrice[] {
  const found = new Map<string, UsualPrice>();
  const add = (p: UsualPrice) => {
    const have = found.get(p.key);
    if (!have || RANK[p.source] < RANK[have.source]) found.set(p.key, p);
  };
  for (const d of [...snap.deals, ...snap.gone]) {
    add({
      key: `${d.sport}:${d.season}:${d.player_id}:${d.bucket}`, sport: d.sport, season: d.season, player_id: d.player_id,
      player_name: d.player_name, bucket: d.bucket, band: bandText(d.bucket), usual: d.reference, sample: d.ref_sample,
      source: d.ref_source,
    });
  }
  for (const m of [...snap.moves.risers, ...snap.moves.fallers]) {
    add({
      key: `${m.sport}:${m.season}:${m.player_id}:${m.bucket}`, sport: m.sport, season: m.season, player_id: m.player_id,
      player_name: m.player_name, bucket: m.bucket, band: bandText(m.bucket), usual: m.median_recent,
      sample: m.sales_recent, source: "today",
    });
  }
  return [...found.values()].sort(
    (a, b) =>
      a.player_name.localeCompare(b.player_name) || b.season - a.season || a.bucket.localeCompare(b.bucket, "en", { numeric: true }),
  );
}

/** What a seller keeps from a sale: the price less Real's share, less the listing fee, rounded (0.9 × price − 10). */
export const afterFees = (price: number, fee: number, listingFee: number): number =>
  Math.round(price * (1 - fee) - listingFee);

/** How often a price sells, in words: "about 99 in 100", "about 9 in 10", "about 3 in 10", "fewer than 1 in 10". */
export function chanceWords(chance: number): string {
  if (chance >= 0.95) return `about ${Math.round(chance * 100)} in 100`;
  const tenths = Math.round(chance * 10);
  return tenths < 1 ? "fewer than 1 in 10" : `about ${tenths} in 10`;
}

export interface SellBar {
  multiple: number; // the price over the usual price
  price: number;
  chance: number; // the share of cards listed at it that sold
  afterFees: number;
}

export interface SellAdvice {
  usual: number;
  list: number; // the recommended list price
  afterFees: number; // what it leaves the seller
  bars: SellBar[]; // every figure of the curve, cheapest first
}

/** The safest list price still near the usual one: the first point that sold at least this often. */
const SAFE_CHANCE = 0.95;

/** The advice for a usual price, or null without a usable price or curve. */
export function sellAdvice(usual: number, curve: readonly [number, number][], fee: number, listingFee: number): SellAdvice | null {
  if (!(usual > 0) || curve.length === 0) return null;
  const bars = [...curve]
    .sort((a, b) => a[0] - b[0])
    .map(([multiple, chance]) => {
      const price = Math.round(usual * multiple);
      return { multiple, price, chance, afterFees: afterFees(price, fee, listingFee) };
    });
  const pick = bars.find((b) => b.chance >= SAFE_CHANCE) ?? bars.reduce((a, b) => (b.chance > a.chance ? b : a));
  return { usual, list: pick.price, afterFees: pick.afterFees, bars };
}
