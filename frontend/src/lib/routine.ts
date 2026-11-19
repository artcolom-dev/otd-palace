// "Your day": a short checklist the visitor ticks themselves, and the streak it builds. Pure functions of the device's
// calendar days ("YYYY-MM-DD"), so a clock change (a 23- or 25-hour day), a clock set back or a store that cannot be
// trusted never costs a day: days are counted on the calendar, never as 24-hour spans.
import type { LevelKey } from "../data/prefs";

/** The five things of the day, in the order the card lists them. */
export const ROUTINE_IDS = ["claim", "polls", "game", "lineup", "deals"] as const;
export type RoutineId = (typeof ROUTINE_IDS)[number];

/** A day counts toward the streak from this many ticks. */
export const STREAK_MIN = 3;
/** One missed day is forgiven, then not again until this many days later. */
export const GRACE_GAP_DAYS = 7;
/** Days of record kept; a streak older than this is cut to it. */
export const KEEP_DAYS = 400;

/** What the device remembers of the routine. */
export interface Routine {
  show: boolean | null; // the visitor's choice; null: by level (New shows it, Regular and Pro do not)
  day: string; // the local day `ticks` belong to; "" before the first tick
  ticks: RoutineId[]; // the things ticked on `day`, in the list's order
  done: string[]; // the local days that reached STREAK_MIN ticks, oldest first, at most KEEP_DAYS
}

export const EMPTY_ROUTINE: Routine = { show: null, day: "", ticks: [], done: [] };

// ---------- calendar days ----------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_DAY = 86_400_000;

/** Whether `value` is a real calendar day written "YYYY-MM-DD". */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const utc = (day: string) => {
  const m = DAY_RE.exec(day)!;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The device's own calendar date at this moment: its clock and its time zone, whatever the hour changes were. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The day `n` days after `day` (before, when negative). Done in UTC, where no day is 23 or 25 hours long. */
export function addDays(day: string, n: number): string {
  const d = new Date(utc(day) + n * MS_DAY);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole calendar days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: string, b: string): number => Math.round((utc(b) - utc(a)) / MS_DAY);

// ---------- the stored routine ----------

const IS_ID: ReadonlySet<string> = new Set(ROUTINE_IDS);
const byList = (ids: Iterable<RoutineId>): RoutineId[] => {
  const have = new Set(ids);
  return ROUTINE_IDS.filter((id) => have.has(id));
};

/** The days of a record as stored: real days only, once each, oldest first, the last KEEP_DAYS of them. */
function cleanDays(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isDay))].sort().slice(-KEEP_DAYS);
}

/** A routine as stored, each field that cannot be trusted taken from the empty one. */
export function readRoutine(value: unknown): Routine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return EMPTY_ROUTINE;
  const r = value as Record<string, unknown>;
  const day = isDay(r.day) ? r.day : "";
  const ticks = day !== "" && Array.isArray(r.ticks) ? byList(r.ticks.filter((t): t is RoutineId => typeof t === "string" && IS_ID.has(t))) : [];
  return { show: typeof r.show === "boolean" ? r.show : null, day, ticks, done: cleanDays(r.done) };
}

/** What is ticked today: the stored ticks while they are of today, none once the local day has turned. */
export const ticksFor = (r: Routine, today: string): RoutineId[] => (r.day === today ? r.ticks : []);

/** Ticks or unticks one item of `today`. A new day starts from nothing; the day is recorded as done from STREAK_MIN. */
export function setTick(r: Routine, id: RoutineId, on: boolean, today: string): Routine {
  const had = ticksFor(r, today);
  const ticks = byList(on ? [...had, id] : had.filter((t) => t !== id));
  const others = r.done.filter((d) => d !== today);
  const done = ticks.length >= STREAK_MIN ? [...others, today].sort() : others;
  // Days older than the record keeps are dropped; days after today (a clock that was set back) stay.
  const kept = done.filter((d) => daysBetween(d, today) <= KEEP_DAYS).slice(-KEEP_DAYS);
  return { show: r.show, day: today, ticks, done: kept };
}

/** Whether the card shows: the visitor's choice, else New does and Regular and Pro do not. */
export const showRoutine = (r: Routine, level: LevelKey): boolean => r.show ?? level === "new";

// ---------- the streak ----------

export interface Streak {
  count: number; // days in a row that counted, forgiven days not counted
  graceDay: string | null; // the day forgiven inside this streak, if one was
  graceReady: boolean; // a miss today would be forgiven
  doneToday: boolean;
}

/** The walk is bounded: a streak longer than this many days is counted from here. */
const MAX_WALK_DAYS = KEEP_DAYS * 2;

/**
 * Consecutive days that counted, up to today. Today not being done yet is not a miss. One missed day is forgiven, and
 * not again until GRACE_GAP_DAYS later; a second miss inside that week, or a miss with no streak to protect, leaves
 * nothing to forgive: the number goes back to 0 and the next day that counts starts a new one.
 */
export function streakOf(done: readonly string[], today: string): Streak {
  const days = new Set(done.filter((d) => isDay(d) && d <= today));
  const doneToday = days.has(today);
  const first = [...days].sort()[0];
  const end = doneToday ? today : addDays(today, -1);
  let count = 0;
  let forgiven: string | null = null;
  if (first !== undefined && first <= end) {
    let day = first;
    const span = daysBetween(first, end);
    if (span > MAX_WALK_DAYS) day = addDays(end, -MAX_WALK_DAYS);
    for (; day <= end; day = addDays(day, 1)) {
      if (days.has(day)) count++;
      else if (count === 0) continue; // nothing to protect
      else if (forgiven === null || daysBetween(forgiven, day) >= GRACE_GAP_DAYS) forgiven = day;
      else {
        count = 0;
        forgiven = null;
      }
    }
  }
  if (count === 0) forgiven = null;
  return {
    count,
    graceDay: forgiven,
    graceReady: forgiven === null || daysBetween(forgiven, today) >= GRACE_GAP_DAYS,
    doneToday,
  };
}
