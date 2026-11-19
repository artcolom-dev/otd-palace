"""Every number that tunes the advisor lives here."""

import logging
import os
import re
from datetime import timedelta

# Reference price: realised sales of the same player, sport, season and value bucket.
SALES_WINDOW_DAYS = 7
MIN_SALES_HIGH = 5  # this many recent sales give a high-confidence reference
MIN_FMV_SALES = 3  # Real's fair market value needs at least this many sales to be a medium-confidence fallback

# Deals.
MIN_DISCOUNT = {"high": 0.20, "medium": 0.30}  # smallest discount to the reference, by reference confidence
BID_DEAL_MAX_LEFT_MIN = 120  # a bid is only a deal when the auction ends within this many minutes
SELLER_FEE = 0.10  # share of a sale price Real keeps
LISTING_FEE = 10  # rax a seller pays for a normal listing, never refunded (Quick List has no fee)
# Quick Sell: Real pays for a card at once, at its own price; any account can, no Real Pro needed (listing needs Pro).
# Measured on about 97,000 quick-sold cards, Sep–Nov 2026: what was paid is a median of 1.00 Rax a rating point (p10
# 0.88, p90 1.20), the same for every rarity and every rating; the price Real offered was a median of 0.13 of what the
# same card sold for on the market (p10 0.08, p90 0.28). So a card of rating 5.2 quick-sells for about 5 Rax.
# No Quick Sell of a whole pass is modelled: no Real source shows one (the whole-pass figures we hold are the lowest
# price Real lets a pass be LISTED at, which needs Real Pro).
QUICKSELL_PER_POINT = 1.0
QUICKSELL_MARKET_SHARE = 0.13  # said as "about an eighth" (tests/test_copy_parity.py)
# Below this reference the resale margin after fees is thin (breaking even takes 10 % + LISTING_FEE / reference):
# every deal still carries its margin, and the screens grey it under this reference.
AFTER_FEES_MIN_REF = 200
MAX_DEALS = 200
MAX_DEALS_PER_PLAYER = 3  # one player's cards must not fill the list: his best deals first, the rest leave room
DEAL_LINK = "listing"  # "card" or "listing": which Real link a deal points to; the listing opens its auction

# Deals that just went away: shown dimmed for a moment, with the reason, so rows do not vanish silently.
GONE_KEEP_S = 45  # a deal that went away stays on the page this many seconds
TAKEN_WINDOW_S = 600  # the live line counts deals taken (target bid, outbid, ended) in the last this-many seconds

# Selling a card: how often a card listed at a multiple of its usual price sold, as (price over usual, share that sold).
# Measured on past sales, not a promise; the list price helper shows it as typical, and the browser reads it from the
# snapshot's rules, so the page and this file never disagree.
SELL_CURVE = [(0.95, 0.99), (1.05, 0.90), (1.20, 0.29)]

# Similar deals ("a deal that went away is never a dead end"): the same player-season first, then the same sport within
# this share of the price and at least the same rating, at most TWIN_MAX of them. The browser reads both from the
# snapshot's rules, and the public deal page (advisor/share.py) applies the same two.
TWIN_PRICE_BAND = 0.25
TWIN_MAX = 3

# A deal's public page (/d/<listing id>): each address may ask for this many pages and cards a minute (in memory only),
# and the server remembers this many deals that went away, newest first, so a shared link still says "gone" hours on.
SHARE_PER_MIN = 60
SHARE_RATE_MAX_ADDRESSES = 10_000
SHARE_ENDED_KEEP = 500

# The free site (advisor/public.py): with the Discord gate on, anyone who is not a member of our server gets a trimmed
# snapshot built on the server: this many of the best deals, this many risers and fallers, and this many of each
# sport's best passes (with each sport's starter pass). Members get every deal, every move and every pass.
PUBLIC_DEALS = 3
PUBLIC_MOVES = 5
PUBLIC_PASSES_PER_SPORT = 5

# Market moves: players whose realised prices rose or fell in the last hours versus the week before.
MOVES_RECENT_H = 24  # "today": sales from the last this-many hours
MOVES_BASE_DAYS = 7  # the week before that
MIN_SALES_RECENT = 5  # a move needs at least this many recent sales ...
MIN_SALES_BASE = 5  # ... and at least this many in the base week
MIN_ABS_CHANGE = 0.20  # smallest rise or fall worth showing, as a share of the base price
MOVE_MIN_PRICE = 100  # a move is shown only when the larger of its two medians reaches this: below it prices step by
# 10-20 rax ticks and 20 -> 60 (+200%) is noise, not a market
TOP_MOVES = 10  # how many risers and how many fallers to show
FALLING_AT = -0.20  # a deal is "falling" when its market moved this much or more downward today

# The market's pulse and the order of the sport tabs.
PULSE_WINDOW_MIN = 60  # the pulse counts each sport's sales in the last this-many minutes
SPORTS_RANK_WINDOW_H = 24  # sport tabs go busiest first: most sales in the last this-many hours

# Freshness of the data on screen: three collector rounds without a new snapshot and the data counts as stale.
STALE_AFTER_S = int(os.environ.get("ADVISOR_STALE_AFTER_S", 30))
POLL_S = 5
# The snapshot and the page go out gzipped to a browser that accepts it, compressed once per snapshot version at
# this level (1 fastest, 9 smallest).
GZIP_LEVEL = 6
# The built files (/assets/*, the manifest, the SVGs) are compressed once each, so the smallest output is worth it.
STATIC_GZIP_LEVEL = 9
# What gets compressed among the built files: text. Images and fonts are compressed already.
STATIC_GZIP_SUFFIXES = frozenset({".js", ".css", ".svg", ".webmanifest", ".json", ".txt"})
# The daily-pay passes change every few hours, the rest every round: the snapshot carries a short hash of its "otd"
# section (this many hex characters), and a poll that names the current one gets the snapshot without that section.
OTD_VERSION_CHARS = 12
# Snapshot versions start at the start time in milliseconds (seconds times this), so a restarted server, or a second
# one started later, keeps counting up from where the last one was, as long as it makes fewer rounds a second.
VERSION_PER_S = 1000

