import { describe, expect, it } from "vitest";
import { makeDeal } from "../test/fixtures";
import { JOKIC, THUNDER, served } from "../test/passScene";
import type { PassMarket, PassOfferCell } from "../data/types";
import { OFFER_FIGURE_MIN, dealOffer, dealOfferWords } from "./dealOffer";
import { OFFER_MIN_SALES } from "./offers";
import { toBasis } from "./passes";

const QUICK = 1; // rules.quicksell_per_point

const market = (offers: PassOfferCell[], over: Partial<PassMarket> = {}): PassMarket =>
  ({ ...served({ ...toBasis(JOKIC), rate_traded: 38.46, rate_build: 30.36, rate_build_from: { bucket: "5-7", rarity: "common", sales: 11 } }), offers, ...over });

// One star's cards: offers cleared near 9 a point where listings sold near 30.
const wemby = market([
  ["5-7", null, 9.18, 50, 38.46],
  ["5-7", "common", 8.93, 23, 30.36],
]);
// Another's: offers cleared above listings.
const matthews = market([["5-7", "uncommon", 30.54, 16, 20.34]]);

const card = (over: Parameters<typeof makeDeal>[0] = {}) =>
  makeDeal({ sport: "nba", season: 2025, player_id: 1001, rating: 5.2, price: 150, rarity: 1, kind: "target", ...over });

describe("dealOffer", () => {
  it("reads the card's own cell: its rating's bucket and its rarity", () => {
    expect(dealOffer(card(), wemby, QUICK)).toEqual({
      rate: 8.93, offers: 23, listing: 30.36, for_card: 46, above: false, under: false, kind: "target",
    });
  });

  it("falls back to the whole bucket for a rarity with no cell of its own, and no further", () => {
    expect(dealOffer(card({ rarity: 3 }), wemby, QUICK)).toMatchObject({ rate: 9.18, offers: 50, listing: 38.46 });
    expect(dealOffer(card({ rating: 2.5 }), wemby, QUICK)).toBeNull(); // the 0-3 bucket was not measured
  });

  it("counts a negative card by its size", () => {
    expect(dealOffer(card({ rating: -5.2 }), wemby, QUICK)).toMatchObject({ rate: 8.93, for_card: 46 });
  });

  it("says nothing under the minimum of accepted offers, even if a cell came through", () => {
    const thin = market([["5-7", "common", 8.93, OFFER_MIN_SALES - 1, 30.36]]);
    expect(dealOffer(card(), thin, QUICK)).toBeNull();
    expect(dealOffer(card(), market([["5-7", "common", 8.93, OFFER_MIN_SALES, 30.36]]), QUICK)).not.toBeNull();
  });

  it("says nothing without measured offers, for a card rated 0, or for a team pass", () => {
    expect(dealOffer(card(), JOKIC, QUICK)).toBeNull();
    expect(dealOffer(card({ rating: 0 }), wemby, QUICK)).toBeNull();
    expect(dealOffer(card(), { ...THUNDER, offers: wemby.offers }, QUICK)).toBeNull();
  });

  it("says nothing when offers cleared at or under Quick Sell, on a rate that is no number, or with no Quick Sell rule", () => {
    expect(dealOffer(card(), market([["5-7", "common", 1, 23, 30.36]]), QUICK)).toBeNull();
    expect(dealOffer(card(), market([["5-7", "common", 0.8, 23, 30.36]]), QUICK)).toBeNull();
    expect(dealOffer(card(), market([["5-7", "common", Number.NaN, 23, 30.36]]), QUICK)).toBeNull();
    expect(dealOffer(card(), market([["5-7", "common", Number.POSITIVE_INFINITY, 23, 30.36]]), QUICK)).toBeNull();
    expect(dealOffer(card(), wemby, undefined)).toBeNull();
    expect(dealOffer(card(), wemby, Number.NaN)).toBeNull();
  });

  it("knows offers that cleared at or above the same cards' listings", () => {
    expect(dealOffer(card({ rating: 5.1, price: 100, rarity: 2 }), matthews, QUICK)).toMatchObject({ rate: 30.54, listing: 20.34, above: true });
  });

  it("knows a card already priced at or under what offers cleared at", () => {
    expect(dealOffer(card({ price: 46 }), wemby, QUICK)).toMatchObject({ for_card: 46, under: true });
    expect(dealOffer(card({ price: 47 }), wemby, QUICK)).toMatchObject({ under: false });
  });
});

