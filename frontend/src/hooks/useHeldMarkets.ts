// The markets the passes this device holds are valued with: this site's past seasons, this season's passes the site
// serves for Deals (`current_markets`) that this device holds (only those: they are never suggested), then the analysed
// account's valuations kept for held passes the site does not list ("Add to my passes" in an account's analysis), their
// rungs walked again from the snapshot's day. An account's own valuation of a pass of this season is kept even when the
// site serves that pass now: the site serves one only while its player has a deal. A big account keeps a couple of thousand of them and several panels ask at once, so the last
// answer is shared: it is worked out once per change of the site's markets, the kept valuations, the rules or the day.
import { useApp } from "../AppContext";
import { useLocal } from "../data/local";
import type { Otd, OtdRules, PassMarket } from "../data/types";
import { withAccountMarkets } from "../lib/accountPasses";
import { type Holding, type PassBasis, dayOf, marketOf } from "../lib/passes";

let last: { site: readonly PassMarket[]; held: readonly PassBasis[]; rules: OtdRules; day: string; out: PassMarket[] } | null = null;

/** This site's markets with the kept valuations after them, the same array for the same inputs. */
export function heldMarketsOf(site: readonly PassMarket[], held: readonly PassBasis[], rules: OtdRules, day: string): PassMarket[] {
  if (held.length === 0) return site as PassMarket[];
  if (last && last.site === site && last.held === held && last.rules === rules && last.day === day) return last.out;
  const out = withAccountMarkets(site, held.map((b) => marketOf(b, rules, day)));
  last = { site, held, rules, day, out };
  return out;
}

let lastSite: { otd: Pick<Otd, "markets" | "current_markets">; holdings: readonly Pick<Holding, "key">[]; out: PassMarket[] } | null = null;

/**
 * The site's markets a holding is matched with: the past seasons, then this season's passes it serves that one of
 * `holdings` is (the same array for the same inputs; the past seasons' own array when there is none).
 */
export function heldSiteMarkets(otd: Pick<Otd, "markets" | "current_markets">, holdings: readonly Pick<Holding, "key">[]): PassMarket[] {
  if (lastSite && lastSite.otd.markets === otd.markets && lastSite.otd.current_markets === otd.current_markets && lastSite.holdings === holdings) {
    return lastSite.out;
  }
  const keys = new Set(holdings.map((h) => h.key));
  const held = (otd.current_markets ?? []).filter((m) => keys.has(m.key));
  const out = held.length ? [...otd.markets, ...held] : otd.markets;
  lastSite = { otd: { markets: otd.markets, current_markets: otd.current_markets }, holdings, out };
  return out;
}

export function useHeldMarkets(): PassMarket[] {
  const { snap } = useApp();
  const { heldMarkets, passes } = useLocal();
  return heldMarketsOf(heldSiteMarkets(snap.otd, passes), heldMarkets, snap.rules.otd, dayOf(snap.otd.as_of));
}
