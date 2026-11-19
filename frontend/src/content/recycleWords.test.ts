import { describe, expect, it } from "vitest";
import { OTD_RULES } from "../test/fixtures";
import { JOKIC, MACKINNON, MURRAY, PASS_MARKETS, SGA, passSnapshot } from "../test/passScene";
import { NOW } from "../test/scene";
import { type Holding, planHoldings } from "../lib/passes";
import { recycleForDeal, recyclePlan } from "../lib/recycle";
import { makeDeal } from "../test/fixtures";
import {
  NO_PRO_NEEDED, PRO_TO_LIST, QUICK_PART, liftText, quickNote, quickText, recycleDealText, sellText, summaryText, targetText,
  whyText,
} from "./recycleWords";
import type { LevelKey } from "../data/prefs";

const JOKIC_FULL: Holding = { key: JOKIC.key, rarity: "epic", rating: 212, mult: 10, cap: 5000, earned: 5100, from: "real" };
const MURRAY_ROOM: Holding = { key: MURRAY.key, rarity: "rare", rating: 100, mult: 4, cap: 2000, earned: 1500, from: "real" };
const MACK_MAXED: Holding = { key: MACKINNON.key, tier: "rare", spent: true };
const SGA_ICONIC: Holding = { key: SGA.key, rarity: "iconic", rating: 3400, mult: 150, from: "real" };

function planFor(holdings: Holding[], pro: boolean, level: LevelKey = "regular", balance: number | null = null) {
  const snap = passSnapshot();
  const plan = planHoldings(holdings, PASS_MARKETS, OTD_RULES, snap.otd.sports);
  return recyclePlan({ snap, markets: PASS_MARKETS, holdings, plan, level, pro, balance, nowMs: NOW });
}

const LEVELS: LevelKey[] = ["new", "regular", "pro"];

