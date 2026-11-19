import { describe, expect, it } from "vitest";
import { OTD_RULES } from "../test/fixtures";
import { realMonth, seasonBoard, seasonMove, seasonNow, topMove } from "./season";

const MONTHS = OTD_RULES.sport_months;
// Times in UTC; Real's day runs on New York time (UTC-5 in winter, UTC-4 in summer).
const at = (iso: string) => Date.parse(iso);

describe("realMonth", () => {
  it("reads the month on New York time, not the device's or UTC", () => {
    // 04:30 UTC on 1 December is still 23:30 on 30 November in New York.
    expect(realMonth(at("2026-12-01T04:30:00Z"))).toBe(11);
    expect(realMonth(at("2026-12-01T05:30:00Z"))).toBe(12);
    // Summer time: 03:59 UTC on 1 July is 23:59 on 30 June.
    expect(realMonth(at("2026-07-01T03:59:00Z"))).toBe(6);
    expect(realMonth(at("2026-07-01T04:01:00Z"))).toBe(7);
  });
});

describe("seasonNow", () => {
  it("turns at the month boundary, New York time (CFB: season, then its playoffs)", () => {
    expect(seasonNow("cfb", MONTHS.cfb, at("2026-12-01T04:30:00Z")).phase).toBe("season");
    expect(seasonNow("cfb", MONTHS.cfb, at("2026-12-01T05:30:00Z")).phase).toBe("playoffs");
  });

  it("calls the month before a season its preseason, and the first month an early season", () => {
    const sept = seasonNow("nba", MONTHS.nba, at("2026-09-30T12:00:00Z"));
    expect(sept).toMatchObject({ phase: "preseason", startMonth: 10, monthsToStart: 1, early: false });
    const oct = seasonNow("nba", MONTHS.nba, at("2026-10-01T12:00:00Z"));
    expect(oct).toMatchObject({ phase: "season", early: true, startMonth: 10, monthsToStart: 0 });
    expect(seasonNow("nba", MONTHS.nba, at("2026-11-15T12:00:00Z"))).toMatchObject({ phase: "season", early: false });
  });

  it("finds the start of a season that runs across the new year, whatever order its months come in", () => {
    // NFL runs September to February; January is its playoffs.
    expect(seasonNow("nfl", MONTHS.nfl, at("2026-12-20T12:00:00Z")).phase).toBe("season");
    expect(seasonNow("nfl", MONTHS.nfl, at("2027-01-10T12:00:00Z")).phase).toBe("playoffs");
    expect(seasonNow("nfl", [1, 2, 9, 10, 11, 12], at("2026-08-10T12:00:00Z"))).toMatchObject({
      phase: "preseason",
      startMonth: 9,
    });
  });

  it("counts the months left before an off-season ends", () => {
    expect(seasonNow("mlb", MONTHS.mlb, at("2026-11-15T12:00:00Z"))).toMatchObject({ phase: "off", startMonth: 3, monthsToStart: 4 });
    expect(seasonNow("mlb", MONTHS.mlb, at("2027-01-15T12:00:00Z"))).toMatchObject({ phase: "off", monthsToStart: 2 });
    expect(seasonNow("mlb", MONTHS.mlb, at("2027-02-15T12:00:00Z"))).toMatchObject({ phase: "preseason", monthsToStart: 1 });
  });

  it("says a sport that pays every month has no off-season", () => {
    expect(seasonNow("golf", MONTHS.golf, at("2026-11-15T12:00:00Z"))).toMatchObject({ phase: "allyear", startMonth: null });
  });

  it("says so when it does not know a sport's months", () => {
    for (const months of [undefined, []]) {
      expect(seasonNow("cricket", months, at("2026-11-15T12:00:00Z"))).toMatchObject({
        phase: "unknown",
        startMonth: null,
        monthsToStart: null,
      });
    }
  });

  it("has no playoffs in a sport without them (soccer)", () => {
    for (const m of MONTHS.soccer!) {
      const iso = `2026-${String(m).padStart(2, "0")}-15T12:00:00Z`;
      expect(seasonNow("soccer", MONTHS.soccer, at(iso)).phase).toBe("season");
    }
  });
});

describe("seasonMove", () => {
  const now = (sport: string, iso: string) => seasonMove(seasonNow(sport, MONTHS[sport], at(iso)));

  it("gives each moment its one move", () => {
    expect(now("nba", "2026-09-15T12:00:00Z").move).toMatch(/before game 1/i);
    expect(now("nba", "2026-10-15T12:00:00Z").move).toMatch(/sell .*new cards/i);
    expect(now("nba", "2026-12-15T12:00:00Z").move).toMatch(/claim/i);
    expect(now("nba", "2026-05-15T12:00:00Z").move).toMatch(/playoff/i);
    expect(now("mlb", "2027-01-15T12:00:00Z").move).toMatch(/buy past-season passes/i);
    expect(now("mlb", "2026-11-15T12:00:00Z").move).toMatch(/don't sell/i);
  });

  it("times a past-season buy as every other screen does: 2 to 4 weeks before, never months ahead", () => {
    const twoMonthsOut = now("mlb", "2027-01-15T12:00:00Z"); // MLB pays from March
    expect(twoMonthsOut.move).toMatch(/next month/);
    expect(twoMonthsOut.detail).toMatch(/2 to 4 weeks before, not sooner/);
    expect(now("mlb", "2026-11-15T12:00:00Z").detail).toMatch(/2 to 4 weeks before/);
    expect(now("nba", "2026-09-15T12:00:00Z").detail).toMatch(/Past-season passes .*buy them now/);
    for (const iso of ["2026-09-15", "2026-11-15", "2027-01-15", "2027-02-15"]) {
      expect(now("mlb", `${iso}T12:00:00Z`).detail).not.toMatch(/months before|pay soon/);
    }
  });

  it("names the month, never a day it does not know", () => {
    const pre = now("nba", "2026-09-15T12:00:00Z");
    expect(pre.detail).toMatch(/October/);
    expect(pre.detail).toMatch(/exact day/i);
    expect(now("mlb", "2027-01-15T12:00:00Z").detail).toMatch(/March/);
    expect(now("cricket", "2026-11-15T12:00:00Z").move).toMatch(/not known/i);
  });
});

describe("seasonBoard and topMove", () => {
  it("lists every sport it knows, the most urgent move first", () => {
    const board = seasonBoard(MONTHS, at("2026-11-15T12:00:00Z"));
    expect(board.map((s) => s.sport).sort()).toEqual(Object.keys(MONTHS).sort());
    // 15 November: CBB has just started; MLB and WNBA are off.
    expect(board[0]).toMatchObject({ sport: "cbb", phase: "season", early: true });
    expect(topMove(board)?.sport).toBe("cbb");
    const off = board.filter((s) => s.phase === "off").map((s) => s.sport).sort();
    expect(off).toEqual(["mlb", "wnba"]);
  });

  it("puts a preseason before anything else", () => {
    const board = seasonBoard(MONTHS, at("2026-09-15T12:00:00Z")); // NBA and NHL start in October
    expect(["nba", "nhl"]).toContain(board[0]!.sport);
    expect(board[0]!.phase).toBe("preseason");
  });

  it("has nothing to say without any sport", () => {
    expect(seasonBoard({}, at("2026-11-15T12:00:00Z"))).toEqual([]);
    expect(topMove([])).toBeNull();
  });
});
