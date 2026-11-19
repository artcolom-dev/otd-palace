// What a deal does for a pass. A pass is one player's (or fighter's) season, and its rarity follows the total rating of
// that player-season's cards held (advisor/otd.py rungs; a card's rating adds to the pass 1:1, a negative card by its
// size). So a deal on player P, season S is rating toward P's S pass, and nothing toward P's other seasons. Deals' cards
// are mostly this season's: their passes come in `otd.current_markets` (`servedMarkets`), on weaker data. Pure.
//
// What it rests on:
//  - The pass's figures are the engine's (lib/passes.ts rungs, the server's golden-vector twin): its rungs are priced
//    at the usual (build) rate a rating point costs (lib/passRates.ts buildRate: the feed's cheapest cell with 5
//    listing sales, else the rate the player-season's cards traded at, as before).
//  - "With this card": the rung's own cost, the card's rating swapped from the usual rate to the card's price. Every
//    figure stays an estimate, as the pass's own are.
//  - The offer: what accepted offers cleared at on the card's own cell (its bucket and rarity), when the feed measured
//    it on OFFER_MIN_SALES offers (lib/offers.ts); else OFFER_LEVEL (80 %) of the usual rate per point, the site's deal
//    line, NOT measured. Times the card's rating. Offers clearing at or above listings make no offer. The odds (about
//    1 in 6 accepted) are measured (lib/offers.ts says where).
//  - A team pass is never matched: its id is a team's, which can equal a player's id, and no deal says it is a team
//    card (lib/owned.ts heldFor does the same).
import { about, monthsWords, tierName, titleText, x1 } from "../content/passWords";
import type { LevelKey } from "../data/prefs";
import type { Deal, Otd, OtdRules, PassMarket, PassRung, Snapshot } from "../data/types";
import { OFFER_ACCEPTED, OFFER_LEVEL, OFFER_MIN_SALES, OFFER_PRO, type OfferVs, offerVs, oneIn } from "./offers";
import { dayOf, paybackAtCost, rungs, toBasis } from "./passes";
import { buildRate, offerCell, passBucket, rarityName } from "./passRates";

/**
 * Every pass the snapshot serves: the past seasons, then this season's passes (`current_markets`, absent from the free
 * site's snapshot). For Deals and for matching the visitor's own passes only: the suggestions read `otd.markets`.
 */
export function servedMarkets(otd: Pick<Otd, "markets"> & Partial<Pick<Otd, "current_markets">>): PassMarket[] {
  return otd.current_markets?.length ? [...otd.markets, ...otd.current_markets] : otd.markets;
}

/** The served pass markets by key. */
export function passMarketIndex(markets: readonly PassMarket[]): Map<string, PassMarket> {
  return new Map(markets.map((m) => [m.key, m]));
}

/** The pass a deal's card builds, when the snapshot serves it: the player's pass of that season (a fighter's for UFC). */
export function dealPassMarket(
  deal: Pick<Deal, "sport" | "season" | "player_id">,
  index: ReadonlyMap<string, PassMarket>,
): PassMarket | null {
  return (
    index.get(`${deal.sport}:${deal.season}:player:${deal.player_id}`) ??
    index.get(`${deal.sport}:${deal.season}:fighter:${deal.player_id}`) ??
    null
  );
}

/** How the card's price per rating point stands against the pass's: under the offer level, under the usual, over it. */
export type PriceVs = "under_offer" | "under_usual" | "over_usual";

export interface DealPass {
  market: PassMarket;
  rating: number; // the card's rating, by its size
  held: number; // the rating the visitor already holds for this pass (0: not held)
  target: PassRung; // the rarity the card counts toward: the highest it reaches, else the next one up
  need: number; // the rating that rarity still needs from what is held
  reaches: boolean; // the card alone brings the pass to `target`
  per_point: number; // the card's price per rating point
  usual_rate: number; // the pass's usual rate per point: its build rate (lib/passRates.ts)
  offer_rate: number; // what accepted offers cleared at on the card's cell, when measured; else OFFER_LEVEL of the usual
  offer_measured: { offers: number; vs: OfferVs } | null; // measured on that many accepted offers; null: the fixed share
  price_vs: PriceVs;
  cost_with: number | null; // `target`'s cost with this card in it
  year_rax: number | null; // what `target` pays in the next 12 months, when the card reaches it
  payback_months: number | null; // `target`'s payback at `cost_with`, when the card reaches it and it pays back
  year_per_rax: number | null; // `target`'s 12 months' pay per Rax at `cost_with`, when that pays back: the sort's figure
  offer: number | null; // what to offer for the card, in Rax; null when no offer is worth saying (see `dealPass`)
}