# What each level of the site shows. A bid deal only shows when its auction ends within the level's
# bid_max_left_min minutes; default_budget is the budget a visitor of that level starts with (None = any);
# hide_falling hides the deals whose market is falling today, whose reference may be behind the market; hide_hurt
# hides the deals of a player ESPN lists as out, suspended or doubtful (see advisor.injuries), whose usual price is
# from before the injury;
# otd_default_budget is the most a visitor of that level starts out spending on one daily-pay pass (None = any).
LEVELS = {
    "new": {
        "label": "New", "min_discount": 0.25, "confidence": ["high"], "kinds": ["target"],
        "bid_max_left_min": 0, "default_budget": 200, "hide_falling": True, "hide_hurt": True,
        "otd_default_budget": 1000,
    },
    "regular": {
        "label": "Regular", "min_discount": 0.20, "confidence": ["high", "medium"], "kinds": ["target", "bid"],
        "bid_max_left_min": 30, "default_budget": 1000, "hide_falling": False, "hide_hurt": False,
        "otd_default_budget": 5000,
    },
    "pro": {
        "label": "Pro", "min_discount": 0.20, "confidence": ["high", "medium"], "kinds": ["target", "bid"],
        "bid_max_left_min": BID_DEAL_MAX_LEFT_MIN, "default_budget": None,  # every bid deal the engine finds
        "hide_falling": False, "hide_hurt": False, "otd_default_budget": None,
    },
}
BUDGET_PRESETS = [50, 200, 1000, None]  # the budgets a visitor can pick in one tap, in rax; None = any

# Outbound clicks: how many visitors the site sends to Real, counted per UTC day and by where on the page they
# clicked, never per person.
# where on the page the click was; "alert" is the deal a notification opened the page on, "share" the Open in Real
# button of a deal's public page (/d/<listing id>), "routine" the daily checklist's links to the Real app
CLICK_PANELS = ["hero", "deals", "moves", "otd", "community", "alert", "share", "routine"]
CLICK_TARGETS = ["listing", "card", "community", "app"]  # what it opened ("app": Real's home page)
# The sport filters that are not one sport: every sport, and "My players". Any other sport filter only counts
# when the current snapshot serves that sport.
CLICK_SPORT_FILTERS = ["all", "mine"]
CLICK_MAX_POS = 50  # the deepest row position counted (0 is the first row)
CLICK_FLUSH_S = 10  # the counts are written to disk at most once every this-many seconds (and on shutdown)
CLICK_MAX_BYTES = 512  # a click report bigger than this is refused
CLICK_MAX_KEYS_PER_DAY = 5000  # a day holding this many distinct counts takes no new one (the ones it has still count)
CLICK_KEEP_DAYS = 90  # counts of days older than this are dropped
# Each address may report this many clicks a minute (a bucket of that many, refilled at that rate), kept in memory
# only and never written anywhere; the table keeps at most this many addresses, the least recently seen go first.
CLICK_PER_MIN = 30
CLICK_RATE_MAX_ADDRESSES = 10_000
CLIENT_KEY_MAX_CHARS = 64  # an address is kept in those tables as at most this many characters

# Visits (advisor/visits.py): an anonymous random id per browser (in its own storage, no cookie), so the private admin
# panel can count active devices, returns and where visits come from. Days are UTC days. Nothing about the visitor
# is kept: no address, no user agent, no full referrer; a signed-in member only as a keyed hash of their Discord id.
VISIT_TABS = ["today", "deals", "prices", "passes", "plan"]  # the site's tabs (frontend/src/data/prefs.ts TabKey)
VISIT_EVENTS = ["load", "view", "signin"]  # the page opened, a tab opened, "Continue with Discord" pressed
VISIT_CLASSES = ["phone", "tablet", "desktop"]  # the device's coarse class, as the page guesses it
VISIT_MAX_BYTES = 512  # a visit report bigger than this is refused
VISIT_KEEP_DAYS = 90  # a device or member not seen for this long is dropped, and so are a day's counts this old
VISIT_MAX_DEVICES = 30_000  # devices kept at once; past it a new device is counted in the day's totals only
VISIT_MAX_MEMBERS = 10_000  # signed-in members kept at once (as hashes); past it a new one is not followed
VISIT_MAX_SOURCES_PER_DAY = 60  # distinct referrer hosts (and, apart, campaign tags) a day keeps; the rest is "other"
VISIT_FLUSH_S = 60  # the visits are written to disk at most this often, from a thread of their own (and on shutdown)
# Visit reports one address (an IPv6 one by its /64) may send a minute, and new device ids it may start an hour, so
# random ids cannot fill the table; memory only, like the click limit. Roomy, for a carrier's NAT shared by many phones;
# past either, a report is dropped quietly (204).
VISIT_PER_MIN = 120
VISIT_NEW_DEVICES_PER_HOUR = 30
DISCORD_COUNT_EVERY_S = 3600  # how often the server's member count is read from Discord (one point is kept a day)
DISCORD_COUNT_KEEP_DAYS = 400  # member counts are kept this many days (a number per day, nothing about anyone)
ADMIN_STATS_CACHE_S = 30  # the admin panel's figures are computed at most this often
ADMIN_DEEP_CACHE_S = 60  # and each of its deep tabs (members, accounts, features, sources, Discord)

