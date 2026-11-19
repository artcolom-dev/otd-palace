import { afterEach, describe, expect, it } from "vitest";
import { curveCaption, curveShape, curveText, priceCurve } from "./priceCurve";
import { PRICE_CURVE_DAYS, priceCurveSwitch } from "./priceCurveSwitch";

const move = (curve: unknown, median_recent = 160, sales_recent = 9) => ({ curve, median_recent, sales_recent });

describe("priceCurve: a move's finished days, then the last 24 hours", () => {
  afterEach(() => {
    priceCurveSwitch.on = true;
  });

  it("reads the server's days oldest first and ends on today's own figure", () => {
    const c = priceCurve(move([[6, 124, 4], [5, 130, 3], [2, 150, 7]]));
    expect(c?.points).toEqual([
      { ago: 6, price: 124, sales: 4 },
      { ago: 5, price: 130, sales: 3 },
      { ago: 2, price: 150, sales: 7 },
      { ago: 0, price: 160, sales: 9 },
    ]);
    expect(c?.days).toBe(7); // six days ago to today: the last 7 days
    expect([c?.first, c?.last]).toEqual([124, 160]);
    expect(c?.change).toBeCloseTo(160 / 124 - 1);
  });

  it("says nothing with fewer than 3 points, today's included", () => {
    expect(priceCurve(move([[1, 150, 3]]))).toBeNull();
    expect(priceCurve(move([]))).toBeNull();
    expect(priceCurve(move(undefined))).toBeNull();
    expect(priceCurve(move([[2, 140, 3], [1, 150, 3]]))?.points).toHaveLength(3);
  });

  it("draws nothing while the switch is off", () => {
    priceCurveSwitch.on = false;
    expect(priceCurve(move([[3, 140, 3], [2, 140, 3], [1, 150, 3]]))).toBeNull();
  });

  it.each([
    ["not a list", { 1: [1, 2, 3] }],
    ["a point that is not three numbers", [[3, 140, 3], [2, 140], [1, 150, 3]]],
    ["a price of 0", [[3, 140, 3], [2, 0, 3], [1, 150, 3]]],
    ["a fraction of a day", [[3, 140, 3], [2.5, 140, 3], [1, 150, 3]]],
    ["today or a day to come", [[3, 140, 3], [0, 140, 3], [-1, 150, 3]]],
    ["a day older than the server keeps", [[PRICE_CURVE_DAYS + 1, 140, 3], [2, 140, 3], [1, 150, 3]]],
    ["days out of order", [[1, 140, 3], [2, 140, 3], [3, 150, 3]]],
    ["the same day twice", [[2, 140, 3], [2, 141, 3], [1, 150, 3]]],
    ["no sale behind a point", [[3, 140, 0], [2, 140, 3], [1, 150, 3]]],
    ["a number too big to be a price", [[3, 1e400, 3], [2, 140, 3], [1, 150, 3]]],
    ["more points than days", Array.from({ length: PRICE_CURVE_DAYS + 5 }, (_, i) => [PRICE_CURVE_DAYS + 5 - i, 100, 3])],
  ])("draws nothing from a curve that is not the server's shape: %s", (_what, curve) => {
    expect(priceCurve(move(curve))).toBeNull();
  });

  it("draws nothing when today's own figure is missing", () => {
    expect(priceCurve(move([[3, 140, 3], [2, 140, 3], [1, 150, 3]], 0))).toBeNull();
    expect(priceCurve(move([[3, 140, 3], [2, 140, 3], [1, 150, 3]], Number.NaN))).toBeNull();
  });
});

describe("the curve in words", () => {
  const c = priceCurve(move([[6, 124, 4], [5, 130, 3], [2, 150, 7]]))!;

  it("says the days it really covers, the first and the last figure and the change", () => {
    expect(curveText(c)).toBe("Typical sale over the last 7 days: from 124 to 160 Rax, up 29%.");
    expect(curveCaption(c)).toBe("Last 7 days: 124 → 160");
  });

  it("says down with a real fall, and level when it rounds to nothing", () => {
    expect(curveText(priceCurve(move([[2, 200, 3], [1, 180, 3]], 150))!)).toBe(
      "Typical sale over the last 3 days: from 200 to 150 Rax, down 25%.",
    );
    expect(curveText(priceCurve(move([[2, 1000, 3], [1, 900, 3]], 1001))!)).toBe(
      "Typical sale over the last 3 days: from 1,000 to 1,001 Rax, level.",
    );
  });
});

describe("the curve drawn", () => {
  it("joins only days next to each other: a missing day is a gap, never a line", () => {
    const c = priceCurve(move([[6, 124, 4], [5, 130, 3], [2, 150, 7]]))!; // 6-5 joined; 5..2 a gap; 2..0 a gap (1 missing)
    const shape = curveShape(c, 96, 26);
    expect(shape.dots).toHaveLength(4);
    expect(shape.lines).toHaveLength(1);
    const joined = priceCurve(move([[2, 140, 3], [1, 150, 3]]))!;
    expect(curveShape(joined, 96, 26).lines).toHaveLength(1); // one unbroken run: 2, 1, today
    expect(curveShape(joined, 96, 26).lines[0]!.split("L")).toHaveLength(3);
  });

  it("keeps every point inside the box, oldest on the left, dearest on top", () => {
    const c = priceCurve(move([[6, 124, 4], [5, 130, 3], [2, 150, 7]]))!;
    const { dots } = curveShape(c, 96, 26);
    for (const [x, y] of dots) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(96);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(26);
    }
    expect(dots[0]![0]).toBeLessThan(dots[3]![0]); // time runs left to right
    expect(dots[3]![1]).toBeLessThan(dots[0]![1]); // 160 sits above 124
  });

  it("draws a flat market as a level line in the middle, not a division by zero", () => {
    const c = priceCurve(move([[2, 100, 3], [1, 100, 3]], 100))!;
    const { dots } = curveShape(c, 96, 26);
    expect(new Set(dots.map(([, y]) => y))).toEqual(new Set([13]));
  });
});
