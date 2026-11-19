// The season clock: for each sport, where its season stands this month (preseason, season, playoffs, off-season) and
// the one move that pays now. It rests on the months each sport pays in (advisor/rules.py OTD_SPORT_MONTHS, served as
// rules.otd.sport_months) and reads the month on New York time, Real's own clock. Months only: Real's exact opening
// days are not in our data, so nothing here names a day. The moves come from the internal research notes
// (b), timing rules; a past-season buy is timed as the later 2026-11-16-rax-economy-deep.md has it, 2 to 4 weeks before
// the sport's months (the 1-2 months of the first note was revised), as every other screen says.

export type Phase = "preseason" | "season" | "playoffs" | "off" | "allyear" | "unknown";

export interface SeasonNow {
  sport: string;
  phase: Phase;
  early: boolean; // the first month of the season: it has just started, or starts this month
  startMonth: number | null; // 1-12, the month the season starts (this one or the next); null without a start
  monthsToStart: number | null; // 0 in the first month, 1 in the preseason, ...; null without a start
}

/**
 * The months that are mostly playoffs, by sport. An approximation: a month where the regular season ends and the
 * playoffs begin counts as the side that fills most of it (NBA and NHL playoffs start in late April: April stays the
 * season). Soccer, golf and UFC have none here.
 */
export const PLAYOFF_MONTHS: Record<string, readonly number[]> = {
  nba: [5, 6],
  nhl: [5, 6],
  mlb: [10],
  nfl: [1, 2],
  wnba: [9, 10],
  cfb: [12, 1],
  cbb: [3, 4],
};

/** The order sports are listed in when their moves are as urgent: the biggest markets first. */
const SPORT_ORDER = ["nba", "nfl", "mlb", "nhl", "cfb", "cbb", "soccer", "wnba", "golf", "ufc"];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
  "December",
];

export const monthName = (month: number): string => MONTH_NAMES[month - 1] ?? "";

const NY_MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric" });

/** The month (1-12) at `ms`, on New York time. */
export function realMonth(ms: number): number {
  return Number(NY_MONTH.format(new Date(ms)));
}

const prevMonth = (m: number) => (m === 1 ? 12 : m - 1);

/** Where `sport`'s season stands at `ms`, from the months it pays in. */
export function seasonNow(sport: string, months: readonly number[] | undefined, ms: number): SeasonNow {
  const set = new Set((months ?? []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12));
  if (set.size === 0) return { sport, phase: "unknown", early: false, startMonth: null, monthsToStart: null };
  if (set.size === 12) return { sport, phase: "allyear", early: false, startMonth: null, monthsToStart: null };
  const month = realMonth(ms);
  // The start is the month whose previous month is not a season month (a season runs as one block of months).
  const startMonth = [...set].find((m) => !set.has(prevMonth(m)))!;
  const monthsToStart = (startMonth - month + 12) % 12;
  if (set.has(month)) {
    const playoffs = (PLAYOFF_MONTHS[sport] ?? []).includes(month);
    return { sport, phase: playoffs ? "playoffs" : "season", early: month === startMonth, startMonth, monthsToStart };
  }
  return { sport, phase: monthsToStart === 1 ? "preseason" : "off", early: false, startMonth, monthsToStart };
}

/** How a season's state is said in a word or two. */
export function phaseLabel(s: SeasonNow): string {
  switch (s.phase) {
    case "preseason":
      return "Starts next month";
    case "season":
      return s.early ? "Just started" : "In season";
    case "playoffs":
      return "Playoffs";
    case "off":
      return "Off-season";
    case "allyear":
      return "All year";
    default:
      return "Dates unknown";
  }
}

export interface SeasonMove {
  move: string; // the one thing to do, short
  detail: string; // why, and what we don't know
}

/** The move that pays now for a season in this state. */
export function seasonMove(s: SeasonNow): SeasonMove {
  const start = s.startMonth === null ? "" : monthName(s.startMonth);
  switch (s.phase) {
    case "preseason":
      return {
        move: "Level the passes you'll keep before game 1",
        detail: `The season starts in ${start}; we don't know the exact day. Cards launch a few days before it: claim your free pass then. A level reached before game 1 earns on every game. Past-season passes pay from then too: buy them now.`,
      };
    case "season":
      return s.early
        ? {
            move: "Sell this season's new cards while buyers are many",
            detail: "Demand is highest at the start. A pass levelled now still earns on most of the season's games.",
          }
        : {
            move: "Claim your 2 best passes every day",
            detail: "Past-season passes pay On This Day now. Levelling this season's pass late only adds the games left.",
          };
    case "playoffs":
      return {
        move: "Hold stars on teams still in the playoffs",
        detail: "Playoff games pay double, live now and, while the pass has room under its limit, on their On This Day dates later. Past-season playoff dates pay double too.",
      };
    case "off":
      return s.monthsToStart === 2
        ? {
            move: "Buy past-season passes next month",
            detail: `Their On This Day dates start in ${start}. Buy 2 to 4 weeks before, not sooner: Rax spent now earns nothing until then. Don't sell yet: few cards sell off-season.`,
          }
        : {
            move: "Don't sell now",
            detail: `Few cards sell off-season. The season returns in ${start}; buy past-season passes 2 to 4 weeks before.`,
          };
    case "allyear":
      return {
        move: "Claim your 2 best passes every day",
        detail: "No off-season: this sport pays in every month, so its passes and its market never stop.",
      };
    default:
      return {
        move: "Season dates not known",
        detail: "We don't have this sport's months yet, so we can't say what pays now. Check the app.",
      };
  }
}

/** How urgent a move is: lower first. A preseason is the window that closes soonest. */
function urgency(s: SeasonNow): number {
  if (s.phase === "preseason") return 0;
  if (s.phase === "season" && s.early) return 1;
  if (s.phase === "off" && s.monthsToStart === 2) return 2;
  if (s.phase === "playoffs") return 3;
  if (s.phase === "season") return 4;
  if (s.phase === "allyear") return 5;
  if (s.phase === "off") return 6;
  return 7;
}

const orderOf = (sport: string) => {
  const i = SPORT_ORDER.indexOf(sport);
  return i === -1 ? SPORT_ORDER.length : i;
};

/** Every sport with months, the most urgent move first, then the biggest market. */
export function seasonBoard(sportMonths: Record<string, readonly number[]>, ms: number): SeasonNow[] {
  return Object.keys(sportMonths)
    .map((sport) => seasonNow(sport, sportMonths[sport], ms))
    .sort((a, b) => urgency(a) - urgency(b) || orderOf(a.sport) - orderOf(b.sport) || a.sport.localeCompare(b.sport));
}

/** The one move to show first; null without any sport. */
export const topMove = (board: readonly SeasonNow[]): SeasonNow | null => board[0] ?? null;