# Activity (advisor/activity.py): what each device and each signed-in member does on the site, event by event, and
# what happens in our Discord (advisor/discord_activity.py), for the admin panel's Members, Accounts, Discord, Features
# and Sources tabs. A device is its random visit id (no address, no user agent, no fingerprint); a signed-in member is
# their Discord id, as the privacy notice says. Everything is bounded below, in rows and in days.
# The page's own events, each with what its `arg` may be: "none", "word" (a short plain word), "user" (a Real
# username), "id" (a listing id, digits). "time" carries seconds the page was on screen in `n`; "year" an account's
# yearly On This Day figure.
ACTIVITY_PAGE_EVENTS = {
    "session": "none",  # a visit starts: the page opened, or came back after ACTIVITY_SESSION_GAP_S out of sight
    "time": "none",  # seconds on screen since the last report (sent when the page is hidden)
    "lookup": "user",  # an account looked up
    "link": "user",  # Link pressed, for this username
    "unlink": "none",
    "share": "word",  # what was shared: a deal, the profile card...
    "filter": "word",  # which filter changed: level, budget...
    "sort": "word",  # the sort picked
    "sport": "word",  # the sport filter picked ("all" for none)
    "deal": "id",  # a deal opened, by listing id
    "out": "word",  # a click to Real, by panel
    "push": "word",  # phone alerts "on" or "off"
    "pings": "word",  # deal pings "on" or "off"
    "install": "word",  # the home-screen offer: "shown", "accepted", "dismissed", "ios"
    "refresh": "none",  # pull to refresh
    "sheet": "word",  # a sheet or menu opened, by name
    "year": "user",  # the yearly figure the page worked out for this account (`n`)
}
# What the server itself records: the page opened ("load", with its tab), a tab opened ("tab"), "Continue with
# Discord" pressed ("signin"), a login finished ("auth"), a Real account linked ("linked", its passes in `n`) or
# unlinked ("unlinked").
ACTIVITY_SERVER_EVENTS = ("load", "tab", "signin", "auth", "linked", "unlinked")
ACTIVITY_SESSION_GAP_S = 30 * 60  # out of sight this long, the page starts a new session when it comes back
ACTIVITY_TIME_MAX_S = 4 * 3600  # one "time" report counts at most this many seconds
ACTIVITY_BATCH_MAX = 40  # events in one report from the page
ACTIVITY_MAX_BYTES = 4096  # a report bigger than this is refused
ACTIVITY_EVENTS_PER_MIN = 600  # events one address (an IPv6 one by its /64) may send a minute; past it, dropped quietly
ACTIVITY_DEVICE_EVENTS_PER_DAY = 600  # events kept from one device in a UTC day; past it, counted as dropped only
ACTIVITY_EVENTS_PER_DAY = 150_000  # events kept from everyone in a UTC day; past it, counted as dropped only
ACTIVITY_MAX_EVENTS = 1_000_000  # events kept at once; past it the oldest go first
ACTIVITY_MAX_DEVICES = 50_000  # devices kept at once; past it a new device's events are dropped (and counted)
ACTIVITY_MAX_MEMBERS = 10_000  # signed-in members kept at once; past it a new one is kept as an anonymous device
ACTIVITY_MAX_LOOKUPS = 200_000  # account lookups kept at once; past it the oldest go first
ACTIVITY_MAX_ACCOUNTS = 50_000  # accounts looked up kept with their size; past it the least recently seen go first
ACTIVITY_QUEUE_MAX = 20_000  # events waiting in memory for the writer; past it, dropped (and counted)
ACTIVITY_FLUSH_S = 15  # the writer stores what waits at most this often (and on shutdown)
ACTIVITY_LOOKUP_DEDUP_S = 600  # the same account looked up again by the same member within this counts once
# How long it is kept: a signed-in member's activity (on the site and in our Discord), and an anonymous device's.
MEMBER_ACTIVITY_KEEP_DAYS = 180
ANON_ACTIVITY_KEEP_DAYS = 90
DISCORD_CHANNEL_KEEP_DAYS = 400  # messages per channel per day (counts, nobody's name) are kept this long
# Our Discord, read by the bot (GET only, never a write): every DISCORD_ACTIVITY_EVERY_S, the new messages of each text
# channel (counted per channel, day and author; their text is never kept), the reactions on the bot's recent posts,
# and, for the members who signed in on the site, whether they are in the server and their roles.
DISCORD_ACTIVITY_EVERY_S = 1800
DISCORD_ACTIVITY_BACKFILL_DAYS = 7  # a channel read for the first time is read back this far
DISCORD_ACTIVITY_PAGES = 5  # pages of 100 messages read per channel per round, at most
DISCORD_ACTIVITY_THREADS = 25  # active threads (forum posts) read per round, the most recent first
DISCORD_ACTIVITY_MEMBER_CHECKS = 200  # site members checked per round, the longest unchecked first
DISCORD_ACTIVITY_PAUSE_S = 0.4  # between two calls, so a round never bursts against Discord's limits
DISCORD_ACTIVITY_POSTS = 300  # the bot's posts whose reactions are kept, the most recent
DISCORD_ACTIVITY_MSG_ROWS_PER_DAY = 5000  # (channel, author) counts a day keeps; past it the rest count per channel only
DISCORD_ACTIVITY_PEOPLE_MAX = 20_000  # people of our server kept (name, avatar, roles), the least recently seen go first

# Our own community: a Discord invite, shown only when set. Anything that is not a Discord invite link is ignored.
_COMMUNITY_URL = re.compile(r"https://(discord\.gg|discord\.com/invite)/[A-Za-z0-9-]{2,32}")


def community_url(value: str | None) -> str | None:
    """`value` if it is a Discord invite link, else None; a value that is set but is not one is logged."""
    if not value:
        return None
    if _COMMUNITY_URL.fullmatch(value) is None:
        logging.getLogger(__name__).warning(
            "ADVISOR_COMMUNITY_URL is not a Discord invite link (https://discord.gg/... or "
            "https://discord.com/invite/...); the community link stays hidden"
        )
        return None
    return value


COMMUNITY_URL = community_url(os.environ.get("ADVISOR_COMMUNITY_URL"))  # read once, so a bad value is logged once

# A gift of Rax to the site: Rax moves from one Real account to another through the market only (a bid on a card the
# other account has on sale), so the page names the account to look for and, when set, links one of its cards.
SUPPORT_ACCOUNT = "otdpalace"  # the Real account a gift goes to
_SUPPORT_URL = re.compile(r"https://www\.realapp\.com/[A-Za-z0-9]{6,40}")  # a Real share link (a card, a listing)


def support_url(value: str | None) -> str | None:
    """`value` if it is a Real share link, else None; a value that is set but is not one is logged."""
    if not value:
        return None
    if _SUPPORT_URL.fullmatch(value) is None:
        logging.getLogger(__name__).warning(
            "ADVISOR_SUPPORT_URL is not a Real share link (https://www.realapp.com/...); the gift page shows the "
            "account's name only"
        )
        return None
    return value


SUPPORT_URL = support_url(os.environ.get("ADVISOR_SUPPORT_URL"))  # read once, so a bad value is logged once

# Daily-pay passes. A pass pays its player's 1x earnings of a game day on that day's anniversary, times its
# rarity multiplier, until its lifetime limit. Real pays at most 2 passes per sport each day.
OTD_CLAIMS_PER_SPORT_DAY = 2
OTD_LADDERS = {  # (tier, rating to enter, multiplier at entry)
    "player":  [("general",0,1), ("common",10,2), ("uncommon",30,3), ("rare",80,4), ("epic",180,10),
                ("legendary",380,25), ("mystic",1380,75), ("iconic",3380,150)],
    "fighter": [("general",0,1), ("common",10,1.2), ("uncommon",30,1.4), ("rare",80,1.6), ("epic",180,2),
                ("legendary",380,5), ("mystic",1380,10), ("iconic",3380,20)],
    "team":    [("general",0,1), ("common",30,1.2), ("uncommon",90,1.4), ("rare",240,1.6), ("epic",540,2),
                ("legendary",1140,2.5), ("mystic",4140,4), ("iconic",10140,6)],
}
OTD_PLAYER_LIMIT_PER_MULT = 500          # player limit = 500 x multiplier
OTD_NO_LIMIT = {"player": {"iconic"}, "fighter": {"iconic"}}  # the tiers without a limit
# General pays nothing On This Day: Real's page says "Common or better", and the past-season Generals of the biggest
# account looked up have a limit of 0 (the internal research notes, 1b). Real's limit tables
# still print 800 for a team or fighter General; those figures are never used. A General still pays a season in
# progress live, game by game.
OTD_NO_OTD_TIERS = frozenset({"general"})
OTD_TEAM_LIMITS = {"common": 1500, "uncommon": 2500, "rare": 4000, "epic": 6000,
                   "legendary": 12000, "mystic": 24000, "iconic": 128000}
