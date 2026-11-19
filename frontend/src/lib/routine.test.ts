import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_ROUTINE,
  ROUTINE_IDS,
  addDays,
  daysBetween,
  isDay,
  localDay,
  readRoutine,
  setTick,
  showRoutine,
  streakOf,
  ticksFor,
} from "./routine";

const D = (day: string, n = 0) => addDays(day, n);
const FIRST = "2026-11-02";
/** A run of days, each one a day that counts. */
const run = (from: string, n: number) => Array.from({ length: n }, (_, i) => D(from, i));

describe("calendar days", () => {
  it("adds and counts days on the calendar, across months, years and leap days", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
    expect(daysBetween("2026-03-07", "2026-03-10")).toBe(3);
    expect(daysBetween("2026-03-10", "2026-03-07")).toBe(-3);
  });

  it("accepts real days only", () => {
    expect(isDay("2026-11-13")).toBe(true);
    for (const bad of ["2026-13-01", "2026-02-30", "2026-1-1", "", "today", 20261113, null, undefined]) {
      expect(isDay(bad)).toBe(false);
    }
  });
});

describe("localDay", () => {
  const saved = process.env.TZ;
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it("is the device's own calendar date", () => {
    process.env.TZ = "Pacific/Auckland";
    // 2026-11-12 23:30 UTC is already the 13th in New Zealand.
    expect(localDay(Date.UTC(2026, 10, 12, 23, 30))).toBe("2026-11-13");
    process.env.TZ = "America/Los_Angeles";
    expect(localDay(Date.UTC(2026, 10, 12, 23, 30))).toBe("2026-11-12");
  });

  it("gives every date once across the clock changes (a 23-hour and a 25-hour day)", () => {
    process.env.TZ = "America/New_York";
    for (const [from, days] of [["2026-03-06", 6], ["2026-10-30", 6]] as const) {
      const seen: string[] = [];
      const [y, m, d] = from.split("-").map(Number) as [number, number, number];
      // Midnight, noon and the last minute of each day: no date skipped, none out of order.
      for (let i = 0; i < days; i++) {
        for (const [h, min] of [[0, 0], [12, 0], [23, 59]] as const) seen.push(localDay(new Date(y, m - 1, d + i, h, min).getTime()));
      }
      expect([...new Set(seen)]).toEqual(run(from, days));
    }
  });

  it("a day is the date, not 24 hours: the night before a clock change and the next morning are consecutive days", () => {
    process.env.TZ = "America/New_York";
    const late = localDay(new Date(2026, 2, 7, 23, 30).getTime());
    const next = localDay(new Date(2026, 2, 8, 0, 30).getTime());
    expect(daysBetween(late, next)).toBe(1);
    const lateFall = localDay(new Date(2026, 10, 1, 23, 30).getTime());
    const nextFall = localDay(new Date(2026, 10, 2, 0, 30).getTime());
    expect(daysBetween(lateFall, nextFall)).toBe(1);
  });
});

describe("ticks and the day rollover", () => {
  it("keeps the ticks of the day, in the list's order, and forgets them at the next day", () => {
    let r = setTick(EMPTY_ROUTINE, "polls", true, FIRST);
    r = setTick(r, "claim", true, FIRST);
    expect(ticksFor(r, FIRST)).toEqual(["claim", "polls"]);
    expect(ticksFor(r, D(FIRST, 1))).toEqual([]); // local midnight passed: a clean card, nothing written
    r = setTick(r, "game", true, D(FIRST, 1));
    expect(ticksFor(r, D(FIRST, 1))).toEqual(["game"]);
  });

  it("ticking twice or unticking what is not ticked changes nothing", () => {
    const r = setTick(setTick(EMPTY_ROUTINE, "claim", true, FIRST), "claim", true, FIRST);
    expect(r.ticks).toEqual(["claim"]);
    expect(setTick(r, "lineup", false, FIRST).ticks).toEqual(["claim"]);
  });

  it("records a day as done from 3 ticks, and takes it back below 3", () => {
    let r = EMPTY_ROUTINE;
    for (const id of ["claim", "polls"] as const) r = setTick(r, id, true, FIRST);
    expect(r.done).toEqual([]);
    r = setTick(r, "game", true, FIRST);
    expect(r.done).toEqual([FIRST]);
    r = setTick(r, "lineup", true, FIRST);
    expect(r.done).toEqual([FIRST]);
    r = setTick(setTick(r, "lineup", false, FIRST), "game", false, FIRST);
    expect(r.done).toEqual([]);
  });

  it("a clock set back keeps the days it left behind and does not wipe a later day's record", () => {
    let r = EMPTY_ROUTINE;
    for (const id of ["claim", "polls", "game"] as const) r = setTick(r, id, true, D(FIRST, 5));
    r = setTick(r, "claim", true, FIRST); // the device clock now says an earlier day
    expect(r.day).toBe(FIRST);
    expect(r.ticks).toEqual(["claim"]);
    expect(r.done).toEqual([D(FIRST, 5)]);
  });

  it("keeps the record bounded", () => {
    let r = EMPTY_ROUTINE;
    for (let i = 0; i < 600; i++) {
      for (const id of ["claim", "polls", "game"] as const) r = setTick(r, id, true, D(FIRST, i));
    }
    expect(r.done.length).toBeLessThanOrEqual(400);
    expect(r.done.at(-1)).toBe(D(FIRST, 599));
  });
});

