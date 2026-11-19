// What the recent listings of a player's cards say about reselling one, in plain English. Only the clear cases get
// words: 6 in 10 or more sold, or 1 in 4 or fewer. In between a tag would be noise. A count needs enough listings
// behind it, and anything that is not a clean count says nothing rather than crash the page.
import type { Resale } from "../data/types";

const MIN_LISTED = 20; // fewer than this and a share is luck: 6 of 8 happens by chance for a card that sells half the time
const WELL = 0.6;
const SLOW = 0.25;

export interface ResaleWords {
  label: string;
  line: string;
  tone: "well" | "slow";
}

export function resaleWords(resale: Resale | null | undefined): ResaleWords | null {
  if (typeof resale !== "object" || resale === null) return null;
  const { listed, sold } = resale;
  if (!Number.isInteger(listed) || !Number.isInteger(sold) || listed < MIN_LISTED || sold < 0 || sold > listed) return null;
  const share = sold / listed;
  const tone = share >= WELL ? "well" : share <= SLOW ? "slow" : null;
  if (tone === null) return null;
  return {
    label: tone === "well" ? "Resells well" : "Slow to resell",
    line: `${sold} of ${listed} recent listings sold (${Math.round(share * 100)}%)`,
    tone,
  };
}
