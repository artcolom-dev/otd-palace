import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const app = { snap: { rules: { otd: { sport_months: { mlb: { start: 4, end: 10 } } } } }, now: 0 };
vi.mock("../AppContext", () => ({ useApp: () => app }));
vi.mock("../lib/season", async (orig) => {
  const real = await orig<typeof import("../lib/season")>();
  return { ...real, seasonBoard: vi.fn((_m: unknown, now: number) => [{ month: real.realMonth(now) }]) };
});

import { useSeasonBoard } from "./EarnSheet";

describe("useSeasonBoard", () => {
  it("is worked out again when the New York month turns, even within one UTC day", () => {
    app.now = Date.parse("2026-12-01T04:30:00Z"); // 23:30 on 30 Nov in New York
    const { result, rerender } = renderHook(() => useSeasonBoard());
    expect((result.current[0] as unknown as { month: number }).month).toBe(11);
    app.now = Date.parse("2026-12-01T05:30:00Z"); // 00:30 on 1 Dec in New York, same UTC day
    rerender();
    expect((result.current[0] as unknown as { month: number }).month).toBe(12);
  });
});
