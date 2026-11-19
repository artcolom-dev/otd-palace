import { describe, expect, it } from "vitest";
import { OTD_RULES, makeDeal } from "../test/fixtures";
import { JOKIC, OLIVEIRA, THUNDER, TODAY, passSnapshot, served } from "../test/passScene";
import { visibleDeals } from "../data/deals";
import type { PassMarket } from "../data/types";
import { OFFER_LEVEL } from "./offers";
import { dealPass, dealPassMarket, dealPassWords, passMarketIndex, passSortValue } from "./dealPass";
import { paybackAtCost, toBasis } from "./passes";

// Jokić 2024-25 (nba:2025:player:1001): cards trade at 10 Rax a rating point; Common needs 10 rating (+ the 200 mint).
const jokicCard = (over: Parameters<typeof makeDeal>[0] = {}) =>
  makeDeal({ sport: "nba", season: 2025, player_id: 1001, player_name: "Nikola Jokić", rating: 6, price: 54, per_point: 9, ...over });

const index = passMarketIndex([JOKIC, OLIVEIRA, THUNDER]);
const rung = (m: PassMarket, tier: string) => m.rungs.find((r) => r.tier === tier)!;

describe("dealPassMarket", () => {
  it("finds the pass a card builds: the same sport, season and player", () => {
    expect(dealPassMarket(jokicCard(), index)?.key).toBe(JOKIC.key);
  });

  it("finds a fighter's pass for a UFC card", () => {
    const card = makeDeal({ sport: "ufc", season: 2025, player_id: 5001 });
    expect(dealPassMarket(card, index)?.key).toBe(OLIVEIRA.key);
  });

  it("never matches another season of the same player: a 2026-27 card does not build the 2024-25 pass", () => {
    expect(dealPassMarket(jokicCard({ season: 2026 }), index)).toBeNull();
  });

  it("never matches a team pass, whose id is a team's and can equal a player's", () => {
    // The Thunder's pass carries team id 101; a player whose own id is 101 is not the Thunder.
    expect(dealPassMarket(makeDeal({ sport: "nba", season: 2025, player_id: 101 }), index)).toBeNull();
  });
});

describe("dealPass", () => {
  it("counts the card's rating toward the next rarity, priced against the pass's usual rate", () => {
    const dp = dealPass(jokicCard(), JOKIC, OTD_RULES, TODAY)!;
    expect(dp.rating).toBe(6);
    expect(dp.held).toBe(0);
    expect(dp.target.tier).toBe("common");
    expect(dp.need).toBe(10);
    expect(dp.reaches).toBe(false);
    expect(dp.per_point).toBe(9);
    expect(dp.usual_rate).toBe(10);
    expect(dp.offer_rate).toBeCloseTo(10 * OFFER_LEVEL);
    expect(dp.price_vs).toBe("under_usual");
  });

  it("is the pass's own cost with this card in it: the card's price instead of its rating at the usual rate", () => {
    const dp = dealPass(jokicCard(), JOKIC, OTD_RULES, TODAY)!;
    const common = rung(JOKIC, "common");
    expect(dp.cost_with).toBeCloseTo(common.cost! - 6 * 10 + 54);
    expect(dp.year_per_rax).toBeCloseTo(common.year_rax / dp.cost_with!);
  });

  it("says what the rarity pays when the card alone brings the pass to it", () => {
    const dp = dealPass(jokicCard({ rating: 12, price: 96, per_point: 8 }), JOKIC, OTD_RULES, TODAY)!;
    const common = rung(JOKIC, "common");
    expect(dp.reaches).toBe(true);
    expect(dp.target.tier).toBe("common");
    expect(dp.year_rax).toBeCloseTo(common.year_rax);
    const back = paybackAtCost(toBasis(JOKIC), common, dp.cost_with!, OTD_RULES, TODAY);
    expect(dp.payback_months).toBeCloseTo(back.months!);
  });

  it("starts from the rating the visitor holds: 25 held and a 6 brings it to Uncommon (30)", () => {
    const dp = dealPass(jokicCard(), JOKIC, OTD_RULES, TODAY, { rating: 25 })!;
    expect(dp.held).toBe(25);
    expect(dp.target.tier).toBe("uncommon");
    expect(dp.need).toBe(5);
    expect(dp.reaches).toBe(true);
    // Held: no mint to pay, and only the 5 points short are bought.
    expect(dp.target.cost).toBeCloseTo(5 * 10);
    expect(dp.cost_with).toBeCloseTo(54);
  });

  it("calls a card at or under the offer level cheaper than an offer, and one over the usual rate dearer", () => {
    expect(dealPass(jokicCard({ price: 48, per_point: 8 }), JOKIC, OTD_RULES, TODAY)!.price_vs).toBe("under_offer");
    expect(dealPass(jokicCard({ price: 120, per_point: 20 }), JOKIC, OTD_RULES, TODAY)!.price_vs).toBe("over_usual");
  });

  it("offers on a starting card only: 80% of the pass's usual rate times its rating, when that is under its price", () => {
    const dp = dealPass(jokicCard(), JOKIC, OTD_RULES, TODAY)!;
    expect(dp.offer).toBe(Math.round(OFFER_LEVEL * 10 * 6)); // 48 < 54
    expect(dealPass(jokicCard({ kind: "bid" }), JOKIC, OTD_RULES, TODAY)!.offer).toBeNull(); // an auction ending soon
    expect(dealPass(jokicCard({ price: 48, per_point: 8 }), JOKIC, OTD_RULES, TODAY)!.offer).toBeNull(); // not under
    // Dearer than the pass's usual rate: an offer that far under the asking price is not worth suggesting.
    expect(dealPass(jokicCard({ price: 120, per_point: 20 }), JOKIC, OTD_RULES, TODAY)!.offer).toBeNull();
  });

  it("counts a negative card by its size, as the engine does", () => {
    expect(dealPass(jokicCard({ rating: -6 }), JOKIC, OTD_RULES, TODAY)!.rating).toBe(6);
  });

  it("is nothing for a card rated 0, a pass with no rarity that pays back, or a team pass", () => {
    expect(dealPass(jokicCard({ rating: 0, per_point: null }), JOKIC, OTD_RULES, TODAY)).toBeNull();
    expect(dealPass(makeDeal({ sport: "ufc", season: 2025, player_id: 5001 }), OLIVEIRA, OTD_RULES, TODAY)).toBeNull();
    expect(dealPass(makeDeal({ sport: "nba", season: 2025, player_id: 101 }), THUNDER, OTD_RULES, TODAY)).toBeNull();
  });

  it("gives no price comparison when the pass's cards have no traded rate", () => {
    const noRate = { ...JOKIC, rate_traded: null };
    const dp = dealPass(jokicCard(), noRate, OTD_RULES, TODAY);
    expect(dp).toBeNull(); // no rung can be priced, so none is known to pay back
  });
});

