import { describe, expect, it } from "vitest";
import { type Buy, type CoachInput, clockOf, comingEvent, rightNow, sportsText, span, turnovers } from "./rightNow";

// advisor/rules.py OTD_SPORT_MONTHS
const MONTHS: Record<string, number[]> = {
  mlb: [3, 4, 5, 6, 7, 8, 9, 10], nba: [10, 11, 12, 1, 2, 3, 4, 5, 6], nfl: [9, 10, 11, 12, 1, 2],
  nhl: [10, 11, 12, 1, 2, 3, 4, 5, 6], wnba: [5, 6, 7, 8, 9, 10], ufc: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  soccer: [8, 9, 10, 11, 12, 1, 2, 3, 4, 5], golf: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  cfb: [8, 9, 10, 11, 12, 1], cbb: [11, 12, 1, 2, 3, 4],
};
const PARIS = "Europe/Paris";
const at = (iso: string) => Date.parse(iso);
const buy = (over: Partial<Buy> = {}): Buy => ({
  sport: "nhl", title: "Lift Nathan MacKinnon to Common", tier: "common", mult: 2, cost: 300, year: 900, ...over,
});
const base = (over: Partial<CoachInput> = {}): CoachInput => ({
  now: at("2026-11-17T14:30:00Z"), zone: PARIS, tiny: true, heldSports: [], sportMonths: MONTHS, buys: [buy()],
  balance: null, streak: null, ...over,
});

describe("Real's day (New York time)", () => {
  it("turns over at 08:15 ET: 13:15 UTC in winter", () => {
    const t = turnovers(at("2026-11-17T14:30:00Z"));
    expect(new Date(t.last).toISOString()).toBe("2026-11-17T13:15:00.000Z");
    expect(new Date(t.next).toISOString()).toBe("2026-11-18T13:15:00.000Z");
  });
  it("turns over at 12:15 UTC in summer (New York daylight time)", () => {
    expect(new Date(turnovers(at("2027-06-10T20:00:00Z")).next).toISOString()).toBe("2027-06-11T12:15:00.000Z");
  });
  it("wraps the day: just after midnight New York time it is still the day that began the morning before", () => {
    const c = clockOf(at("2026-12-11T05:30:00Z"), PARIS); // 00:30 ET, 06:30 in Paris
    expect(c.sinceMin).toBe(16 * 60 + 15);
    expect(c.untilMin).toBe(7 * 60 + 45);
    expect(c.phase).toBe("open");
  });
  it("is closing within 3 hours of the next turnover and fresh within 2 hours after", () => {
    expect(clockOf(at("2026-11-17T11:00:00Z"), PARIS).phase).toBe("closing"); // 06:00 ET
    expect(clockOf(at("2026-11-17T13:14:00Z"), PARIS).phase).toBe("closing");
    expect(clockOf(at("2026-11-17T13:15:00Z"), PARIS).phase).toBe("fresh");
    expect(clockOf(at("2026-11-17T15:14:00Z"), PARIS).phase).toBe("fresh");
    expect(clockOf(at("2026-11-17T15:15:00Z"), PARIS).phase).toBe("open");
  });
  it("counts the day across the spring clock change (23 hours long) and the autumn one (25)", () => {
    const spring = turnovers(at("2027-03-14T05:00:00Z")); // 02:00 ET jumps to 03:00 on 14 March 2027
    expect(spring.next - spring.last).toBe(23 * 3_600_000);
    const autumn = turnovers(at("2027-11-07T04:00:00Z")); // 02:00 EDT falls back on 7 November 2027
    expect(autumn.next - autumn.last).toBe(25 * 3_600_000);
  });
  it("says the turnover on both clocks, and drops the second when the visitor is in New York time", () => {
    const paris = clockOf(at("2026-11-17T18:00:00Z"), PARIS);
    expect([paris.ny, paris.local, paris.sameZone]).toEqual(["8:15 am", "2:15 pm", false]);
    const ny = clockOf(at("2026-11-17T18:00:00Z"), "America/New_York");
    expect([ny.local, ny.sameZone]).toEqual(["8:15 am", true]);
    expect(rightNow(base({ zone: "America/New_York", now: at("2026-11-17T18:00:00Z") })).headline).not.toMatch(/for you/);
    expect(rightNow(base({ now: at("2026-11-17T18:00:00Z") })).headline).toMatch(/8:15 am in New York \(2:15 pm for you\)/);
  });
  it("reads the month on New York time: 1 December 02:00 Paris is still 30 November", () => {
    expect(clockOf(at("2026-12-01T01:00:00Z"), PARIS).month).toBe(11);
    expect(clockOf(at("2026-12-01T05:00:00Z"), PARIS).month).toBe(12);
  });
  it("words durations and lists", () => {
    expect([span(35), span(120), span(340)]).toEqual(["35 min", "2 h", "5 h 40 min"]);
    expect([sportsText(["nba"]), sportsText(["nba", "nhl"]), sportsText(["nba", "nhl", "cbb"]), sportsText(["nba", "nhl", "cbb", "ufc", "golf"])])
      .toEqual(["NBA", "NBA and NHL", "NBA, NHL and CBB", "NBA, NHL, CBB and 2 more"]);
  });
});

