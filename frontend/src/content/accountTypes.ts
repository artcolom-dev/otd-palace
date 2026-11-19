// What kind of account you have, by what its passes can pay On This Day in a year (rax a year): the ONE table. Never by
// Rax balance, never by passes held, never in claims. advisor/account_types.py is the same table for the server and
// the Discord roles; tests/test_account_types.py keeps the two equal. Change an edge here and in the Python file
// together; nothing else names one.
//
// Source: the internal research notes (section 4, FINAL: 150 accounts read, 123 valued; Strong, Big and Giant
// are measured, Starter and Steady rest on first principles and a few accounts) and
// 2026-11-16-rax-economy-deep.md (what pays, what each step costs). Every line below is Medium confidence or better
// there; an uncertain one is worded as "about". The yearly figure is a ceiling by construction (what the passes CAN
// pay when every claim day is claimed), so the site always says "up to". How far real collection falls under it is
// not known: the one day measured (2026-11-16-habits-audit.md, section 4) shows accounts claiming, tool or no tool,
// and a claim paying what the planner expects; the earlier "0.6" and "a fifth" read a tool's ledger as the account.
//
// `color` is an index into Real's rarity scale (content/real.ts, tokens.css --rarity-N), so the types read as a
// ladder in the colours players already know: General grey, Common blue, Uncommon green, Epic red, Legendary
// purple, Mystic gold. Iconic, the ice colour, stays the staff's: nobody can earn it by typing a username.
// `from` counts, `to` does not (a type runs from its `from` up to, not including, the next `from`).
// do / skip / watch: one line each, 25 words at most.

export interface AccountType {
  key: string;
  name: string;
  from: number; // rax a year, included
  to: number | null; // rax a year, not included; null for the top type
  color: number; // index into Real's rarity scale
  meaning: string; // one line: what this account is
  do: string; // the move that matters most at this size
  skip: string; // what to ignore or not to do
  watch: string; // the one thing to keep an eye on
}

export const ACCOUNT_TYPES: readonly AccountType[] = [
  {
    key: "none",
    name: "Not earning yet",
    from: 0,
    to: 1,
    color: 0,
    meaning: "No pass pays you yet. A General pass earns nothing On This Day; a Common does.",
    do: "Take the free pass in each sport, then lift it to Common (10 rating) with offers (they need Real Pro). That starts the pay.",
    skip: "Boosters (they pay nothing On This Day), Mystic and Iconic passes, and buying packs to resell the cards.",
    watch: "MLB 2027 passes: the labour deal ends 1 December 2026 and a lockout is possible. Past-season MLB passes still pay.",
  },
  {
    key: "starter",
    name: "Starter",
    from: 1,
    to: 10_000,
    color: 1,
    meaning: "A few passes pay you. Each sport you add can have two more passes paid each day.",
    do: "Put one Common pass in each sport playing now that does not pay yet: about 300 Rax each, roughly 1,000 Rax a year.",
    skip: "Many passes in one sport (only the best 2 a day pay), and deals under 50 Rax: 82 in 100 lose after fees.",
    watch: "Past-season MLB and WNBA passes bought now sit idle for months. A lockout may hold up 2027 MLB passes (labour deal ends 1 December 2026).",
  },
  {
    key: "steady",
    name: "Steady",
    from: 10_000,
    to: 100_000,
    color: 2,
    meaning: "A working base. Many sports still have fewer than two passes paid a day: two good passes in every sport grow it.",
    do: "Lift cheap passes first: a few dozen Rax can add hundreds a year. Then give every sport two good passes a day.",
    skip: "Passes of the same team, or in football the same season, which play the same days, and Generals spread over every sport.",
    watch: "A pass stops paying On This Day once all it has earned reaches its limit, live pay included. Count the passes that still pay.",
  },
  {
    key: "strong",
    name: "Strong",
    from: 100_000,
    to: 500_000,
    color: 4,
    meaning: "A solid account: nine sports pay and half the pay is this season's games. Rarity is now what grows it.",
    do: "Lift cheaply first, fill empty sports, then go for Legendary. Check what the first Iconic would cost (3,380 rating).",
    skip: "Lifting a pass whose game days two better passes already cover. It adds nothing.",
    watch: "Past-season MLB and WNBA passes bought now sit idle for months: they pay from spring. Buy their rating a few weeks before.",
  },
  {
    key: "big",
    name: "Big",
    from: 500_000,
    to: 2_000_000,
    color: 5,
    meaning: "A large account. Iconic passes have no lifetime limit; every other rarity stops at one.",
    do: "Do cheap lifts first (60 Rax can add 1,600 a year). Then Iconic: 30,000 to 40,000 Rax for 65,000 to 116,000 a year.",
    skip: "More passes in sports you already cover: your daily claims are about three-quarters used.",
    watch: "Passes that have earned their limit, live pay included, pay nothing more On This Day. Lifting one a rarity reopens it.",
  },
  {
    key: "giant",
    name: "Giant",
    from: 2_000_000,
    to: null,
    color: 6,
    meaning: "A top account. Most of the pay comes from a layer of Iconic passes.",
    do: "Do the cheap lifts first (about 400 Rax can add 9,600 a year), then the next Iconic at its entry, 3,380 rating.",
    skip: "Everything under Legendary, and counting passes as value. The Iconic layer carries most of the pay.",
    watch: "Unused claims: a sport with fewer than two good passes a day leaves Rax unclaimed.",
  },
];

/** The words after the headline, everywhere the site says the figure: it is a ceiling, not a payout. */
export const UP_TO_NOTE = "Up to: what your passes can pay if you claim every claim day for a year. A day you skip pays nothing.";

const clean = (year: number): number => (Number.isFinite(year) && year > 0 ? Math.round(year) : 0);

/** The type of an account whose passes can pay `year` rax a year. */
export function typeOf(year: number): AccountType {
  const y = clean(year);
  let found = ACCOUNT_TYPES[0]!;
  for (const t of ACCOUNT_TYPES) if (y >= t.from) found = t;
  return found;
}

/** The type after the one `year` is in; null for the top type. */
export function nextType(year: number): AccountType | null {
  const i = ACCOUNT_TYPES.indexOf(typeOf(year));
  return ACCOUNT_TYPES[i + 1] ?? null;
}

export interface Progress {
  next: AccountType;
  year: number; // the figure, rounded
  target: number; // the next type's edge
  fraction: number; // 0..1: year / target
  toGo: number; // rax a year still to add
}

/** How far `year` is from the next type's edge: "2,900 of 10,000 · 29 %"; null at the top. */
export function progressToNext(year: number): Progress | null {
  const next = nextType(year);
  if (!next) return null;
  const y = clean(year);
  return { next, year: y, target: next.from, fraction: Math.min(1, y / next.from), toGo: Math.max(0, next.from - y) };
}