/**
 * The card's part in its pass, or null when there is nothing honest to say: a card rated 0, a team pass, a pass whose
 * cards have no traded rate, a pass already at its top, or a pass with no rarity that pays back (not worth building).
 * `held` is the visitor's own holding of that pass (lib/owned.ts), when known: the rarities then start from it.
 *
 * The offer is said only for a card whose listing can be started (kind "target": an auction ending soon has no time
 * for one), when it is under the card's price, and only while the card is at or under the pass's usual rate: further
 * over, an offer that far under the asking price is not worth suggesting, and the line says so instead.
 */
export function dealPass(
  deal: Pick<Deal, "rating" | "price" | "kind"> & Partial<Pick<Deal, "rarity">>,
  market: PassMarket,
  rules: OtdRules,
  today: string,
  held: { rating: number } | null = null,
): DealPass | null {
  const rating = Math.abs(deal.rating);
  const usual = buildRate(market).rate;
  if (market.kind === "team" || !(rating > 0) || usual === null || !(usual > 0)) return null;
  const heldRating = held ? Math.abs(held.rating) : 0;
  const ladder = held ? rungs(toBasis(market), rules, { today, heldRating, minted: true }) : market.rungs;
  const cards = ladder.filter((r) => r.route !== "mint" && r.rating_to_add > 0);
  if (cards.length === 0 || !ladder.some((r) => r.pays_back)) return null;
  const reached = cards.filter((r) => r.rating_to_add <= rating + 1e-9);
  const target = reached.at(-1) ?? cards[0]!;
  const reaches = reached.length > 0;
  const perPoint = deal.price / rating;
  const cell = offerCell(market, passBucket(rating), deal.rarity === undefined ? null : rarityName(deal.rarity));
  const measured = cell && cell.offers >= OFFER_MIN_SALES ? { offers: cell.offers, vs: offerVs(cell, usual) } : null;
  const offerRate = measured ? cell!.rate : usual * OFFER_LEVEL;
  const offers = offerRate < usual; // an offer clearing at or above the usual rate is no way to pay less
  const priceVs: PriceVs =
    offers && perPoint <= offerRate + 1e-9 ? "under_offer" : perPoint <= usual + 1e-9 ? "under_usual" : "over_usual";
  const used = Math.min(rating, target.rating_to_add);
  const costWith = target.cost === null ? null : Math.max(0, target.cost - used * usual + deal.price);
  let payback: number | null = null;
  let yearPerRax: number | null = null;
  if (costWith !== null && costWith > 0) {
    const back = paybackAtCost(toBasis(market), target, costWith, rules, today);
    if (back.pays_back) yearPerRax = target.year_rax / costWith;
    if (reaches && back.pays_back) payback = back.months;
  }
  const offer = Math.round(offerRate * rating);
  return {
    market,
    rating,
    held: heldRating,
    target,
    need: target.rating_to_add,
    reaches,
    per_point: perPoint,
    usual_rate: usual,
    offer_rate: offerRate,
    offer_measured: measured,
    price_vs: priceVs,
    cost_with: costWith,
    year_rax: reaches ? target.year_rax : null,
    payback_months: payback,
    year_per_rax: yearPerRax,
    offer: offers && deal.kind === "target" && priceVs === "under_usual" && offer < deal.price ? offer : null,
  };
}

/**
 * The "For passes" sort's figure for each deal: its pass's next 12 months' pay per Rax, the card bought at its price
 * (`DealPass.year_per_rax`); null for a deal that builds no tracked pass, or a pass that would not pay back. From the
 * pass as served (nobody's holding: the sort is the same on every device). Looked up once per snapshot.
 */
export function passSortValue(snap: Pick<Snapshot, "otd" | "rules">): (deal: Deal) => number | null {
  const index = passMarketIndex(servedMarkets(snap.otd));
  const today = dayOf(snap.otd.as_of);
  const memo = new Map<string, number | null>();
  return (deal) => {
    const key = `${deal.listing_id}:${deal.kind}:${deal.price}`;
    if (memo.has(key)) return memo.get(key)!;
    const market = dealPassMarket(deal, index);
    const value = market ? (dealPass(deal, market, snap.rules.otd, today)?.year_per_rax ?? null) : null;
    memo.set(key, value);
    return value;
  };
}

export interface DealPassWords {
  chip: string; // the tag on the row: "Pass"
  label: string; // what the tag says to a screen reader: which pass it opens
  line: string; // the card's share of the next rarity and its price per point against the pass's usual
  pay: string | null; // what the rarity pays, when the card reaches it
  offer: string | null; // the offer, or why none
}

/** A rating as the rows say it: a whole number bare, else one decimal ("6", "4.5"). */
const pts = (n: number) => (Number.isInteger(n) ? String(n) : x1(n));

