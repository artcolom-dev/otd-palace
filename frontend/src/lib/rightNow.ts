// "Right now": the one to three best moves for a small account at THIS moment, from the clock, the month and what the
// account holds. Pure: the clock is passed in (`now`, and `zone` for the visitor's own time zone, the device's by default).
//
// What it rests on, and nothing more:
//  - Real's claims turn over about 08:15 New York time (the internal research notes 4d, Medium: nominally
//    07:30, observed later; 98 % of a day's tool claims land within two hours of it). The site says "about".
//  - Real pays at most 2 passes per sport per day; a day you skip pays nothing (content/accountTypes.ts UP_TO_NOTE).
//  - A past-season pass pays only in its sport's On This Day months (advisor/rules.py OTD_SPORT_MONTHS, served as
//    rules.otd.sport_months) and a General pays nothing On This Day; the multipliers are the ladder the planner uses.
//  - The streak poll pays 5 Rax for 2 right in a row, up to 320 for 8 (lib/earn.ts, Real's changelog).
// An idle sport is never advised, except in the month before its months open, with the "pays from" wording. No figure
// here is a measurement of what an account makes in a day: the Rax words are the planner's, "up to".
import { SEASON_EVENTS, type SeasonEvent } from "../content/seasonEvents";
import { about, tierName } from "../content/passWords";
import { STREAK_MAX, STREAK_MIN as POLL_MIN, streakPay } from "./earn";
import { OFFER_LEVEL } from "./offers";
import { STREAK_MIN as DAY_MIN } from "./routine";
import { monthName, realMonth, seasonBoard } from "./season";
import { sportLabel } from "./words";

export const REAL_ZONE = "America/New_York";
/** The turnover's New York wall-clock time. */
export const TURNOVER_HOUR = 8;
export const TURNOVER_MIN = 15;
/** Within this many minutes after the turnover the day is "fresh"; within this many before the next, "closing". */
export const FRESH_MIN = 120;
export const CLOSING_MIN = 180;
/** An event this many days away or fewer is shown. */
export const EVENT_DAYS = 30;

const MIN = 60_000;
const DAY = 86_400_000;

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wall(ms: number, zone: string | undefined): Wall {
  const key = zone ?? "";
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    formatters.set(key, f);
  }
  const get = (t: string) => Number(f.formatToParts(new Date(ms)).find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
}

/** The zone's offset from UTC at `ms`, in minutes (New York in winter: -300). */
function offset(ms: number, zone: string | undefined): number {
  const w = wall(ms, zone);
  return (Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - Math.floor(ms / MIN) * MIN) / MIN;
}

/** The instant of a New York wall-clock time, right across a clock change. */
function newYorkAt(y: number, m: number, d: number, h: number, min: number): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - offset(guess, REAL_ZONE) * MIN;
  return guess - offset(first, REAL_ZONE) * MIN;
}

/** The turnover just before or at `now`, and the next one, as instants. */
export function turnovers(now: number): { last: number; next: number } {
  const w = wall(now, REAL_ZONE);
  const at = (add: number) => {
    const day = new Date(Date.UTC(w.y, w.m - 1, w.d + add));
    return newYorkAt(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), TURNOVER_HOUR, TURNOVER_MIN);
  };
  const list = [at(-1), at(0), at(1)];
  return { last: Math.max(...list.filter((t) => t <= now)), next: Math.min(...list.filter((t) => t > now)) };
}

export type DayPhase = "fresh" | "open" | "closing";

export interface Clock {
  phase: DayPhase;
  sinceMin: number; // minutes since the last turnover
  untilMin: number; // minutes to the next
  next: number; // the next turnover, an instant
  ny: string; // "8:15 am", the turnover on New York time
  local: string; // the turnover on the visitor's clock
  sameZone: boolean; // the visitor's clock shows New York's time now
  month: number; // 1-12 on New York time, the month the sports' months are read in
}

const timeText = (ms: number, zone: string | undefined) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(ms)).replace(/\s?([AP])M/, (_, c: string) => ` ${c.toLowerCase()}m`);

export function clockOf(now: number, zone?: string): Clock {
  const { last, next } = turnovers(now);
  const sinceMin = Math.floor((now - last) / MIN);
  const untilMin = Math.ceil((next - now) / MIN);
  const phase: DayPhase = sinceMin < FRESH_MIN ? "fresh" : untilMin <= CLOSING_MIN ? "closing" : "open";
  return {
    phase, sinceMin, untilMin, next,
    ny: timeText(next, REAL_ZONE),
    local: timeText(next, zone),
    sameZone: offset(now, zone) === offset(now, REAL_ZONE),
    month: realMonth(now),
  };
}