describe("the coach, no pass held", () => {
  it("a November morning: free pass in the paying sports, then the first pass, then the polls", () => {
    const r = rightNow(base());
    expect(r.clock.phase).toBe("fresh");
    expect(r.moves.map((m) => m.kind)).toEqual(["free", "pass", "poll"]);
    expect(r.moves[0]!.title).toBe("Take your free pass in each sport that pays now");
    expect(r.moves[0]!.why).toMatch(/^Paying now: .*NBA/);
    expect(r.moves[0]!.why).not.toMatch(/MLB|WNBA/); // idle in November
    expect(r.moves[1]!.why).toMatch(/NHL pays this month\. Common pays 2x .*General pays nothing On This Day/);
    expect(r.moves[1]!.worth).toBe("About 300 Rax for up to 900 Rax a year");
    expect(r.moves[2]!.worth).toBe("5 Rax for 2 right in a row, up to 320 for 8");
    expect(r.idle).toMatch(/MLB \(from March\), WNBA \(from May\)/);
  });
  it("never advises an idle sport now, and falls through to the next buy", () => {
    const r = rightNow(base({ buys: [buy({ sport: "mlb", title: "MLB pass" }), buy({ sport: "wnba", title: "WNBA pass" }), buy()] }));
    expect(r.moves.find((m) => m.kind === "pass")!.title).toBe("Lift Nathan MacKinnon to Common");
    expect(JSON.stringify(r.moves)).not.toMatch(/MLB pass|WNBA pass/);
  });
  it("advises no pass at all when only idle sports are on offer", () => {
    const r = rightNow(base({ buys: [buy({ sport: "mlb", title: "MLB pass" })] }));
    expect(r.moves.map((m) => m.kind)).toEqual(["free", "poll"]);
  });
  it("the month before a sport opens, it is said 'pays from' with the 2 to 4 weeks window", () => {
    const r = rightNow(base({ now: at("2027-02-17T15:00:00Z"), buys: [buy({ sport: "mlb", title: "Lift Shohei Ohtani to Common" })] }));
    expect(r.moves.find((x) => x.kind === "soon")!.why).toBe("MLB pays from March: buy it 2 to 4 weeks before, not sooner.");
  });
  it("two months before, the same pass is left out", () => {
    const r = rightNow(base({ now: at("2027-01-17T15:00:00Z"), buys: [buy({ sport: "mlb" })] }));
    expect(r.moves.map((m) => m.kind)).not.toContain("soon");
  });
  it("tells a small account offers are the cheap way to its passes, with what the pass could cost by them", () => {
    const r = rightNow(base({ buys: [buy({ offerCost: 240 })] }));
    expect(r.moves[0]!.tip).toBe("Offers under the usual price are the cheapest way to those 10 rating: most are refused, so send many.");
    expect(r.moves[1]!.tip).toBe(
      "Cheaper with offers: offer about 20% under the usual price on many of its cards. Most are refused, so send many; if enough are accepted it costs about 240 Rax, not 300.",
    );
    expect(rightNow(base({ balance: 260, buys: [buy({ offerCost: 240 })] })).moves[1]!.tip).toMatch(/not 300\. That fits your 260 Rax\.$/);
    expect(rightNow(base({ balance: 200, buys: [buy({ offerCost: 240 })] })).moves[1]!.tip).toMatch(/not 300\.$/);
    expect(rightNow(base()).moves[1]!.tip).toBeNull(); // no offer cost known: no figure
    expect(r.moves[2]!.tip).toBeNull(); // the polls
  });
  it("with a balance, says whether it is enough", () => {
    expect(rightNow(base({ balance: 500 })).moves[1]!.why).toMatch(/You have enough for it\.$/);
    expect(rightNow(base({ balance: 120 })).moves[1]!.why).toMatch(/You are 180 Rax short\.$/);
    expect(rightNow(base({ balance: null })).moves[1]!.why).not.toMatch(/enough|short/);
  });
});

