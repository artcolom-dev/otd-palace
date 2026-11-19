// "What offer to make?": what accepted offers on cards like a deal's really went for, next to what listings of the
// same cards sell for. For a member at the Pro level only (components/DealPassLine.tsx), behind lib/offerHintSwitch.ts.
// Pure.
//
// What it rests on, and nothing more:
//  - The feed's accepted-offer cells, served on the card's player-season pass (`offers`, advisor/pass_rates.py
//    offer_cells): the rate a point accepted offers cleared at, by the card's rating bucket and rarity, how many
//    offers, and the same cell's listing rate a point (null under 5 listing sales). The card's own cell is read as
//    everywhere else (lib/passRates.ts offerCell: its rarity's in its bucket, else the whole bucket's, never further).
//  - Only from OFFER_MIN_SALES accepted offers (lib/offers.ts, the server's minimum, checked here again: a device's
//    kept snapshot is not trusted), and only above Real's Quick Sell (`rules.quicksell_per_point`): a rate at or under
//    what Real itself pays for any card is no market price. Without that rule (an older server), nothing.
//  - It is a fact about the past ("were accepted", with the count), never a saving, a percentage or a promise. The
//    odds (about 1 in 6 offers accepted) are the measured ones the other offer lines say (lib/offers.ts).
//  - An offer needs a listing with time left (kind "target"): on an auction ending soon the figure is said for "a
//    card of this rating", and no offer is suggested. Making an offer needs Real Pro (OFFER_PRO says so everywhere).
//  - The card's own figure (the rate times its rating) is said only from OFFER_FIGURE_MIN Rax: the shelves move in
//    steps of 10 Rax, 10 the smallest price seen, and no minimum offer was measured, so "~2 for this card" could be an
//    offer Real refuses. Under it the rate alone is said.
//  - Two readings of the same facts: `text`, the Pro level's short form for the eye (about three lines on a phone), and
//    `spoken`, the full sentences for a screen reader (the short form drops the words that carry the tense).
import { about, x1 } from "../content/passWords";
import type { Deal, DealKind, PassMarket } from "../data/types";
import { OFFER_ACCEPTED, OFFER_MIN_SALES, oneIn } from "./offers";
import { offerCell, passBucket, rarityName } from "./passRates";

export interface DealOffer {
  rate: number; // what accepted offers cleared at on the card's cell, a rating point
  offers: number; // how many accepted offers that rests on
  listing: number | null; // the same cell's listing rate a point; null under 5 listing sales
  for_card: number | null; // that rate times the card's rating, in whole Rax; null under OFFER_FIGURE_MIN: not said
  above: boolean; // offers cleared at or above the cell's listings: an offer is no way to pay less
  under: boolean; // the card is already priced at or under that rate times its rating
  kind: DealKind;
}

/** The card's own figure is said from this many Rax (see the header: steps of 10, no measured minimum offer). */
export const OFFER_FIGURE_MIN = 10;

const isRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * The accepted offers measured on the card's own cell, or null when there is nothing honest to say: no measured cell,
 * too few offers, a rate at or under Quick Sell (or no Quick Sell rule to check it against), a card rated 0, or a team
 * pass (whose id is a team's, never matched to a card: lib/dealPass.ts).
 */
export function dealOffer(
  deal: Pick<Deal, "rating" | "price" | "kind"> & Partial<Pick<Deal, "rarity">>,
  market: Pick<PassMarket, "kind"> & Partial<Pick<PassMarket, "offers">>,
  quickPerPoint: number | undefined,
): DealOffer | null {
  const rating = Math.abs(deal.rating);
  if (market.kind === "team" || !(rating > 0) || !Number.isFinite(rating) || !isRate(quickPerPoint)) return null;
  const cell = offerCell(market, passBucket(rating), deal.rarity === undefined ? null : rarityName(deal.rarity));
  if (!cell || !Number.isInteger(cell.offers) || cell.offers < OFFER_MIN_SALES) return null;
  if (!isRate(cell.rate) || cell.rate <= quickPerPoint) return null;
  const listing = isRate(cell.listing) ? cell.listing : null;
  const forCard = Math.round(cell.rate * rating);
  return {
    rate: cell.rate,
    offers: cell.offers,
    listing,
    for_card: forCard >= OFFER_FIGURE_MIN ? forCard : null,
    above: listing !== null && cell.rate >= listing,
    under: deal.price <= forCard,
    kind: deal.kind,
  };
}

export interface DealOfferWords {
  text: string; // the short form, for the eye
  spoken: string; // the same facts in full sentences, for a screen reader
  offerable: boolean; // the line suggests an offer on this card: the glossary's "offer" goes with it
}

/** The hint in the Pro level's short words, and in full. Past tense, with the count; never a percentage, never a
 * promise. */
export function dealOfferWords(o: DealOffer): DealOfferWords {
  const head = `Offers accepted ~${x1(o.rate)}/pt (${o.offers} offers)`;
  const said = `Offers on cards like it were accepted at about ${x1(o.rate)} Rax a rating point (${o.offers} offers)`;
  if (o.above) {
    return {
      text: `${head}, above listings (~${x1(o.listing!)}/pt): no saving by offer`,
      spoken: `${said}, above what listings of the same cards sell at (about ${x1(o.listing!)} a point): an offer saves nothing here.`,
      offerable: false,
    };
  }
  const target = o.kind === "target";
  const what = target ? "this card" : "a card of this rating";
  const figure = o.for_card === null ? "" : `: ~${about(o.for_card)} for ${what}`;
  const figureSaid = o.for_card === null ? "." : `: about ${about(o.for_card)} Rax for ${what}.`;
  const listings = o.listing === null ? "" : ` · listings ~${x1(o.listing)}/pt`;
  const listingsSaid = o.listing === null ? "" : ` Listings of the same cards sell at about ${x1(o.listing)} a point.`;
  const body = `${head}${figure}${listings}`;
  const bodySaid = `${said}${figureSaid}${listingsSaid}`;
  if (!target) {
    return { text: `${body} · ends too soon for an offer`, spoken: `${bodySaid} This auction ends too soon for an offer.`, offerable: false };
  }
  if (o.under) {
    const that = o.for_card === null ? "that rate" : "that";
    return { text: `${body} · this one is at or under ${that}`, spoken: `${bodySaid} This card is priced at or under ${that}.`, offerable: false };
  }
  const odds = oneIn(OFFER_ACCEPTED);
  return {
    text: `${body} · ~1 in ${odds} accepted · needs Real Pro`,
    spoken: `${bodySaid} About 1 in ${odds} offers is accepted. Making an offer needs Real Pro.`,
    offerable: true,
  };
}
