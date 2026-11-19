import type { Deal, GoneDeal, Level, OtdRules, Rules, Snapshot } from "../data/types";

export const LEVELS: Record<string, Level> = {
  new: {
    label: "New", min_discount: 0.25, confidence: ["high"], kinds: ["target"], bid_max_left_min: 0, default_budget: 200,
    hide_falling: true, hide_hurt: true, otd_default_budget: 1000,
  },
  regular: {
    label: "Regular", min_discount: 0.2, confidence: ["high", "medium"], kinds: ["target", "bid"],
    bid_max_left_min: 30, default_budget: 1000, hide_falling: false, otd_default_budget: 5000,
  },
  pro: {
    label: "Pro", min_discount: 0.2, confidence: ["high", "medium"], kinds: ["target", "bid"],
    bid_max_left_min: 120, default_budget: null, hide_falling: false, otd_default_budget: null,
  },
};

/** The daily-pay pass constants as the server ships them (advisor/rules.py). */
export const OTD_RULES: OtdRules = {
  claims_per_sport_day: 2,
  ladders: {
    player: [["general", 0, 1], ["common", 10, 2], ["uncommon", 30, 3], ["rare", 80, 4], ["epic", 180, 10],
      ["legendary", 380, 25], ["mystic", 1380, 75], ["iconic", 3380, 150]],
    fighter: [["general", 0, 1], ["common", 10, 1.2], ["uncommon", 30, 1.4], ["rare", 80, 1.6], ["epic", 180, 2],
      ["legendary", 380, 5], ["mystic", 1380, 10], ["iconic", 3380, 20]],
    team: [["general", 0, 1], ["common", 30, 1.2], ["uncommon", 90, 1.4], ["rare", 240, 1.6], ["epic", 540, 2],
      ["legendary", 1140, 2.5], ["mystic", 4140, 4], ["iconic", 10140, 6]],
  },
  player_limit_per_mult: 500,
  no_limit: { player: ["iconic"], fighter: ["iconic"] },
  team_limits: {
    common: 1500, uncommon: 2500, rare: 4000, epic: 6000, legendary: 12000, mystic: 24000,
    iconic: 128000,
  },
  fighter_limits: { common: 1500, uncommon: 3000, rare: 6000, epic: 12000, legendary: 24000, mystic: 48000 },
  limit_estimated_kinds: [],
  limit_estimated_sports: ["soccer"],
  no_limit_horizon_years: 3,
  payback_horizon_years: 5,
  mint_cost: { player: 200, team: 800, fighter: 800 },
  sport_months: {
    mlb: [3, 4, 5, 6, 7, 8, 9, 10], nba: [10, 11, 12, 1, 2, 3, 4, 5, 6], nfl: [9, 10, 11, 12, 1, 2],
    nhl: [10, 11, 12, 1, 2, 3, 4, 5, 6], wnba: [5, 6, 7, 8, 9, 10], ufc: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    soccer: [8, 9, 10, 11, 12, 1, 2, 3, 4, 5], golf: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    cfb: [8, 9, 10, 11, 12, 1], cbb: [11, 12, 1, 2, 3, 4],
  },
  sport_days: {
    mlb: [205, 135], nba: [210, 78], nfl: [62, 18], nhl: [195, 82], wnba: [130, 50], ufc: [250, 25],
    soccer: [230, 47], golf: [180, 20], cfb: [55, 13], cbb: [145, 33],
  },
  weekly_days: { nfl: [18, 0.78], cfb: [14, 0.8], golf: [43, 1] },
  same_weekdays: { golf: 0.7 },
  projection_below: 0.9,
  full_at: 0.85,
  ignore_ask_above: 5,
  ignore_ask_min_sales: 5,
  starter_tiers: ["common", "uncommon"],
  top: 10,
  budget_presets: [1000, 5000, 20000, null],
  no_otd_tiers: ["general"],
  later: { window_months: 3, share_below: 0.1, start_share: 0.02 },
};

export const RULES: Rules = {
  stale_after_s: 90,
  poll_s: 5,
  fee: 0.1,
  listing_fee: 10,
  quicksell_per_point: 1,
  after_fees_min_ref: 200,
  budget_presets: [50, 200, 1000, null],
  demo: false,
  sell_curve: [[0.95, 0.99], [1.05, 0.9], [1.2, 0.29]],
  twins: { price_band: 0.25, max: 3 },
  otd: OTD_RULES,
};

/** A deal at 300 RAX, 28.6% under its reference, high confidence, a target price, an NBA card listed an hour ago
 * and ending in an hour. */
export function makeDeal(over: Partial<Deal> & { now?: number } = {}): Deal {
  const { now = Date.now(), ...fields } = over;
  return {
    listing_id: 1,
    card_id: 10,
    sport: "nba",
    season: 2026,
    player_id: 100,
    player_name: "Test Player",
    card_label: "Test Player 2026",
    rarity: 3,
    rating: 4.2,
    bucket: "3-5",
    mint: 12,
    kind: "target",
    price: 300,
    reference: 420,
    ref_source: "sales",
    ref_tier: null,
    ref_sample: 6,
    confidence: "high",
    discount: 0.286,
    gap: 120,
    flip_margin: 68,
    per_point: 71.4,
    ref_per_point: 100,
    num_bids: 0,
    listed_at: new Date(now - 3_600_000).toISOString(),
    ends_at: new Date(now + 3_600_000).toISOString(),
    falling: false,
    url: "https://www.realapp.com/D5h7FRFWPOKGR",
    ...fields,
  };
}

/** That deal as it is served once it went away: why ("ended" by default) and when (`now` by default). */
export function makeGone(over: Partial<GoneDeal> & { now?: number } = {}): GoneDeal {
  const { reason = "ended", gone_at, now = Date.now(), ...fields } = over;
  return { ...makeDeal({ now, ...fields }), reason, gone_at: gone_at ?? isoAt(now) };
}

/** A time as the server writes it: UTC to the second, such as 2026-11-12T18:00:00Z. */
export const isoAt = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A snapshot generated right now, by the clock a test runs on (fake timers move it). */
export function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    generated_at: isoAt(Date.now()),
    sports: ["nba"],
    deals: [],
    moves: { risers: [], fallers: [] },
    otd: { as_of: isoAt(Date.now()), sports: {}, markets: [], picks: {}, starters: {} },
    levels: LEVELS,
    rules: RULES,
    pulse: { window_min: 60, sales: [] },
    gone: [],
    taken_10m: 0,
    links: { community: null, push: null },
    ...over,
  };
}
