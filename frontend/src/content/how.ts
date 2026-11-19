// "How Real works": what Real is, for someone who never played, then the things a player needs before the numbers
// on this site make sense, in plain words. Each is 40 words at most. Only public mechanics of Real and what our own data
// shows; nothing about what an account earns. Real's rules for Rax come from its own docs (docs.realapp.link), as
// summed up in the internal research notes and 2026-11-16-rax-economy-deep.md (high-confidence points only).
import { REAL_HOME } from "../lib/openLink";
import { foldName } from "../lib/words";
import type { TermKey } from "./glossary";

export type HowId =
  | "new"
  | "fees"
  | "countdown"
  | "winning"
  | "offers"
  | "minted"
  | "usual"
  | "falling"
  | "passes"
  | "rarity"
  | "first"
  | "boosters"
  | "more"
  | "polls"
  | "estimates";

export interface HowItem {
  id: HowId;
  title: string;
  text: string;
  link?: { label: string; href: string }; // one way on, under the text
}

export const MAX_HOW_WORDS = 40;

export const HOW: readonly HowItem[] = [
  {
    id: "new",
    title: "New to Real?",
    text: "Real is a sports app: you collect cards of real players and earn Rax, its coin. Players sell cards to each other in auctions, and a pass earns you Rax on the days its player plays. Start with the app.",
    link: { label: "Get Real at realapp.com", href: REAL_HOME },
  },
  {
    id: "fees",
    title: "Fees",
    text: "Real keeps 10% of each sale. A normal listing costs 10 Rax, never refunded; Quick List has no listing fee. So a deal can still lose when resold; on cards usually under 50 Rax, most do.",
  },
  {
    id: "countdown",
    title: "No instant buy, and the countdown",
    text: "You cannot buy a card at once. Bidding the target price starts a 10-minute countdown, and others can still outbid you. A bid in the last minute adds a minute (the soft close).",
  },
  {
    // Measured on 435 listings behind the sale records of 49 star players, 7 sports (2026-11-02): 78% of quick-list
    // sales went to one bid at the opening price; of the deals (opened under 0.8x the usual price) that sold, 46% went
    // to that first bid and the rest ended near 0.85x.
    id: "winning",
    title: "Who wins a deal",
    text: "Most cards that sell get one bid, at the opening price. On deals, about half go to the first bidder; the rest turn into a bidding war that still ends under the usual price. Bid early.",
  },
  {
    // Offers read: 18% of 61,537 were accepted, 64 Rax a card (the internal research notes, how they buy;
    // 2026-11-16-rax-economy-deep.md, A-admin); low offers from the smallest accounts, 6%. No figure here: the ⓘ of
    // "offer" (content/glossary.ts) and the pass hints (lib/offers.ts) carry it, as an expectation. Reframed for the
    // passes (the owner, 2026-11-18): the accepted ones are the cheapest rating a pass can get.
    id: "offers",
    title: "Offers: the cheap way to build a pass",
    text: "Offer under the usual price on many cards of the player and season your pass needs. Most offers are refused, so send many: the ones accepted are the cheapest rating you will get. Offers need Real Pro.",
  },
  {
    id: "minted",
    title: "Real's own listings and players' listings",
    text: "Real also lists cards of its own. Its supply has no end, so those are never deals and we hide them. A deal is a card another player lists for less than it usually sells for.",
  },
  {
    id: "usual",
    title: "What \"usual price\" means",
    text: "The middle price of the latest sales of the same kind of card over the past 7 days. It comes from real sales, never from asking prices, which run far higher. The number of sales is shown.",
  },
  {
    id: "falling",
    title: "A falling market",
    text: "When a card's prices drop 20% or more in a day, its usual price may be out of date and a deal there can be a trap. New hides these deals; the other levels mark them.",
  },
  {
    id: "passes",
    title: "What passes pay",
    text: "A pass of the season now playing pays Rax for every game its player plays, on its own; playoff games pay double. Past seasons pay On This Day, until a lifetime limit: Real pays 2 claims per sport per day.",
  },
  {
    // Real's player-cards page (rarity = the cards owned of that player and season); seen on accounts: between two
    // reads 9.5 hours apart 504 passes fell a rarity on 66 of 123 accounts, 12 of them from Legendary to General
    // (the internal research notes, 3c).
    id: "rarity",
    title: "A pass's rarity is its cards",
    text: "A pass's rarity is the sum of the ratings of the cards you hold of that player and season. Buy a card and the pass can climb; sell one and it falls back, and so does what it pays.",
  },
  {
    id: "first",
    title: "Your free pass, and Real Pro's extra claim",
    text: "Each season, your first player pass in each sport is free; more cost 200 Rax to mint. Real Pro members also get one extra claim a day across all sports, through the bonus poll: win the poll and it counts.",
  },
  {
    id: "boosters",
    title: "Boosters",
    text: "Every pack holds a booster. Put it on a pass before a game and it adds to the pass's multiplier for that game: Rare +10, Epic +15, Legendary +25. No effect On This Day; a bad game still uses it.",
  },
  {
    id: "more",
    title: "Other ways to earn Rax",
    text: "Streak poll: 2 right picks in a row cash out 5 Rax, 8 cash out 320. Karma converts to Rax, 5 per 1,000. Real Pro lineups pay 100 down to 10 to the top 10, plus 10 per exact pick.",
  },
  {
    id: "polls",
    title: "The poll lock",
    text: "A pass applied to a poll cannot be claimed until the poll ends. Before you use a pass on a poll, check it is not one you still want to claim with.",
  },
  {
    id: "estimates",
    title: "Why numbers are estimates",
    text: "Prices move, and past sales do not promise future ones. A pass's pay is spread by how its past seasons fell across the months. A figure marked estimate is our best reading, not a promise.",
  },
];

export const HOW_IDS: readonly HowId[] = HOW.map((h) => h.id);

export const isHowId = (value: unknown): value is HowId => typeof value === "string" && (HOW_IDS as readonly string[]).includes(value);

/** The words of an item, counted the way a reader would. */
export const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** What the address asks for: `#how` (the sheet), `#how/fees` (the sheet at an item); null when it asks for neither. */
export function howFromHash(hash: string): { id: HowId | null } | null {
  let raw: string;
  try {
    raw = decodeURIComponent(hash.replace(/^#/, "")).toLowerCase();
  } catch {
    return null;
  }
  if (raw === "how") return { id: null };
  const m = /^how\/([a-z]+)$/.exec(raw);
  if (!m) return null;
  return { id: isHowId(m[1]) ? m[1] : null }; // an item that does not exist opens the sheet at its top
}

export const howHash = (id: HowId | null): string => (id ? `#how/${id}` : "#how");

/** The items whose title or text holds every word typed (accents and case ignored); all of them for an empty search. */
export function howSearch(query: string, items: readonly HowItem[] = HOW): HowItem[] {
  const words = foldName(query.trim()).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const hay = foldName(`${item.title} ${item.text}`);
    return words.every((w) => hay.includes(w));
  });
}

/** The ⓘ terms that have a fuller answer here. */
export const TERM_HOW: Partial<Record<TermKey, HowId>> = {
  fees: "fees",
  thin: "fees",
  usual: "usual",
  typical: "usual",
  start: "countdown",
  bid: "countdown",
  falling: "falling",
  realMinted: "minted",
  otd: "passes",
  claims: "passes",
  claim: "passes",
  livePay: "passes",
  pass: "passes",
  rarity: "rarity",
  lift: "rarity",
  general: "first",
  mint: "first",
  booster: "boosters",
  quickList: "fees",
  offer: "offers",
  estimate: "estimates",
  projection: "estimates",
};
