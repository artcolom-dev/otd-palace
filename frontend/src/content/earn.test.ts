import { describe, expect, it } from "vitest";
import { MISTAKES, TIER_PLANS } from "./earn";
import { MAX_HOW_WORDS, wordCount } from "./how";

const plan = (id: string) => TIER_PLANS.find((p) => p.id === id)!;
const steps = (id: string) => plan(id).steps.join(" ");

describe("the Earn guide's words", () => {
  it("keeps every step and every mistake to 40 words", () => {
    for (const p of TIER_PLANS) for (const s of p.steps) expect([s, wordCount(s) <= MAX_HOW_WORDS]).toEqual([s, true]);
    for (const m of MISTAKES) expect([m.text, wordCount(m.text) <= MAX_HOW_WORDS]).toEqual([m.text, true]);
  });

  it("a new player takes a free pass straight to Common: a General pays nothing On This Day", () => {
    expect(steps("start")).toMatch(/free pass straight to Common/);
    expect(steps("start")).toMatch(/General pays nothing On This Day/);
  });

  it("never says Common 'doubles' a pay that a General does not have On This Day", () => {
    for (const plan of TIER_PLANS) for (const step of plan.steps) expect(step).not.toMatch(/doubles the pay/);
  });

  it("puts passes before deals, with the measured paybacks and the measured deal margin", () => {
    expect(steps("beginner")).toMatch(/Passes before deals: a Common on a top earner pays back in about 2 to 3\.5 months/);
    expect(steps("beginner")).toMatch(/the typical deal leaves about 3 Rax after fees/);
  });

  it("builds rating with offers, many at a time, from the first pass on", () => {
    expect(steps("start")).toMatch(/offers under the usual price/i);
    expect(steps("beginner")).toMatch(/offers under the usual price/i);
    expect(steps("growing")).toMatch(/with offers/);
  });

  it("says when past-season rating is cheap, and to buy it a few weeks before its On This Day months", () => {
    expect(steps("growing")).toMatch(/MLB 10\.5 Rax per rating point against NBA 12\.9/);
    expect(steps("growing")).toMatch(/2 to 4 weeks before its On This Day months/);
  });

  it("a starting player waits for February before past-season MLB passes, April for WNBA", () => {
    expect(steps("beginner")).toMatch(/past-season MLB passes before February, or WNBA before April/);
  });

  it("football passes are spread over seasons, not teams: a season's games fall on the same weekend days", () => {
    // the internal research notes: two teams of one season share about 60 % of their game dates.
    expect(steps("beginner")).toMatch(/A third pass in a sport pays only on days your first two don't play/);
    expect(steps("beginner")).toMatch(/NFL and college football most games of a season fall on the same weekend days/);
    expect(steps("beginner")).toMatch(/over seasons, not teams/);
    expect(steps("beginner")).not.toMatch(/different teams/);
    const three = MISTAKES.find((m) => m.text.startsWith("Three passes in one sport"))!;
    expect(three.text).toMatch(/only 2 are paid each day/);
    expect(three.text).toMatch(/In football the same season mostly means the same days, whatever the team/);
    expect(three.text).not.toMatch(/\d+ ?%/); // no figure the page cannot show
  });

  it("a growing player skips, on a crowded day, the pass that will reach its limit anyway: the player picks the 2 claims", () => {
    // Real's docs (On This Day): "select the cards you want to claim for each sport". A pass sure to reach its lifetime
    // limit loses nothing by waiting for a day with a free claim; the other two would have lost theirs.
    expect(steps("growing")).toMatch(/skip the one that will reach its lifetime limit anyway/);
    expect(steps("growing")).toMatch(/Claim the other two: it still gets there on quieter days/);
    expect(steps("growing")).not.toMatch(/skip[^.]*\d/); // advice, no figure
  });

  it("stacking golf passes of one season is a mistake said with its measured seasons, as a fact", () => {
    // the internal research notes: two golfers of a season share 54 % of their pay dates; seasons with the
    // same weekdays (2014 and 2025, 2017 and 2023, 2019 and 2024) share 65 to 90 % of theirs.
    const golf = MISTAKES.find((m) => m.text.startsWith("Stacking golf passes of one season"))!;
    expect(golf.text).toMatch(/paid on the same tournament Sundays, 2 a day/);
    expect(golf.text).toMatch(/2014 and 2025, 2017 and 2023, 2019 and 2024/);
    expect(golf.unsure).toBeUndefined();
  });

  it("a growing player keeps the strongest boosters for playoff games and major tournaments: Real pays double there", () => {
    // Real's docs (Player cards): "Playoffs and major tournaments are 2x more than the regular season base earnings."
    // A booster multiplies the game's base (measured, 83 of 83 rows), and unused boosters carry over to the next season.
    expect(steps("growing")).toMatch(/Keep your strongest boosters for playoff games and major tournaments: Real pays double there/);
    expect(steps("growing")).toMatch(/Unused boosters carry over to the sport's next season/);
  });

  it("a growing player levels this season's stars early: live pay, outside the 2 daily claims (advice, no figure)", () => {
    expect(steps("growing")).toMatch(/outside the 2 daily claims/);
    // B9 (audit 4f): live pay fills the lifetime limit, so the advice never promises On This Day pay after it.
    expect(steps("growing")).toMatch(/count toward the pass's lifetime limit/);
    expect(steps("growing")).not.toMatch(/On This Day later|then up to/i);
    expect(steps("growing")).not.toMatch(/\d{3,}.*Rax a/); // advice, not a computed number
  });

  it("a big account buys Iconic at its entry and sends the full rank order", () => {
    expect(steps("big")).toMatch(/Iconic right at its entry, 3,380 rating/);
    expect(steps("big")).toMatch(/100 players and 5 teams/);
  });

  it("warns that selling a player's cards lowers his pass, and that a pass's limit counts its live pay too", () => {
    expect(MISTAKES.some((m) => /Selling the cards under a pass/.test(m.text) && /falls back/.test(m.text))).toBe(true);
    const limit = MISTAKES.find((m) => m.text.includes("lifetime limit"))!;
    expect(limit.unsure).toBeUndefined(); // measured: a pass at its limit pays nothing more On This Day
    expect(limit.text).toMatch(/live pay/);
  });

  it("says a 2027 MLB pass carries a lockout risk, not confirmed, while past-season MLB still pays", () => {
    const mlb = MISTAKES.find((m) => m.text.includes("2027 MLB"))!;
    expect(mlb.unsure).toBe(true);
    expect(mlb.text).toMatch(/1 December 2026/);
    expect(mlb.text).toMatch(/Past-season MLB passes still pay On This Day/);
  });
});
