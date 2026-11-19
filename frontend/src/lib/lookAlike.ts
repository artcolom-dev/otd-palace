// Two cards of one player can be on sale with the same rating, rarity and price: two rows that read the same, which
// looks like a mistake. They are different cards, so each such row shows its mint number ("#169") to tell them apart.
import type { Deal } from "../data/types";

type Seen = Pick<Deal, "listing_id" | "player_id" | "sport" | "season" | "rarity" | "rating" | "price" | "mint">;

/** The listing ids of the rows that read the same as another row and have a mint number to show. */
export function lookAlikes(rows: readonly Seen[]): Set<number> {
  const groups = new Map<string, number[]>();
  for (const d of rows) {
    if (d.mint === null) continue;
    const key = `${d.sport}|${d.player_id}|${d.season}|${d.rarity}|${d.rating}|${d.price}`;
    const ids = groups.get(key);
    if (ids) ids.push(d.listing_id);
    else groups.set(key, [d.listing_id]);
  }
  const out = new Set<number>();
  for (const ids of groups.values()) if (ids.length > 1) for (const id of ids) out.add(id);
  return out;
}
