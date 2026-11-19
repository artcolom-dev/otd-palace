import { describe, expect, it } from "vitest";
import { makeDeal } from "../test/fixtures";
import {
  afterFeesText,
  clockText,
  clockTone,
  foldName,
  initials,
  perPointText,
  rarityName,
  realEstimateText,
  recentSalesText,
  seenText,
  sportLabel,
} from "./words";

const NOW = Date.parse("2026-11-12T18:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("sportLabel", () => {
  it.each([
    ["nba", "NBA"],
    ["nfl", "NFL"],
    ["mlb", "MLB"],
    ["nhl", "NHL"],
    ["soccer", "Soccer"],
    ["f1", "F1"],
    ["cricket", "Cricket"],
  ])("%s reads %s", (sport, label) => expect(sportLabel(sport)).toBe(label));
});

describe("rarityName", () => {
  it("names Real's rarities by index, and nothing for an unknown one", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(rarityName)).toEqual([
      "General", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mystic", "Iconic",
    ]);
    expect(rarityName(9)).toBe("");
  });
});

describe("seenText", () => {
  it("says nothing while the listing was read under 2 minutes ago, or at the snapshot's own moment", () => {
    expect(seenText(makeDeal(), NOW)).toBe("");
    expect(seenText(makeDeal({ seen_at: null }), NOW)).toBe("");
    expect(seenText(makeDeal({ seen_at: at(-119_000) }), NOW)).toBe("");
  });

  it("says when an older read was, so a bid shown may have moved", () => {
    expect(seenText(makeDeal({ seen_at: at(-12 * 60_000 - 5_000) }), NOW)).toBe("checked 12 m ago");
    expect(seenText(makeDeal({ seen_at: at(-125 * 60_000) }), NOW)).toBe("checked 2 h ago");
    expect(seenText(makeDeal({ seen_at: "soon" }), NOW)).toBe("");
  });
});

describe("clockText", () => {
  it("says how long ago a target deal was listed", () => {
    expect(clockText(makeDeal({ listed_at: at(-20_000) }), NOW)).toBe("listed just now");
    expect(clockText(makeDeal({ listed_at: at(-3 * 60_000 - 5_000) }), NOW)).toBe("listed 3 m ago");
    expect(clockText(makeDeal({ listed_at: at(-125 * 60_000) }), NOW)).toBe("listed 2 h ago");
  });

  it("reads as the end of a sentence when asked: a capital, and minutes spelled out", () => {
    expect(clockText(makeDeal({ listed_at: at(-19 * 60_000) }), NOW, true)).toBe("Listed 19 min ago.");
    expect(clockText(makeDeal({ listed_at: at(-20_000) }), NOW, true)).toBe("Listed just now.");
    expect(clockText(makeDeal({ kind: "bid", ends_at: at(22 * 60_000 + 14_000) }), NOW, true)).toBe("Ends in 22 min.");
    expect(clockText(makeDeal({ kind: "bid", ends_at: at(4 * 60_000 + 10_000) }), NOW, true)).toBe("Ends in 4:10.");
    expect(clockText(makeDeal({ kind: "bid", ends_at: at(65 * 60_000) }), NOW, true)).toBe("Ends in 1 h 05 min.");
  });

  it("falls back to the end time when a target deal has no listing time", () => {
    expect(clockText(makeDeal({ listed_at: null, ends_at: at(22 * 60_000) }), NOW)).toBe("ends in 22 m");
  });

  it("says when a bid deal's auction ends: minutes, then minutes and seconds under 10 minutes", () => {
    const bid = (ms: number) => makeDeal({ kind: "bid", ends_at: at(ms) });
    expect(clockText(bid(22 * 60_000 + 14_000), NOW)).toBe("ends in 22 m");
    expect(clockText(bid(65 * 60_000), NOW)).toBe("ends in 1 h 05 m");
    expect(clockText(bid(4 * 60_000 + 10_000), NOW)).toBe("ends in 4:10");
    expect(clockText(bid(49_000), NOW)).toBe("ends in 0:49");
    expect(clockText(bid(-1_000), NOW)).toBe("ended");
  });
});

describe("clockTone", () => {
  it("turns a bid's clock orange under a minute and bright under ten", () => {
    const bid = (ms: number) => makeDeal({ kind: "bid", ends_at: at(ms) });
    expect(clockTone(bid(49_000), NOW)).toBe("hot");
    expect(clockTone(bid(5 * 60_000), NOW)).toBe("soon");
    expect(clockTone(bid(25 * 60_000), NOW)).toBe("");
    expect(clockTone(makeDeal({ ends_at: at(30_000) }), NOW)).toBe("");
  });
});

describe("afterFeesText", () => {
  it("signs a gain, writes a loss with a real minus sign, and zero as is", () => {
    expect(afterFeesText(158)).toBe("+158");
    expect(afterFeesText(1234)).toBe("+1,234");
    expect(afterFeesText(-12)).toBe("−12");
    expect(afterFeesText(0)).toBe("0");
  });
});

describe("perPointText", () => {
  it("keeps one decimal under 100, none from 100, and a dash when there is none", () => {
    expect(perPointText(20.34)).toBe("20.3");
    expect(perPointText(141.2)).toBe("141");
    expect(perPointText(1412)).toBe("1,412");
    expect(perPointText(null)).toBe("—");
  });
});

describe("initials and foldName", () => {
  it("draws a monogram from the first and last name", () => {
    expect(initials("Ja'Marr Chase")).toBe("JC");
    expect(initials("Nikola Jokić")).toBe("NJ");
    expect(initials("Pelé")).toBe("P");
  });

  it("folds accents and case for search", () => {
    expect(foldName("Nikola JOKIĆ")).toBe("nikola jokic");
  });
});

describe("realEstimateText", () => {
  it("says how far Real's own estimate is from the sales, only when the usual price is from sales", () => {
    expect(realEstimateText(makeDeal({ ref_source: "sales", reference: 420, real_estimate: 560 }))).toBe(
      "Real's own estimate says 560, 33% above what this card really sold for. We go by the sales.",
    );
    expect(realEstimateText(makeDeal({ ref_source: "sales", reference: 400, real_estimate: 300 }))).toMatch(/25% below/);
    expect(realEstimateText(makeDeal({ ref_source: "sales", reference: 420, real_estimate: null }))).toBe("");
    expect(realEstimateText(makeDeal({ ref_source: "fmv", reference: 420, real_estimate: 560 }))).toBe("");
  });
});

describe("recentSalesText", () => {
  it("lists the newest sales behind the usual price, and says how recent the newest is", () => {
    expect(recentSalesText(makeDeal({ recent_sales: [[420, 3600], [400, 7200], [380, 90_000]] }))).toBe("420 · 400 · 380 Rax, the newest 1 h ago");
    expect(recentSalesText(makeDeal({ recent_sales: [[1200, 300]] }))).toBe("1,200 Rax, 5 m ago");
    expect(recentSalesText(makeDeal({ recent_sales: [[50, 200_000]] }))).toBe("50 Rax, 2 days ago");
    expect(recentSalesText(makeDeal({ recent_sales: [] }))).toBe("");
    expect(recentSalesText(makeDeal())).toBe("");
  });
});
