// How the Passes tab says its numbers: rounded the way a person says them ("about 12,500"), months by name, a
// pass in one line. The figures themselves are the snapshot's.
import type { OutReason } from "../data/passList";
import type { LevelKey } from "../data/prefs";
import type { PassMarket, PassRung } from "../data/types";
import { formatRax } from "../lib/format";
import { monthName } from "../lib/passes";
import { sportLabel } from "../lib/words";

/** Units under 100, tens under 1,000, hundreds above. */
export const aboutN = (n: number) => (n < 100 ? Math.round(n) : n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100);
export const about = (n: number) => formatRax(aboutN(n));
export const big = (n: number) => formatRax(Math.round(n));
export const x1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** "January"; with its year ("November 2027") once it is 12 months or more after today's month. */
export function monthWord(ym: string, today: string): string {
  const [y, m] = ym.split("-").map(Number);
  const [ty, tm] = today.split("-").map(Number);
  const ahead = ((y ?? 0) - (ty ?? 0)) * 12 + ((m ?? 1) - (tm ?? 1));
  return ahead >= 12 ? `${monthName(m ?? 1)} ${y}` : monthName(m ?? 1);
}

/** Months as a short number: "<1", "2", "13". */
export const monthsText = (months: number) => (months < 0.5 ? "<1" : String(Math.round(months)));

/** "1 month", "11 months", "2.1 years" (from 23.5 months on). */
export function spanText(months: number): string {
  if (months >= 23.5) return `${x1(months / 12)} years`;
  const n = Math.max(1, Math.round(months));
  return `${n} month${n === 1 ? "" : "s"}`;
}

/** A General of a season being played (limit 0): what it pays, in place of a lifetime limit. */
export const LIVE_ONLY = "pays only the games left this season, nothing On This Day";

/** A pass whose pay is months away, in plain words: "Pays from March — better bought in February". */
export const paysLaterText = ({ from, buy }: { from: number; buy: number }) =>
  `Pays from ${monthName(from)} — better bought in ${monthName(buy)}`;

/** How a spent pass is called in a list. Real's cap of 0 was a General in every one of the 35,583 spent passes read from
 * 123 accounts (the internal research notes, 3): that is a pass that never paid On This Day, not one that
 * is maxed out. A pass the visitor ticked as maxed by hand keeps the old word. */
export const spentWords = (tier: string): { tag: string; pay: string } =>
  tier === "general" ? { tag: "", pay: "pays nothing On This Day" } : { tag: " · maxed", pay: "pays nothing" };

/** A held pass with no room left On This Day and nothing live: one whose earnings reached Real's limit (`cap` above 0)
 * can be reopened by a lift to the next rarity, whose limit is higher; a cap of 0 is the old word. */
export const noRoomWords = (cap: number | null): string => (cap !== null && cap > 0 ? "limit reached: a lift reopens it" : "maxed On This Day");

/** The passes that hardly ever get a claim (`idlePasses`): the heading, the mark on a held row, and the line under the
 * heading for `n` of them when the sport pays `k` claims a day. An estimate, said as one. */
export const IDLE_TITLE = "Passes that hardly ever get a claim";
export const IDLE_MARK = "Rarely claimed";
export const idleLine = (n: number, k: number): string =>
  `By our estimate ${formatRax(n)} ${n === 1 ? "pass wins" : "passes win"} few of the ${k} daily claims of ${n === 1 ? "its" : "their"} sport: ` +
  `passes that pay more play on the same days. Levelling ${n === 1 ? "it" : "one"} adds little while they stay ahead.`;

export const tierName = (tier: string) => tier.charAt(0).toUpperCase() + tier.slice(1);
export const multText = (x: number) => `${Number.isInteger(x) ? x : x.toFixed(1)}×`;

export const seasonText = (m: Pick<PassMarket, "season_state">) => (m.season_state === "current" ? "this season" : "past season");

/** "NBA 2024-25 · past season", "· team" for a team pass; a fighter's pass is its fighter's. */
export function metaText(m: PassMarket): string {
  if (m.kind === "fighter") return `${sportLabel(m.sport)} ${m.season_label} · fighter`;
  return `${sportLabel(m.sport)} ${m.season_label} · ${seasonText(m)}${m.kind === "team" ? " · team" : ""}`;
}

/** "Nikola Jokić 2024-25". */
export const titleText = (m: Pick<PassMarket, "player_name" | "season_label">) => `${m.player_name} ${m.season_label}`;

/** What each level shows on the Passes tab, under the level control. */
export const PASS_LEVEL_MEANING: Record<LevelKey, string> = {
  new: "One pick per pass, in plain words.",
  regular: "Every pass, with the numbers.",
  pro: "The whole ladder, both prices, the claim math. Free here, not Real Pro.",
};

