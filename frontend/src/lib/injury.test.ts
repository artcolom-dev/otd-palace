import { describe, expect, it } from "vitest";
import { backDay, injuryWords, isBenched } from "./injury";

describe("backDay", () => {
  it("says the day in short English, whatever this device's time zone", () => {
    expect(backDay("2026-11-18")).toBe("Nov 18");
    expect(backDay("2026-12-01")).toBe("Dec 1");
    expect(backDay("2027-01-31")).toBe("Jan 31");
  });

  it("says nothing for a day that is not one", () => {
    expect(backDay(null)).toBeNull();
    expect(backDay("soon")).toBeNull();
    expect(backDay("2026-02-30")).toBeNull();
  });
});

describe("injuryWords", () => {
  it("puts the status, what hurts and the day back on one plain line", () => {
    expect(injuryWords({ status: "out", part: "Knee", back: "2026-11-18" })).toEqual({
      label: "Out",
      line: "Out · knee · back about Nov 18",
      tone: "hurt",
    });
    expect(injuryWords({ status: "day", part: "Left Ankle", back: "2026-11-16" })).toEqual({
      label: "Day-to-day",
      line: "Day-to-day · left ankle · back about Nov 16",
      tone: "maybe",
    });
  });

  it("leaves out what ESPN does not say rather than invent it", () => {
    expect(injuryWords({ status: "out", part: null, back: null })?.line).toBe("Out");
    expect(injuryWords({ status: "questionable", part: "Ankle", back: null })?.line).toBe("Questionable · ankle");
    expect(injuryWords({ status: "doubtful", part: null, back: "2026-11-22" })?.line).toBe("Doubtful · back about Nov 22");
  });

  it("calls a suspension a suspension: it is not an injury", () => {
    expect(injuryWords({ status: "suspended", part: null, back: null })).toEqual({
      label: "Suspended",
      line: "Suspended",
      tone: "hurt",
    });
  });

  it("is firm for out, suspended and doubtful, and soft for questionable and day-to-day", () => {
    const tone = (status: "out" | "suspended" | "doubtful" | "questionable" | "day") => injuryWords({ status, part: null, back: null })?.tone;
    expect([tone("out"), tone("suspended"), tone("doubtful")]).toEqual(["hurt", "hurt", "hurt"]);
    expect([tone("questionable"), tone("day")]).toEqual(["maybe", "maybe"]);
  });
});

describe("isBenched", () => {
  it("is true for a player who most likely misses the next game, false for one who may play and for no note", () => {
    expect(["out", "suspended", "doubtful"].map((status) => isBenched({ status: status as "out", part: null, back: null }))).toEqual([true, true, true]);
    expect(["questionable", "day"].map((status) => isBenched({ status: status as "day", part: null, back: null }))).toEqual([false, false]);
    expect(isBenched(undefined)).toBe(false);
  });
});

describe("a note the server could one day send in a shape we do not know", () => {
  // The page must never crash on it: no tag is better than an error card.
  it("says nothing for a status it has no word for, or for no note", () => {
    expect(injuryWords({ status: "probable", part: null, back: null } as never)).toBeNull();
    expect(injuryWords({ part: "Knee" } as never)).toBeNull();
    expect(injuryWords(null)).toBeNull();
    expect(injuryWords(undefined)).toBeNull();
    expect(injuryWords("out" as never)).toBeNull();
  });

  it("keeps what hurts only when it is text, and the day only when it is a real one", () => {
    expect(injuryWords({ status: "out", part: 5, back: 7 } as never)?.line).toBe("Out");
    expect(injuryWords({ status: "out", part: ["Knee"], back: {} } as never)?.line).toBe("Out");
  });

  it("is not benched for any of them", () => {
    expect(isBenched(null)).toBe(false);
    expect(isBenched({ status: "probable" } as never)).toBe(false);
    expect(isBenched("out" as never)).toBe(false);
  });
});
