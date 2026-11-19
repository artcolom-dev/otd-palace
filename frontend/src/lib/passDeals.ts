// Pass deals: the passes whose cards on sale right now reach a paying rarity for less than the usual rate, read from the
// passes' own shelves: the past seasons and this season's passes the feed sends for Deals (`current_markets`, never a
// suggestion elsewhere). Pure.
//
// What it rests on: the shelf is the player-season's cards on sale, cheapest per rating point first, asks over 5x the
// usual left out (lib/passes.ts onSale, advisor/otd.py on_sale); when the feed sends the shelf's live auctions, only
// those at a firm pay count (ending within 2 hours, read within 3, no house listing, not a floor opening: an opening
// is never a deal) and each at its pay. The usual rate is the build rate (lib/passRates.ts buildRate: the feed's
// cheapest cell with 5 listing sales, else the median the cards traded at, counted only from `ignore_ask_min_sales`
// trades up; a thin rate, measured but with no cell, is never the yardstick). The rarity's pay and payback are the
// engine's walk at the cost on sale (an estimate, as every pass figure). Which rarities count is the budget buddy's own rule (lib/budget.ts routeRungOk), so the two never disagree on
// what is worth building; the ranking is the engine's figure, the next 12 months' pay per Rax, at the cost on sale.
import { about, monthsWords, tierName, titleText, x1 } from "../content/passWords";
import type { LevelKey } from "../data/prefs";
import type { Otd, OtdRules, PassMarket, PassRung } from "../data/types";
import { routeRungOk } from "./budget";
import { servedMarkets } from "./dealPass";
import { OFFER_ACCEPTED, OFFER_PRO, type OfferHint, offerHint, oneIn } from "./offers";
import { dayOf, isLiquid, onSale, paybackAtCost, paysLater, toBasis } from "./passes";
import { buildRate } from "./passRates";

export interface PassDeal {
  market: PassMarket;
  rung: PassRung & { cost: number }; // the rarity, at the usual (build) rate (the engine's)
  rating: number; // the rating the cards taken off the shelf add up to (at least the rung's)
  cards: number; // what those cards ask, together
  cost: number; // the rarity at the cost on sale: the mint (when the pass is not held) plus `cards`
  per_point: number; // `cards` per rating point
  usual_rate: number; // the pass's usual rate per point: its build rate (lib/passRates.ts)
  year_per_rax: number; // the rarity's next 12 months' pay per Rax at `cost`
  payback_months: number | null; // the engine's walk at `cost`
  offer: OfferHint | null; // offers at the offer line, when they would build it for less than the cards on sale
}

export interface PassDealOptions {
  level: LevelKey;
  sport: string; // a sport, or "all" / "mine" for every sport
  budget: number | null; // the most to spend on one pass (the visitor's pass budget); null = any
  held: ReadonlySet<string>; // the market keys this device holds: never offered again
  live?: Readonly<Record<string, number>>; // the live passes held in each sport (lib/budget.ts liveBySport): each takes a claim
}

/**
 * The pass deals, best first: for each pass, the rarity whose cost on sale is under its cost at the usual rate and
 * pays the most a year per Rax at that cost; at most as many per sport as it pays claims a day, less the live passes the
 * visitor holds there (the budget buddy's rule).
 */
