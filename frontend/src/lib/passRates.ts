// A pass's build rate and the accepted offers measured on its cards: the browser's twin of advisor/pass_rates.py. The
// feed sends, once its switch is on, the cheapest (bucket, rarity) cell with 5 listing sales (`rate_build`: what a
// rating point costs to build), the bucket `rate_traded` comes from, and the accepted-offer rates measured on enough
// offers (advisor/snapshot.py _build_json). A pass served without them is priced exactly as before. Pure.
//
// Why: `rate_traded` is the median of one bucket's listing sales, which one rarity can carry far above what a build
// buys (one pass's over-7 bucket sold at 164 a point on Mystic sales while its Legendary cards sold at 29); and offers
// can clear far below listings (about 9 a point against 35) or above them (about 30 against 20)
// (the internal research notes).
import type { PassBucket, PassMarket, PassOfferCell } from "../data/types";

export const PASS_BUCKETS: readonly PassBucket[] = ["0-3", "3-5", "5-7", "7+"];
export const PASS_RARITIES = ["general", "common", "uncommon", "rare", "epic", "legendary", "mystic", "iconic"] as const;

type RateFields = Pick<PassMarket, "rate_traded" | "rate_sales"> &
  Partial<Pick<PassMarket, "rate_build" | "rate_build_from" | "rate_bucket" | "offers">>;

export interface BuildRate {
  rate: number | null; // null: the pass cannot be priced
  thin: boolean; // the feed measured the pass and no cell had enough sales: `rate_traded` stands in, less certain
  bucket: PassBucket | null; // the cell's bucket (or `rate_traded`'s), when known
  rarity: string | null; // the cell's rarity; null without a build cell
  sales: number; // the sales behind the rate: the cell's, else `rate_traded`'s
}

/** advisor/pass_rates.py build_rate: `rate_build` when the feed found a cell, else `rate_traded` as before (thin when
 * the feed sent a null `rate_build`: measured, but no cell has enough sales). */
export function buildRate(m: RateFields): BuildRate {
  if (typeof m.rate_build === "number") {
    const from = m.rate_build_from ?? null;
    return { rate: m.rate_build, thin: false, bucket: from?.bucket ?? null, rarity: from?.rarity ?? null, sales: from?.sales ?? 0 };
  }
  return { rate: m.rate_traded, thin: m.rate_build === null && m.rate_traded !== null, bucket: m.rate_bucket ?? null, rarity: null, sales: m.rate_sales };
}

/** advisor/pass_rates.py bucket_of: the feed's value bucket of a rating, by its size; null for 0. */
export function passBucket(rating: number): PassBucket | null {
  const r = Math.abs(rating);
  if (r === 0) return null;
  return r <= 3 ? "0-3" : r <= 5 ? "3-5" : r <= 7 ? "5-7" : "7+";
}

/** A card's rarity, 0 (General) to 7 (Iconic), by its name; null out of range. */
export const rarityName = (n: number): string | null => PASS_RARITIES[n] ?? null;

export interface OfferCell {
  rate: number; // the rate a point accepted offers cleared at
  offers: number; // how many
  listing: number | null; // the same cell's listing rate a point; null under 5 listing sales
}

/** The accepted offers measured for a cell: the rarity's in that bucket, else the whole bucket's; null when neither
 * rests on enough offers (the server serves only those that do) or the pass was not measured. */
export function offerCell(m: Pick<RateFields, "offers">, bucket: PassBucket | null, rarity: string | null): OfferCell | null {
  if (!m.offers || bucket === null) return null;
  const find = (r: string | null) => m.offers!.find(([b, rr]) => b === bucket && rr === r);
  const cell = (rarity !== null ? find(rarity) : undefined) ?? find(null);
  return cell ? { rate: cell[2], offers: cell[3], listing: cell[4] } : null;
}

const isRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100_000_000;
const isCount = (v: unknown, low: number): v is number => Number.isInteger(v) && (v as number) >= low && (v as number) <= 1_000_000;
const isBucket = (v: unknown): v is PassBucket => typeof v === "string" && (PASS_BUCKETS as readonly string[]).includes(v);
const isRarity = (v: unknown): v is string => typeof v === "string" && (PASS_RARITIES as readonly string[]).includes(v);

function isOfferCell(c: unknown): c is PassOfferCell {
  return (
    Array.isArray(c) && c.length === 5 && isBucket(c[0]) && (c[1] === null || isRarity(c[1])) && isRate(c[2]) &&
    isCount(c[3], 1) && (c[4] === null || isRate(c[4]))
  );
}

/**
 * A stored market's new fields, each kept only when it fits (a device's storage is not trusted), and never its live
 * auctions: the cards on sale when it was kept are not the cards on sale now (lib/passes.ts toStored).
 */
export function cleanBuildFields<T extends RateFields & { auctions?: unknown }>(m: T): T {
  const { rate_bucket, rate_build, rate_build_from, offers, auctions: _a, ...rest } = m;
  const out = rest as T;
  if (rate_bucket === null || isBucket(rate_bucket)) out.rate_bucket = rate_bucket;
  // `rate_build` and its cell stand or fall together, as on the server.
  const from = rate_build_from as Record<string, unknown> | null | undefined;
  if (rate_build === null && (from === null || from === undefined)) {
    out.rate_build = null;
    if (from === null) out.rate_build_from = null;
  } else if (isRate(rate_build) && from && isBucket(from.bucket) && isRarity(from.rarity) && isCount(from.sales, 5)) {
    out.rate_build = rate_build;
    out.rate_build_from = { bucket: from.bucket, rarity: from.rarity, sales: from.sales };
  }
  if (Array.isArray(offers) && offers.every(isOfferCell)) out.offers = offers;
  return out;
}
