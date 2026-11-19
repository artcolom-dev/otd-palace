// Offers: a cheap way to build a pass's rarity. In Real a player can offer less than the asking price on another
// player's card; most offers are refused, but the ones accepted buy rating below what it trades at, so the pass costs
// less and pays back sooner. Pure; the figures are said as an expectation, never as a promise.
//
// What it rests on, and nothing more (the same numbers are in advisor/rules.py, held equal by tests/test_copy_parity.py):
//  - Acceptance, measured: 18 % of 61,537 offers sent by the tool accounts we read were accepted, at about 64 Rax an
//    accepted card; the smallest accounts' low offers, 6 % of 2,777 (the internal research notes, section
//    2, "how they buy"; 2026-11-16-rax-economy-deep.md, A-admin). Those were offers at the tools' own prices.
//  - The level, NOT measured: what price those offers were made at was not read, so no acceptance curve exists. The
//    level is the site's own deal line (advisor/rules.py MIN_DISCOUNT["high"]: 20 % under the usual price), anchored
//    on the typical price per rating point the passes are priced at (the build rate, lib/passRates.ts). Listings opened under 0.8x the
//    usual price that sold ended near 0.85x (content/how.ts "winning"), so 0.8x is a low but not absurd offer.
//  - An accepted offer starts a 12-hour auction, so someone can still outbid it (Real's changelog; truth audit).
//  - Real's docs list offers among Real Pro's features (2026-11-15-rax-economy.md A5, D-pro); the owner confirmed
//    (11-18) that making an offer in Real needs Real Pro.
//  - Measured, once the feed sends it: the rate a point accepted offers cleared at, by bucket and rarity
//    (lib/passRates.ts offerCell). From OFFER_MIN_SALES accepted offers on the cell a rung is built from (the build
//    cell; a deal card's own), the hint uses that rate instead of the fixed share, and says when offers clear far
//    below listings (one star's cards: about 9 a point against 30) or above them (another's: about 30 against 20: an
//    offer then saves nothing, and listings are the cheaper way). The usual rate is the build rate.
import { about, monthsText, monthsWords, x1 } from "../content/passWords";
import type { LevelKey } from "../data/prefs";
import type { OtdRules, PassRung } from "../data/types";
import { type PassBasis, paybackAtCost } from "./passes";
import { type OfferCell, buildRate, offerCell } from "./passRates";

/** What every offer line on Deals says once: making an offer needs Real Pro. */
export const OFFER_PRO = "Offers need Real Pro.";

/** The offer level: this share of the typical price per rating point (the deal line, 20 % under). */
export const OFFER_LEVEL = 0.8;
/** The share of offers accepted, measured (18 % of 61,537). */
export const OFFER_ACCEPTED = 0.18;
/** The share of the smallest accounts' low offers accepted, measured (6 % of 2,777). */
export const OFFER_ACCEPTED_SMALL = 0.06;

/** Accepted offers measured on at least this many (advisor/rules.py OTD_OFFER_MIN_SALES) set the offer's level. */
export const OFFER_MIN_SALES = 5;
/** Offers clearing at or under this share of the same cards' listing rate "clear far below listings"
 * (advisor/rules.py OTD_OFFER_FAR_BELOW). */
export const OFFER_FAR_BELOW = 0.5;

/** How measured offers stand against listings of the same cards: far below, below, or at or above them. */
export type OfferVs = "far_below" | "below" | "above";

/** What accepted offers cleared at, against the listing rate of the same cards (`listing`, else `usual`). */
export function offerVs(cell: OfferCell, usual: number): OfferVs {
  const listing = cell.listing ?? usual;
  return cell.rate >= listing ? "above" : cell.rate <= OFFER_FAR_BELOW * listing ? "far_below" : "below";
}

/** "1 in 6": how many offers one accepted card takes, rounded the way a person says it. */
export const oneIn = (share: number): number => Math.round(1 / share);

export interface OfferHint {
  level: number; // the offer as a share of the usual rate: OFFER_LEVEL, or the measured rate's share
  usual_rate: number; // the typical price per rating point: the build rate (lib/passRates.ts)
  rate: number; // the offer per rating point
  cost: number; // the rung's cost with every card bought at the offer level (the mint, when there is one, unchanged)
  saved: number; // the rung's cost minus that; 0 when offers clear at or above the usual rate
  payback_months: number | null; // the engine's walk at that cost
  payback_month: string | null;
  // The rate is what accepted offers cleared at on these cards (`offers` of them), against their listing rate; null:
  // nothing measured, the fixed OFFER_LEVEL.
  measured: { offers: number; listing: number; vs: OfferVs } | null;
}

/**
 * What a rung costs if its cards are bought by offers, and when it then pays back: at the rate accepted offers cleared
 * at on the cell it is built from, when measured on OFFER_MIN_SALES offers (an offer clearing at or above the usual
 * rate saves nothing: `saved` 0, the cost unchanged); else at OFFER_LEVEL of the usual (build) rate. Null when the
 * rung buys no card (General, the mint alone), or has no price to start from.
 */