describe("recycle words", () => {
  it("say why a pass is done, plainly for New, with Real's figures after", () => {
    const d = planFor([JOKIC_FULL], false).dead[0]!;
    expect(whyText(d, "new")).toBe("It has earned its limit, so Real stopped its On This Day pay.");
    expect(whyText(d, "regular")).toBe("Earned 5,100 of its 5,000 limit, live pay included.");
    expect(whyText(planFor([MACK_MAXED], false).dead[0]!, "regular")).toBe("You marked it maxed: it pays nothing more.");
  });

  it("the lift says no Real Pro is needed and gives its figures as estimates", () => {
    const d = planFor([JOKIC_FULL], false).dead[0]!;
    expect(liftText(d.lift!, d.earned, "new")).toBe(
      `Lift it to Legendary for about 1,700 Rax and it pays again, up to about 7,400 more. ${NO_PRO_NEEDED}`,
    );
    expect(liftText(d.lift!, d.earned, "regular")).toMatch(/^Lift to Legendary for about 1,700 Rax: reopens about 7,400 of limit, adds about [\d,]+ a year \(estimate\)\. No Real Pro needed\.$/);
    expect(liftText(d.lift!, d.earned, "pro")).toContain("limit 12,500 − 5,100 earned = 7,400");
    expect(liftText({ ...d.lift!, affordable: false }, d.earned, "regular")).toMatch(/More than the balance you typed\.$/);
    expect(liftText({ ...d.lift!, reopens: null, limit: null, tier: "iconic" }, d.earned, "new")).toContain("with no limit");
  });

  it("the sale says what Real keeps, and how sure the price is", () => {
    const d = planFor([JOKIC_FULL], true).dead[0]!;
    expect(sellText(d, "new")).toBe("Its cards would sell for about 1,900 Rax (estimate).");
    expect(sellText(d, "regular")).toBe("Its cards: about 1,900 Rax if sold, after Real's 10% (estimate).");
    expect(sellText(d, "pro")).toBe("Sell: 212 rating × 10.0 = 2,120, less Real's 10% ≈ 1,900 Rax, before 10 Rax a listed card.");
    expect(sellText({ ...d, value: { ...d.value!, thin: true } }, "new")).toMatch(/a rough price\.$/);
    expect(sellText({ ...d, value: null }, "new")).toBeNull();
  });

  it("the target names the pass, its rarity, its cost and its year", () => {
    const d = planFor([JOKIC_FULL, MURRAY_ROOM, SGA_ICONIC], true).dead[0]!;
    expect(targetText(d)).toMatch(/^Enough for .+ at [A-Z][a-z]+ \(about [\d,]+ Rax\), which pays about [\d,]+ a year\.$/);
    expect(targetText({ ...d, target: null })).toBe("Not enough on its own for a pass that pays back.");
  });

  it("the summary: without Real Pro, only the lift and a word on selling; with it, what the cards together build", () => {
    expect(summaryText(planFor([JOKIC_FULL, MACK_MAXED], false))).toBe(
      "2 passes are done paying. A lift reopens them. No Real Pro needed. With Real Pro, their cards could also be sold for a pass that pays.",
    );
    // Without Real Pro a lift the typed balance does not cover is not shown, so the summary does not count it.
    expect(summaryText(planFor([JOKIC_FULL], false, "regular", 1000))).toBe(
      "1 pass is done paying. With Real Pro, its cards could also be sold for a pass that pays.",
    );
    expect(summaryText(planFor([JOKIC_FULL], true, "regular", 1000))).toContain("A lift reopens it.");
    const pro = summaryText(planFor([JOKIC_FULL, MACK_MAXED, MURRAY_ROOM], true));
    expect(pro).toMatch(/^2 passes are done paying\. Their cards would sell for about [\d,]+ Rax \(estimate\)\. Sold, that could build .+ which (together )?should pay about [\d,]+ Rax a year\./);
  });

  it("never promises: every figure is 'about' or an estimate, at every level", () => {
    for (const level of LEVELS) {
      const plan = planFor([JOKIC_FULL, MACK_MAXED], true, level);
      const all = [summaryText(plan), ...plan.dead.flatMap((d) => [whyText(d, level), sellText(d, level), targetText(d), d.lift ? liftText(d.lift, d.earned, level) : ""])].join(" ");
      expect(all).not.toMatch(/\b(will|guarantee|sure)\b/i);
    }
    expect(PRO_TO_LIST).toContain("needs Real Pro");
  });

  // Jokić full with every next rarity's limit already earned: no lift, so Quick Sell is the way without Real Pro.
  const JOKIC_SPENT: Holding = { ...JOKIC_FULL, earned: 50000 };

  it("Quick Sell, when it is the advice: instant, no Real Pro, but about an eighth, with the listing figure beside it", () => {
    const d = planFor([JOKIC_SPENT], false).dead[0]!;
    expect(QUICK_PART).toBe("about an eighth");
    expect(quickText(d, "new", false)).toBe(
      "Quick Sell its cards now for about 210 Rax: instant, and no Real Pro needed. But it pays far less, about an eighth of what cards usually sell for. Listed with Real Pro, they might bring several times more.",
    );
    expect(quickText(d, "regular", false)).toBe(
      "Quick Sell: about 210 Rax for its cards, at once, no Real Pro needed (about 1 Rax a rating point). That is about an eighth of what cards usually sell for: listed with Real Pro, they might bring several times more.",
    );
    expect(quickText(d, "pro", false)).toBe(
      "Quick Sell: 212 rating × 1 ≈ 210 Rax now, no Real Pro needed; about an eighth of what cards usually sell for. Listed with Real Pro, they usually bring several times more.",
    );
    const unpriced = { ...d, quick: { ...d.quick!, listed: null } };
    expect(quickText(unpriced, "new", false)).toBe(
      "Quick Sell its cards now for about 210 Rax: instant, and no Real Pro needed. But it pays far less, about an eighth of what cards usually sell for.",
    );
    expect(quickText(unpriced, "pro", false)).toBe("Quick Sell: 212 rating × 1 ≈ 210 Rax now, no Real Pro needed; about an eighth of what cards usually sell for.");
    expect(quickText({ ...d, quick: null }, "new", false)).toBeNull();
  });

  it("Quick Sell while a lift reopens the pass: kept second, and it says selling ends the lift", () => {
    const d = planFor([JOKIC_FULL], false).dead[0]!;
    expect(quickText(d, "new", true)).toBe(
      "Quick Sell would bring only about 210 Rax, and it ends the lift. Lift first: you keep the cards.",
    );
    expect(quickText(d, "regular", true)).toBe(
      "Quick Sell instead: only about 210 Rax, and it ends the lift.",
    );
    expect(quickText(d, "pro", true)).toBe("Quick Sell: 212 rating × 1 ≈ 210 Rax, and it ends the lift; a lifted pass's cards can still be sold later.");
    // The lift is not on screen (more than the typed balance): the line names it, as the reason not to sell.
    const short = planFor([JOKIC_FULL], false, "regular", 1000).dead[0]!;
    expect(quickText(short, "regular", false)).toBe(
      "Quick Sell would bring only about 210 Rax for its cards. Before you sell: a lift to Legendary for about 1,700 Rax would make it pay again, and selling the cards ends that.",
    );
  });

  it("Quick Sell for an idle pass that still wins more in a year: keep it", () => {
    const d = planFor([JOKIC_SPENT], false).dead[0]!;
    const idle = { ...d, why: "idle" as const, lift: null, gets: 400, quick: { ...d.quick!, advice: "keep" as const } };
    expect(quickText(idle, "new", false)).toBe("Keep it: it still pays a little, more in a year than its cards would bring by Quick Sell (about 210 Rax).");
    expect(quickText(idle, "regular", false)).toBe("Keep it: about 400 a year (estimate) still beats a Quick Sell of its cards (about 210 Rax).");
  });

  it("the summary without Real Pro adds the Quick Sells it advises, beside what listing them would bring", () => {
    expect(summaryText(planFor([JOKIC_SPENT], false))).toBe(
      "1 pass is done paying. Quick Sell would bring about 210 Rax for its cards now, with no Real Pro, but that is about an eighth of what cards usually sell for. With Real Pro, listing them might bring several times more.",
    );
    expect(summaryText(planFor([JOKIC_SPENT, MACK_MAXED], false))).toBe(
      "2 passes are done paying. A lift reopens 1 of them. No Real Pro needed. Quick Sell would bring about 210 Rax for the cards of 1 pass now, with no Real Pro, but that is about an eighth of what cards usually sell for. With Real Pro, listing them might bring several times more.",
    );
  });

  it("with Real Pro, one note: Quick Sell pays about 1 Rax a rating point, about an eighth of a sale", () => {
    expect(quickNote(planFor([JOKIC_FULL], true))).toBe(
      "Real's Quick Sell is instant and needs no Real Pro, but it pays about 1 Rax a rating point, about an eighth of what cards usually sell for: listing usually brings more.",
    );
    const { quicksell_per_point: _drop, ...rules } = passSnapshot().rules;
    const snap = { ...passSnapshot(), rules };
    const plan = planHoldings([JOKIC_FULL], PASS_MARKETS, OTD_RULES, snap.otd.sports);
    expect(quickNote(recyclePlan({ snap, markets: PASS_MARKETS, holdings: [JOKIC_FULL], plan, level: "regular", pro: true, balance: null, nowMs: NOW }))).toBeNull();
  });

  it("Quick Sell words never promise either", () => {
    for (const level of LEVELS) {
      for (const plan of [planFor([JOKIC_SPENT, MACK_MAXED], false, level), planFor([JOKIC_FULL], false, level, 1000)]) {
        const all = [summaryText(plan), ...plan.dead.flatMap((d) => [quickText(d, level, true), quickText(d, level, false)])].join(" ");
        expect(all).not.toMatch(/\b(will|guarantee|sure)\b/i);
        expect(all).not.toMatch(/\brax\b/); // Rax, with a capital
      }
    }
  });

  it("a deal row's line, for the rare card that lifts a full pass", () => {
    const line = recycleForDeal(makeDeal({ sport: "nba", season: 2025, player_id: 1001, rating: 200 }), planFor([JOKIC_FULL], false))!;
    expect(recycleDealText(line, "regular")).toBe("Lifts your full Nikola Jokić 2024-25 pass to Legendary: reopens about 7,400 of limit.");
    expect(recycleDealText(line, "new")).toBe("This card makes your full Nikola Jokić 2024-25 pass pay again (it lifts it to Legendary).");
  });
});
