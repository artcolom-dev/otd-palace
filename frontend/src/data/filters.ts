import { isRarity } from "../content/real";
import { isBenched } from "../lib/injury";
import type { Prefs } from "./prefs";
import type { Deal, GoneDeal, Level } from "./types";

/** Whether a deal is one this visitor asked for: within the budget, in the chosen sport and rarity, and meeting the level's
 * discount, confidence and kinds. A level whose bid window is 0 shows no bid at all, whatever its kinds say, a
 * level that hides falling deals (New) shows none whose market fell today, and one that hides hurt players (New)
 * shows none whose player ESPN lists as out, suspended or doubtful: a price that far under usual is often the
 * injury, and the usual price is from before it. */
function fitsPrefs(deal: Deal, prefs: Prefs, level: Level): boolean {
  return fitsExceptInjury(deal, prefs, level) && !(level.hide_hurt && isBenched(deal.injury));
}

/**
 * Whether a deal is of the rarity chosen on the strip: any deal when none is chosen (a card of unknown rarity too),
 * else that rarity, or with "and rarer" that rarity and every rarer one. A card whose rarity is not one of Real's
 * eight never matches a chosen rarity; it still shows under All.
 */
export function fitsRarity(deal: Pick<Deal, "rarity">, prefs: Pick<Prefs, "rarity" | "rarer">): boolean {
  const want = prefs.rarity;
  if (!isRarity(want)) return true;
  if (!isRarity(deal.rarity)) return false;
  return prefs.rarer ? deal.rarity >= want : deal.rarity === want;
}

function fitsExceptInjury(deal: Deal, prefs: Prefs, level: Level): boolean {
  return (
    (prefs.budget === null || deal.price <= prefs.budget) &&
    (prefs.sport === "all" || deal.sport === prefs.sport) &&
    fitsRarity(deal, prefs) &&
    deal.discount >= level.min_discount &&
    level.confidence.includes(deal.confidence) &&
    level.kinds.includes(deal.kind) &&
    (deal.kind !== "bid" || level.bid_max_left_min > 0) &&
    !(level.hide_falling && deal.falling)
  );
}

/** Whether a bid's auction ends within the level's bid window, counted from `fromMs`. */
function inBidWindow(deal: Deal, level: Level, fromMs: number): boolean {
  return Date.parse(deal.ends_at) - fromMs <= level.bid_max_left_min * 60_000;
}

/**
 * The deals this visitor should see, in the server's order: not ended by the client clock (`nowMs`), within
 * the budget, in the chosen sport, and meeting the chosen level's discount, confidence and kinds. A bid also has
 * to end within the level's `bid_max_left_min` minutes, so a level whose window is 0 shows no bid at all.
 */
export function filterDeals(deals: Deal[], prefs: Prefs, levels: Record<string, Level>, nowMs: number): Deal[] {
  const level = levels[prefs.level];
  if (!level) return []; // a level the snapshot does not define shows nothing rather than everything
  return deals.filter(
    (deal) =>
      Date.parse(deal.ends_at) > nowMs && // an end time that cannot be read is not proof the deal is still on
      fitsPrefs(deal, prefs, level) &&
      (deal.kind !== "bid" || inBidWindow(deal, level, nowMs)),
  );
}

/**
 * The deals that just went away this visitor would have seen, in the server's order (newest first): the same
 * budget, sport and level rules as `filterDeals`, but no end-time check against the clock, since a deal that ended
 * is one of the things this list shows. A bid shows only if it was inside the level's bid window when it went
 * (its `ends_at` at most `bid_max_left_min` minutes after its `gone_at`): otherwise it was never on screen.
 */
export function filterGone(gone: GoneDeal[], prefs: Prefs, levels: Record<string, Level>): GoneDeal[] {
  const level = levels[prefs.level];
  if (!level) return [];
  return gone.filter(
    (deal) =>
      fitsPrefs(deal, prefs, level) && (deal.kind !== "bid" || inBidWindow(deal, level, Date.parse(deal.gone_at))),
  );
}
