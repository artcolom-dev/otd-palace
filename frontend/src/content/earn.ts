// "Earn more Rax": a plan for each kind of player and the mistakes that cost Rax, in plain words. Everything here
// comes from the internal research notes, (b) strategies by level and (c) mistakes, and from
// 2026-11-16-rax-economy-deep.md (high and medium confidence only). A medium-confidence fact is said as unconfirmed,
// never as a fact, or given as advice without a figure; the weekly figures say how sure they are. 40 words a line.
// Passes first and offers (the owner, 2026-11-18): the paybacks are the deep note's headline 2 (High), the deal margin
// its headline 6 (High, "the median deal ... leaves +3 rax"), the rates per point its headline 3 and section 1e (High
// for the rates, one day); offers as in lib/offers.ts, with no figure here.
import type { GuideTier } from "../lib/earn";

/** How sure a figure is, in words: measured on accounts, worked out from Real's rules, or a rough guess. */
export type Sureness = "measured" | "worked" | "rough";

export const SURENESS_WORDS: Record<Sureness, string> = {
  measured: "Measured on real accounts",
  worked: "Worked out from Real's rules, not measured",
  rough: "A rough guess",
};

export interface TierPlan {
  id: GuideTier;
  tab: string; // the short name on its tab (fits a 360 px phone with three others)
  title: string;
  who: string; // who it is for
  steps: string[];
  estimate: string; // what it can bring, a week
  sureness: Sureness;
}

export const TIER_PLANS: readonly TierPlan[] = [
  {
    id: "start",
    tab: "New",
    title: "New to Real",
    who: "No Rax yet, nothing bought.",
    steps: [
      "Take the free player pass in every sport that offers one. Pick a top-10 earner of a sport that is playing now.",
      "With your first 100 to 150 Rax, take a free pass straight to Common (10 rating): it starts paying On This Day, at 2× a game day. A General pays nothing On This Day.",
      "Get those 10 rating with offers under the usual price, many at once: most are refused, the accepted ones are the cheapest rating. Offers need Real Pro; without it, buy the cheapest cards on sale.",
      "Answer the daily streak poll in each sport. If you pick right more than half the time, ride the run to 8.",
      "Do the karma routine: polls, live games, a comment. It turns into a little Rax and feeds the leaderboards.",
      "Don't buy packs to resell their cards: in most sports they lose Rax.",
    ],
    estimate: "About 100 to 150 Rax a week while seasons run.",
    sureness: "rough",
  },
  {
    id: "beginner",
    tab: "Starting",
    title: "Starting out",
    who: "A few hundred to about 5,000 Rax.",
    steps: [
      "Passes before deals: a Common on a top earner pays back in about 2 to 3.5 months in NBA, NHL, NFL or college basketball (mid-November 2026), while the typical deal leaves about 3 Rax after fees.",
      "Take your best passes to Common: 10 rating, about 100 to 150 Rax of cards. It opens On This Day and doubles live pay.",
      "Build rating with offers under the usual price, many at a time: most are refused, the accepted ones make the cheapest passes (offers need Real Pro). Off-season, few cards sell, so sellers have fewer other buyers.",
      "A third pass in a sport pays only on days your first two don't play. In NFL and college football most games of a season fall on the same weekend days: spread those passes over seasons, not teams.",
      "Passes of the season now playing first: they pay every game, with no daily limit.",
      "Don't buy past-season MLB passes before February, or WNBA before April: they pay nothing until spring. Buy their rating 2 to 4 weeks before their season's dates.",
      "Put boosters on stars of weekly sports (NFL, college football, golf), never on a player likely to have a bad game.",
      "Sell with Quick List (no fee, but at Real's floor price, not yours), or price at the usual price or under.",
    ],
    estimate: "About 250 Rax a week with 10 Common passes and the free sources.",
    sureness: "worked",
  },
  {
    id: "growing",
    tab: "Growing",
    title: "Growing",
    who: "About 10,000 to 50,000 Rax.",
    steps: [
      "Skip Rare. From Uncommon, save up and jump to Legendary: 380 rating, about 4,000 Rax, 25 times the pay.",
      "Past-season rating is cheapest once its sport stops (mid-November 2026: MLB 10.5 Rax per rating point against NBA 12.9). Buy it with offers (they need Real Pro), 2 to 4 weeks before its On This Day months.",
      "Level this season's stars to Legendary early, before game 1 if possible: games left pay live, outside the 2 daily claims, but count toward the pass's lifetime limit, so little On This Day is left.",
      "Fill both daily claims in every sport, the cheaper ones too (college basketball, golf, WNBA, UFC).",
      "When three of your passes can claim the same day, skip the one that will reach its lifetime limit anyway. Claim the other two: it still gets there on quieter days.",
      "Keep your strongest boosters for playoff games and major tournaments: Real pays double there. Unused boosters carry over to the sport's next season.",
      "Look at Real Pro around here: a daily pack, one extra daily claim across all sports through the bonus poll, Lineups that pay Rax.",
    ],
    estimate: "About 1,000 to 1,200 Rax a week with 6 Legendary and 10 Common passes (about 30,000 Rax spent).",
    sureness: "worked",
  },
  {
    id: "big",
    tab: "Big",
    title: "Big account",
    who: "100,000 Rax or more, hundreds of passes.",
    steps: [
      "Breadth before depth: 2 paying passes on every day of every sport comes before any level.",
      "Buy Iconic right at its entry, 3,380 rating, and stop there, as nearly every big account we read does. Put it on players with the most dates: it has no lifetime limit.",
      "Before levelling a pass, check its days aren't already covered by 2 better passes: then the level adds nothing.",
      "Send the full rank order every preseason, 100 players and 5 teams: those passes pay their season live and are the base to level later.",
    ],
    estimate: "17,000 to 37,000 Rax a week from On This Day claims, plus live pay.",
    sureness: "measured",
  },
];