/** "your 5,000 budget"; "any budget" without one. */
export const budgetText = (budget: number | null) => (budget === null ? "any budget" : `your ${big(budget)} budget`);

/** The payback month of a rung in words ("January"), or null when it does not pay back. */
export const paybackWord = (rung: Pick<PassRung, "pays_back" | "payback_month">, today: string) =>
  rung.pays_back && rung.payback_month ? monthWord(rung.payback_month, today) : null;

/** "Jan", or "Jan ’28" a year or more away: the short month under a payback in months. */
export function monthShortWord(ym: string, today: string): string {
  const word = monthWord(ym, today);
  const [name, year] = word.split(" ");
  return year ? `${name!.slice(0, 3)} ’${year.slice(-2)}` : word.slice(0, 3);
}

/** "about 3 months", "<1 month": how long until it pays back. */
export function monthsWords(months: number): string {
  const t = monthsText(months);
  return t === "<1" ? "<1 month" : `about ${t} month${t === "1" ? "" : "s"}`;
}

/** "Nikola Jokić and Jamal Murray play on the same days"; three or more: "A, B and C …". */
export function mateLine(names: string[]): string {
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} play on the same days`;
}

export const MATE_LINES = 3;
export const MATE_NAMES = 4;

/**
 * The teammate lines one sport shows: the biggest groups first, at most MATE_LINES, each naming at most MATE_NAMES (a
 * big account holds dozens of such groups, which would bury the rest), and how many groups are left unsaid.
 */
export function mateLines(groups: readonly string[][]): { lines: string[]; more: number } {
  const ordered = [...groups].sort((a, b) => b.length - a.length);
  const lines = ordered
    .slice(0, MATE_LINES)
    .map((g) => mateLine(g.length > MATE_NAMES ? [...g.slice(0, MATE_NAMES - 1), `${g.length - MATE_NAMES + 1} more`] : g));
  return { lines, more: Math.max(0, ordered.length - MATE_LINES) };
}

/** How full one sport's claims are, in a sentence: "NBA: 1 pass — room on most days". */
export function sportFillLine(sport: string, n: number, fill: number, fullAt: number): string {
  const name = sportLabel(sport);
  if (fill >= fullAt) return `${name}: nearly full — a new ${name} pass only pays on days it beats your top two`;
  if (n === 1) return `${name}: 1 pass — room on most days`;
  return `${name}: ${n} passes — room on many days`;
}

/** The sports with passes and none held: "NFL, MLB: empty — their 2 claims a day are free Rax". */
export function emptySportsLine(sports: string[], claims: number): string {
  const names = sports.map(sportLabel).join(", ");
  return `${names}: empty — ${sports.length > 1 ? "their" : "its"} ${claims} claims a day are free Rax`;
}

/** What the filters left out: "Hidden: 1 never pays back · 2 short on cards"; empty when nothing is. */
export function hiddenText(
  hidden: { never: number; over: number; slow: number; notSoon: number; unpriced: number },
  showAll: boolean,
): string {
  const parts: string[] = [];
  if (hidden.never && !showAll) parts.push(`${hidden.never} never pay${hidden.never > 1 ? "" : "s"} back`);
  if (hidden.over) parts.push(`${hidden.over} over budget`);
  if (hidden.slow) parts.push(`${hidden.slow} slower than a year`);
  if (hidden.notSoon) parts.push(`${hidden.notSoon} short on cards`);
  if (hidden.unpriced) parts.push(`${hidden.unpriced} not priced yet`);
  return parts.length ? `Hidden: ${parts.join(" · ")}` : "";
}

// "Build to" a rarity (lib/buildToSwitch.ts).
/** The strip's first chip: each pass at its own best rarity, the list of before. */
export const BUILD_TO_BEST = "Best for each";
/** A pass priced on a thin rate (lib/passRates.ts buildRate), in its line: the build rate's own words. */
export const THIN_LINE = "Price less certain: too few of any one rarity";

/** Why a pass is set apart when the list is built to a rarity: its row names the rarity, and the line over them too. */
export function outWhy(why: OutReason, budget: number | null, years: number): string {
  switch (why) {
    case "over":
      return `Over ${budgetText(budget)}`;
    case "never":
      return `Doesn't pay back within ${years} years`;
    case "even":
      return "Its limit is no more than its cost";
    case "unpriced":
      return "No price yet";
    case "none":
      return "Can't be built: no cards trade";
  }
}

/** "3 passes don't pay back at Legendary, or can't be built to it": the line over Show more. */
export const outLead = (n: number, tier: string) =>
  `${formatRax(n)} ${n === 1 ? "pass doesn't" : "passes don't"} pay back at ${tierName(tier)}, or can't be built to it`;

/** The list's line on a phone, built to `tier`. */
export const buildToMeta = (top: number, tier: string) =>
  `the ${top} best per sport built to ${tierName(tier)}, most Rax a year per Rax first`;
