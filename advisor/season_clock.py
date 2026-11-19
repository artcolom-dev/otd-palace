"""The season clock: when each sport's money months open and close, as a small dated table for the Discord digest and
its one-time alerts. It is derived from the internal research notes (section 2, "The seasonal clock",
and findings 4, 5 and 10): what pays depends on the month more than on the sport, a past-season pass pays only in its
sport's On This Day months, so it is bought 2 to 4 weeks before them, and a current-season pass is levelled before game
1. The dates are the research's "about" dates, not a league's schedule.

TIPS: one line for the week's digest, by the month the digest goes out in.
EVENTS: a date worth a heads-up. Each is announced once, SEASON_ALERT_DAYS days ahead (see advisor/discord_post.py),
and never after its date.
"""

from datetime import date, timedelta

from advisor.rules import OTD_SPORT_MONTHS

# (first month, last month, the line). Every month is covered once; a range may wrap the year (Nov to Feb).
TIPS = (
    (11, 2, "NBA, NHL, CBB and soccer are mid-season: level a current-season star now, a game before the level pays "
            "at the lower rarity. MLB and WNBA passes bought now sit idle until spring."),
    (3, 4, "March is the biggest pay month for CBB, and MLB pays from late March. Buy a past-season MLB or WNBA pass "
           "2 to 4 weeks before its months, not on the day."),
    (5, 8, "WNBA and MLB are paying. Cards of the sports that start in the fall are cheapest now: look at NFL, CFB, "
           "NBA and NHL before preseason."),
    (9, 10, "NFL and CFB are live, and NBA and NHL are about to start: claim the free pass, then level the ones you keep "
            "before game 1."),
)

# (id, date, sport, title, line)
EVENTS = (
    ("mlb-labour-deal-2026", date(2026, 12, 1), "MLB",
     "MLB's labour deal ends on December 1",
     "A lockout is widely expected. Past-season MLB passes are not affected (they pay on games already played). A 2027 "
     "MLB pass and its preseason rank order carry lockout risk."),
    ("wnba-winter-2027", date(2027, 1, 15), "WNBA",
     "WNBA: winter is the time to buy",
     "Its cards are cheapest off-season and its pay months start in May. Buy now, level 2 to 4 weeks before May."),
    ("cbb-march-2027", date(2027, 2, 15), "CBB",
     "March is college basketball's biggest month",
     "About 28% of a season's On This Day pay comes in March. Have past-season passes in place by late February."),
    ("mlb-buy-window-2027", date(2027, 3, 1), "MLB",
     "MLB pays from late March",
     "A past-season MLB pass should be in place 2 to 4 weeks before its months open. Check the labour news first."),
    ("wnba-buy-window-2027", date(2027, 4, 15), "WNBA",
     "WNBA pays from mid-May",
     "Level your past-season WNBA passes now, a few weeks before its pay months open."),
    ("nba-nhl-preseason-2027", date(2027, 10, 1), "NBA and NHL",
     "NBA and NHL seasons start this month",
     "Claim the free pass of each sport and level the ones you keep before game 1: a game before the level pays at the "
     "lower rarity."),
)


def tip_for(day: date) -> str:
    """The digest's season line for the month of `day`."""
    for first, last, line in TIPS:
        if (first <= day.month <= last) if first <= last else (day.month >= first or day.month <= last):
            return line
    return ""


def due_events(day: date, days_ahead: int, sent: set[str]) -> list[tuple]:
    """The events not announced yet whose date is today or within `days_ahead` days, soonest first."""
    return sorted((e for e in EVENTS if e[0] not in sent and day <= e[1] <= day + timedelta(days=days_ahead)),
                  key=lambda e: e[1])


_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
           "December")


def pays_from(sport: object, day: date) -> str | None:
    """"pays from March" when `sport`'s On This Day months are not open on `day`: a past-season pass bought now sits
    idle until then. None while the sport pays (or when it is not one we know). The months are the site's own table."""
    months = OTD_SPORT_MONTHS.get(str(sport).lower())
    if not months or day.month in months:
        return None
    for step in range(1, 13):
        month = (day.month - 1 + step) % 12 + 1
        if month in months:
            return f"pays from {_MONTHS[month - 1]}"
    return None