describe("the coach, a Starter", () => {
  it("a March evening: claim the sports that pay now, with the turnover on both clocks", () => {
    const r = rightNow(base({ now: at("2027-03-16T23:00:00Z"), heldSports: ["nhl", "mlb", "wnba"] })); // 7 pm EDT
    expect(r.clock.month).toBe(3);
    const claim = r.moves[0]!;
    expect(claim.kind).toBe("claim");
    expect(claim.title).toBe("Claim your NHL and MLB passes"); // WNBA is idle until May
    expect(claim.why).toMatch(/Do it any time before the day turns over in 13 h 15 min\. A day you skip pays nothing\./);
    expect(r.headline).toBe("Real's day turns over at about 8:15 am in New York (1:15 pm for you), in 13 h 15 min.");
    expect(r.idle).toMatch(/WNBA \(from May\)/);
    expect(r.idle).not.toMatch(/MLB/);
  });
  it("is urgent in the last 3 hours before the turnover", () => {
    const r = rightNow(base({ now: at("2026-11-17T11:30:00Z"), heldSports: ["nhl"] }));
    expect(r.moves[0]!.why).toMatch(/^The day turns over in 1 h 45 min: claim before then\. A day you skip pays nothing\./);
  });
  it("a December night: claims still open, the labour deal named on its day", () => {
    const r = rightNow(base({ now: at("2026-12-02T04:00:00Z"), heldSports: ["nba"] })); // 11 pm ET on 1 December
    expect(r.moves[0]!.title).toBe("Claim your NBA passes");
    expect(r.clock.untilMin).toBe(9 * 60 + 15);
    expect(r.coming).toMatchObject({ days: 0, event: { id: "mlb-labour-deal-2026" } });
  });
  it("holding only idle sports: nothing to claim, said calmly", () => {
    const r = rightNow(base({ heldSports: ["mlb", "wnba"] }));
    expect(r.moves[0]).toMatchObject({ kind: "wait", title: "Nothing to claim today" });
    expect(r.moves[0]!.why).toMatch(/MLB and WNBA passes are idle until March/);
  });
});

describe("a bigger account", () => {
  it("gets the clock and the polls, never a purchase", () => {
    const r = rightNow(base({ tiny: false, heldSports: ["nhl", "nba"], buys: [buy()] }));
    expect(r.moves.map((m) => m.kind)).toEqual(["claim", "poll"]);
  });
});

describe("season events", () => {
  it("shows the labour deal in the days before 1 December, and on the day", () => {
    expect(comingEvent(at("2026-11-17T15:00:00Z"))).toMatchObject({ days: 14, event: { id: "mlb-labour-deal-2026" } });
    expect(comingEvent(at("2026-12-01T15:00:00Z"))).toMatchObject({ days: 0 });
  });
  it("shows college basketball's March from a month before 15 February, after the WNBA winter one has passed", () => {
    expect(comingEvent(at("2027-01-20T15:00:00Z"))).toMatchObject({ days: 26, event: { id: "cbb-march-2027" } });
    expect(comingEvent(at("2027-02-15T15:00:00Z"))).toMatchObject({ days: 0, event: { id: "cbb-march-2027" } });
    expect(comingEvent(at("2027-02-16T15:00:00Z"))).toMatchObject({ days: 13, event: { id: "mlb-buy-window-2027" } });
  });
  it("is gone the day after, and shows nothing beyond 30 days", () => {
    expect(comingEvent(at("2026-12-02T15:00:00Z"))).toBeNull(); // the next one, 15 January, is 44 days off
    expect(comingEvent(at("2027-05-10T15:00:00Z"))).toBeNull();
  });
});

describe("the streak line", () => {
  it("is gentle: no guilt, the grace day named", () => {
    const a = rightNow(base({ streak: { count: 4, doneToday: false } })).streak!;
    expect(a).toBe("You are on a 4-day streak. Ticking 3 things in Your day keeps it going, and one missed day a week is forgiven.");
    expect(a).not.toMatch(/lose|lost|break|don't|miss out/i);
    expect(rightNow(base({ streak: { count: 0, doneToday: false } })).streak).toMatch(/No rush/);
    expect(rightNow(base({ streak: { count: 3, doneToday: true } })).streak).toBe("Streak kept today: 3 days.");
    expect(rightNow(base({ streak: null })).streak).toBeNull();
  });
});
