import { describe, expect, it } from "vitest";
import type { Snapshot } from "../data/types";
import { isoAt, makeDeal, makeGone, makeSnapshot } from "../test/fixtures";
import { afterFees, chanceWords, sellAdvice, usualPrices } from "./sell";

const CURVE: [number, number][] = [[0.95, 0.99], [1.05, 0.9], [1.2, 0.29]];

describe("afterFees", () => {
  it("is what the seller keeps: 0.9 × price − 10, rounded", () => {
    expect(afterFees(200, 0.1, 10)).toBe(170);
    expect(afterFees(95, 0.1, 10)).toBe(76); // 75.5 rounds up
    expect(afterFees(5, 0.1, 10)).toBe(-5); // a loss stays a loss
  });
});

describe("chanceWords", () => {
  it("says almost always, then tenths", () => {
    expect(chanceWords(0.99)).toBe("about 99 in 100");
    expect(chanceWords(0.9)).toBe("about 9 in 10");
    expect(chanceWords(0.29)).toBe("about 3 in 10");
    expect(chanceWords(0.04)).toBe("fewer than 1 in 10");
  });
});

describe("sellAdvice", () => {
  it("lists at the first price that sells nearly every time, and draws every figure of the curve", () => {
    const a = sellAdvice(200, CURVE, 0.1, 10)!;
    expect(a.list).toBe(190);
    expect(a.afterFees).toBe(161); // 0.9 × 190 − 10
    expect(a.bars.map((b) => [b.multiple, b.price, b.chance, b.afterFees])).toEqual([
      [0.95, 190, 0.99, 161],
      [1.05, 210, 0.9, 179],
      [1.2, 240, 0.29, 206],
    ]);
  });

  it("of several points that sell nearly every time, lists at the cheapest, whatever order the curve comes in", () => {
    const a = sellAdvice(100, [[1.1, 0.5], [1, 0.96], [0.9, 0.99]], 0.1, 10)!;
    expect(a.list).toBe(90);
    expect(a.bars.map((b) => b.multiple)).toEqual([0.9, 1, 1.1]);
  });

  it("uses the safest point when none reaches 95%, and nothing without a curve", () => {
    expect(sellAdvice(100, [[1, 0.8], [1.1, 0.5]], 0.1, 10)?.list).toBe(100);
    expect(sellAdvice(100, [], 0.1, 10)).toBeNull();
    expect(sellAdvice(0, CURVE, 0.1, 10)).toBeNull();
  });
});

describe("usualPrices", () => {
  const now = Date.UTC(2026, 10, 12, 18);
  const move = (over = {}) => ({
    sport: "nba", season: 2026, player_id: 5, player_name: "Moved Man", bucket: "5-7", median_recent: 80,
    median_base: 64, change: 0.25, sales_recent: 9, ...over,
  });
  const snap = (over: Partial<Snapshot> = {}) =>
    makeSnapshot({ generated_at: isoAt(now), ...over, moves: { risers: [move()], fallers: [], ...(over.moves ?? {}) } });

  it("collects the usual prices the site serves, with their samples, from deals, gone deals and moves", () => {
    const prices = usualPrices(
      snap({
        deals: [makeDeal({ player_id: 1, player_name: "Ann", reference: 420, ref_sample: 6, bucket: "3-5" })],
        gone: [makeGone({ player_id: 2, player_name: "Bob", reference: 90, ref_sample: 5, bucket: "5-7", season: 2025 })],
      }),
    );
    expect(prices.map((p) => [p.player_name, p.season, p.bucket, p.usual, p.sample, p.source])).toEqual([
      ["Ann", 2026, "3-5", 420, 6, "sales"],
      ["Bob", 2025, "5-7", 90, 5, "sales"],
      ["Moved Man", 2026, "5-7", 80, 9, "today"],
    ]);
  });

  it("keeps one price per player, season and rating band: a week of sales before today's moves before Real's estimate", () => {
    const prices = usualPrices(
      snap({
        deals: [
          makeDeal({ listing_id: 1, player_id: 5, bucket: "5-7", reference: 100, ref_sample: 7, ref_source: "sales" }),
          makeDeal({ listing_id: 2, player_id: 6, bucket: "5-7", reference: 55, ref_sample: 3, ref_source: "fmv", confidence: "medium" }),
          makeDeal({ listing_id: 3, player_id: 6, bucket: "5-7", reference: 55, ref_sample: 3, ref_source: "fmv", confidence: "medium", kind: "bid" }),
        ],
        moves: { risers: [move({ player_id: 6, player_name: "Test Player", median_recent: 60, sales_recent: 12 })], fallers: [] },
      }),
    );
    const byPlayer = Object.fromEntries(prices.map((p) => [p.player_id, p]));
    expect(byPlayer[5]).toMatchObject({ usual: 100, sample: 7, source: "sales" });
    expect(byPlayer[6]).toMatchObject({ usual: 60, sample: 12, source: "today" });
    expect(prices.filter((p) => p.player_id === 6)).toHaveLength(1);
  });

  it("falls back to Real's estimate when it is all there is, and lists names in order", () => {
    const prices = usualPrices(
      snap({
        deals: [
          makeDeal({ player_id: 9, player_name: "Zed", ref_source: "fmv", reference: 50, ref_sample: 4 }),
          makeDeal({ listing_id: 2, player_id: 8, player_name: "Abe", season: 2024, bucket: "1-3", reference: 20 }),
          makeDeal({ listing_id: 3, player_id: 8, player_name: "Abe", season: 2026, bucket: "1-3", reference: 25 }),
        ],
        moves: { risers: [], fallers: [] },
      }),
    );
    expect(prices.map((p) => [p.player_name, p.season])).toEqual([["Abe", 2026], ["Abe", 2024], ["Zed", 2026]]);
    expect(prices.at(-1)?.source).toBe("fmv");
  });
});
