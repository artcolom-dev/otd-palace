// Real's own vocabulary, in one place: the rarities (names, order, colours, the emoji Real's docs give them), the sport
// names, how a season is written, and the words rule the copy follows. advisor/real.py is the same table for the
// server's pages and the Discord copy; tests/test_real.py keeps the two equal, and tokens.css's --rarity-N with them.
//
// Source: Real's public docs (docs.realapp.link, read 2026-11-16): /collect/player-cards and /collect/team-cards
// (the rarity order and multipliers, "Legendary 2" … sub-levels), /collect/on-this-day ("player and team passes",
// "Common or better", "2022-23"), /basics/rax ("Rax"), /basics/sports, /basics/real-pro, /collect/play-cards/prestige.
// We never copy Real's logo, art or screenshots; this is words and a colour per rarity, so players read a rarity here
// the way they read it in the app.

export interface Rarity {
  key: string; // the API's tier name, lower case
  name: string; // as Real writes it
  emoji: string; // the mark Real's docs put beside it (Discord copy only; the site draws a swatch)
  color: string; // the swatch, ring and frame colour on the dark theme: Real's colour for this rarity
}

/**
 * Real's eight rarities by index 0..7. The colours follow the colour Real's docs give each rarity (⚪ General,
 * 🔵 Common, 🟢 Uncommon, 🟠 Rare, 🔴 Epic, 🟣 Legendary, 🟡 Mystic, 💎 Iconic), tuned to read on our near-black.
 * They only ever draw a swatch, a ring or a frame next to the rarity's name: never text, never an action.
 */
export const RARITIES: readonly Rarity[] = [
  { key: "general", name: "General", emoji: "⚪", color: "#c9cbd1" },
  { key: "common", name: "Common", emoji: "🔵", color: "#3f8cf0" },
  { key: "uncommon", name: "Uncommon", emoji: "🟢", color: "#45b35a" },
  { key: "rare", name: "Rare", emoji: "🟠", color: "#ee8a2a" },
  { key: "epic", name: "Epic", emoji: "🔴", color: "#e5484d" },
  { key: "legendary", name: "Legendary", emoji: "🟣", color: "#a071f0" },
  { key: "mystic", name: "Mystic", emoji: "🟡", color: "#f0c232" },
  { key: "iconic", name: "Iconic", emoji: "💎", color: "#72d3f2" },
];

/** Whether `value` is one of Real's eight rarity indexes (a whole number 0..7). The feed sends 0 (General) for a card
 * Real gave no rarity, so General can hold a few such cards; anything else odd is no rarity at all. */
export function isRarity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < RARITIES.length;
}

/** Real's rarity by its index 0..7; an empty string for one it does not have. */
export function rarityName(rarity: number): string {
  return RARITIES[rarity]?.name ?? "";
}

/** The index 0..7 of a tier name ("legendary" → 5, any case); -1 for one Real does not have. */
export function rarityIndex(tier: string): number {
  const key = tier.trim().toLowerCase();
  return RARITIES.findIndex((r) => r.key === key);
}

/** A rarity index the stylesheet has a colour for (0..7), else 0. */
export function rarityClass(rarity: number): string {
  return `rar-${Number.isInteger(rarity) && rarity >= 0 && rarity < RARITIES.length ? rarity : 0}`;
}

const SUB_LEVEL = /^([a-z]+)(?: ([1-9]\d?))?$/i;

/**
 * A rarity as Real writes it on a card: "Legendary 3" when Real's own label names that sub-level of this rarity,
 * else the rarity's name ("Legendary"). A label that names another rarity, or anything else, is not trusted.
 */
export function rarityLabel(rarity: number | string, realLabel?: string | null): string {
  const index = typeof rarity === "number" ? rarity : rarityIndex(rarity);
  const name = rarityName(index);
  if (!name) return typeof rarity === "string" ? rarity.charAt(0).toUpperCase() + rarity.slice(1) : "";
  const m = SUB_LEVEL.exec((realLabel ?? "").trim());
  if (!m || m[1]!.toLowerCase() !== name.toLowerCase()) return name;
  return m[2] && m[2] !== "1" ? `${name} ${m[2]}` : name;
}

/** Sports as Real names them in a sentence (/basics/sports); a tab or a meta line uses `sportLabel`. */
export const SPORT_NAMES: Record<string, string> = {
  nba: "NBA",
  nfl: "NFL",
  mlb: "MLB",
  nhl: "NHL",
  ufc: "UFC",
  wnba: "WNBA",
  soccer: "Soccer",
  golf: "Golf",
  cfb: "NCAA Football",
  cbb: "NCAA Men's Basketball",
};

const SPORT_SHORT: Record<string, string> = { soccer: "Soccer", golf: "Golf", cricket: "Cricket", tennis: "Tennis" };

/** "nba" → "NBA": the short name a tab, a chip or a meta line uses; a sport that reads as a word gets a capital. */
export function sportLabel(sport: string): string {
  const known = SPORT_SHORT[sport];
  if (known) return known;
  return sport.length <= 4 ? sport.toUpperCase() : sport.charAt(0).toUpperCase() + sport.slice(1);
}

/** The sport's name in a sentence: Real's ("NCAA Football"), else its short label. */
export const sportName = (sport: string) => SPORT_NAMES[sport] ?? sportLabel(sport);

/**
 * The leagues whose season straddles New Year, which Real writes as two years ("2025-26"); its data numbers such a
 * season by the year it ends in. Every other sport is one year ("2026").
 */
export const CROSS_YEAR_SPORTS: readonly string[] = ["nba", "nhl", "cbb"];

/** A season as Real writes it: "2025-26" for NBA 2026, "2026" for NFL or MLB 2026. */
export function seasonLabel(sport: string, season: number): string {
  if (!Number.isInteger(season)) return "";
  if (!CROSS_YEAR_SPORTS.includes(sport)) return String(season);
  return `${season - 1}-${String(season % 100).padStart(2, "0")}`;
}
