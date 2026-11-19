// The snapshot as the server publishes it (advisor/snapshot.py): same keys, same snake_case.
// Nothing here identifies a person: a deal is about a card and a listing, never about who bids or sells.

export type DealKind = "target" | "bid"; // "target": the listing's target price; "bid": the bid to win an auction ending soon
export type Confidence = "high" | "medium";

export interface Deal {
  listing_id: number;
  card_id: number;
  sport: string;
  season: number;
  player_id: number;
  player_name: string;
  card_label: string;
  rarity: number;
  rating: number;
  bucket: string;
  mint: number | null;
  kind: DealKind;
  price: number;
  reference: number;
  ref_source: "sales" | "fmv";
  ref_tier: string | null;
  ref_sample: number;
  confidence: Confidence;
  discount: number; // the gap as a share of the reference, 0.286 = 28.6%
  gap: number; // reference minus price
  // What reselling at the reference pays after Real's fee and the listing fee, minus price; negative for a loss.
  // Under rules.after_fees_min_ref the fees eat most of any resale, so the screens grey it as thin.
  flip_margin: number;
  num_bids: number;
  ends_at: string; // UTC, such as 2026-11-12T18:00:00Z
  url: string;
  per_point: number | null; // price per rating point, to 1 decimal; null for a card rated 0
  ref_per_point: number | null; // reference per rating point, to 1 decimal; null for a card rated 0
  listed_at: string | null; // when the listing went up, UTC like ends_at; null when unknown
  falling: boolean; // its market fell 20% or more today, so the reference may be behind the market
  // When the listing was last read, UTC, if before the snapshot's moment (its bids may have moved since); null or
  // absent = read at that moment.
  seen_at?: string | null;
  // Real's own estimate for the card when the usual price comes from sales and the two differ a lot; null otherwise.
  real_estimate?: number | null;
  // The newest sales behind a usual price taken from sales: [price, seconds ago], newest first; empty otherwise.
  recent_sales?: [number, number][];
  // What ESPN says about this player's health, when it lists them; absent = no note, which is NOT "healthy".
  injury?: Injury;
  // How many recent listings of this player's cards ended, and how many of those sold; absent = no count.
  resale?: Resale;
}

/** Of the recent listings of a player's cards that ended, how many (`listed`) and how many of those sold. */
export interface Resale {
  listed: number;
  sold: number;
}

/** ESPN's note on a player: out (or on injured reserve), suspended, doubtful, questionable or day-to-day. */
export type InjuryStatus = "out" | "suspended" | "doubtful" | "questionable" | "day";
export interface Injury {
  status: InjuryStatus;
  part: string | null; // what hurts, in plain words ("Knee"), when ESPN says
  back: string | null; // the day ESPN expects them back, "YYYY-MM-DD", when it says
}

// Why a deal of the last round is not one now: "ended" (the auction is over), "countdown_started" (someone bid
// the target price), "outbid" (a higher bid than the deal's price), "price_moved" (the target price changed),
// "no_longer_a_deal" (anything else, such as the market it was judged against).
export type GoneReason = "ended" | "countdown_started" | "outbid" | "price_moved" | "no_longer_a_deal";

// A deal that just went away, exactly as it was served, plus why and when; shown dimmed for a moment.
export type GoneDeal = Deal & {
  reason: GoneReason;
  gone_at: string; // UTC like ends_at
};

export interface Move {
  sport: string;
  season: number;
  player_id: number;
  player_name: string;
  bucket: string;
  median_recent: number;
  median_base: number;
  change: number; // median_recent / median_base - 1
  sales_recent: number;
  injury?: Injury; // see Deal
  // The market's finished days for the curve on Prices, a member's only: [days ago, middle sale, sales], oldest first
  // (advisor/price_history.py). Read through lib/priceCurve.ts, which draws nothing from any other shape.
  curve?: unknown;
}

/** A ladder: "player", "fighter" or "team". */
export type PassKind = "player" | "fighter" | "team";

/**
 * One rarity a daily-pay pass can be built to, from the rating already held (advisor/otd.py Rung). Every figure is
 * the pass on its own: it wins each claim it is eligible for.
 */