# A fighter's (UFC) limits, from Real's On This Day page (Legendary and Mystic at their first level).
OTD_FIGHTER_LIMITS = {"common": 1500, "uncommon": 3000, "rare": 6000, "epic": 12000,
                      "legendary": 24000, "mystic": 48000}
OTD_LIMIT_ESTIMATED_KINDS: set[str] = set()  # kinds whose limit Real never states (500 x multiplier is an estimate)
OTD_LIMIT_ESTIMATED_SPORTS = {"soccer"}  # same for every soccer pass
OTD_NO_LIMIT_HORIZON_YEARS = 3           # how long an unlimited pass is counted for
OTD_PAYBACK_HORIZON_YEARS = 5            # a pass not paid back within this many years from today never pays back
OTD_MINT_COST = {"player": 200, "team": 800, "fighter": 800}  # fallback when the market doesn't state it (every UFC row says 800)
OTD_SPORT_MONTHS = {"mlb": (3,4,5,6,7,8,9,10), "nba": (10,11,12,1,2,3,4,5,6), "nfl": (9,10,11,12,1,2),
                    "nhl": (10,11,12,1,2,3,4,5,6), "wnba": (5,6,7,8,9,10), "ufc": tuple(range(1,13)),
                    "soccer": (8,9,10,11,12,1,2,3,4,5), "golf": tuple(range(1,13)), "cfb": (8,9,10,11,12,1),
                    "cbb": (11,12,1,2,3,4)}
OTD_SPORT_DAYS = {"mlb": (205,135), "nba": (210,78), "nfl": (62,18), "nhl": (195,82), "wnba": (130,50),
                  "ufc": (250,25), "soccer": (230,47), "golf": (180,20), "cfb": (55,13), "cbb": (145,33)}
                  # (days the sport pays anyone, days one regular player pays); golf from measured logs
# Football's game days are not spread over its days: in a season nearly every NFL or college football team plays on the
# same weekend dates (the internal research notes, measured on the public 2023-2025 schedules: 18 NFL
# Sundays, about 14 college Saturdays, each played by roughly three teams in four, carrying 78-80 % of a team's
# games), while two seasons share few dates (1-8 % of a team's, as the year is not part of a day). The planner
# (frontend/src/lib/passes.ts replaySport) puts a pass's game days on its season's shared days that way:
# sport -> (shared days a season, share of a pass's game days on them). Medium confidence: it is the public schedule
# of whole teams; a player misses games, and Real's own game dates are not published.
# Golf is the same in kind (the internal research notes, measured on the per-date pay of the 2014-2025
# seasons): a season's tournaments end on 41 to 45 Sundays, the same for every golfer, and a regular one is paid on
# about 20 of them, so two golfers of one season share 54 % of their pay dates (the planner assumed 11 %).
OTD_WEEKLY_DAYS = {"nfl": (18, 0.78), "cfb": (14, 0.80), "golf": (43, 1.0)}
# Golf seasons whose years have the same weekdays replay the same Sundays (2014 and 2025, 2017 and 2023, 2019 and
# 2024, 2016 and 2022, 2015 and 2020; by the calendar, 2026 with those two and 2027 with 2021): sport -> the share of
# their days two such seasons have in common. Two golfers of such seasons share 23 to 46 % of their pay dates, 0.43
# to 0.83 of what two of one season do; other pairs of seasons 0 to 8 %. Medium confidence: the dates come from a
# community site's copy of Real's figures, not from Real.
OTD_SAME_WEEKDAYS = {"golf": 0.7}
OTD_PROJECTION_BELOW = 0.9               # a current season under this share played is a projection
OTD_FULL_AT = 0.85                       # a sport's claims count as nearly full from this share
OTD_IGNORE_ASK_ABOVE = 5                 # asks above 5x the traded price per point are not real supply ...
OTD_IGNORE_ASK_MIN_SALES = 5             # ... judged only with at least this many sales
OTD_BUILD_DAYS_OK = 21                   # "can be built soon"
OTD_BUILD_DAYS_MAX = 91                  # past this, "not buildable soon"
OTD_SHELF_KEEP = 60
OTD_TOP = 10                             # how many passes to show per sport
OTD_BUDGET_PRESETS = [1000, 5000, 20000, None]  # the most to spend on one pass, offered in one tap; None = any
# The cheapest way into a sport for a newcomer: the first of these rungs by advisor/otd.py _rank (payback from today).
OTD_STARTER_TIERS = ("common", "uncommon")
# Passes are ranked by when they pay back from today (advisor/otd.py _rank), and a pass whose pay is mostly months
# away (a past MLB season in November) is said so: "Pays from March — better bought in February". That is when the
# next OTD_LATER_WINDOW_MONTHS months from today hold under OTD_LATER_SHARE_BELOW of what its next 12 months pay; its
# pay "starts" in the first month holding at least OTD_LATER_START_SHARE of its season. The browser applies them.
OTD_LATER_WINDOW_MONTHS = 3
OTD_LATER_SHARE_BELOW = 0.10
OTD_LATER_START_SHARE = 0.02
# "Pass deals", at the top of Deals (frontend/src/lib/passDeals.ts; the free site's teaser is advisor/pass_deals.py).
# A pass counts only when its usual rate rests on at least OTD_IGNORE_ASK_MIN_SALES trades. The block shows
# PASS_DEALS_SHOWN passes (components/PassDeals.tsx). The teaser's best saving is rounded down to a step of
# PASS_DEALS_PCT_STEP points and never said above PASS_DEALS_PCT_MAX: the shelf it rests on can be a day old, and the
# cheapest asks are the first ones bought. Under PASS_DEALS_PCT_MIN the page says no percent, only how many passes (the
# owner's call: "at least 5% less" sells nothing); components/PassDeals.tsx applies it, the server still counts it.
PASS_DEALS_SHOWN = 3
PASS_DEALS_PCT_STEP = 5
PASS_DEALS_PCT_MAX = 50
PASS_DEALS_PCT_MIN = 10
# Whether the free site is told the best saving at all. Off since 2026-11-18: a star's pass of this season showed
# "48% less" against a usual rate of 36.6 a point while its 574 cards on sale started near 9 a point, so the usual
# rate looks mixed (the feed's sales are the player's, maybe across seasons and rating buckets; being checked
# at the source). Off, the teaser sends how many passes and no percent, and the page leads with the count.
PASS_DEALS_SAY_PCT = False
# Whether "Pass deals" shows at all, to members or as the free site's locked place (frontend/src/lib/passDealsSwitch.ts
# mirrors it). Off since 2026-11-18: a pass's usual rate rests on one rating bucket, picked by whichever card ends
# first, and its shelf holds auctions' opening prices, so "for less than usual" could not be trusted. Off, the free
# site is told zero passes, and the page shows no block. The maths now reads the feed's build rate and the shelf's
# live auctions at their pay, firm ones only (the internal research notes); it stays off until
# the feed sends them and they are checked live.
PASS_DEALS_ON = False
# Whether the Passes tab offers "Build to" a rarity (frontend/src/lib/buildToSwitch.ts mirrors it): a strip of Real's
# rarities, Common to Iconic, that prices every pass at that one rung (the cost from what is held or from scratch at the
# build rate, the year, the payback) and ranks them by Rax a year per Rax; "Best for each", today's list, stays the
# default. The browser alone does it, from the rungs every served pass already carries (members' and visitors' alike),
# so the server computes nothing new. Off until the feed's build rates cover most passes and the mode is checked live
# (the internal research notes): with only a few passes measured, most rows would read "less certain".
BUILD_TO_ON = False

