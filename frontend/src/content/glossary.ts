// Every word the screens use, explained in plain English. Shown behind each ⓘ: a popover on desktop, a sheet on a
// phone. The text is the product's voice; keep it short and concrete.

import { PRICE_CURVE_ON } from "../lib/priceCurveSwitch";

// The curve on Prices, said only while it is drawn (lib/priceCurve.ts; the numbers are advisor/rules.py's).
const MOVES_CURVE = PRICE_CURVE_ON
  ? " The small chart on Prices draws the middle sale of each day with 3 or more sales, at most 30 days back: a day with fewer is left empty, and the last dot is the last 24 hours."
  : "";

export type TermKey =
  | "rating"
  | "usual"
  | "start"
  | "bid"
  | "under"
  | "cheaper"
  | "perPoint"
  | "fees"
  | "thin"
  | "falling"
  | "noProfit"
  | "hurt"
  | "resale"
  | "realMinted"
  // The Passes tab
  | "otd"
  | "claims"
  | "passYear"
  | "perGameDay"
  | "payback"
  | "limit"
  | "limitCost"
  | "buildCost"
  | "onSale"
  | "typical"
  | "projection"
  | "estimate"
  | "weak"
  | "team"
  | "never"
  | "breakEven"
  | "fill"
  | "myPasses"
  | "bestForBudget"
  | "soon"
  // Today and Prices
  | "moves"
  | "saved"
  // Real's own words, for someone new (the advice, the budget answer, the guides)
  | "pass"
  | "rarity"
  | "general"
  | "lift"
  | "livePay"
  | "claim"
  | "booster"
  | "quickList"
  | "quickSell"
  | "mint"
  | "offer"
  | "yearBack"
  | "realPro";

export interface Term {
  title: string;
  text: string; // "{n}" is the number of sales behind a usual price
  short?: string; // one line, for a hover and for the first time a word appears in plain words; else the text's first sentence
}