export interface PassRung {
  tier: string; // "general" ... "iconic"; General (the mint alone) only for a pass not held that can be minted, of a season with live games left
  rating: number; // the rating that enters the tier
  mult: number; // the tier's multiplier at entry
  limit: number | null; // the most the pass pays over its life; null when the tier has none (counted over the horizon)
  limit_estimated: boolean; // Real states no limit for this pass: `limit` is an estimate
  rating_to_add: number;
  cost: number | null; // the mint (when not held) plus the rating at the build rate (lib/passRates.ts buildRate); null when it cannot be priced
  route: "mint" | "mint+cards" | "cards"; // "mint": General, the mint alone
  year_rax: number; // what it pays in the next 12 months
  year_capped: boolean; // the limit cuts what the season's anniversaries would pay
  projected: boolean; // a season in progress under rules.otd.projection_below played: a projection
  per_game_day: number | null;
  years_to_limit: number | null; // null without a limit
  year_per_rax: number | null; // the next 12 months' pay per Rax spent: the ranking figure
  lifetime_per_rax: number | null; // the limit (live pay counts toward it) per Rax spent; an unlimited tier counts its horizon
  pays_back: boolean | null; // within rules.otd.payback_horizon_years, the lifetime beating the cost; null if unpriced
  payback_months: number | null; // months from the snapshot's day; a month-level estimate
  payback_month: string | null; // "YYYY-MM"
}

/** What the shelf holds toward the best rung's rating: cheapest per point first, parked asks left out. */
export interface PassOnSale {
  on_sale_rating: number;
  on_sale_cost: number;
  enough: boolean;
  // Read from the shelf's live auctions (`PassMarket.auctions`): whether every card taken is at a pay a buyer can count
  // on now; false when one is only an auction opening at its pay ("auctions opening at"). Absent for the old shelf.
  firm?: boolean;
}

/** The feed's value bucket of a card's rating: (0, 3], (3, 5], (5, 7], over 7. */
export type PassBucket = "0-3" | "3-5" | "5-7" | "7+";

/** Accepted offers measured on enough offers (advisor/pass_rates.py offer_cells): the bucket, the rarity (null: the
 * whole bucket), the rate a point they cleared at, how many, and the listing rate a point of the same cell (null
 * under 5 listing sales). */
export type PassOfferCell = [bucket: PassBucket, rarity: string | null, rate: number, offers: number, listing: number | null];

/** One pass of one season: the engine's inputs, served whole so the browser's planner can recompute. */
export interface PassMarket {
  key: string; // "sport:season:kind:player_id"
  sport: string;
  season: number;
  season_label: string; // such as "2024-25"
  season_state: "past" | "current";
  player_id: number; // a team pass carries its team's id
  player_name: string;
  team_id: number | null;
  position: string | null;
  kind: PassKind;
  base_1x: number; // the season's 1x earnings; so far, for a season in progress
  season_progress: number; // share of the season played; 1 for a past season
  game_days: number | null;
  game_days_measured: boolean;
  month_share: number[]; // 12 shares of the season's pay by calendar month, January first
  // The shares are missing, all zero or not 12: the payback walk used the sport's months evenly (the whole year for
  // a sport whose months are unknown), so the payback month is an estimate.
  month_share_estimated: boolean;
  rate_traded: number | null; // median Rax per rating point the cards traded at; null when unknown
  rate_sales: number; // how many trades that rate comes from
  shelf: [rating: number, ask: number][]; // cards on sale, cheapest per point first, bounded
  shelf_count: number;
  mint_cost: number | null;
  mintable: boolean;
  // The feed's build rate and live auctions (advisor/snapshot.py _build_json), each only when the feed sent it: a
  // pass without them is priced and read exactly as before.
  rate_bucket?: PassBucket | null; // the bucket `rate_traded` comes from
  // What a rating point costs to build: the cheapest (bucket, rarity) cell with 5 listing sales. Null (present): the
  // feed measured the pass but no cell has enough sales, so `rate_traded` stands in, thin. Absent: an older row.
  rate_build?: number | null;
  rate_build_from?: { bucket: PassBucket; rarity: string; sales: number } | null;
  offers?: PassOfferCell[];
  // The shelf's auctions still open at the snapshot's moment, cheapest a point first: [rating, pay (the current bid,
  // else the opening price), 1 when that pay is a price a buyer can count on now, 0 when only an opening]. When
  // present, "on sale" reads these, not `shelf`.
  auctions?: [rating: number, pay: number, firm: 0 | 1][];
  rungs: PassRung[];
  best: string | null; // the tier paying the most next year per Rax spent, among those that pay back
  weak: string[]; // tiers paying less over their life per Rax than both neighbours; only tiers with a limit compared
  on_sale: PassOnSale | null; // toward the best rung; null without one, or when the best is General (the mint alone)
}

