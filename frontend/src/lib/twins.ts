// Similar deals, for a deal that went away: a vanished deal is never a dead end. The same player-season first, then
// the same sport within the rules' price band and at least the same rating. The public deal page applies the same
// two steps on the server (advisor/share.py `twins`), so a shared link and the site agree.
import type { Deal, TwinRules } from "../data/types";

/** What a twin is looked for by: a deal, or a gone one, or the few facts an opened deal remembers (no season, no rating). */
export interface TwinSubject {
  listing_id: number;
  sport: string;
  player_id: number;
  season?: number;
  price: number;
  rating?: number;
}

const samePlayerSeason = (subject: TwinSubject, d: Deal) =>
  d.sport === subject.sport && d.player_id === subject.player_id && (subject.season === undefined || d.season === subject.season);

/**
 * Up to `limit` (the rules' maximum by default) deals like `subject` from `pool`, the best discount first within each
 * group; the nearer price, then the lower listing id, break a tie. Never the subject's own listing, and a listing that
 * is in the pool as a target and as a bid shows once, as the better of the two.
 */
export function findTwins<T extends Deal>(subject: TwinSubject, pool: readonly T[], rules: TwinRules, limit = rules.max): T[] {
  const best = new Map<number, T>();
  for (const d of pool) {
    if (d.listing_id === subject.listing_id) continue;
    const have = best.get(d.listing_id);
    if (!have || d.discount > have.discount || (d.discount === have.discount && d.price < have.price)) best.set(d.listing_id, d);
  }
  const same: T[] = [];
  const close: T[] = [];
  for (const d of best.values()) {
    if (samePlayerSeason(subject, d)) same.push(d);
    else if (
      d.sport === subject.sport &&
      Math.abs(d.price - subject.price) <= rules.price_band * subject.price &&
      (subject.rating === undefined || d.rating >= subject.rating)
    ) {
      close.push(d);
    }
  }
  same.sort((a, b) => b.discount - a.discount || a.price - b.price || a.listing_id - b.listing_id);
  close.sort(
    (a, b) =>
      b.discount - a.discount ||
      Math.abs(a.price - subject.price) - Math.abs(b.price - subject.price) ||
      a.listing_id - b.listing_id,
  );
  return [...same, ...close].slice(0, limit);
}
