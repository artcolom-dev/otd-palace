import { describe, expect, it } from "vitest";
import { OTD_RULES } from "../test/fixtures";
import { OFFER_ACCEPTED, OFFER_ACCEPTED_SMALL, oneIn } from "../lib/offers";
import { GLOSSARY, type TermKey, explain, shortOf } from "./glossary";

describe("glossary: every word on screen has a plain explanation", () => {
  it("covers each term the screens use", () => {
    const keys: TermKey[] = ["rating", "usual", "start", "bid", "under", "perPoint", "fees", "thin", "falling", "realMinted"];
    for (const key of keys) {
      expect(GLOSSARY[key].title).not.toBe("");
      expect(explain(key, { n: 5 })).not.toBe("");
    }
  });

  it("uses the agreed words", () => {
    expect(explain("usual", { n: 14 })).toBe("Middle price of the last 14 sales of this card type, past 7 days.");
    expect(explain("start")).toBe(
      "Bid this to start a 10-min countdown. Others can still outbid you; a bid in the last minute adds a minute.",
    );
    expect(explain("fees")).toBe("If you resold at the usual price: Real keeps 10% and a normal listing costs 10 Rax (Quick List has no fee).");
    expect(explain("falling")).toBe("Prices for this card dropped today; the usual price may be out of date.");
    expect(explain("realMinted")).toBe("Real's own listings are unlimited supply, so they are never deals.");
    expect(GLOSSARY.realMinted.title).toBe("Real-minted listings are hidden");
  });

  it("explains every word of the Passes tab", () => {
    const keys: TermKey[] = [
      "otd", "claims", "passYear", "perGameDay", "payback", "limit", "limitCost", "buildCost", "onSale", "typical",
      "projection", "estimate", "weak", "team", "never", "breakEven", "fill", "myPasses", "bestForBudget", "soon",
    ];
    for (const key of keys) {
      expect(GLOSSARY[key].title).not.toBe("");
      expect(explain(key).length).toBeGreaterThan(30);
    }
    expect(explain("claims")).toContain("2 passes per sport each day");
    expect(explain("breakEven")).toContain("never recommend");
    expect(explain("claims")).toContain("Real Pro: one extra claim a day across all sports, through the bonus poll");
    expect(explain("otd")).toContain("also pays after each game");
    expect(explain("limit")).toContain("1,500 at Common up to 48,000 at Mystic");
    expect(explain("limit")).toContain("General pays nothing On This Day");
    expect(explain("estimate")).not.toMatch(/fighter/);
    expect(explain("buildCost")).toContain("800 for a fighter");
    // No figure the data does not give: the traded rate's window is not served, so no "90 days".
    expect(keys.map((k) => explain(k)).join(" ")).not.toMatch(/90 days/);
  });

  it("explains the moves and the saved total in the visitor's terms", () => {
    expect(GLOSSARY.saved.title).toBe("Saved with OTD Palace");
    expect(explain("saved")).toBe("Counted on this device from deals you marked.");
    expect(explain("moves")).toContain("last 7 days");
  });

  it("says when the usual price is Real's own estimate rather than our count of sales", () => {
    expect(explain("usual", { n: 4, fmv: true })).toBe(
      "Real's own estimate for this card type, backed by 4 recent sales: too few for us to count on our own.",
    );
  });
});

describe("glossary: Real's own words, for someone new", () => {
  const BEGINNER: TermKey[] = ["pass", "rarity", "general", "lift", "livePay", "claim", "booster", "quickList", "mint", "offer", "yearBack"];

  it("explains every word a beginner meets in the advice, with a one-line version for a hover", () => {
    for (const key of BEGINNER) {
      expect(GLOSSARY[key].title).not.toBe("");
      expect(explain(key).length).toBeGreaterThan(40);
      const short = shortOf(key);
      expect(short.length).toBeGreaterThan(15);
      expect(short.length).toBeLessThanOrEqual(120);
      expect(short).not.toContain("\n");
    }
  });

  it("gives every term a one-line version, its own or the first sentence of its text", () => {
    for (const key of Object.keys(GLOSSARY) as TermKey[]) expect(shortOf(key).length).toBeLessThanOrEqual(160);
  });

  it("says offers as measured: most refused, the accepted ones cheap, the 12-hour auction, Real Pro", () => {
    const text = explain("offer");
    expect(text).toContain(`about 1 in ${oneIn(OFFER_ACCEPTED)} was accepted`);
    expect(text).toContain(`1 in ${oneIn(OFFER_ACCEPTED_SMALL)}`);
    expect(text).not.toMatch(/tool|scan|account|bot|fleet/i); // never who was read
    expect(text).toContain("12-hour auction");
    expect(text).toContain("Real Pro");
  });

  it("says making an offer needs Real Pro, plainly", () => {
    expect(explain("offer")).toContain("Making an offer needs Real Pro.");
    expect(explain("offer")).not.toMatch(/each side|card holder's|both sides/);
  });

  it("says the rarity ladder the planner runs on", () => {
    const ladder = OTD_RULES.ladders.player!;
    const at = (tier: string) => ladder.find(([t]) => t === tier)!;
    expect(explain("rarity")).toContain(`Common at ${at("common")[1]} rating`);
    expect(explain("rarity")).toContain(`Iconic at ${at("iconic")[1].toLocaleString("en-US")}`);
    expect(explain("rarity")).toContain(`Common ${at("common")[2]}×, Legendary ${at("legendary")[2]}×, Iconic ${at("iconic")[2]}×`);
  });

  it("never calls a General a pass that pays On This Day", () => {
    expect(explain("general")).toContain("pays nothing On This Day");
  });
});