# Offers: a cheap way to build a pass. Acceptance, measured on the tool accounts we read: 18 % of 61,537 offers, and 6 %
# of the smallest accounts' low offers (the internal research notes, section 2). The level is not measured
# (the offers' prices were not read): it is the deal line, MIN_DISCOUNT["high"] under the typical price per rating point.
# An accepted offer starts a 12-hour auction (Real's changelog). frontend/src/lib/offers.ts holds the same figures
# (tests/test_copy_parity.py).
OFFER_ACCEPTED = 0.18
OFFER_ACCEPTED_SMALL = 0.06
OFFER_LEVEL = round(1 - MIN_DISCOUNT["high"], 2)
# A pass can be built only when its cards trade (a traded rate per rating point exists) or are on sale: a market
# with no trade in the window and nothing on the shelf is never listed. There is no "pass market" to count sales on.

# Player photos: fetched by the server from public league sources only (never from Real's own media server), kept
# on disk in photos/ of the data directory (ADVISOR_DATA_DIR), and served from our own origin, so the page's CSP keeps
# img-src 'self'.
PHOTO_TTL_S = 7 * 24 * 3600  # a photo, and a sport's name-to-photo map, is fetched again after this long
PHOTO_MISS_TTL_S = 24 * 3600  # a player without a photo is not asked about again for this long
PHOTO_RETRY_S = 3600  # a sport's map that could not be read at all is tried again after this long
PHOTO_MAX_BYTES = 300_000  # a bigger image is refused
PHOTO_ROSTER_MAX_BYTES = 1_000_000  # a bigger roster is refused: an NFL team's ESPN roster is about 375 KB of JSON
PHOTO_TIMEOUT_S = 3  # each request gives up after this long, from the first byte asked to the last read
PHOTO_MAP_DEADLINE_S = 30  # building one sport's map stops asking for more rosters after this long
PHOTO_MAP_WORKERS = 4  # how many rosters of one sport are asked for at once
PHOTO_HOSTS = frozenset(  # the only hosts asked anything; a redirect, even to one of them, counts as no photo
    {"img.mlbstatic.com", "assets.nhle.com", "site.web.api.espn.com", "a.espncdn.com"}
)
PHOTO_TYPES = frozenset({"image/png", "image/jpeg", "image/webp"})  # what an image may be served as
PHOTO_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)
# MLB and NHL: Real's player id is the league's, so the photo comes straight from the id.
PHOTO_BY_ID = {
    "mlb": "https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_auto:best/v1/people/{id}/headshot/silo/current.png",
    "nhl": "https://assets.nhle.com/mugs/nhl/latest/{id}.png",
}
# NBA, WNBA, NFL: ESPN's public team rosters, matched by name. UFC: ESPN's MMA rankings, matched by name (a fighter
# missing from them, a champion included, has no photo). Soccer shows initials: ESPN has almost no soccer faces.
PHOTO_ESPN_API = "https://site.web.api.espn.com/apis/site/v2/sports/"
PHOTO_ESPN_ROSTERS = {"nba": "basketball/nba", "wnba": "basketball/wnba", "nfl": "football/nfl"}
PHOTO_ESPN_RANKINGS = {"ufc": "mma/ufc"}
# MLB and NHL by name too, but only where the ids are invented (the demo): there an id URL would show a stranger's face.
PHOTO_ESPN_NAME_ROSTERS = {"mlb": "baseball/mlb", "nhl": "hockey/nhl"}
# Who is hurt: ESPN's public injury list for the five leagues whose ESPN rosters give an exact athlete id (the same id sits in a
# hurt player's headshot and in the roster's; an NHL or MLB photo still comes from Real's own id, the league's), so a hurt player is never matched to a namesake by name alone.
INJURY_PATHS = PHOTO_ESPN_ROSTERS | PHOTO_ESPN_NAME_ROSTERS
INJURY_TTL_S = 30 * 60  # a league's list is read again after this long
INJURY_RETRY_S = 5 * 60  # a read that failed is tried again after this long, never sooner
INJURY_MAX_AGE_S = 3 * 3600  # a list older than this says nothing: a stale injury is not news
INJURY_MAX_BYTES = 16_000_000  # ESPN's list repeats every team's logos per player: the NFL's is 8.8 MB decoded (350 KB on the wire)
INJURY_TIMEOUT_S = 10  # each read gives up after this long
# College football, college basketball and golf: ESPN's public player search, kept like any photo, matched by name in
# the sport's leagues one after the other: the first league with athletes of that name decides. College passes are
# often of past seasons whose players went pro, so the pro league comes after the college one.
PHOTO_ESPN_SEARCH_API = "https://site.web.api.espn.com/apis/common/v3/search"
PHOTO_ESPN_SEARCH = {"cfb": ("college-football", "nfl"), "cbb": ("mens-college-basketball", "nba"), "golf": ("pga", "lpga")}
PHOTO_ESPN_SIZE = (180, 130)  # ESPN's image resizer serves its headshots at this width and height
PHOTO_BROWSER_CACHE_S = 86400  # the browser keeps a photo this long
PHOTO_SIDE_MAX = 228  # a photo is kept no bigger than this on its short side: the biggest face is 76 px, at 3x
PHOTO_WEBP_QUALITY = 80  # and re-encoded as WebP at this quality (its see-through corners kept), when that is smaller
PHOTO_PIXELS_MAX = 4_000_000  # an image claiming more pixels than this is never decoded, only kept as it came
PHOTO_NONE_CACHE_S = 600  # and a "no photo" answer this long