/** The pass line of a deal, in the words of each level. Plain, short; every figure an estimate, never a promise. */
export function dealPassWords(dp: DealPass, level: LevelKey): DealPassWords {
  const tier = tierName(dp.target.tier);
  const name = titleText(dp.market);
  const yours = dp.held > 0 ? "Your pass: " : "";
  let line: string;
  if (level === "pro") {
    line = dp.reaches
      ? `${yours}+${pts(dp.rating)} → ${tier} · ${x1(dp.per_point)}/pt (usual ${x1(dp.usual_rate)})`
      : `${yours}${pts(dp.rating)}/${pts(dp.need)} to ${tier} · ${x1(dp.per_point)}/pt (usual ${x1(dp.usual_rate)})`;
  } else if (level === "new") {
    const share = dp.reaches ? `${pts(dp.rating)} rating, enough for ${tier}` : `${pts(dp.rating)} of the ${pts(dp.need)} rating it needs for ${tier}`;
    line = `Builds ${dp.held > 0 ? "your" : `${name}'s`} pass: ${share}. ${x1(dp.per_point)} Rax a rating point (usual ${x1(dp.usual_rate)}).`;
  } else {
    const share = dp.reaches ? `+${pts(dp.rating)} rating, enough for ${tier}` : `${pts(dp.rating)} of the ${pts(dp.need)} rating to ${tier}`;
    line = `${yours}${share}, ${x1(dp.per_point)} a point (usual ${x1(dp.usual_rate)}).`;
  }
  let pay: string | null = null;
  if (dp.year_rax !== null) {
    const back = dp.payback_months === null ? "" : level === "pro" ? `, back ~${Math.round(dp.payback_months)} mo` : `, back in ${monthsWords(dp.payback_months)}`;
    pay = level === "pro" ? `${tier} ~${about(dp.year_rax)}/yr${back}` : `${tier} pays about ${about(dp.year_rax)} Rax a year${back}.`;
  }
  const odds = oneIn(OFFER_ACCEPTED);
  let offer: string | null = null;
  const m = dp.offer_measured;
  if (m && m.vs === "above") {
    offer =
      level === "pro"
        ? `Offers clear above listings here (~${x1(dp.offer_rate)}/pt, ${m.offers} accepted): no offer`
        : level === "new"
          ? `Offers on these cards have cleared above listing prices, about ${x1(dp.offer_rate)} a point: an offer will not save here.`
          : `Offers here clear above listings (~${x1(dp.offer_rate)} a point): no saving by offer.`;
  } else if (m && dp.offer !== null) {
    offer =
      level === "pro"
        ? `Offer ~${about(dp.offer)} (offers clear ~${x1(dp.offer_rate)}/pt, ${m.offers} accepted) · ~1 in ${odds} accepted · Offers need Real Pro`
        : level === "new"
          ? `Or offer about ${about(dp.offer)} Rax in Real: accepted offers on cards like it cleared near ${x1(dp.offer_rate)} a point. Most offers are refused, about 1 in ${odds} is accepted. ${OFFER_PRO}`
          : `Or offer about ${about(dp.offer)}: offers on cards like it cleared near ${x1(dp.offer_rate)} a point; about 1 in ${odds} is accepted. ${OFFER_PRO}`;
  } else if (m && dp.price_vs === "over_usual") {
    offer =
      level === "pro"
        ? `Over usual/pt: offers on cards like it clear ~${x1(dp.offer_rate)}/pt (offers need Real Pro)`
        : level === "new"
          ? `Dear for this pass: accepted offers on cards like it cleared near ${x1(dp.offer_rate)} a point. ${OFFER_PRO}`
          : `Dear here: offers on cards like it clear ~${x1(dp.offer_rate)} a point. ${OFFER_PRO}`;
  } else if (dp.offer !== null) {
    offer =
      level === "pro"
        ? `Offer ~${about(dp.offer)} (${Math.round(OFFER_LEVEL * 100)}% of usual/pt) · ~1 in ${odds} accepted · Offers need Real Pro`
        : level === "new"
          ? `Or offer about ${about(dp.offer)} Rax in Real: most offers are refused, about 1 in ${odds} is accepted. ${OFFER_PRO}`
          : `Or offer about ${about(dp.offer)}: about 1 in ${odds} offers is accepted. ${OFFER_PRO}`;
  } else if (dp.price_vs === "under_offer") {
    offer = level === "pro" ? "Under our offer line" : "Cheaper than an offer would be.";
  } else if (dp.price_vs === "over_usual") {
    offer =
      level === "pro"
        ? `Over usual/pt: offers on other cards ~${x1(dp.offer_rate)}/pt (offers need Real Pro)`
        : level === "new"
          ? `Dear for this pass: offers on its other cards, about ${x1(dp.offer_rate)} a point, build it for less. ${OFFER_PRO}`
          : `Dear here: offers on its other cards ~${x1(dp.offer_rate)} a point. ${OFFER_PRO}`;
  }
  return { chip: "Pass", label: `Open ${name}'s pass`, line, pay, offer };
}