describe("dealPassWords", () => {
  const dp = dealPass(jokicCard(), JOKIC, OTD_RULES, TODAY)!;
  const reach = dealPass(jokicCard({ rating: 12, price: 96, per_point: 8 }), JOKIC, OTD_RULES, TODAY)!;

  it("says the share of the next rarity and the price per point against the usual, at every level", () => {
    for (const level of ["new", "regular", "pro"] as const) {
      const w = dealPassWords(dp, level);
      expect(w.line).toMatch(/6 of the 10|6\/10/);
      expect(w.line).toMatch(/Common/);
      expect(w.line).toMatch(/9\.0/);
      expect(w.line).toMatch(/10\.0/);
    }
  });

  it("New names the player and season, so the pass is clear without Real's words", () => {
    expect(dealPassWords(dp, "new").line).toContain("Nikola Jokić 2024-25");
  });

  it("says what the rarity pays and when it pays back once the card reaches it, as an estimate", () => {
    const w = dealPassWords(reach, "regular");
    expect(w.pay).toMatch(/a year/);
    expect(w.pay).toMatch(/back in/);
    expect(dealPassWords(dp, "regular").pay).toBeNull();
  });

  it("states the offer with the measured odds and never calls the 80% measured", () => {
    for (const level of ["new", "regular", "pro"] as const) {
      const offer = dealPassWords(dp, level).offer!;
      expect(offer).toMatch(/48/);
      expect(offer).toMatch(/1 in 6/);
      expect(offer).not.toMatch(/measured/i);
    }
  });

  it("says every offer needs Real Pro, in plain words", () => {
    for (const level of ["new", "regular", "pro"] as const) {
      expect(dealPassWords(dp, level).offer).toMatch(/Offers need Real Pro/);
      expect(dealPassWords(dp, level).offer).not.toMatch(/both sides|seller's|each side/);
    }
    expect(dealPassWords(dp, "regular").offer).toContain("Offers need Real Pro.");
  });

  it("says a card under the offer level needs no offer, and one over the usual rate is a dear way to build it", () => {
    const cheap = dealPass(jokicCard({ price: 48, per_point: 8 }), JOKIC, OTD_RULES, TODAY)!;
    expect(dealPassWords(cheap, "regular").offer).toMatch(/cheaper than an offer/i);
    const dear = dealPass(jokicCard({ price: 120, per_point: 20 }), JOKIC, OTD_RULES, TODAY)!;
    expect(dealPassWords(dear, "regular").offer).toMatch(/other cards/i);
    for (const level of ["new", "regular", "pro"] as const) {
      expect(dealPassWords(dear, level).offer).toMatch(/[Oo]ffers need Real Pro/);
      expect(dealPassWords(dear, level).offer).not.toMatch(/both sides|seller's|each side/);
    }
  });
});

describe("passSortValue", () => {
  it("is each deal's pass return per Rax with the card in it; null for a deal that builds no tracked pass", () => {
    const snap = passSnapshot({ deals: [] });
    const value = passSortValue(snap);
    const card = jokicCard();
    expect(value(card)).toBeCloseTo(dealPass(card, JOKIC, OTD_RULES, TODAY)!.year_per_rax!);
    expect(value(makeDeal({ sport: "nba", season: 2027, player_id: 9999 }))).toBeNull();
  });

  it("puts the deal that builds a pass first in the visible list under the For passes sort", () => {
    const card = jokicCard({ listing_id: 77, flip_margin: -5 });
    const snap = passSnapshot({ deals: [makeDeal({ listing_id: 1, flip_margin: 300 }), card] });
    const prefs = { level: "pro" as const, budget: null, sport: "all", sort: "passes" as const, tab: "deals" as const, passBudget: null };
    const shown = visibleDeals(snap, prefs, new Set(), Date.parse(snap.generated_at));
    expect(shown[0]!.listing_id).toBe(77);
  });
});

describe("dealPassWords wording", () => {
  it("never says about twice", () => {
    const dp = dealPass(jokicCard({ rating: 12, price: 96, per_point: 8 }), JOKIC, OTD_RULES, TODAY)!;
    expect(dealPassWords(dp, "regular").pay).not.toMatch(/about about/);
  });
});

describe("dealPass on the feed's build rate and measured offers", () => {
  const wemby = served({
    ...toBasis(JOKIC),
    rate_traded: 38.46,
    rate_build: 30.36,
    rate_build_from: { bucket: "5-7", rarity: "common", sales: 11 },
    offers: [
      ["5-7", null, 9.18, 50, 38.46],
      ["5-7", "common", 8.93, 23, 30.36],
    ],
  });
  const matthews = served({
    ...toBasis(JOKIC),
    rate_traded: 19.12,
    rate_build: 20.34,
    rate_build_from: { bucket: "5-7", rarity: "uncommon", sales: 7 },
    offers: [["5-7", "uncommon", 30.54, 16, 20.34]],
  });

  it("weighs the card against the build rate, and offers what offers on its own cell cleared at", () => {
    const dp = dealPass(jokicCard({ rating: 5.2, price: 150, rarity: 1, kind: "target" }), wemby, OTD_RULES, TODAY)!;
    expect(dp.usual_rate).toBe(30.36);
    expect(dp.price_vs).toBe("under_usual");
    expect(dp.offer_rate).toBe(8.93);
    expect(dp.offer_measured).toEqual({ offers: 23, vs: "far_below" });
    expect(dp.offer).toBe(Math.round(8.93 * 5.2));
    expect(dp.cost_with).toBeCloseTo(rung(wemby, "common").cost! - 5.2 * 30.36 + 150);
    expect(dealPassWords(dp, "regular").offer).toBe("Or offer about 46: offers on cards like it cleared near 8.9 a point; about 1 in 6 is accepted. Offers need Real Pro.");
  });

  it("makes no offer where offers clear above listings, and says so", () => {
    const dp = dealPass(jokicCard({ rating: 5.1, price: 100, rarity: 2, kind: "target" }), matthews, OTD_RULES, TODAY)!;
    expect(dp.price_vs).toBe("under_usual");
    expect(dp.offer_measured).toEqual({ offers: 16, vs: "above" });
    expect(dp.offer).toBeNull();
    expect(dealPassWords(dp, "pro").offer).toBe("Offers clear above listings here (~30.5/pt, 16 accepted): no offer");
  });

  it("keeps the fixed share for a card whose cell has no measured offers", () => {
    const dp = dealPass(jokicCard({ rating: 2.5, price: 70, rarity: 1, kind: "target" }), wemby, OTD_RULES, TODAY)!; // 0-3
    expect(dp.offer_measured).toBeNull();
    expect(dp.offer_rate).toBeCloseTo(30.36 * OFFER_LEVEL);
  });
});