export function offerHint(market: PassBasis, rung: PassRung, rules: OtdRules, today: string): OfferHint | null {
  const build = buildRate(market);
  const usual = build.rate;
  if (usual === null || !(usual > 0) || rung.cost === null || !(rung.rating_to_add > 0) || rung.route === "mint") return null;
  const cell = offerCell(market, build.bucket, build.rarity);
  const measured = cell && cell.offers >= OFFER_MIN_SALES ? { offers: cell.offers, listing: cell.listing ?? usual, vs: offerVs(cell, usual) } : null;
  const rate = measured ? cell!.rate : usual * OFFER_LEVEL;
  const saved = rung.rating_to_add * Math.max(0, usual - rate);
  const cost = Math.max(0, rung.cost - saved);
  const back = paybackAtCost(market, rung, cost, rules, today);
  return {
    level: measured ? rate / usual : OFFER_LEVEL,
    usual_rate: usual,
    rate,
    cost,
    saved,
    payback_months: back.pays_back ? back.months : null,
    payback_month: back.pays_back ? back.month : null,
    measured,
  };
}

/** A card of this rating makes the per-point offer concrete at New: a won card averaged 5.6 rating (habits audit, 2). */
const EXAMPLE_CARD_RATING = 5;

/** The offer hint under a rung, in the words of each level: an expectation ("if enough are accepted"), never a promise. */
export function offerWords(hint: OfferHint, rung: Pick<PassRung, "cost">, level: LevelKey): string {
  const was = about(rung.cost ?? hint.cost + hint.saved);
  const now = about(hint.cost);
  const odds = oneIn(OFFER_ACCEPTED);
  if (hint.measured) return measuredWords(hint, hint.measured, was, now, level);
  if (level === "pro") {
    const back = hint.payback_months === null ? "" : `, back in ${monthsText(hint.payback_months)} mo`;
    return `Offers at ${Math.round(hint.level * 100)}%: ${x1(hint.rate)}/pt → ${now} (−${about(hint.saved)})${back}. ~1 in ${odds} accepted.`;
  }
  if (level === "new") {
    // Under 10 a point a whole number would hide the offer's 20 % (6.5 and 5.2 would read 7 and 5).
    const per = (r: number) => (r < 10 ? x1(r) : about(r));
    const back = hint.payback_months === null ? "" : ` and pays back in ${monthsWords(hint.payback_months)}`;
    return `Cheaper with offers: in Real, offer less than the asking price on many of its cards, about ${per(hint.rate)} Rax per rating point (a ${EXAMPLE_CARD_RATING}-rating card: about ${about(
      hint.rate * EXAMPLE_CARD_RATING,
    )} Rax; the usual is ${per(hint.usual_rate)} a point). Most are refused; if enough are accepted, it costs about ${now} instead of ${was}${back}.`;
  }
  const back = hint.payback_months === null ? "" : `, back in ${monthsWords(hint.payback_months)}`;
  return `Cheaper with offers: about ${x1(hint.rate)} Rax a rating point (usual ${x1(hint.usual_rate)}), on many cards. About 1 in ${odds} is accepted; if enough are, about ${now} instead of ${was}${back}.`;
}

/** The offer hint when accepted offers were measured on these cards: what they cleared at, and how that stands
 * against listings. */
function measuredWords(hint: OfferHint, m: NonNullable<OfferHint["measured"]>, was: string, now: string, level: LevelKey): string {
  const per = (r: number) => (r < 10 ? x1(r) : about(r));
  const odds = oneIn(OFFER_ACCEPTED);
  if (m.vs === "above") {
    if (level === "pro") return `Offers clear above listings here: ~${x1(hint.rate)}/pt (${m.offers} accepted) vs ${x1(m.listing)} listed. Buy listings.`;
    if (level === "new") {
      return `Offers do not help here: accepted offers on these cards cleared at about ${per(hint.rate)} Rax a rating point, more than listed cards sell for (about ${per(m.listing)}). Buy listed cards instead.`;
    }
    return `Offers clear above listings here: about ${x1(hint.rate)} a rating point (${m.offers} accepted) against ${x1(m.listing)} listed. Buy listed cards.`;
  }
  const far = m.vs === "far_below";
  if (level === "pro") {
    const back = hint.payback_months === null ? "" : `, back in ${monthsText(hint.payback_months)} mo`;
    return `Offers clear ~${x1(hint.rate)}/pt (${m.offers} accepted${far ? ", far under listings" : ""}) → ${now} (−${about(hint.saved)})${back}. ~1 in ${odds} accepted.`;
  }
  if (level === "new") {
    const back = hint.payback_months === null ? "" : ` and pays back in ${monthsWords(hint.payback_months)}`;
    return `Cheaper with offers: in Real, accepted offers on these cards have cleared at about ${per(hint.rate)} Rax per rating point (a ${EXAMPLE_CARD_RATING}-rating card: about ${about(
      hint.rate * EXAMPLE_CARD_RATING,
    )} Rax)${far ? ", far under" : ", under"} the usual ${per(hint.usual_rate)} a point. Most offers are refused; if enough are accepted, it costs about ${now} instead of ${was}${back}.`;
  }
  const back = hint.payback_months === null ? "" : `, back in ${monthsWords(hint.payback_months)}`;
  return `Cheaper with offers: accepted offers cleared at about ${x1(hint.rate)} Rax a rating point (${m.offers} of them; usual ${x1(hint.usual_rate)})${far ? ", far under listings" : ""}. About 1 in ${odds} is accepted; if enough are, about ${now} instead of ${was}${back}.`;
}
