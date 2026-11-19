import { describe, expect, it } from "vitest";
import { resaleWords } from "./resale";

describe("resaleWords", () => {
  it("says a player's cards resell well when 6 in 10 recent listings or more sold", () => {
    expect(resaleWords({ listed: 40, sold: 28 })).toEqual({
      label: "Resells well",
      line: "28 of 40 recent listings sold (70%)",
      tone: "well",
    });
    expect(resaleWords({ listed: 20, sold: 12 })?.label).toBe("Resells well"); // exactly 60 %
  });

  it("says they are slow to resell when 1 in 4 or fewer sold", () => {
    expect(resaleWords({ listed: 20, sold: 2 })).toEqual({
      label: "Slow to resell",
      line: "2 of 20 recent listings sold (10%)",
      tone: "slow",
    });
    expect(resaleWords({ listed: 20, sold: 5 })?.label).toBe("Slow to resell"); // exactly 25 %
  });

  it("says the percentage the rule uses, never a rounded 'in 10' that contradicts it", () => {
    expect(resaleWords({ listed: 20, sold: 5 })?.line).toBe("5 of 20 recent listings sold (25%)");
    expect(resaleWords({ listed: 40, sold: 39 })?.line).toBe("39 of 40 recent listings sold (98%)");
  });

  it("says nothing in between, where a tag would be noise", () => {
    expect(resaleWords({ listed: 40, sold: 20 })).toBeNull();
    expect(resaleWords({ listed: 20, sold: 6 })).toBeNull(); // 30 %
    expect(resaleWords({ listed: 20, sold: 11 })).toBeNull(); // 55 %
  });

  it("says nothing on too few listings, however extreme: a handful of listings is luck", () => {
    expect(resaleWords({ listed: 19, sold: 19 })).toBeNull();
    expect(resaleWords({ listed: 8, sold: 0 })).toBeNull();
  });

  it("says nothing for a count it cannot trust rather than crash", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { listed: "40", sold: 28 }, { listed: 40.5, sold: 28 }, { listed: 30, sold: 31 }, { listed: 30, sold: -1 }, { listed: Number.NaN, sold: 1 }, { listed: Infinity, sold: 1 }]) {
      expect(resaleWords(bad as never)).toBeNull();
    }
  });
});