export function passDeals(otd: Pick<Otd, "markets" | "as_of"> & Partial<Pick<Otd, "current_markets">>, rules: OtdRules, options: PassDealOptions): PassDeal[] {
  const today = dayOf(otd.as_of);
  const only = options.sport === "all" || options.sport === "mine" ? null : options.sport;
  const found: PassDeal[] = [];
  for (const market of servedMarkets(otd)) {
    const build = buildRate(market);
    const usual = build.rate;
    // With the live auctions, only a firm pay is on sale for a deal; without them, the old shelf.
    const supply = market.auctions ? market.auctions.some(([, , firm]) => firm === 1) : market.shelf.length > 0;
    if (market.kind === "team" || usual === null || !(usual > 0) || !isLiquid(market) || !supply) continue;
    if (options.held.has(market.key) || (only !== null && market.sport !== only)) continue;
    // A usual rate from a handful of trades is too thin to call an ask cheaper than usual: one dear sale can make the
    // whole shelf look like a deal (the same bar as the parked asks, advisor/rules.py OTD_IGNORE_ASK_MIN_SALES). A
    // build cell has its 5 sales; a thin rate (measured, no cell) is never the yardstick.
    if (build.thin || build.sales < rules.ignore_ask_min_sales) continue;
    if (paysLater(market, rules, today)) continue; // its pay is months away: the Passes tab says when to buy it
    let best: PassDeal | null = null;
    for (const rung of market.rungs) {
      if (rung.route === "mint" || !(rung.rating_to_add > 0) || !routeRungOk(rung, options.level)) continue;
      const sale = onSale(market, rung.rating_to_add, rules, { firmOnly: true });
      if (!sale.enough || !(sale.on_sale_rating > 0)) continue;
      const mint = rung.route === "mint+cards" ? rung.cost - rung.rating_to_add * usual : 0;
      const cost = mint + sale.on_sale_cost;
      if (!(cost < rung.cost - 1e-9) || (options.budget !== null && cost > options.budget)) continue;
      const back = paybackAtCost(toBasis(market), rung, cost, rules, today);
      if (!back.pays_back) continue;
      const offer = offerHint(market, rung, rules, today);
      const deal: PassDeal = {
        market,
        rung,
        rating: sale.on_sale_rating,
        cards: sale.on_sale_cost,
        cost,
        per_point: sale.on_sale_cost / sale.on_sale_rating,
        usual_rate: usual,
        year_per_rax: rung.year_rax / cost,
        payback_months: back.months,
        offer: offer && offer.cost < cost ? offer : null,
      };
      if (!best || deal.year_per_rax > best.year_per_rax) best = deal;
    }
    if (best) found.push(best);
  }
  found.sort((a, b) => b.year_per_rax - a.year_per_rax || a.cost - b.cost || (a.market.key < b.market.key ? -1 : 1));
  const perSport = new Map<string, number>();
  return found.filter((d) => {
    const n = perSport.get(d.market.sport) ?? options.live?.[d.market.sport] ?? 0;
    perSport.set(d.market.sport, n + 1);
    return n < rules.claims_per_sport_day;
  });
}

export interface PassDealWords {
  title: string; // "Nikola Jokić 2024-25"
  tier: string; // "Common"
  sale: string; // the rating on sale, its price, a point, and the usual
  pay: string; // what the rarity pays a year, and when it is back
  offer: string | null;
}

/** A pass deal in the words of each level: figures are estimates (pay, payback) or asks on the shelf now. */
export function passDealWords(d: PassDeal, level: LevelKey): PassDealWords {
  const tier = tierName(d.rung.tier);
  const rating = Number.isInteger(d.rating) ? String(d.rating) : x1(d.rating);
  const minting = d.cost - d.cards;
  let sale: string;
  if (level === "pro") {
    sale = `${rating} rating for ${about(d.cards)}${minting > 0 ? " + mint" : ""} · ${x1(d.per_point)}/pt (usual ${x1(d.usual_rate)})`;
  } else if (level === "new") {
    const mint = minting > 0 ? `, plus ${about(minting)} Rax to mint the pass` : "";
    sale = `Cards on sale add ${rating} rating for ${about(d.cards)} Rax${mint}: ${x1(d.per_point)} Rax a rating point (usual ${x1(d.usual_rate)}).`;
  } else {
    sale = `${rating} rating on sale for ${about(d.cards)} Rax${minting > 0 ? " plus the mint" : ""}: ${x1(d.per_point)} a point (usual ${x1(d.usual_rate)}).`;
  }
  const back = d.payback_months === null ? "" : level === "pro" ? `, back ~${Math.round(d.payback_months)} mo` : `, back in ${monthsWords(d.payback_months)}`;
  const pay = level === "pro" ? `${tier} ~${about(d.rung.year_rax)}/yr${back}` : `${tier} pays about ${about(d.rung.year_rax)} Rax a year${back}.`;
  const odds = oneIn(OFFER_ACCEPTED);
  let offer: string | null = null;
  if (d.offer) {
    offer =
      level === "pro"
        ? `Offers ~${x1(d.offer.rate)}/pt → ~${about(d.offer.cost)} · ~1 in ${odds} accepted · Offers need Real Pro`
        : level === "new"
          ? `Or offer less in Real, about ${x1(d.offer.rate)} Rax a rating point, for about ${about(d.offer.cost)} in all: most offers are refused, about 1 in ${odds} is accepted. ${OFFER_PRO}`
          : `Offers at about ${x1(d.offer.rate)} a point could make it about ${about(d.offer.cost)}; about 1 in ${odds} is accepted. ${OFFER_PRO}`;
  }
  return { title: titleText(d.market), tier, sale, pay, offer };
}