# Alerts by web push, opt-in per device and per category, no account: see advisor/push.py.
PUSH_PER_HOUR = 12  # at most this many alerts a device gets in any hour (its test sends count apart)
PUSH_TAG_COOLDOWN_S = 900  # one tag (a player's deals, one listing's last call, ...) waits this long before its next
PUSH_LAST_CALL_S = 180  # "last call" on a deal the device opened: its auction or countdown ends within this long
PUSH_MOVE_MIN = 0.20  # a followed player's prices moving this much today (up or down) is worth an alert
PUSH_MAX_SUBS = 5000  # subscriptions kept at most; a new one is refused past this
# The only push services ever sent to, https only and never through a redirect; "*." needs a name before it.
PUSH_ALLOWED_HOSTS = (
    "fcm.googleapis.com", "updates.push.services.mozilla.com", "*.notify.windows.com", "web.push.apple.com",
    "*.push.apple.com",
)
PUSH_DEFAULT_DIGEST_HOUR = 9  # the daily digest's hour on the device's clock, until its visitor picks another
PUSH_DEFAULT_QUIET = (23, 7)  # no alert from 23:00 to 07:00 on the device's clock, until its visitor changes it
PUSH_MAX_BYTES = 4096  # a push request body bigger than this is refused
PUSH_TESTS_PER_HOUR = 3  # "Send a test" works this many times an hour per device (counted in memory, by endpoint)
PUSH_TEST_GLOBAL_PER_HOUR = 60  # and this many times an hour for the whole server
PUSH_TEST_KEYS_MAX = 10_000  # endpoints whose test counts are remembered at most (in memory)
PUSH_CLIENT_PER_MIN = 20  # subscribe, unsubscribe and test requests one address may make a minute (in memory)
PUSH_RATE_MAX_ADDRESSES = 10_000  # addresses that limit remembers at most
PUSH_ROW_TTL_DAYS = 30  # a subscription its device has not sent for this long is dropped
PUSH_ANNOUNCED_KEPT = 200  # listings a device was told about, remembered so a deal that comes back is not news again
PUSH_MAX_FOLLOWS = 100  # followed players a subscription carries at most (the device sends its newest)
PUSH_MAX_OPENED = 30  # opened listings it carries at most, for "last call"
PUSH_MAX_ENDPOINT = 1024  # characters in an endpoint URL at most
PUSH_TIMEOUT_S = 5  # one send gives up after this long
PUSH_QUEUE = 4  # snapshots waiting for the dispatcher at most; past this the newest is dropped (the next one catches up)
PUSH_BACKOFF_S = 60  # after a failed send a device waits this long, doubled for each failure in a row ...
PUSH_BACKOFF_CAP_S = 3600  # ... up to this
PUSH_MAX_FAILS = 30  # this many failures in a row and the subscription is dropped
PUSH_MAX_DEAD = 5000  # endpoints remembered as unsubscribed (as hashes), so a device can be told it was
PUSH_DIGEST_SIZE = 3  # deals in the daily digest
PUSH_TTL_S = {"deal": 600, "last_call": PUSH_LAST_CALL_S, "move": 3600, "digest": 3600, "routine": 3600, "test": 60}  # how long a
# push service may hold an alert for a device that is offline before dropping it

# Posts in our own Discord server (advisor/discord_post.py): the best new deals in #live-deals, the day's pass picks in
# #otd-picks. A deal posted is one the safest level (New) shows, that resells at its usual price for a profit after
# both fees, with no injury note, read recently and with time left to act on it.
DISCORD_POST_CHECK_S = 5  # how often the poster looks for a new snapshot
DISCORD_DEALS_PER_ROUND = 3  # deals posted from one snapshot at most: a restart (or a first start) never floods the channel
DISCORD_DEALS_PER_HOUR = 6  # in any 60 minutes
DISCORD_DEALS_PER_DAY = 40  # in any 24 hours
DISCORD_MIN_LEFT_S = 600  # a deal ending sooner is not posted: by the time someone reads it, it is gone
DISCORD_MAX_READ_AGE_S = 1800  # a listing last read longer ago than this is not posted: its price may have moved
# The Deal Alerts role is pinged for an exceptional deal only: twice the smallest high-confidence discount, and at
# least this much profit after fees; never one that is slow to resell; at most DISCORD_PINGS_PER_DAY in any 24 hours.
DISCORD_PING_MIN_DISCOUNT = 2 * MIN_DISCOUNT["high"]
DISCORD_PING_MIN_MARGIN = 100
DISCORD_PINGS_PER_DAY = 3
DISCORD_POSTED_KEPT = 2000  # listings remembered as posted (with their message), so a deal is never posted twice
DISCORD_GONE_EDIT_H = 24  # a posted deal that goes away within this many hours gets "Gone" on its post
DISCORD_GONE_EDITS_PER_ROUND = 5  # posts marked Gone from one snapshot at most
DISCORD_OTD_HOUR_UTC = 15  # the daily pass picks go out at this hour (UTC) ...
DISCORD_OTD_LATE_H = 6  # ... or, after a restart, up to this many hours later; never twice the same day
DISCORD_OTD_PICKS = 5  # passes in the daily post at most
DISCORD_OTD_MIN_PICKS = 3  # fewer than this and there is no post that day (yet)
DISCORD_OTD_PER_SPORT = 2  # and at most this many of one sport
DISCORD_OTD_MAX_AGE_H = 8 * 24  # pass figures measured longer ago than this are not posted (the feed measures them
# every few days: its figures were 7 days old on 2026-11-16)
DISCORD_BACKOFF_S = 30  # Discord down (a timeout, a 5xx): the poster waits this long, doubled each failure in a row ...
DISCORD_BACKOFF_CAP_S = 900  # ... up to this
DISCORD_RETRY_AFTER_CAP_S = 600  # a 429's retry_after is obeyed up to this long
# One player never floods #live-deals: at most this many posts about the same player in any 24 hours, and the same card
# at the same price (a seller listing it again) is never posted twice in that time.
DISCORD_PLAYER_PER_DAY = 2
# "What's new" (advisor/whatsnew.json) goes to #announcements once per entry, at most this many in one round.
DISCORD_WHATSNEW_PER_ROUND = 2
DISCORD_ANNOUNCE_SCAN = 100  # messages of a channel read to see whether a post is there already (a wiped disk forgets)
# The weekly digest in #market-talk: Mondays from this hour (UTC), or up to DISCORD_DIGEST_LATE_H later after a restart;
# at least DISCORD_DIGEST_MIN_ITEMS of its parts must have something to say, or the week is skipped.
DISCORD_DIGEST_HOUR_UTC = 14
DISCORD_DIGEST_LATE_H = 8
DISCORD_DIGEST_DEALS = 3
DISCORD_DIGEST_MOVERS = 2  # risers and fallers each
DISCORD_DIGEST_MIN_ITEMS = 2
DISCORD_SEASON_ALERT_DAYS = 7  # a season-clock date is announced this many days ahead, once
# A Discord interaction (a slash command, see advisor/discord_commands.py) bigger than this is refused: Discord's are a
# few kilobytes, the member who asked and their roles included.
DISCORD_INTERACTION_MAX_BYTES = 16 * 1024

