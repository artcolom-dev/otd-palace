import { describe, expect, it } from "vitest";
import { worthReporting } from "./reportYear";

describe("worthReporting: the server hears a new yearly figure only when it moved by 5 % or more", () => {
  it("sends the first figure, and a figure after nothing", () => {
    expect(worthReporting(null, 0)).toBe(true);
    expect(worthReporting(null, 48_000)).toBe(true);
  });
  it("stays quiet for the same figure and for a move under 5 %", () => {
    expect(worthReporting(48_000, 48_000)).toBe(false);
    expect(worthReporting(100_000, 104_999)).toBe(false);
    expect(worthReporting(100_000, 95_001)).toBe(false);
  });
  it("sends from 5 % up, either way", () => {
    expect(worthReporting(100_000, 105_000)).toBe(true);
    expect(worthReporting(100_000, 95_000)).toBe(true);
    expect(worthReporting(100_000, 0)).toBe(true);
  });
  it("sends the first rax a year after a nothing, and no figure that cannot be one", () => {
    expect(worthReporting(0, 1)).toBe(true);
    expect(worthReporting(0, 0)).toBe(false);
    expect(worthReporting(10, NaN)).toBe(false);
    expect(worthReporting(10, -3)).toBe(false);
    expect(worthReporting(10, 50_000_001)).toBe(false);
    expect(worthReporting(10, Infinity)).toBe(false);
  });
});
