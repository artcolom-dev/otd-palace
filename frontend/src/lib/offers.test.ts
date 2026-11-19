import { describe, expect, it } from "vitest";
import { OTD_RULES } from "../test/fixtures";
import { CHASE, JOKIC, MACKINNON, TODAY, WEMBANYAMA, served } from "../test/passScene";
import { OFFER_ACCEPTED, OFFER_ACCEPTED_SMALL, OFFER_LEVEL, offerHint, offerWords, oneIn } from "./offers";
import { rungs, toBasis } from "./passes";

const rungOf = (m: typeof JOKIC, tier: string) => m.rungs.find((r) => r.tier === tier)!;

describe("the offer figures", () => {
  it("are the measured acceptance and the deal line, as advisor/rules.py says them", () => {
    expect(OFFER_ACCEPTED).toBe(0.18);
    expect(OFFER_ACCEPTED_SMALL).toBe(0.06);
    expect(OFFER_LEVEL).toBe(0.8);
  });

  it("say how many offers one accepted card takes, as a person would", () => {
    expect(oneIn(OFFER_ACCEPTED)).toBe(6); // 1 / 0.18 = 5.6
    expect(oneIn(OFFER_ACCEPTED_SMALL)).toBe(17); // 1 / 0.06 = 16.7
  });
});

describe("offerHint", () => {
  it("prices the rating at the offer level, the mint unchanged, on the engine's own walk", () => {
    const rung = rungOf(JOKIC, "legendary"); // 380 rating at 10 a point, plus the 200 mint
    const hint = offerHint(JOKIC, rung, OTD_RULES, TODAY)!;
    expect(hint.usual_rate).toBe(10);
    expect(hint.rate).toBeCloseTo(8);
    expect(hint.cost).toBeCloseTo(200 + 380 * 8);
    expect(hint.saved).toBeCloseTo(380 * 2);
    // The same as the engine run on a market whose cards trade at the offer level.
    const cheap = rungs({ ...toBasis(JOKIC), rate_traded: 8 }, OTD_RULES, { today: TODAY }).find((r) => r.tier === "legendary")!;
    expect(hint.cost).toBeCloseTo(cheap.cost!);
    expect(hint.payback_months).toBeCloseTo(cheap.payback_months!);
    expect(hint.payback_month).toBe(cheap.payback_month);
    expect(hint.payback_months!).toBeLessThan(rung.payback_months!);
  });

  it("counts from the rating a holder already has (a lift needs no mint)", () => {
    const lift = rungs(toBasis(MACKINNON), OTD_RULES, { today: TODAY, heldRating: 10, minted: true }).find((r) => r.tier === "epic")!;
    const hint = offerHint(MACKINNON, lift, OTD_RULES, TODAY)!;
    expect(hint.cost).toBeCloseTo(lift.rating_to_add * 5.5 * 0.8);
    expect(hint.saved).toBeCloseTo(lift.cost! - hint.cost);
  });

  it("has nothing to say when there is no card to buy or no price to start from", () => {
    expect(offerHint(WEMBANYAMA, rungOf(WEMBANYAMA, "general"), OTD_RULES, TODAY)).toBeNull(); // the mint alone
    expect(offerHint({ ...JOKIC, rate_traded: null }, rungOf(JOKIC, "common"), OTD_RULES, TODAY)).toBeNull();
    expect(offerHint(JOKIC, { ...rungOf(JOKIC, "common"), cost: null }, OTD_RULES, TODAY)).toBeNull();
  });

  it("works for a season being played, whose live games also pay", () => {
    const rung = rungOf(CHASE, "legendary");
    const hint = offerHint(CHASE, rung, OTD_RULES, TODAY)!;
    expect(hint.cost).toBeLessThan(rung.cost!);
    expect(hint.payback_months!).toBeLessThanOrEqual(rung.payback_months!);
  });
});

