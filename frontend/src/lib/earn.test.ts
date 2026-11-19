import { describe, expect, it } from "vitest";
import { RULES } from "../test/fixtures";
import { STREAK_MAX, bestStreak, guideTier, saleCompare, streakDaily, streakPay } from "./earn";

describe("guideTier", () => {
  it("opens the plan of the visitor's level when no balance is known", () => {
    expect(guideTier("new", null)).toBe("start");
    expect(guideTier("regular", null)).toBe("beginner");
    expect(guideTier("pro", null)).toBe("growing");
  });

  it("follows the balance the visitor typed, whatever the level", () => {
    expect(guideTier("pro", 150)).toBe("start");
    expect(guideTier("new", 299)).toBe("start");
    expect(guideTier("new", 300)).toBe("beginner");
    expect(guideTier("pro", 9_999)).toBe("beginner");
    expect(guideTier("new", 10_000)).toBe("growing");
    expect(guideTier("new", 99_999)).toBe("growing");
    expect(guideTier("regular", 100_000)).toBe("big");
  });
});

describe("saleCompare", () => {
  it("takes Real's share and the listing fee from the site's own rules, and leaves the fee out for Quick List", () => {
    expect(saleCompare(100, RULES.fee, RULES.listing_fee)).toEqual({ price: 100, normal: 80, quick: 90 });
    expect(saleCompare(500, RULES.fee, RULES.listing_fee)).toEqual({ price: 500, normal: 440, quick: 450 });
  });

  it("says when a small sale leaves nothing after a normal listing", () => {
    expect(saleCompare(10, RULES.fee, RULES.listing_fee)).toEqual({ price: 10, normal: -1, quick: 9 });
  });

  it("has nothing to say about a price that is not a positive number", () => {
    for (const price of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(saleCompare(price, 0.1, 10)).toBeNull();
  });
});

describe("the daily streak", () => {
  it("pays 5 Rax for 2 in a row, doubling up to 320 for 8", () => {
    expect([2, 3, 4, 5, 6, 7, 8].map(streakPay)).toEqual([5, 10, 20, 40, 80, 160, 320]);
    expect(streakPay(1)).toBe(0);
    expect(STREAK_MAX).toBe(8);
  });

  it("works out the Rax a day of riding to a target, one pick a day", () => {
    // At 60%: 0.6^8 x 320 = 5.37 Rax a run; a run lasts (1 - 0.6^8) / 0.4 = 2.46 days on average.
    expect(streakDaily(0.6, 8)).toBeCloseTo(2.19, 2);
    expect(streakDaily(0.5, 2)).toBeCloseTo(0.833, 3);
    expect(streakDaily(0, 8)).toBe(0);
    expect(streakDaily(1, 8)).toBe(40); // every pick right: 320 every 8 days
  });

  it("rides to 8 for a good picker and cashes early for a coin flip", () => {
    expect(bestStreak(0.6)).toMatchObject({ target: 8 });
    expect(bestStreak(0.6).perDay).toBeCloseTo(2.19, 2);
    expect(bestStreak(0.5).target).toBe(2);
    expect(bestStreak(0.3).target).toBe(2);
    expect(bestStreak(1).target).toBe(8);
  });

  it("compares with cashing out at 2, and clamps a rate outside 0-100%", () => {
    expect(bestStreak(0.6).atTwo).toBeCloseTo(streakDaily(0.6, 2), 6);
    expect(bestStreak(1.4)).toEqual(bestStreak(1));
    expect(bestStreak(-1)).toEqual(bestStreak(0));
    expect(bestStreak(Number.NaN)).toEqual(bestStreak(0));
  });
});