# The web server. Waitress turns away a request body past this before the app sees it: twice the biggest body any
# route takes (a Discord interaction), so a small overrun still gets the app's own 413, with its headers.
REQUEST_MAX_BYTES = 2 * max(PUSH_MAX_BYTES, DISCORD_INTERACTION_MAX_BYTES)
STATS_TOKEN_MIN_CHARS = 32  # the server refuses to start with a shorter ADVISOR_STATS_TOKEN
HSTS_MAX_AGE_S = 31_536_000  # browsers keep to https for a year (only ever sent over https)

# The collector: how often it asks its source for data, and how far repeated failures slow it down.
COLLECT_INTERVAL_S = 5.0  # was 10: the best auctions go fast, and the page already asks every POLL_S
BACKOFF_CAP_S = 300.0  # after n failures in a row it waits COLLECT_INTERVAL_S * 2**n, but never more than this
# ... except when the feed was only stale or could not be reached: that passes by itself, so it is asked again soon.
BACKOFF_TRANSIENT_CAP_S = 30.0
COLLECT_LOG_EVERY_S = 60.0  # a round is logged when its outcome changes, and otherwise at most this often

# The live feed source (ADVISOR_SOURCE=feed), which reads one private JSON document over https.
FEED_TIMEOUT_S = 5  # a request that takes longer than this, in all, fails
FEED_MAX_BYTES = 20 * 1024 * 1024  # a document bigger than this, as sent or once unzipped, is refused
FEED_TOKEN_MIN_CHARS = 32  # the server refuses to start with a shorter ADVISOR_FEED_TOKEN
FEED_FUTURE_TOLERANCE_S = 10  # a document dated up to this far ahead of the clock counts as made now; further, refused
FEED_MEMORY_FMV_HOLD = timedelta(hours=6)  # a fair value the feed stops sending is held this long (the producer's own)
FEED_MEMORY_SAVE_EVERY = timedelta(minutes=5)  # the feed memory is written to disk at most this often
FEED_MEMORY_MAX_SALES = 50_000  # past this many remembered sales, the oldest go first

# The demo source: how the invented market moves on each fetch. Prices are shares of the reference price.
REPLAY_BID_SHARE = 0.03  # share of the open listings that get a higher bid
REPLAY_BID_STEP = (0.02, 0.06)  # a raise adds this share of the current bid
REPLAY_BID_CEILING = 1.05  # bids stop rising at this multiple of the reference price
REPLAY_TARGET_CEILING = 0.95  # bids also stay under this share of the listing's target price
REPLAY_NEW_LISTINGS = (0, 2)  # how many listings appear (fewest, most)
REPLAY_NEW_LISTING_MINUTES = (10, 60)  # a new listing ends this many minutes from now (soonest, latest)
REPLAY_DEAL_SHARE = 0.15  # share of the new listings that are deals
REPLAY_DEAL_TARGET = (0.50, 0.68)  # a deal's target price ...
REPLAY_DEAL_START = (0.45, 0.65)  # ... and opening bid
REPLAY_FAIR_TARGET = (0.92, 1.30)  # a fair-priced listing's target price ...
REPLAY_FAIR_START = (0.86, 0.96)  # ... and opening bid
REPLAY_TARGET_SHARE = 0.7  # share of the fair-priced listings that carry a target price at all
REPLAY_TAKE_CHANCE = 0.15  # chance, on each fetch, that someone bids the target price of one target deal

# Importing a visitor's passes from their Real username (advisor/importer.py), through the private feed.
IMPORT_CACHE_S = 10 * 60  # one answer per username is kept this long
IMPORT_PER_HOUR = 60  # lookups the whole site asks the producer for in an hour; each one costs it reads
IMPORT_PER_ADDRESS = 3  # lookups one address may ask for in IMPORT_ADDRESS_WINDOW_S
IMPORT_ADDRESS_WINDOW_S = 10 * 60
# Every pass of an account, the biggest measured (1,576) with room: the producer's own bound.
IMPORT_MAX_PASSES = 5000
# An answer some of whose passes wait on a season's ranking is kept this short, so the page's next ask sees progress;
# those next asks are free for IMPORT_FOLLOW_UP_S after the first such answer (the producer keeps it an hour).
IMPORT_PENDING_CACHE_S = 15
IMPORT_FOLLOW_UP_S = 55 * 60
# Those next asks cost the producer no read, but each still holds one of the server's threads while it waits: one
# address may make IMPORT_FOLLOW_UP_BURST of them at once, then IMPORT_FOLLOW_UP_PER_MIN a minute (the page asks
# every 15 s, four a minute).
IMPORT_FOLLOW_UP_BURST = 10
IMPORT_FOLLOW_UP_PER_MIN = 6
# A lookup holds a web thread up to IMPORT_TIMEOUT_S: at most this many leave for the producer at once, so slow lookups
# never take every thread from the page. One more is told to come back (503) after IMPORT_RETRY_AFTER_S.
IMPORT_MAX_CONCURRENT = 2
IMPORT_RETRY_AFTER_S = 15
IMPORT_MAX_WAITERS = 4  # asks that may wait at once for lookups already on their way; more answer "busy" (threads)
# A deal priced on sales also says what Real's own estimate says when the two differ by this share of the usual price.
# Measured: Real's figures sit 20% or more away from the realised price about one time in five.
REAL_ESTIMATE_GAP = 0.15
IMPORT_TIMEOUT_S = 35  # one lookup waits this long for the producer (it waits up to 25 s for a free account itself)