describe("offerWords", () => {
  const rung = rungOf(JOKIC, "legendary"); // 4,000 to build, about 3,200 by offers
  const hint = offerHint(JOKIC, rung, OTD_RULES, TODAY)!;

  it("says it plainly at New: what to offer on a card, that most are refused, what it could cost", () => {
    expect(offerWords(hint, rung, "new")).toBe(
      "Cheaper with offers: in Real, offer less than the asking price on many of its cards, about 8.0 Rax per rating point (a 5-rating card: about 40 Rax; the usual is 10 a point). Most are refused; if enough are accepted, it costs about 3,200 instead of 4,000 and pays back in about 2 months.",
    );
  });

  it("keeps a decimal at New under 10 a point, so the 20% shows", () => {
    const nhl = offerHint(MACKINNON, rungOf(MACKINNON, "legendary"), OTD_RULES, TODAY)!;
    expect(offerWords(nhl, rungOf(MACKINNON, "legendary"), "new")).toContain("about 4.4 Rax per rating point (a 5-rating card: about 22 Rax; the usual is 5.5 a point)");
  });

  it("gives the figures at Regular, with the measured acceptance", () => {
    expect(offerWords(hint, rung, "regular")).toBe(
      "Cheaper with offers: about 8.0 Rax a rating point (usual 10.0), on many cards. About 1 in 6 is accepted; if enough are, about 3,200 instead of 4,000, back in about 2 months.",
    );
  });

  it("is one short line at Pro", () => {
    expect(offerWords(hint, rung, "pro")).toBe("Offers at 80%: 8.0/pt → 3,200 (−760), back in 2 mo. ~1 in 6 accepted.");
  });
});

describe("offers measured by the feed (accepted offers by bucket and rarity)", () => {
  // The Wembanyama probe: the build cell is common 5-7 at 30.36; its accepted offers cleared at 8.93 (23 of them).
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
  // The Matthews probe: the build cell is uncommon 5-7 at 20.34; accepted offers cleared at 30.54 (16): above listings.
  const matthews = served({
    ...toBasis(MACKINNON),
    rate_traded: 19.12,
    rate_build: 20.34,
    rate_build_from: { bucket: "5-7", rarity: "uncommon", sales: 7 },
    offers: [["5-7", "uncommon", 30.54, 16, 20.34]],
  });

  it("prices the cards at what accepted offers cleared at on the build cell, and says they clear far below listings", () => {
    const rung = rungOf(wemby, "legendary");
    expect(rung.cost).toBeCloseTo(200 + 380 * 30.36);
    const hint = offerHint(wemby, rung, OTD_RULES, TODAY)!;
    expect(hint.usual_rate).toBe(30.36);
    expect(hint.rate).toBe(8.93);
    expect(hint.saved).toBeCloseTo(380 * (30.36 - 8.93));
    expect(hint.cost).toBeCloseTo(200 + 380 * 8.93);
    expect(hint.measured).toEqual({ offers: 23, listing: 30.36, vs: "far_below" });
    expect(offerWords(hint, rung, "regular")).toContain("accepted offers cleared at about 8.9 Rax a rating point (23 of them; usual 30.4), far under listings");
    expect(offerWords(hint, rung, "pro")).toContain("Offers clear ~8.9/pt (23 accepted, far under listings)");
  });

  it("saves nothing when offers clear above listings, and says to buy listed cards", () => {
    const rung = rungOf(matthews, "legendary");
    const hint = offerHint(matthews, rung, OTD_RULES, TODAY)!;
    expect(hint.measured).toEqual({ offers: 16, listing: 20.34, vs: "above" });
    expect(hint.saved).toBe(0);
    expect(hint.cost).toBe(rung.cost);
    expect(offerWords(hint, rung, "new")).toBe(
      "Offers do not help here: accepted offers on these cards cleared at about 31 Rax a rating point, more than listed cards sell for (about 20). Buy listed cards instead.",
    );
    expect(offerWords(hint, rung, "pro")).toBe("Offers clear above listings here: ~30.5/pt (16 accepted) vs 20.3 listed. Buy listings.");
  });

  it("falls back to the whole bucket's offers, then to the fixed share of the build rate", () => {
    const bucketOnly = served({ ...toBasis(wemby), rate_build_from: { bucket: "5-7", rarity: "rare", sales: 7 } });
    expect(offerHint(bucketOnly, rungOf(bucketOnly, "common"), OTD_RULES, TODAY)!.rate).toBe(9.18);
    const none = served({ ...toBasis(wemby), offers: [] });
    const hint = offerHint(none, rungOf(none, "common"), OTD_RULES, TODAY)!;
    expect(hint.measured).toBeNull();
    expect(hint.rate).toBeCloseTo(30.36 * OFFER_LEVEL);
    expect(hint.level).toBe(OFFER_LEVEL);
  });

  it("a pass served without the new fields keeps today's hint", () => {
    const hint = offerHint(JOKIC, rungOf(JOKIC, "legendary"), OTD_RULES, TODAY)!;
    expect(hint.measured).toBeNull();
    expect(offerWords(hint, rungOf(JOKIC, "legendary"), "pro")).toBe("Offers at 80%: 8.0/pt → 3,200 (−760), back in 2 mo. ~1 in 6 accepted.");
  });
});
