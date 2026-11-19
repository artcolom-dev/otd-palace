// The dated season heads-ups, the same six the Discord digest uses (advisor/season_clock.py EVENTS). Dates are the
// research's "about" dates, not a league's schedule. tests/test_season_events_parity.py keeps the ids and dates equal.
// The lines are shorter than the Python ones and say "pays at the lower rarity", not "lost" (truth audit, finding 15).
// The college basketball line has the Python one's words: its 28% is March's share of a season's pay on our feed
// (the internal research notes, the seasonal clock).

export interface SeasonEvent {
  id: string;
  date: string; // YYYY-MM-DD, a New York day
  sport: string;
  title: string;
  line: string;
}

export const SEASON_EVENTS: readonly SeasonEvent[] = [
  {
    id: "mlb-labour-deal-2026", date: "2026-12-01", sport: "MLB", title: "MLB's labour deal ends on 1 December",
    line: "A lockout is possible. Past-season MLB passes still pay (they pay on games already played). A 2027 MLB pass is the risky one.",
  },
  {
    id: "wnba-winter-2027", date: "2027-01-15", sport: "WNBA", title: "WNBA: winter is the time to buy",
    line: "Its cards are cheapest off-season and its pay months start in May. Level 2 to 4 weeks before May.",
  },
  {
    id: "cbb-march-2027", date: "2027-02-15", sport: "CBB", title: "March is college basketball's biggest month",
    line: "About 28% of a season's On This Day pay comes in March. Have past-season passes in place by late February.",
  },
  {
    id: "mlb-buy-window-2027", date: "2027-03-01", sport: "MLB", title: "MLB pays from late March",
    line: "Have a past-season MLB pass in place 2 to 4 weeks before its months open. Check the labour news first.",
  },
  {
    id: "wnba-buy-window-2027", date: "2027-04-15", sport: "WNBA", title: "WNBA pays from mid-May",
    line: "Level your past-season WNBA passes now, a few weeks before its pay months open.",
  },
  {
    id: "nba-nhl-preseason-2027", date: "2027-10-01", sport: "NBA and NHL", title: "NBA and NHL seasons start this month",
    line: "Claim the free pass of each sport and level the ones you keep before game 1: a game before the level pays at the lower rarity.",
  },
];
