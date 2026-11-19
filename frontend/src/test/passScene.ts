// A small daily-pay pass market for the Passes tests. Each market's rungs, best, weak and on-sale figures come from
// the browser engine (lib/passes.ts), which the golden vectors hold equal to the server's, and the picks and starters
// follow advisor/otd.py's rules: so the scene is what the server would publish for these inputs.
import type { Otd, PassMarket, PassRung, Snapshot } from "../data/types";
import { type PassBasis, bestRung, isLiquid, onSale, rungs, weakRungs } from "../lib/passes";
import { OTD_RULES, isoAt, makeSnapshot } from "./fixtures";
import { NOW } from "./scene";

export const TODAY = isoAt(NOW).slice(0, 10);
const FLAT = (months: number[]) => Array.from({ length: 12 }, (_, i) => (months.includes(i + 1) ? 1 / months.length : 0));
const NBA = FLAT([10, 11, 12, 1, 2, 3, 4, 5, 6]);
const NHL = FLAT([10, 11, 12, 1, 2, 3, 4, 5, 6]);
const NFL = FLAT([9, 10, 11, 12, 1, 2]);
const UFC = FLAT([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const MLB = FLAT([3, 4, 5, 6, 7, 8, 9, 10]);

function basis(over: Partial<PassBasis> & Pick<PassBasis, "sport" | "season" | "player_id" | "player_name">): PassBasis {
  const kind = over.kind ?? "player";
  return {
    key: `${over.sport}:${over.season}:${kind}:${over.player_id}`,
    season_label: String(over.season),
    season_state: "past",
    team_id: null,
    position: null,
    kind,
    base_1x: 500,
    season_progress: 1,
    game_days: 80,
    game_days_measured: true,
    month_share: NBA,
    rate_traded: 10,
    rate_sales: 30,
    shelf: [],
    shelf_count: 0,
    mint_cost: kind === "team" ? 800 : kind === "fighter" ? 600 : 200,
    mintable: true,
    ...over,
  };
}

/** The market as the server serves it: its inputs, then the engine's rungs, best, weak and on-sale figures. */
export function served(b: PassBasis, today = TODAY): PassMarket {
  const ladder = rungs(b, OTD_RULES, { today });
  const best = bestRung(ladder);
  const weak = weakRungs(ladder);
  const sale = best && best.route !== "mint" ? onSale(b, best.rating_to_add, OTD_RULES) : null; // General needs no card
  return {
    ...b,
    month_share_estimated: false,
    rungs: ladder,
    best: best?.tier ?? null,
    weak: ladder.filter((r) => weak.has(r.tier)).map((r) => r.tier),
    on_sale: sale && { on_sale_rating: sale.on_sale_rating, on_sale_cost: sale.on_sale_cost, enough: sale.enough },
  };
}

// advisor/otd.py _rank: soonest paid back from today, then the most a year per Rax, the bigger year, the ids.
const rank = (m: PassMarket, r: PassRung) =>
  [r.payback_months ?? Infinity, -(r.year_per_rax ?? 0), -r.year_rax, m.player_id, m.season] as const;
function byRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * The otd section for these markets, picks and starters as advisor/otd.py makes them. Every market is in `markets`,
 * a season being played too: the engine's own tests feed it those. The server now serves a season being played apart
 * and never suggests it (`servedOtd`).
 */
export function otdOf(markets: PassMarket[]): Otd {
  const sports = [...new Set(markets.map((m) => m.sport))].sort();
  const picks: Record<string, string[]> = {};
  const starters: Record<string, string> = {};
  for (const sport of sports) {
    const ranked = markets
      .filter((m) => m.sport === sport && isLiquid(m))
      .map((m) => ({ m, r: m.rungs.find((r) => r.tier === m.best) }))
      .filter((x): x is { m: PassMarket; r: PassRung } => x.r !== undefined)
      .sort((a, b) => byRank(rank(a.m, a.r), rank(b.m, b.r)));
    if (ranked.length) picks[sport] = ranked.slice(0, OTD_RULES.top).map((x) => x.m.key);
    const entries = markets
      .filter((m) => m.sport === sport && isLiquid(m))
      .flatMap((m) =>
        m.rungs
          .filter((r) => !r.projected && OTD_RULES.starter_tiers.includes(r.tier) && r.pays_back && r.year_per_rax !== null)
          .map((r) => ({ m, r })),
      )
      .sort((a, b) => byRank(rank(a.m, a.r), rank(b.m, b.r)));
    if (entries[0]) starters[sport] = entries[0].m.key;
  }
  return {
    as_of: isoAt(NOW),
    sports: Object.fromEntries(sports.map((s) => [s, { claim_days: OTD_RULES.sport_days[s]?.[0] ?? null, months: OTD_RULES.sport_months[s] ?? [] }])),
    markets,
    picks,
    starters,
  };
}

/**
 * The otd section as advisor/snapshot.py serves it: a season being played is in `current_markets`, for Deals and held
 * passes only, and never a pick or a starter; `markets` holds the past seasons.
 */
export function servedOtd(all: PassMarket[]): Otd {
  const past = otdOf(all.filter((m) => m.season_state !== "current"));
  const sports = [...new Set(all.map((m) => m.sport))].sort();
  return {
    ...past,
    sports: Object.fromEntries(sports.map((s) => [s, { claim_days: OTD_RULES.sport_days[s]?.[0] ?? null, months: OTD_RULES.sport_months[s] ?? [] }])),
    current_markets: all.filter((m) => m.season_state === "current"),
  };
}

export const MACKINNON = served(basis({
  sport: "nhl", season: 2026, season_label: "2025-26", player_id: 3001, player_name: "Nathan MacKinnon", team_id: 301,
  base_1x: 520, game_days: 84, month_share: NHL, rate_traded: 5.5, rate_sales: 40, shelf_count: 3,
  shelf: [[200, 1000], [100, 560], [80, 470]],
}));
export const MCDAVID = served(basis({
  sport: "nhl", season: 2026, season_label: "2025-26", player_id: 3002, player_name: "Connor McDavid", team_id: 302,
  base_1x: 400, game_days: 89, month_share: NHL, rate_traded: 11, rate_sales: 25, shelf_count: 1, shelf: [[12, 130]],
}));
export const JOKIC = served(basis({
  sport: "nba", season: 2025, season_label: "2024-25", player_id: 1001, player_name: "Nikola Jokić", team_id: 101,
  base_1x: 600, game_days: 80, rate_traded: 10, rate_sales: 50, shelf_count: 2, shelf: [[6, 60], [5, 52]],
}));
export const MURRAY = served(basis({
  sport: "nba", season: 2025, season_label: "2024-25", player_id: 1002, player_name: "Jamal Murray", team_id: 101,
  base_1x: 300, game_days: 74, rate_traded: 9, rate_sales: 18, shelf_count: 0,
}));
export const SGA = served(basis({
  sport: "nba", season: 2026, season_label: "2025-26", player_id: 1003, player_name: "Shai Gilgeous-Alexander",
  team_id: 102, base_1x: 1000, game_days: 76, rate_traded: 40, rate_sales: 60, shelf_count: 0,
}));
export const CHASE = served(basis({
  sport: "nfl", season: 2026, season_label: "2026", season_state: "current", season_progress: 0.5,
  player_id: 2001, player_name: "Ja'Marr Chase", team_id: 201, base_1x: 300, game_days: 17, month_share: NFL,
  rate_traded: 12, rate_sales: 22, shelf_count: 0,
}));
// A fighter whose season earned too little to pay back his 600 mint within the horizon, at any rarity.
export const OLIVEIRA = served(basis({
  sport: "ufc", season: 2025, season_label: "2025", kind: "fighter", player_id: 5001, player_name: "Charles Oliveira",
  base_1x: 25, game_days: 3, month_share: UFC, rate_traded: 30, rate_sales: 12, shelf_count: 0,
}));
// A past MLB season, in November: the most Rax a year per Rax of the scene, but nothing until March. Not in
// PASS_MARKETS: the tests on the season's clock add it.
export const JUDGE = served(basis({
  sport: "mlb", season: 2026, season_label: "2026", player_id: 4001, player_name: "Aaron Judge", team_id: 401,
  base_1x: 600, game_days: 140, month_share: MLB, rate_traded: 5, rate_sales: 30, shelf_count: 2,
  shelf: [[200, 1000], [200, 1000]],
}));
// A season being played with most of its games left: its General, the mint alone, pays those games live (never On
// This Day), and is its best rung. Not in PASS_MARKETS: the tests that need a mint-only pick add it.
export const WEMBANYAMA = served(basis({
  sport: "nba", season: 2027, season_label: "2026-27", season_state: "current", season_progress: 0.3, player_id: 1004,
  player_name: "Victor Wembanyama", team_id: 104, base_1x: 300, game_days: 80, rate_traded: 40, rate_sales: 30,
  shelf_count: 0,
}));
export const THUNDER = served(basis({
  sport: "nba", season: 2025, season_label: "2024-25", kind: "team", player_id: 101,
  player_name: "Oklahoma City Thunder", team_id: 101, base_1x: 1935, game_days: 88, rate_traded: null, rate_sales: 0,
  shelf_count: 0,
}));

export const PASS_MARKETS = [JOKIC, MURRAY, SGA, THUNDER, CHASE, MACKINNON, MCDAVID, OLIVEIRA];

/** A snapshot of the deals scene with this pass market. */
export function passSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return makeSnapshot({ sports: ["nba", "nhl", "nfl"], otd: otdOf(PASS_MARKETS), ...over });
}