describe("the card's own figure, from OFFER_FIGURE_MIN Rax", () => {
  // Shelves move in steps of 10 Rax and no minimum offer was measured: "~2 for this card" could be an offer Real refuses.
  const small = market([["0-3", null, 8.93, 23, 30.36]]);

  it("is left out under 10 Rax, the rate kept", () => {
    const o = dealOffer(card({ rating: 1.1, price: 40 }), small, QUICK)!; // 8.93 x 1.1 = 9.8, said as 10
    expect(o.for_card).toBe(10);
    const tiny = dealOffer(card({ rating: 1, price: 40 }), small, QUICK)!; // 8.93: under 10
    expect(tiny).toMatchObject({ rate: 8.93, offers: 23, for_card: null, under: false });
    expect(dealOfferWords(tiny).text).toBe("Offers accepted ~8.9/pt (23 offers) · listings ~30.4/pt · ~1 in 6 accepted · needs Real Pro");
    expect(dealOfferWords(tiny).spoken).not.toMatch(/for this card/);
    expect(OFFER_FIGURE_MIN).toBe(10);
  });

  it("still says a card priced at or under the rate, and an auction ending soon", () => {
    expect(dealOfferWords(dealOffer(card({ rating: 1, price: 8 }), small, QUICK)!).text).toBe(
      "Offers accepted ~8.9/pt (23 offers) · listings ~30.4/pt · this one is at or under that rate",
    );
    expect(dealOfferWords(dealOffer(card({ rating: 1, price: 40, kind: "bid" }), small, QUICK)!).text).toBe(
      "Offers accepted ~8.9/pt (23 offers) · listings ~30.4/pt · ends too soon for an offer",
    );
  });

  it("keeps the rate even where the figure rounds to nothing", () => {
    expect(dealOffer(card({ rating: 0.04, price: 20 }), small, QUICK)).toMatchObject({ rate: 8.93, for_card: null });
  });
});

describe("dealOfferWords", () => {
  const words = (o: ReturnType<typeof dealOffer>) => dealOfferWords(o!);

  it("says what accepted offers went for, with the count, the card's own figure and the listing rate", () => {
    expect(words(dealOffer(card(), wemby, QUICK))).toEqual({
      text: "Offers accepted ~8.9/pt (23 offers): ~46 for this card · listings ~30.4/pt · ~1 in 6 accepted · needs Real Pro",
      spoken:
        "Offers on cards like it were accepted at about 8.9 Rax a rating point (23 offers): about 46 Rax for this card. Listings of the same cards sell at about 30.4 a point. About 1 in 6 offers is accepted. Making an offer needs Real Pro.",
      offerable: true,
    });
  });

  it("leaves the listing rate out when the cell has too few listing sales", () => {
    const o = dealOffer(card(), market([["5-7", "common", 8.93, 23, null]]), QUICK);
    expect(words(o).text).toBe("Offers accepted ~8.9/pt (23 offers): ~46 for this card · ~1 in 6 accepted · needs Real Pro");
    expect(words(o).spoken).not.toMatch(/Listings/);
  });

  it("says no saving where offers cleared above listings", () => {
    expect(words(dealOffer(card({ rating: 5.1, price: 100, rarity: 2 }), matthews, QUICK))).toEqual({
      text: "Offers accepted ~30.5/pt (16 offers), above listings (~20.3/pt): no saving by offer",
      spoken:
        "Offers on cards like it were accepted at about 30.5 Rax a rating point (16 offers), above what listings of the same cards sell at (about 20.3 a point): an offer saves nothing here.",
      offerable: false,
    });
  });

  it("says a card priced at or under that is already there", () => {
    expect(words(dealOffer(card({ price: 40 }), wemby, QUICK))).toEqual({
      text: "Offers accepted ~8.9/pt (23 offers): ~46 for this card · listings ~30.4/pt · this one is at or under that",
      spoken:
        "Offers on cards like it were accepted at about 8.9 Rax a rating point (23 offers): about 46 Rax for this card. Listings of the same cards sell at about 30.4 a point. This card is priced at or under that.",
      offerable: false,
    });
  });

  it("makes no offer on an auction ending soon: no time for one", () => {
    expect(words(dealOffer(card({ kind: "bid" }), wemby, QUICK))).toEqual({
      text: "Offers accepted ~8.9/pt (23 offers): ~46 for a card of this rating · listings ~30.4/pt · ends too soon for an offer",
      spoken:
        "Offers on cards like it were accepted at about 8.9 Rax a rating point (23 offers): about 46 Rax for a card of this rating. Listings of the same cards sell at about 30.4 a point. This auction ends too soon for an offer.",
      offerable: false,
    });
  });

  it("never says a percentage or a promise, and the full reading keeps the past tense", () => {
    for (const o of [dealOffer(card(), wemby, QUICK), dealOffer(card({ price: 40 }), wemby, QUICK), dealOffer(card({ rating: 5.1, rarity: 2 }), matthews, QUICK)]) {
      for (const said of [words(o).text, words(o).spoken]) {
        expect(said).not.toMatch(/%|will|guarantee|save \d/i);
        expect(said).toMatch(/\(\d+ offers\)/);
      }
      expect(words(o).text).toMatch(/^Offers accepted ~/);
      expect(words(o).spoken).toMatch(/were accepted/);
    }
  });
});
