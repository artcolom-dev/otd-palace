import { describe, expect, it } from "vitest";
import { formatCountdown, formatPct, formatRax } from "./format";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRax", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1234567, "1,234,567"],
    [1234.6, "1,235"],
    [-4500, "-4,500"],
  ])("formatRax(%j) = %j", (n, out) => expect(formatRax(n)).toBe(out));
});

describe("formatCountdown", () => {
  it.each([
    [Number.NaN, "—"],
    [Number.POSITIVE_INFINITY, "—"],
    [Number.NEGATIVE_INFINITY, "—"],
    [-5_000, "Ended"],
    [0, "Ended"],
    [45_000, "45s"],
    [59_999, "59s"],
    [65_000, "1m 05s"],
    [59 * MIN + 59_000, "59m 59s"],
    [HOUR, "1h 00m"],
    [3 * HOUR + 12 * MIN, "3h 12m"],
    [3 * HOUR + 5 * MIN, "3h 05m"],
    [DAY, "1d 0h"],
    [2 * DAY + 4 * HOUR, "2d 4h"],
    [2 * DAY + 14 * HOUR + 59 * MIN, "2d 14h"],
  ])("formatCountdown(%s) = %j", (ms, out) => expect(formatCountdown(ms)).toBe(out));
});

describe("formatPct", () => {
  it.each([
    [0.286, "29%"],
    [0.2, "20%"],
    [0, "0%"],
    [1.5, "150%"],
    [-0.123, "-12%"],
    [-0.001, "0%"],
  ])("formatPct(%j) = %j", (x, out) => expect(formatPct(x)).toBe(out));
});