# Linked accounts (advisor/members.py) and what linking unlocks in our Discord (advisor/discord_perks.py).
MEMBER_LINKS_MAX = 5000  # members whose linked account the server keeps at most (the file is rewritten whole)
LINK_PLAYERS_MAX = 250  # players kept per member for their deal pings: those of their best-rated passes
LINK_OWNED_MAX = 500  # player-seasons kept per member with the rung held, so a ping never offers a card owned
LINK_FOLLOWS_MAX = 200  # players followed on the site a member may send for their pings
LINK_PINGED_KEPT = 50  # listings remembered per member as pinged already
LINK_PER_MIN = 20  # link, unlink and settings requests one address may make a minute
LINK_PINGS_PER_DAY = 3  # personal deal pings a member gets in any 24 hours at most
LINK_PINGS_PER_ROUND = 20  # personal deal pings sent from one snapshot at most, all members together
LINK_QUEUE_MAX = 200  # role refreshes waiting at once; more are dropped (the next link or refresh asks again)
# The invite board in our Discord (advisor/discord_invites.py, /invites): joins through a member's own invite links, as
# Discord counts them. The two roles are for show: alt accounts can inflate the count, so they must never carry a right.
INVITE_ROLES = (("Recruiter", 3), ("Ambassador", 10))  # role, the joins through a member's links that earn it; rising
INVITES_REFRESH_S = 600  # Discord's invites are read again after this long, never sooner
INVITES_TOP = 10  # members the board lists
INVITERS_MAX = 5000  # members whose count is kept at most (the file is rewritten whole)
INVITES_MEMBER_CHECK_S = 6 * 3600  # whether an inviter is still in the server, or on the staff, is asked again after this
INVITES_CHECKS_PER_ROUND = 15  # inviters asked about in one read at most, the highest counts first
INVITES_GRANTS_PER_ROUND = 5  # invite roles given in one read at most
# Resale: per player, how many of the recent listings of his cards sold (the private feed's /resale route, read by
# advisor.resale). A table older than RESALE_MAX_AGE_S says nothing.
RESALE_TTL_S = 3600  # the table is read again after this long
RESALE_RETRY_S = 600  # a read that failed is tried again after this long, never sooner
RESALE_MAX_AGE_S = 6 * 3600  # counted from when the table was BUILT, not from when it was fetched
RESALE_MIN_LISTED = 20  # fewer ended listings than this in a band and a player has no count (the producer says so too)
RESALE_MAX_BYTES = 4_000_000
RESALE_TIMEOUT_S = 15
# A bid deal (an auction about to end, priced at the bid to beat) moves by the minute: when its listing was last read
# longer ago than this, the bid shown is a guess and the deal is not shown. A target deal lasts hours and keeps its
# "checked N m ago".
BID_READ_MAX_AGE_S = 600
RECENT_SALES_SHOWN = 5  # a deal priced on sales shows its newest sales of the window as the evidence behind the usual price
# A target deal read longer ago than this is not shown: a cheap target price goes fast, so after hours it is likely gone.
TARGET_READ_MAX_AGE_S = 3 * 3600

# A pass's build rate and its shelf's auctions: five optional fields the feed adds to each pass row once its switch is
# on (the internal research notes, advisor/pass_rates.py). Rows without them read as before.
PASS_BUCKETS = ("0-3", "3-5", "5-7", "7+")  # the feed's value buckets of a card's rating: (0,3], (3,5], (5,7], over 7
PASS_RARITIES = ("general", "common", "uncommon", "rare", "epic", "legendary", "mystic", "iconic")
FEED_PASS_EXTRA_MAX_BYTES = 1500  # the five fields of one row, as compact JSON: the feed's own cap
FEED_SHELF_AUCTIONS_MAX = 10      # the shelf page the feed reads holds 10 listings
FEED_RATE_MAX = 100_000_000       # no price or rate above this
FEED_SALES_MAX = 1_000_000        # nor a count
FEED_SPAN_D_MAX = 100_000.0
FEED_RATING_MAX = 1000.0
FEED_ENDS_IN_MAX_S = 100_000_000
# A (bucket, rarity) cell's listing rate counts from this many sales: the feed's own bar for `rate_build`.
OTD_BUILD_MIN_SALES = 5
# The offer hint uses the accepted offers measured for the build cell (or a deal card's own cell) from this many on;
# under it, the fixed share of the usual rate (OFFER_LEVEL). frontend/src/lib/offers.ts holds the same figures.
OTD_OFFER_MIN_SALES = 5
OTD_OFFER_FAR_BELOW = 0.5  # offers clearing at or under this share of the listing rate "clear far below listings"
# "What offer to make?": under a card deal, a member at the Pro level reads what accepted offers on cards like it went
# for (its own cell, from OTD_OFFER_MIN_SALES accepted offers and only above QUICKSELL_PER_POINT), next to what the
# same cards' listings sell for. A fact about the past with its count: never a saving, a percentage or a promise. The
# browser alone says it, from the `offers` every measured pass already carries, so the server computes nothing new
# (frontend/src/lib/dealOffer.ts; the switch's twin is lib/offerHintSwitch.ts, held equal by tests/test_copy_parity.py).
OFFER_HINT_ON = True
# The shelf's auctions (advisor/pass_rates.py live_auctions), on card deals' own caution (advisor/deals.py): a listing's
# `pay` (its current bid, else its opening price) is a price only in its last OTD_SHELF_FIRM_LEFT_MIN minutes, read
# at most OTD_SHELF_FIRM_READ_S ago, not a house listing (the platform's floor supply) and not under
# OTD_SHELF_OPENING_BELOW of its own cell's rate a point (an opening that is usually bid up). Anything else still open
# is an auction "opening at" its pay; an auction already over is dropped.
OTD_SHELF_FIRM_LEFT_MIN = BID_DEAL_MAX_LEFT_MIN
OTD_SHELF_FIRM_READ_S = TARGET_READ_MAX_AGE_S
OTD_SHELF_OPENING_BELOW = 0.5

# The price curve on Prices: a move's row draws its market's middle sale, a day at a time (advisor/price_history.py).
# Mirrored in frontend/src/lib/priceCurveSwitch.ts, kept equal by tests/test_copy_parity.py. Off, no move carries a
# curve and the page draws none; the history keeps learning its days all the same, so nothing is lost meanwhile.
PRICE_CURVE_ON = True
PRICE_CURVE_DAYS = 30  # how far back a curve goes; the history forgets older days
# A day's figure needs this many sales: the median of 3 shrugs off one odd sale, and a move's whole base week may
# rest on MIN_SALES_BASE (5), so asking more would leave nearly every day empty. Fewer is a gap, never a point.
PRICE_CURVE_MIN_SALES = 3
PRICE_CURVE_MIN_POINTS = 3  # a curve is drawn from this many points, today's included; fewer says nothing
PRICE_HISTORY_MAX_ROWS = 40_000  # day figures kept over every market (at most about 1.5 MB on disk); the oldest days go first
PRICE_HISTORY_SAVE_EVERY = timedelta(minutes=5)  # the history is written to disk at most this often