describe("streakOf", () => {
  it("is 0 with nothing done", () => {
    expect(streakOf([], FIRST)).toMatchObject({ count: 0, graceDay: null, graceReady: true, doneToday: false });
  });

  it("counts consecutive done days up to today", () => {
    expect(streakOf(run(FIRST, 4), D(FIRST, 3))).toMatchObject({ count: 4, doneToday: true });
  });

  it("does not break the streak because today is not done yet", () => {
    expect(streakOf(run(FIRST, 4), D(FIRST, 4))).toMatchObject({ count: 4, doneToday: false });
  });

  it("forgives one missed day: the number stays, the grace is shown as spent", () => {
    const done = [...run(FIRST, 3), ...run(D(FIRST, 4), 2)]; // missed the 4th day
    const s = streakOf(done, D(FIRST, 5));
    expect(s.count).toBe(5);
    expect(s.graceDay).toBe(D(FIRST, 3));
    expect(s.graceReady).toBe(false);
  });

  it("forgives one missed day a week, not two inside the week", () => {
    // 3 done, a miss, 2 done, then a second miss 3 days after the first.
    const done = [...run(FIRST, 3), ...run(D(FIRST, 4), 2)];
    expect(streakOf(done, D(FIRST, 7)).count).toBe(0);
    // A second miss 7 days after the first is forgiven again.
    const spaced = [...run(FIRST, 3), ...run(D(FIRST, 4), 6), ...run(D(FIRST, 11), 1)];
    const s = streakOf(spaced, D(FIRST, 11));
    expect(s.count).toBe(3 + 6 + 1);
    expect(s.graceDay).toBe(D(FIRST, 10));
  });

  it("two missed days in a row end it, and the day after starts a new one", () => {
    const done = [...run(FIRST, 5), D(FIRST, 8)];
    expect(streakOf(done, D(FIRST, 8))).toMatchObject({ count: 1, graceDay: null, doneToday: true });
  });

  it("a long absence ends it", () => {
    expect(streakOf(run(FIRST, 10), D(FIRST, 30))).toMatchObject({ count: 0, graceDay: null, graceReady: true });
  });

  it("offers the grace again a week after it was spent", () => {
    const done = [...run(FIRST, 3), ...run(D(FIRST, 4), 6)]; // grace spent on day 3
    expect(streakOf(done, D(FIRST, 9)).graceReady).toBe(false);
    expect(streakOf(done, D(FIRST, 10)).graceReady).toBe(true); // 7 days after
  });

  it("ignores days after today (a clock that went back) and duplicates", () => {
    const done = [...run(FIRST, 3), D(FIRST, 2), D(FIRST, 20)];
    expect(streakOf(done, D(FIRST, 2))).toMatchObject({ count: 3, doneToday: true });
  });

  it("is the same across a clock change", () => {
    expect(streakOf(["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"], "2026-03-09").count).toBe(4);
  });

  it("stays bounded on a record that spans centuries", () => {
    const start = Date.now();
    expect(streakOf(["1900-01-01", "2026-11-12"], "2026-11-13").count).toBe(1);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("readRoutine (a store that cannot be trusted)", () => {
  it("gives a clean routine for anything that is not a record", () => {
    for (const bad of [null, undefined, 3, "x", [], true]) expect(readRoutine(bad)).toEqual(EMPTY_ROUTINE);
  });

  it("keeps what is valid and drops what is not, field by field", () => {
    const r = readRoutine({
      show: "yes",
      day: "2026-02-30",
      ticks: ["claim", "claim", "karma", 5, "polls"],
      done: ["2026-11-03", "nope", "2026-11-01", "2026-11-03", 7, "2026-13-40"],
    });
    expect(r.show).toBeNull();
    expect(r.day).toBe("");
    expect(r.ticks).toEqual([]); // ticks without a valid day belong to nothing
    expect(r.done).toEqual(["2026-11-01", "2026-11-03"]);
    const ok = readRoutine({ show: true, day: FIRST, ticks: ["polls", "claim", "x"], done: [FIRST] });
    expect(ok).toEqual({ show: true, day: FIRST, ticks: ["claim", "polls"], done: [FIRST] });
  });

  it("bounds a huge store", () => {
    const done = Array.from({ length: 5000 }, (_, i) => addDays("2000-01-01", i));
    expect(readRoutine({ day: FIRST, ticks: ROUTINE_IDS, done }).done).toHaveLength(400);
  });
});

describe("showRoutine", () => {
  it("is on for New, off for the others, until the visitor chooses", () => {
    expect(showRoutine(EMPTY_ROUTINE, "new")).toBe(true);
    expect(showRoutine(EMPTY_ROUTINE, "regular")).toBe(false);
    expect(showRoutine(EMPTY_ROUTINE, "pro")).toBe(false);
    expect(showRoutine({ ...EMPTY_ROUTINE, show: true }, "pro")).toBe(true);
    expect(showRoutine({ ...EMPTY_ROUTINE, show: false }, "new")).toBe(false);
  });
});