export interface PassSport {
  claim_days: number | null; // the days a year the sport pays anyone
  months: number[]; // the calendar months its season runs over
}

/** Two numbers of the "Pass deals" block, for the free site (Locked.pass_deals). */
export interface PassDealsTeaser {
  passes: number;
  best_pct: number | null;
}

export interface Otd {
  as_of: string;
  sports: Record<string, PassSport>; // the sports with passes
  markets: PassMarket[]; // the past seasons: what the Passes tab, the plan and every suggestion read
  // This season's passes, for Deals only (a deal's pass line, "Pass deals", the "For passes" sort) and for valuing a
  // pass the visitor holds: never a pick, a starter or any other suggestion (advisor/snapshot.py _otd_json). The feed
  // sends one for each player with a deal, on weaker data than a past season's. Absent from the free site's snapshot.
  current_markets?: PassMarket[];
  picks: Record<string, string[]>; // per sport, market keys best first; numbers live on the markets
  starters: Record<string, string>; // per sport, the market with the best Common or Uncommon entry
}

/** The pass constants the browser's planner shares with the server (advisor/rules.py). */
export interface OtdRules {
  claims_per_sport_day: number;
  ladders: Record<string, [tier: string, rating: number, mult: number][]>;
  player_limit_per_mult: number;
  no_limit: Record<string, string[]>;
  team_limits: Record<string, number>;
  fighter_limits?: Record<string, number>; // a fighter's (UFC) own limits; absent from an older payload
  limit_estimated_kinds: string[];
  limit_estimated_sports: string[];
  no_limit_horizon_years: number;
  payback_horizon_years: number; // a rung not paid back within this many years never pays back
  mint_cost: Record<string, number>;
  sport_months: Record<string, number[]>;
  sport_days: Record<string, [claim_days: number, player_days: number]>;
  // A weekly sport's game days are not spread: a season's passes play on the same few weekend dates (NFL, college
  // football): [shared days a season, share of a pass's game days on them] (advisor/rules.py OTD_WEEKLY_DAYS). A sport
  // missing here (or an older payload) is spread evenly, as every other sport is.
  weekly_days?: Record<string, [shared_days: number, share: number]>;
  // A weekly sport whose seasons with the same weekdays replay the same dates (golf): the share of days two such
  // seasons have in common.
  same_weekdays?: Record<string, number>;
  projection_below: number;
  full_at: number;
  ignore_ask_above: number;
  ignore_ask_min_sales: number;
  starter_tiers: string[];
  top: number;
  budget_presets: (number | null)[]; // the most to spend on one pass, offered in one tap, in RAX; null = any
  // The tiers that pay nothing On This Day (General): limit 0, only the live games of a season being played.
  no_otd_tiers: string[];
  // A pass whose next `window_months` from today hold under `share_below` of its next 12 months' pay is said to pay
  // later; its pay starts in the first month holding `start_share` of its season (lib/passes.ts paysLater).
  later: { window_months: number; share_below: number; start_share: number };
}

export interface Level {
  label: string;
  min_discount: number;
  confidence: Confidence[];
  kinds: DealKind[];
  bid_max_left_min: number; // a bid deal shows only when its auction ends within this many minutes; 0 = no bids
  default_budget: number | null; // the budget a visitor of this level starts with, in RAX; null = any
  hide_falling: boolean; // hide the deals whose market fell today (their reference may be behind the market)
  hide_hurt?: boolean; // hide the deals of a player ESPN lists as out, suspended or doubtful; absent (an older server) = show
  otd_default_budget: number | null; // the most this level starts out spending on one daily-pay pass; null = any
}

export interface Rules {
  stale_after_s: number;
  poll_s: number;
  fee: number; // the share of a sale price Real keeps
  listing_fee: number; // the RAX a seller pays to list a card, never refunded
  /** What Real's Quick Sell pays a card's rating point, in RAX (advisor/rules.py QUICKSELL_PER_POINT, measured): instant,
   * no Real Pro needed. Missing (an older server): no Quick Sell figures anywhere. */
  quicksell_per_point?: number;
  after_fees_min_ref: number; // under this reference a deal's flip_margin is thin, and greyed
  budget_presets: (number | null)[]; // budgets offered in one tap, in RAX; null = any
  demo?: boolean; // true while the server runs on the bundled sample data; the screens then tag it "Sample data"
  /** The list price helper's figures, measured on past sales (advisor/rules.py SELL_CURVE): [price over usual, share that sold]. */
  sell_curve?: [multiple: number, sold: number][];
  /** Similar deals: the price band (0.25 = within 25%) and how many to show at most (advisor/rules.py TWIN_*). */
  twins?: TwinRules;
  /** What the live feed covers, so the screens can say what they rest on; missing on the sample data. */
  coverage?: Coverage | null;
  otd: OtdRules;
  /** The sports our server has photos for; every other one shows initials and asks for none. Missing: ask for all. */
  photo_sports?: string[];
  /** The sports ESPN's injury list speaks for right now; missing or empty: no health notes anywhere. */
  injury_sports?: string[];
  /** Whether the server has a resale table right now (`deal.resale` says more); missing or false: no resale tags. */
  resale?: boolean;
}

