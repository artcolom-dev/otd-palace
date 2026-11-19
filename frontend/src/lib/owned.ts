// What the visitor already owns, as the advice needs it: each held pass's rung, by market key. A pass is a player's
// (or team's) season: the same player in another season is another market (keys "sport:season:kind:id"). A deal is a
// card of one player-season; it is "owned" when that pass is held at the card's rarity or higher, so the advice never
// recommends it and the list says so. Pure.
import type { Deal, OtdRules } from "../data/types";
import { tierName } from "../content/passWords";
import { type Holding, heldRung, realCap } from "./passes";

export interface Owned {
  tier: string;
  index: number; // the rung's place on its ladder, 0 (General) to 7 (Iconic)
  rating: number; // the rating held (within Real's rung when it names one)
  mult: number;
  cap: number | null; // Real's On This Day limit for it, when Real says
  earned: number | undefined; // all it has earned (what Real says), counted against the cap by `earnedSoFar`
  liftUnknown: boolean; // Real names a lower rung than the rating reaches: no lift price can be given
}

const KEY = /^([a-z][a-z0-9_-]{0,19}):(\d{4}):(player|team|fighter):(\d{1,12})$/;

/** The holdings' rungs by market key (Real's own rung when it names one, else what the rating reaches). */
export function ownIndex(holdings: readonly Holding[], rules: OtdRules): Map<string, Owned> {
  const out = new Map<string, Owned>();
  for (const h of holdings) {
    const m = KEY.exec(h.key);
    if (!m) continue;
    const at = heldRung(h, m[3]!, rules);
    out.set(h.key, { tier: at.tier, index: at.index, rating: at.rating, mult: at.mult, cap: realCap(h), earned: h.earned, liftUnknown: at.liftUnknown });
  }
  return out;
}

/** The pass a deal's card belongs to, if held: the player's pass of that season (a fighter's for UFC). */
export function heldFor(deal: Pick<Deal, "sport" | "season" | "player_id">, index: ReadonlyMap<string, Owned>): Owned | null {
  return (
    index.get(`${deal.sport}:${deal.season}:player:${deal.player_id}`) ??
    index.get(`${deal.sport}:${deal.season}:fighter:${deal.player_id}`) ??
    null
  );
}

/** The rung the visitor holds a deal's pass at, when it is the card's rarity or higher; else null. */
export function dealOwned(deal: Pick<Deal, "sport" | "season" | "player_id" | "rarity">, index: ReadonlyMap<string, Owned>): string | null {
  const held = heldFor(deal, index);
  return held !== null && held.index >= deal.rarity ? held.tier : null;
}

/** "You own this one at Epic". */
export const ownedText = (tier: string) => `You own this one at ${tierName(tier)}`;
