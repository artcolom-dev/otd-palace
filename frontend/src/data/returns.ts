// Reasons to come back, worked out on this device alone: what changed for the players followed since the last
// visit, and the deals opened in Real that the page can ask about ("got one?").
import { playerKey, visibleDeals } from "./deals";
import type { OpenedDeal } from "./local";
import { changeText } from "./moves";
import type { Prefs } from "./prefs";
import type { Move, Snapshot } from "./types";
import { plural, shortName } from "../lib/words";

/** A last visit closer than this is the same sitting: nothing to tell. */
export const SINCE_MIN_MS = 10 * 60_000;
/** A move this big or bigger, up or down, is news about a followed player. */
export const SINCE_MIN_CHANGE = 0.2;
/** An open is asked about for this long. */
export const OPENED_WINDOW_MS = 30 * 60_000;

export interface SinceNews {
  deals: number; // deals of followed players listed since the last visit, that this visitor would see
  move: Move | null; // the biggest move today among the followed players, if 20% or more
}

/**
 * What changed for the followed players since `since` (the last visit), or null when there is nothing to say: a
 * first visit, a visit less than 10 minutes ago, no player followed, or nothing new for them.
 */
export function sinceLastVisit(
  snap: Snapshot,
  prefs: Prefs,
  follows: ReadonlySet<string>,
  nowMs: number,
  since: number | null,
): SinceNews | null {
  if (since === null || nowMs - since < SINCE_MIN_MS || follows.size === 0) return null;
  const deals = visibleDeals(snap, { ...prefs, sport: "mine", rarity: null }, follows, nowMs).filter((d) => {
    const listed = d.listed_at === null ? Number.NaN : Date.parse(d.listed_at);
    return listed > since;
  }).length;
  const move =
    [...snap.moves.risers, ...snap.moves.fallers]
      .filter((m) => follows.has(playerKey(m)) && Math.abs(m.change) >= SINCE_MIN_CHANGE)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0] ?? null;
  return deals > 0 || move ? { deals, move } : null;
}

/** "3 new deals on your players · Jokić −22% today", either half alone when the other has nothing. */
export function sinceText(news: SinceNews): string {
  const parts: string[] = [];
  if (news.deals > 0) parts.push(`${plural(news.deals, "new deal", "new deals")} on your players`);
  if (news.move) parts.push(`${shortName(news.move.player_name)} ${changeText(news.move.change)} today`);
  return parts.join(" · ");
}

/**
 * The opened deals to ask "got one?" about: opened in the last 30 minutes, before the page last came back (an open
 * the visitor has not left for yet is not asked about), after the last "Not this time", and not already got.
 */
export function recentOpens(
  opened: readonly OpenedDeal[],
  nowMs: number,
  returnedAt: number,
  dismissedAt: number,
  got: readonly number[],
): OpenedDeal[] {
  return opened.filter(
    (o) => nowMs - o.at <= OPENED_WINDOW_MS && o.at < returnedAt && o.at > dismissedAt && !got.includes(o.listing_id),
  );
}