export interface Mistake {
  text: string;
  unsure?: boolean; // Real's own pages disagree, or the measurement is small: said as not confirmed
}

/** The mistakes that cost the most Rax, short, the costliest first. */
export const MISTAKES: readonly Mistake[] = [
  { text: "Levelling to Rare and stopping: it is the worst step of the ladder for what it costs." },
  { text: "Three passes in one sport on the same days: only 2 are paid each day. In football the same season mostly means the same days, whatever the team." },
  {
    text: "Stacking golf passes of one season: they are paid on the same tournament Sundays, 2 a day. Seasons with the same weekdays meet too: 2014 and 2025, 2017 and 2023, 2019 and 2024.",
  },
  {
    text: "Selling the cards under a pass you count on: its rarity is the sum of the cards you hold, so it falls back and pays less. Check the pass before you list a card.",
  },
  { text: "Putting a pass you meant to claim with on a poll: it can't be claimed until the poll ends." },
  { text: "Paying the 10 Rax listing fee again and again: it is never refunded. Use Quick List or price at the usual price." },
  { text: "Selling off-season, when few cards sell, or buying packs to resell their cards (most sports lost Rax in November 2026)." },
  { text: "Levelling this season's pass late: you get the games left, not the season." },
  { text: "Missing the preseason: the free pass, the 3-day rank order, and levelling before game 1." },
  { text: "Boosters on daily-sport players or for On This Day: they pay most on weekly-sport stars, and nothing On This Day." },
  { text: "Cashing the daily streak early when you pick right more than half the time." },
  { text: "Buying or lifting a finished-season pass without checking what is left of its lifetime limit: everything it has earned counts, live pay too." },
  {
    text: "Buying a General pass to claim with: General pays nothing On This Day, only the live games of a season being played. Take it to Common (10 rating).",
  },
  {
    text: "Counting on a 2027 MLB pass: MLB's labour deal ends 1 December 2026 and a lockout is possible. Past-season MLB passes still pay On This Day.",
    unsure: true,
  },
];