export const GLOSSARY: Record<TermKey, Term> = {
  rating: {
    title: "Rating",
    text: "The card's rating points, not points scored. Passes are built from rating points, so a lower price per rating point is better.",
  },
  usual: { title: "Usual price", text: "Middle price of the last {n} sales of this card type, past 7 days." },
  start: {
    title: "To start",
    text: "Bid this to start a 10-min countdown. Others can still outbid you; a bid in the last minute adds a minute.",
  },
  bid: { title: "Top bid", text: "Live auction; this is the bid to beat." },
  under: { title: "% under", text: "How much under the usual price: 1 − price ÷ usual price." },
  cheaper: { title: "% cheaper", text: "How much cheaper than the usual price: 1 − price ÷ usual price." },
  perPoint: { title: "Per rating pt", text: "Price ÷ rating. Lower means cheaper rating points for your passes." },
  fees: { title: "After fees", text: "If you resold at the usual price: Real keeps 10% and a normal listing costs 10 Rax (Quick List has no fee)." },
  thin: {
    title: "Thin",
    text: "The usual price is under 200, so fees eat most of any resale: too small to count on.",
  },
  falling: { title: "Falling", text: "Prices for this card dropped today; the usual price may be out of date." },
  noProfit: {
    title: "Below its usual price, but no profit to resell after fees",
    text: "Resold at the usual price, Real's 10% and the 10 Rax listing fee would eat the whole gap. Worth it if you want the card, not to flip.",
  },
  resale: {
    title: "Resale",
    text: "Of the recent listings of cards like this one (this player's, of about this rating) that ended, how many sold before their auction did. 6 in 10 or more is Resells well; 1 in 4 or fewer is Slow to resell. It says how easily cards like this sell again, not what yours will fetch: price and timing matter more.",
  },
  hurt: {
    title: "Hurt player",
    text: "ESPN lists this player as hurt, suspended or doubtful. Cards of hurt players often sell cheap because buyers expect them to miss games, and the usual price is from before. It can fall further, or recover when they are back. Check the news before you bid.",
  },
  realMinted: {
    title: "Real-minted listings are hidden",
    text: "Real's own listings are unlimited supply, so they are never deals.",
  },
  otd: {
    title: "On This Day",
    short: "A pass pays you Rax again on the anniversaries of its player's games, up to its lifetime limit.",
    text: "A player or team pass (Real also calls it a player card or a team card) pays you Rax On This Day: on the anniversaries of its games, times its rarity's multiplier, until it reaches its lifetime limit. A pass of the season now playing also pays after each game, on its own; playoff games pay double. Here a \"card\" is always a play card you buy on the market, never a pass.",
  },
  claims: {
    title: "2 a day per sport",
    text: "Real pays at most 2 passes per sport each day, and each pass at most once. A third pass with a game that day pays nothing (Real Pro: one extra claim a day across all sports, through the bonus poll), so passes on different days are worth more (in NFL and college football, passes of different seasons). This season's games pay every pass you hold, outside this limit.",
  },
  passYear: {
    title: "Rax a year",
    text: "What the pass pays in the next 12 months if it is your only pass with a game on those days, counted until its limit.",
  },
  perGameDay: {
    title: "Per game day",
    text: "A season's pay at this rarity ÷ the player's game days: what one claim pays on average.",
  },
  payback: {
    title: "Pays back",
    text: "The month when what the pass has paid reaches what it cost, walking the months from today with the season's pay spread over the months it was earned in. An estimate.",
  },
  limit: {
    title: "Lifetime limit",
    text: "A pass stops paying On This Day once it has earned this much in total, live pay included; a lift to the next rarity raises it. Player passes: 500 × the rarity's multiplier; team and fighter passes follow Real's own tables (a fighter: 1,500 at Common up to 48,000 at Mystic). General pays nothing On This Day. Iconic player and fighter passes have no limit, so we count them over 3 years.",
  },
  limitCost: {
    title: "Limit ÷ cost",
    text: "How many Rax the pass can ever pay for each Rax it costs. At 1.0 or under it never does more than break even.",
  },
  buildCost: {
    title: "Cost to build",
    text: "Rating to add × the typical price per rating point, plus minting the pass: 200 for a player, 800 for a fighter or a team. General is the mint alone, and pays only the live games of a season being played. Your first player pass in each sport each season is free.",
  },
  onSale: {
    title: "On sale now",
    text: "The cheapest cards listed right now for this player-season, cheapest per rating point first, until the rating is reached. Asks over 5× the typical price are left out.",
  },
  typical: {
    title: "Typical price",
    text: "The middle price per rating point of this player-season's recent card trades.",
  },
  projection: {
    title: "Projection",
    text: "This season is still being played. Its pay so far is scaled up to a full season, so Rax a year is a projection until 90% of it is played.",
  },
  estimate: {
    title: "Estimated limit",
    text: "Real doesn't state a limit for soccer passes. We use 500 × the multiplier, like other player passes, and say so.",
  },
  weak: {
    title: "Weak step",
    text: "This rarity costs much more than the one below for little more pay. Stay one rarity lower or go one higher.",
  },
  team: {
    title: "Team pass rating price unknown",
    text: "Team passes need 3× the rating of a player pass, and nobody trades team rating per point yet, so we can't say what one costs or when it pays back. Rax a year and the limit are known.",
  },
  never: {
    title: "Never pays back",
    text: "At every rarity, the most this pass can ever pay (its lifetime limit) is no more than what it costs today.",
  },
  breakEven: {
    title: "Breaks even at best",
    text: "Over its whole life this rarity pays back no more than it costs, like a pass that costs as much as its lifetime limit. We never recommend it.",
  },
  fill: {
    title: "Claims used",
    text: "Of the 2 claims a day a sport offers on its game days, the share your passes win in a modelled year. From 85% a sport counts as nearly full.",
  },
  myPasses: {
    title: "My passes",
    text: "Passes you add by hand stay on this device, never sent anywhere; a linked account's are read from Real. We spread each player's game days evenly over the season, except in NFL and college football, where a season's passes share the same weekend days; teammates share their days too. These figures are estimates.",
  },
  bestForBudget: {
    title: "Most Rax back for your budget",
    text: "The rarity whose next 12 months pay the most for each Rax it costs, among those that fit your budget and pay back.",
  },
  moves: {
    title: "Prices moving today",
    text: "Today's middle sale price for a player's cards (the last 24 hours), beside the middle sale over the last 7 days before that, in the same rating band. Only moves of 20% or more, with 5 or more sales in both, are shown." + MOVES_CURVE,
  },
  saved: {
    title: "Saved with OTD Palace",
    text: "Counted on this device from deals you marked.",
  },
  // Real's own words. Sources: Real's docs as summed up in the internal research notes and
  // 2026-11-17-truth-audit.md; the ladder is advisor/rules.py OTD_LADDERS (tests hold the numbers equal); offers are
  // lib/offers.ts (measured acceptance, 12-hour auction, Real Pro).
  pass: {
    title: "Pass",
    short: "Your card for one player (or team) and season: it pays you Rax when they play, and again a year later.",
    text: "Your card for one player (or team) and one season, which Real calls a player card. It pays you Rax after each game of a season being played, and again on the anniversaries of its games (On This Day). The more card rating you hold of that player and season, the higher its rarity and the more it pays.",
  },
  rarity: {
    title: "Rarity",
    short: "The step a pass has climbed (Common to Iconic): each step multiplies what it pays.",
    text: "The steps a pass climbs as the ratings of the cards you hold of that player and season add up: General, then Common at 10 rating, Uncommon, Rare, Epic, Legendary, Mystic, and Iconic at 3,380 for a player. Each step multiplies its pay: Common 2×, Legendary 25×, Iconic 150×. A card on sale has its own rarity too; it is not the pass's.",
  },
  general: {
    title: "General pass",
    short: "A pass with no card rating yet: it pays nothing On This Day.",
    text: "A pass with no card rating yet: the free one, or the 200-Rax mint alone. It pays nothing On This Day, only the games left of a season being played. Add 10 rating of that player-season's cards and it becomes Common, which does pay.",
  },
  lift: {
    title: "Lift",
    short: "Buying more cards of a pass you hold, so it climbs a rarity and pays more.",
    text: "Buying more cards of a player and season you already hold a pass for, so the pass climbs a rarity: it pays more, and its lifetime limit rises with it. Selling those cards drops it back.",
  },
  livePay: {
    title: "Live pay",
    short: "This season's games pay every pass you hold, after each game, with no daily limit.",
    text: "A pass of the season being played pays after every game its player plays, on its own: no 2-a-day limit, and playoff games pay double. It counts toward the pass's lifetime limit, so what is left for On This Day shrinks as the season goes.",
  },
  claim: {
    title: "Claim",
    short: "Collecting a pass's On This Day pay in Real: a day you skip pays nothing.",
    text: "Collecting a pass's On This Day pay in the Real app. Real's day turns over at about 8:15 in New York; a day you skip pays nothing, and at most 2 passes per sport pay each day.",
  },
  booster: {
    title: "Booster",
    short: "A pack extra that raises one pass's pay for one live game; nothing On This Day.",
    text: "Every pack holds a booster. Put it on a pass before a game and it adds to the pass's multiplier for that game: Rare +10, Epic +15, Legendary +25. No effect On This Day; a bad game still uses it.",
  },
  quickList: {
    title: "Quick List",
    short: "Real's quick way to sell a card: no listing fee, but at Real's floor price, not yours.",
    text: "Real's quick way to put a card on sale: no 10-Rax listing fee, but it lists at Real's floor price, not the price you choose, and that floor can sit far from the usual price.",
  },
  quickSell: {
    title: "Quick Sell",
    short: "Real pays for a card at once: about 1 Rax a rating point for a card, no Real Pro needed, but far below a sale.",
    text: "Real's instant sale: Real pays for the card at once, at its own price, about 1 Rax a rating point for a card (so about 5 Rax for a card of rating 5.2), whatever its rarity. Any account can, no Real Pro needed. It pays far less than a sale: about an eighth of what the same cards sold for. For a very cheap card, the 10 Rax listing fee can make Quick Sell the better deal. Measured on about 97,000 quick-sold cards, Sep–Nov 2026.",
  },
  mint: {
    title: "Mint",
    short: "Making a new pass: 200 Rax for a player, 800 for a team or a fighter.",
    text: "Making a new pass in Real: 200 Rax for a player, 800 for a team or a fighter. Your first player pass in each sport each season is free. The mint cannot be resold; the cards you add to the pass can.",
  },
  offer: {
    title: "Offer",
    short: "Offering less than the asking price on a card: most are refused, the accepted ones are cheap rating.",
    text: "In Real you can offer less than the asking price on another player's card. Most offers are refused: of the offers we measured, about 1 in 6 was accepted, and low offers far fewer (about 1 in 17). So send many, below the usual price: the accepted ones are the cheapest rating you will get for a pass. An accepted offer opens a 12-hour auction, so someone can still outbid you. Making an offer needs Real Pro.",
  },
  yearBack: {
    title: "Rax back in a year",
    short: "What a use of Rax gives back over the next 12 months, on top of what it cost.",
    text: "How passes and deals are compared here: what each gives back over the next 12 months on top of what you paid. A pass: what it pays in that year (an estimate), and you keep its cards, whose price can move. A deal: what is left after Real's fees if you resell the card at its usual price, once. Deals are rare and about half lose Rax after fees, so a pass that pays back usually gives more.",
  },
  realPro: {
    title: "Real Pro",
    short: "Real's paid membership. Listing your cards for sale and making offers need it.",
    text: "Real's paid membership. Among what it adds: listing your cards for sale at your price and making offers, and one extra On This Day claim a day through the bonus poll. Real's docs say some very active accounts can list too; others can only Quick Sell, at Real's price. We can't see Real Pro on an account, so you tell us. A lift needs none: it is buying cards.",
  },
  soon: {
    title: "Can be built within 3 weeks",
    text: "For now this means enough rating is on sale today. Time to gather the rest needs live sales data, so passes short of it are left out.",
  },
};

const FMV_USUAL = "Real's own estimate for this card type, backed by {n} recent sales: too few for us to count on our own.";

/** A term in one line: its own `short`, or the first sentence of its text. */
export function shortOf(key: TermKey): string {
  const term = GLOSSARY[key];
  if (term.short) return term.short;
  const text = term.text.replace("{n}", "recent");
  const end = text.search(/[.:](\s|$)/);
  return end < 0 ? text : `${text.slice(0, end)}.`;
}

/** A term's explanation, with the sales count filled in; `fmv` when the usual price is Real's estimate. */
export function explain(key: TermKey, vars: { n?: number; fmv?: boolean } = {}): string {
  const text = key === "usual" && vars.fmv ? FMV_USUAL : GLOSSARY[key].text;
  return text.replace("{n}", String(vars.n ?? "recent"));
}