/** "5 h 40 min", "35 min". */
export function span(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h === 0 ? `${m} min` : m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** A list in words: "NBA", "NBA and NHL", "NBA, NHL and CBB", "NBA, NHL, CBB and 2 more". */
export function sportsText(sports: readonly string[], max = 3): string {
  const names = sports.map(sportLabel);
  if (names.length <= 1) return names.join("");
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(", ")} and ${rest} more`;
}

/** A pass the planner proposes, reduced to what the coach reads. */
export interface Buy {
  sport: string;
  title: string; // "Lift Nathan MacKinnon to Common"
  tier: string; // the rarity it reaches
  mult: number; // that rarity's multiplier
  cost: number; // Rax
  year: number | null; // up to, a year (estimate)
  offerCost?: number | null; // the same pass with its cards bought by offers (lib/offers.ts); absent or null: unknown
  offerMeasured?: boolean; // that offer rests on the accepted offers the feed measured, not on the fixed 20 % under
}

export type MoveKind = "claim" | "free" | "pass" | "soon" | "wait" | "poll";

export interface CoachMove {
  kind: MoveKind;
  title: string;
  why: string;
  worth: string | null; // the Rax it is worth, in words, "up to" for a ceiling
  tip?: string | null; // one more way to do it for less (offers), or nothing
}

export interface CoachInput {
  now: number;
  zone?: string; // the visitor's time zone; the device's when absent (tests pass one)
  tiny: boolean; // "Not earning yet" or "Starter": the moves of a small account; a bigger one gets the clock and the polls only
  heldSports: readonly string[]; // the sports of the passes the visitor holds
  sportMonths: Record<string, readonly number[]>;
  buys: readonly Buy[]; // the planner's passes to add or lift, best first
  balance: number | null; // what the visitor typed as theirs; null when they did not
  streak: { count: number; doneToday: boolean } | null;
}

export interface Coming {
  event: SeasonEvent;
  days: number; // 0 = today
}

export interface RightNow {
  clock: Clock;
  headline: string; // the day's rhythm in one sentence, with the clock
  moves: CoachMove[]; // 1 to 3, the first is the one to do
  idle: string | null; // the sports that are idle until a named month
  coming: Coming | null;
  streak: string | null; // one gentle line, or nothing
}

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
};

/** The nearest dated event today or within EVENT_DAYS days, on New York's calendar day. */
export function comingEvent(now: number, events: readonly SeasonEvent[] = SEASON_EVENTS): Coming | null {
  const w = wall(now, REAL_ZONE);
  const today = Math.floor(Date.UTC(w.y, w.m - 1, w.d) / DAY);
  let best: Coming | null = null;
  for (const event of events) {
    const days = dayNumber(event.date) - today;
    if (days >= 0 && days <= EVENT_DAYS && (best === null || days < best.days)) best = { event, days };
  }
  return best;
}

export function headline(clock: Clock): string {
  const when = clock.sameZone ? `${clock.ny}` : `${clock.ny} in New York (${clock.local} for you)`;
  if (clock.phase === "fresh") return `Real's day just turned over (about ${clock.ny} New York time). Today's claims are open.`;
  return `Real's day turns over at about ${when}, in ${span(clock.untilMin)}.`;
}

const LOSS = "A day you skip pays nothing.";

const offerUnder = () => `${Math.round((1 - OFFER_LEVEL) * 100)}%`;

function claimMove(clock: Clock, paying: readonly string[]): CoachMove {
  const names = sportsText(paying);
  const worth = "Up to 2 passes per sport pay each day";
  const why =
    clock.phase === "fresh"
      ? `The day just turned over, so today's claims are open. ${LOSS}`
      : clock.phase === "closing"
      ? `The day turns over in ${span(clock.untilMin)}: claim before then. ${LOSS}`
      : `Do it any time before the day turns over in ${span(clock.untilMin)}. ${LOSS}`;
  return { kind: "claim", title: `Claim your ${names} passes`, why, worth };
}

function pollMove(): CoachMove {
  return {
    kind: "poll",
    title: "Answer the daily polls",
    why: "Free, and it takes a minute. Polls earn karma, and the daily streak poll pays Rax.",
    worth: `${streakPay(POLL_MIN)} Rax for ${POLL_MIN} right in a row, up to ${streakPay(STREAK_MAX)} for ${STREAK_MAX}`,
  };
}

function streakLine(streak: CoachInput["streak"]): string | null {
  if (!streak) return null;
  if (streak.doneToday) return streak.count > 0 ? `Streak kept today: ${streak.count} ${streak.count === 1 ? "day" : "days"}.` : null;
  if (streak.count === 0) return `A day counts once you tick ${DAY_MIN} things in Your day. No rush: one missed day a week is forgiven.`;
  return `You are on a ${streak.count}-day streak. Ticking ${DAY_MIN} things in Your day keeps it going, and one missed day a week is forgiven.`;
}

