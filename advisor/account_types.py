"""What kind of account a member has, by what its passes can pay On This Day in a year (rax a year): the same table as
the site's frontend/src/content/accountTypes.ts (tests/test_account_types.py keeps them equal). Never by Rax balance,
never by passes held, never in claims. The Discord size roles are named after these types and given from the yearly
figure the site reports (advisor/members.py keeps it, advisor/discord_perks.py gives the role).

Source: the internal research notes, section 4 (FINAL: 150 accounts read, 123 valued; Strong, Big and
Giant are measured, Starter and Steady rest on first principles). `color` is an index into Real's rarity scale (advisor/real.py), so the types read as a ladder in the colours
players know. `from_` counts, `to` does not.

The yearly figure is the site's own estimate of what the passes CAN pay, sent by the visitor's browser: it is never
trusted for anything but a cosmetic role and a line of text.
"""

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class AccountType:
    key: str
    name: str
    from_: int  # rax a year, included
    to: int | None  # rax a year, not included; None for the top type
    color: int  # index into Real's rarity scale
    meaning: str
    do: str
    skip: str
    watch: str


ACCOUNT_TYPES: tuple[AccountType, ...] = (
    AccountType(
        key="none",
        name="Not earning yet",
        from_=0,
        to=1,
        color=0,
        meaning="No pass pays you yet. A General pass earns nothing On This Day; a Common does.",
        do="Take the free pass in each sport, then lift it to Common (10 rating) with offers (they need Real Pro). That starts the pay.",
        skip="Boosters (they pay nothing On This Day), Mystic and Iconic passes, and buying packs to resell the cards.",
        watch="MLB 2027 passes: the labour deal ends 1 December 2026 and a lockout is possible. Past-season MLB passes still pay.",
    ),
    AccountType(
        key="starter",
        name="Starter",
        from_=1,
        to=10_000,
        color=1,
        meaning="A few passes pay you. Each sport you add can have two more passes paid each day.",
        do="Put one Common pass in each sport playing now that does not pay yet: about 300 Rax each, roughly 1,000 Rax a year.",
        skip="Many passes in one sport (only the best 2 a day pay), and deals under 50 Rax: 82 in 100 lose after fees.",
        watch="Past-season MLB and WNBA passes bought now sit idle for months. A lockout may hold up 2027 MLB passes (labour deal ends 1 December 2026).",
    ),
    AccountType(
        key="steady",
        name="Steady",
        from_=10_000,
        to=100_000,
        color=2,
        meaning="A working base. Many sports still have fewer than two passes paid a day: two good passes in every sport grow it.",
        do="Lift cheap passes first: a few dozen Rax can add hundreds a year. Then give every sport two good passes a day.",
        skip="Passes of the same team, or in football the same season, which play the same days, and Generals spread over every sport.",
        watch="A pass stops paying On This Day once all it has earned reaches its limit, live pay included. Count the passes that still pay.",
    ),
    AccountType(
        key="strong",
        name="Strong",
        from_=100_000,
        to=500_000,
        color=4,
        meaning="A solid account: nine sports pay and half the pay is this season's games. Rarity is now what grows it.",
        do="Lift cheaply first, fill empty sports, then go for Legendary. Check what the first Iconic would cost (3,380 rating).",
        skip="Lifting a pass whose game days two better passes already cover. It adds nothing.",
        watch="Past-season MLB and WNBA passes bought now sit idle for months: they pay from spring. Buy their rating a few weeks before.",
    ),
    AccountType(
        key="big",
        name="Big",
        from_=500_000,
        to=2_000_000,
        color=5,
        meaning="A large account. Iconic passes have no lifetime limit; every other rarity stops at one.",
        do="Do cheap lifts first (60 Rax can add 1,600 a year). Then Iconic: 30,000 to 40,000 Rax for 65,000 to 116,000 a year.",
        skip="More passes in sports you already cover: your daily claims are about three-quarters used.",
        watch="Passes that have earned their limit, live pay included, pay nothing more On This Day. Lifting one a rarity reopens it.",
    ),
    AccountType(
        key="giant",
        name="Giant",
        from_=2_000_000,
        to=None,
        color=6,
        meaning="A top account. Most of the pay comes from a layer of Iconic passes.",
        do="Do the cheap lifts first (about 400 Rax can add 9,600 a year), then the next Iconic at its entry, 3,380 rating.",
        skip="Everything under Legendary, and counting passes as value. The Iconic layer carries most of the pay.",
        watch="Unused claims: a sport with fewer than two good passes a day leaves Rax unclaimed.",
    ),
)

# A member who linked with /link and has not opened the site since (so no yearly figure was ever reported) is given the
# type their number of passes most often has: from the research's "typical holdings" per type. Only a stop-gap: the first
# figure the site reports replaces it, and a pass count never reaches Giant.
TYPE_BY_PASSES: tuple[tuple[int, str], ...] = ((0, "none"), (1, "starter"), (100, "steady"), (300, "strong"), (500, "big"))

TYPE_NAMES = tuple(t.name for t in ACCOUNT_TYPES)
YEAR_MAX = 50_000_000  # the most the server keeps as a member's yearly figure; a bigger one is garbage


def _clean(year: object) -> int:
    ok = isinstance(year, (int, float)) and not isinstance(year, bool) and year == year and year not in (float("inf"), float("-inf"))
    return math.floor(year + 0.5) if ok and year > 0 else 0  # half up, as the site's Math.round (not banker's round)


def type_of(year: object) -> AccountType:
    """The type of an account whose passes can pay `year` rax a year (anything that is not a number reads as 0)."""
    y = _clean(year)
    found = ACCOUNT_TYPES[0]
    for t in ACCOUNT_TYPES:
        if y >= t.from_:
            found = t
    return found


def next_type(year: object) -> AccountType | None:
    i = ACCOUNT_TYPES.index(type_of(year))
    return ACCOUNT_TYPES[i + 1] if i + 1 < len(ACCOUNT_TYPES) else None


def type_by_passes(passes: object) -> AccountType:
    """The stop-gap type for a member whose yearly figure is not known yet, from how many passes they hold."""
    n = passes if isinstance(passes, int) and not isinstance(passes, bool) and passes > 0 else 0
    key = [k for low, k in TYPE_BY_PASSES if n >= low][-1]
    return next(t for t in ACCOUNT_TYPES if t.key == key)
