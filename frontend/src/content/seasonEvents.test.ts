import { describe, expect, it } from "vitest";
import { SEASON_EVENTS } from "./seasonEvents";

describe("the dated season heads-ups", () => {
  it("are in date order, one id each, each a day on the calendar", () => {
    const dates = SEASON_EVENTS.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(SEASON_EVENTS.map((e) => e.id)).size).toBe(SEASON_EVENTS.length);
    for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("tell college basketball's March is its biggest month, about 28% of a season's pay, and to be ready by late February", () => {
    const event = SEASON_EVENTS.find((e) => e.id === "cbb-march-2027")!;
    expect(event.date).toBe("2027-02-15");
    expect(event.title).toBe("March is college basketball's biggest month");
    expect(event.line).toBe("About 28% of a season's On This Day pay comes in March. Have past-season passes in place by late February.");
  });

  it("keep each heads-up to 40 words, title and line together", () => {
    for (const e of SEASON_EVENTS) expect(`${e.title}. ${e.line}`.split(/\s+/).length, e.id).toBeLessThanOrEqual(40);
  });
});