/** The sentence under a pass: its rarity's multiplier, and the General trap. */
function multLine(buy: Buy): string {
  const x = Number.isInteger(buy.mult) ? String(buy.mult) : buy.mult.toFixed(1);
  const base = `${tierName(buy.tier)} pays ${x}x a day's earnings On This Day.`;
  return buy.tier === "common" || buy.tier === "uncommon" ? `${base} A General pays nothing On This Day.` : base;
}

/** Offers, for a small account: the same pass for less if enough are accepted (lib/offers.ts), said as an expectation. */
function offerTip(buy: Buy, balance: number | null): string | null {
  const cost = buy.offerCost;
  if (cost === null || cost === undefined || !(cost < buy.cost)) return null;
  const fits = balance !== null && balance < buy.cost && balance >= cost ? ` That fits your ${about(balance)} Rax.` : "";
  const how = buy.offerMeasured
    ? "offer under the usual price on many of its cards, near what accepted offers on them have cleared at"
    : `offer about ${offerUnder()} under the usual price on many of its cards`;
  return `Cheaper with offers: ${how}. Most are refused, so send many; if enough are accepted it costs about ${about(
    cost,
  )} Rax, not ${about(buy.cost)}.${fits}`;
}

export function rightNow(input: CoachInput): RightNow {
  const clock = clockOf(input.now, input.zone);
  const board = seasonBoard(input.sportMonths, input.now);
  const payingList = board.filter((s) => s.phase === "season" || s.phase === "playoffs" || s.phase === "allyear").map((s) => s.sport);
  const paying = new Set(payingList);
  const idleBoard = board.filter((s) => (s.phase === "off" || s.phase === "preseason") && s.startMonth !== null);
  const idle = idleBoard.length
    ? `Idle until their month: ${idleBoard.map((s) => `${sportLabel(s.sport)} (from ${monthName(s.startMonth!)})`).join(", ")}. Leave those for later.`
    : null;
  const held = [...new Set(input.heldSports)];
  const heldPaying = held.filter((s) => paying.has(s));
  const heldIdle = held.filter((s) => !paying.has(s) && idleBoard.some((b) => b.sport === s));
  const moves: CoachMove[] = [];

  if (heldPaying.length > 0) moves.push(claimMove(clock, heldPaying));
  else if (input.tiny && held.length > 0) {
    const first = idleBoard.find((s) => heldIdle.includes(s.sport));
    moves.push({
      kind: "wait",
      title: "Nothing to claim today",
      why: first
        ? `Your ${sportsText(heldIdle)} ${heldIdle.length === 1 ? "pass is" : "passes are"} idle until ${monthName(first.startMonth!)}. Come back for the daily polls.`
        : "None of your passes pays this month.",
      worth: null,
    });
  }

  if (input.tiny) {
    if (held.length === 0 && payingList.length > 0) {
      moves.push({
        kind: "free",
        title: "Take your free pass in each sport that pays now",
        why: `Paying now: ${sportsText(payingList, 4)}. It costs nothing. A General pays nothing On This Day: lift it to Common (10 rating) and it starts paying.`,
        worth: "Free",
        tip: "Offers under the usual price are the cheapest way to those 10 rating: most are refused, so send many.",
      });
    }
    // The first pass worth buying: a paying sport at once, or one whose months open next month (said "pays from").
    const buy = input.buys.find((b) => paying.has(b.sport) || board.find((s) => s.sport === b.sport)?.phase === "preseason");
    if (buy) {
      const here = paying.has(buy.sport);
      const start = board.find((s) => s.sport === buy.sport)?.startMonth;
      const need = input.balance !== null && input.balance < buy.cost ? Math.ceil(buy.cost - input.balance) : 0;
      const afford =
        input.balance === null ? "" : need === 0 ? " You have enough for it." : ` You are ${about(need)} Rax short.`;
      moves.push({
        kind: here ? "pass" : "soon",
        title: buy.title,
        why: here
          ? `${sportLabel(buy.sport)} pays this month. ${multLine(buy)}${afford}`
          : `${sportLabel(buy.sport)} pays from ${monthName(start ?? 0)}: buy it 2 to 4 weeks before, not sooner.${afford}`,
        worth: `About ${about(buy.cost)} Rax${buy.year !== null && buy.year > 0 ? ` for up to ${about(buy.year)} Rax a year` : ""}`,
        tip: offerTip(buy, input.balance),
      });
    }
  }

  if (moves.length < 3) moves.push(pollMove());

  return {
    clock,
    headline: headline(clock),
    moves: moves.slice(0, 3).map((m) => ({ ...m, tip: m.tip ?? null })),
    idle,
    coming: comingEvent(input.now),
    streak: streakLine(input.streak),
  };
}

/** Whether `typeKey` (content/accountTypes.ts) is a tiny account: it sees the coach first. */
export const isTiny = (typeKey: string): boolean => typeKey === "none" || typeKey === "starter";