/** What the live feed says it covers; the sample data carries none. */
export interface Coverage {
  sports: string[]; // the sports the feed reads
  listings_complete: boolean; // false while it may be missing some open listings
  sales_window_h: number; // the prices rest on this many hours of sales
  otd_as_of: string | null; // when the pass figures were measured; null when the feed has none
}

export interface TwinRules {
  price_band: number;
  max: number;
}

export interface Pulse {
  window_min: number; // the sales counted are those of the last this-many minutes
  sales: [sport: string, count: number][]; // busiest sport first, then by name; sports with no sale left out
}

export interface PushLink {
  public_key: string; // the server's VAPID public key, base64url: the browser subscribes with it
  check_s: number; // the server checks for alerts this often, in seconds
}

export interface Links {
  community: string | null; // our Discord invite (https://discord.gg/... or https://discord.com/invite/...); null hides it
  push?: PushLink | null; // alerts by web push; null (or missing) while the server sends none
  accounts?: boolean; // the site can read a Real account's passes (the page offers to link one)
  // Where a gift of Rax goes: the Real account to look for and, when set, the link of one of its cards.
  support?: { account: string; url: string | null };
}

/**
 * What the free site's snapshot leaves out, as counts: present only in the snapshot the server gives anyone who is not
 * a member of our Discord server (advisor/public.py), which holds the best few deals, a summary of the moves and each
 * sport's best passes. Absent: the whole snapshot (a member, or the gate is off).
 */
export interface Locked {
  deals: number; // every deal a member sees right now
  risers: number;
  fallers: number;
  passes: number; // every pass a member's lists rank
  alerts: boolean; // the site sends alerts (to members)
  accounts: boolean; // the site can read a Real account (for members)
  // "Pass deals" is a member's block: how many passes the cards on sale build for less than usual, and the best saving in
  // percent (null without one; rounded down to 5, at most 50; the deepest of the first 3 the block lists), as the block
  // would show a member of each level (advisor/pass_deals.py). The page says it from 10 up (PASS_DEALS_PCT_MIN). The
  // top-level pair is the New level's; `levels` is absent from an older snapshot, and the
  // whole of it from one made before it was counted.
  pass_deals?: PassDealsTeaser & { levels?: Record<string, PassDealsTeaser> };
  // The locked rarity strip: how many of every deal a member sees are of each of Real's rarities, keyed "0".."7"
  // (advisor/public.py rarity_counts). Counts only; absent from a snapshot made before they were counted.
  by_rarity?: Record<string, number>;
}

export interface Snapshot {
  version: number;
  generated_at: string;
  sports: string[]; // the sports with listings, most sales in the last 24 h first, then by name
  deals: Deal[];
  moves: { risers: Move[]; fallers: Move[] };
  otd: Otd;
  /** A short hash of `otd`: a poll that names it (`?otd=`) gets the snapshot without `otd` while the passes stand. */
  otd_version?: string;
  levels: Record<string, Level>; // "new", "regular" and "pro"
  rules: Rules;
  pulse: Pulse;
  gone: GoneDeal[]; // deals that went away in the last 45 s, newest first
  taken_10m: number; // deals taken (target bid, outbid or ended) in the last 10 minutes
  links: Links;
  // What Real pays Rax or packs for right now, soonest-ending first; empty or absent when nothing runs.
  challenges?: Challenge[];
  // Bids heard in the last 10 minutes per sport whose live bid stream is up; empty or absent without one.
  bidding?: Record<string, { bids_10m: number; bidders_10m: number }>;
  /** The free site's snapshot says what it leaves out (see Locked); a member's has none. */
  locked?: Locked;
}

/** A challenge Real runs now (watch a game's plays, fill a profile...) that pays Rax or packs. */
export interface Challenge {
  title: string;
  reward: string | null; // what it pays, in Real's words, when known
  ends_at: string | null; // UTC; null when it says no end
}
