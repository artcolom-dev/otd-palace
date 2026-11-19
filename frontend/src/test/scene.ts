import type { Deal, Move, Snapshot } from "../data/types";
import { isoAt, makeDeal, makeSnapshot } from "./fixtures";

/** The clock every scene is drawn at: 2026-11-12 18:00:00 UTC. */
export const NOW = Date.parse("2026-11-12T18:00:00Z");

const ago = (min: number) => isoAt(NOW - min * 60_000);
const inMs = (ms: number) => isoAt(NOW + ms);

/**
 * Seven deals across four sports, chosen so each rule has something to bite on:
 * - New (budget 200, high confidence, targets, 25% off, no falling) sees Chase (the hero) and Edwards;
 * - Regular (budget 1,000) also sees Jokić (falling), McDavid (a bid ending in 22 m), Allen (medium confidence),
 *   Celebrini (a bid ending in 49 s) and Salah (a loss after fees).
 */
export function sceneDeals(now = NOW): Deal[] {
  const d = (over: Partial<Deal>) => makeDeal({ now, ...over });
  return [
    d({
      listing_id: 101, card_id: 1, sport: "nfl", player_id: 11, player_name: "Ja'Marr Chase",
      card_label: "Ja'Marr Chase 2026", rarity: 4, rating: 7.1, mint: 41, price: 160, reference: 230,
      ref_sample: 8, discount: 0.304, gap: 70, flip_margin: 37, per_point: 22.5, listed_at: ago(4),
      ends_at: inMs(3_600_000),
    }),
    d({
      listing_id: 102, card_id: 2, sport: "nba", player_id: 22, player_name: "Nikola Jokić",
      card_label: "Nikola Jokić 2026", rarity: 3, rating: 7.4, mint: 233, price: 150, reference: 228,
      ref_sample: 12, discount: 0.342, gap: 78, flip_margin: 45, per_point: 20.3, listed_at: ago(5), falling: true,
      ends_at: inMs(3_600_000),
    }),
    d({
      listing_id: 103, card_id: 3, sport: "nhl", player_id: 33, player_name: "Connor McDavid",
      card_label: "Connor McDavid 2026", rarity: 2, rating: 5.5, mint: 402, kind: "bid", price: 64,
      reference: 104, ref_sample: 11, discount: 0.385, gap: 40, flip_margin: 19, per_point: 11.6, num_bids: 4,
      listed_at: ago(30), ends_at: inMs(22 * 60_000 + 14_000),
    }),
    d({
      listing_id: 104, card_id: 4, sport: "nba", player_id: 44, player_name: "Anthony Edwards",
      card_label: "Anthony Edwards 2026", rarity: 3, rating: 5.9, mint: 140, price: 70, reference: 95,
      ref_sample: 15, discount: 0.263, gap: 25, flip_margin: 5, per_point: 11.9, listed_at: ago(9),
      ends_at: inMs(3_600_000),
    }),
    d({
      listing_id: 105, card_id: 5, sport: "nfl", player_id: 55, player_name: "Josh Allen",
      card_label: "Josh Allen 2026", rarity: 4, rating: 6.8, mint: 63, price: 640, reference: 880,
      ref_sample: 4, ref_source: "fmv", confidence: "medium", discount: 0.273, gap: 240, flip_margin: 142,
      per_point: 94.1, listed_at: ago(7), ends_at: inMs(3_600_000),
    }),
    d({
      listing_id: 106, card_id: 6, sport: "nhl", player_id: 66, player_name: "Macklin Celebrini",
      card_label: "Macklin Celebrini 2026", rarity: 3, rating: 4.4, mint: 96, kind: "bid", price: 46,
      reference: 62, ref_sample: 7, discount: 0.258, gap: 16, flip_margin: -1, per_point: 10.5, num_bids: 2,
      listed_at: ago(40), ends_at: inMs(49_000),
    }),
    d({
      listing_id: 107, card_id: 7, sport: "soccer", player_id: 77, player_name: "Mohamed Salah",
      card_label: "Mohamed Salah 2026", rarity: 1, rating: 3.2, mint: 2311, price: 48, reference: 60,
      ref_sample: 33, discount: 0.2, gap: 12, flip_margin: -4, per_point: 15, listed_at: ago(14),
      ends_at: inMs(3_600_000),
    }),
  ];
}

const move = (over: Partial<Move> & Pick<Move, "sport" | "player_id" | "player_name">): Move => {
  const m = { season: 2026, bucket: "5-7", median_recent: 100, median_base: 100, sales_recent: 10, ...over };
  return { ...m, change: Math.round((m.median_recent / m.median_base - 1) * 1000) / 1000 } as Move;
};

/**
 * Today's price moves, as the server orders them (risers biggest first, fallers biggest fall first): five risers in
 * four sports, two fallers. Jokić falls 22% (his deal is tagged falling), McDavid 23%; Chase rises 40%.
 */
export function sceneMoves(): Snapshot["moves"] {
  return {
    risers: [
      move({ sport: "nfl", player_id: 11, player_name: "Ja'Marr Chase", bucket: "7-9", median_recent: 236, median_base: 168, sales_recent: 52 }),
      move({ sport: "nba", player_id: 44, player_name: "Anthony Edwards", median_recent: 84, median_base: 64, sales_recent: 46 }),
      move({ sport: "soccer", player_id: 77, player_name: "Mohamed Salah", bucket: "3-5", median_recent: 55, median_base: 44, sales_recent: 61 }),
      move({ sport: "nhl", player_id: 66, player_name: "Macklin Celebrini", bucket: "3-5", median_recent: 61, median_base: 50, sales_recent: 19 }),
      move({ sport: "nfl", player_id: 55, player_name: "Josh Allen", median_recent: 960, median_base: 790, sales_recent: 1 }),
    ],
    fallers: [
      move({ sport: "nhl", player_id: 33, player_name: "Connor McDavid", median_recent: 80, median_base: 104, sales_recent: 12 }),
      move({ sport: "nba", player_id: 22, player_name: "Nikola Jokić", bucket: "7-9", median_recent: 49, median_base: 63, sales_recent: 14 }),
    ],
  };
}

/** The scene as one snapshot, generated at `NOW`; `over` replaces whole fields. */
export function sceneSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return makeSnapshot({
    generated_at: isoAt(NOW),
    sports: ["nfl", "nba", "nhl", "soccer"],
    deals: sceneDeals(),
    moves: sceneMoves(),
    ...over,
  });
}
