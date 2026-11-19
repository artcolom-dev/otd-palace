"""The numbers the page and the Discord guides write out in words are the numbers the code runs on: a change to one of
these rules fails here until the sentence that promises it is changed too."""

import json
from pathlib import Path

import pytest

from advisor import rules

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "src"


def pct(share: float) -> str:
    return f"{round(abs(share) * 100)}%"


def part(share: float) -> str:
    """0.13 -> "an eighth": a share said as the nearest simple part."""
    n = round(1 / share)
    return {4: "a quarter", 5: "a fifth", 6: "a sixth", 7: "a seventh", 8: "an eighth", 9: "a ninth", 10: "a tenth"}[n]


PROMISES = [
    # (file, the words, what they promise)
    ("components/AlertsSheet.tsx", f"ends in under {rules.PUSH_LAST_CALL_S // 60} minutes", "last call window"),
    ("components/AlertsSheet.tsx", f"{pct(rules.PUSH_MOVE_MIN)} or more in a day", "big price move alert"),
    ("components/AlertsSheet.tsx", f"Today's {rules.PUSH_DIGEST_SIZE} best deals", "digest size"),
    ("components/DiscordPerks.tsx", f"Up to {rules.LINK_PINGS_PER_DAY} a day", "DM pings a day"),
    ("components/CommunityCta.tsx", f"up to {rules.LINK_PINGS_PER_DAY} a day", "DM pings a day"),
    ("content/glossary.ts", f"Real keeps {pct(rules.SELLER_FEE)} and a normal listing costs {rules.LISTING_FEE} Rax", "fees"),
    ("content/glossary.ts", f"The usual price is under {rules.AFTER_FEES_MIN_REF}", "thin"),
    ("content/glossary.ts", f"about {rules.QUICKSELL_PER_POINT:g} Rax a rating point for a card", "quick sell pay"),
    ("content/glossary.ts", f"about {part(rules.QUICKSELL_MARKET_SHARE)} of what", "quick sell against a sale"),
    ("content/recycleWords.ts", f'export const QUICK_PART = "about {part(rules.QUICKSELL_MARKET_SHARE)}";', "quick sell against a sale"),
    ("content/how.ts", f"Real keeps {pct(rules.SELLER_FEE)} of each sale. A normal listing costs {rules.LISTING_FEE} Rax", "fees"),
    ("content/how.ts", f"drop {pct(rules.FALLING_AT)} or more in a day", "falling"),
    ("views/DealsSection.tsx", f"taken in the last {rules.TAKEN_WINDOW_S // 60} min", "taken window"),
    ("components/PassDeals.tsx", f"export const PASS_DEALS_SHOWN = {rules.PASS_DEALS_SHOWN};", "pass deals shown"),
    ("components/PassDeals.tsx", f"export const PASS_DEALS_PCT_MIN = {rules.PASS_DEALS_PCT_MIN};", "pass deals percent said from"),
    ("lib/passDealsSwitch.ts", f"export const PASS_DEALS_ON = {str(rules.PASS_DEALS_ON).lower()};", "pass deals on"),
    ("lib/buildToSwitch.ts", f"export const BUILD_TO_ON = {str(rules.BUILD_TO_ON).lower()};", "build to on"),
    ("lib/offerHintSwitch.ts", f"export const OFFER_HINT_ON = {str(rules.OFFER_HINT_ON).lower()};", "offer hint on"),
    ("lib/priceCurveSwitch.ts", f"export const PRICE_CURVE_ON = {str(rules.PRICE_CURVE_ON).lower()};", "price curve on"),
    ("lib/priceCurveSwitch.ts", f"export const PRICE_CURVE_DAYS = {rules.PRICE_CURVE_DAYS};", "price curve days"),
    ("lib/priceCurveSwitch.ts", f"export const PRICE_CURVE_MIN_POINTS = {rules.PRICE_CURVE_MIN_POINTS};", "price curve points"),
    ("content/glossary.ts", f"each day with {rules.PRICE_CURVE_MIN_SALES} or more sales, at most {rules.PRICE_CURVE_DAYS} days back", "price curve day"),
]


@pytest.mark.parametrize(("path", "words", "what"), PROMISES, ids=[f"{p[0]}:{p[2]}" for p in PROMISES])
def test_the_page_says_the_rule_the_code_runs(path, words, what):
    assert words in (SRC / path).read_text(), f"{path} no longer says {words!r} ({what})"


def test_the_moves_rule_is_said_as_it_is_applied():
    assert rules.MIN_SALES_RECENT == rules.MIN_SALES_BASE  # the words say one count for both
    n = rules.MIN_SALES_RECENT
    assert f"Only moves of {pct(rules.MIN_ABS_CHANGE)} or more, with {n} or more sales in both" in (
        SRC / "content" / "glossary.ts").read_text()
    assert f"once a player has {n} or more sales today" in (SRC / "views" / "PricesView.tsx").read_text()


def test_the_offer_figures_are_the_same_on_the_page_and_in_the_bot():
    """The page's offer hints (lib/offers.ts) and the bot's /otd line run on the figures in advisor/rules.py."""
    offers = (SRC / "lib" / "offers.ts").read_text()
    assert f"export const OFFER_LEVEL = {rules.OFFER_LEVEL};" in offers
    assert f"export const OFFER_ACCEPTED = {rules.OFFER_ACCEPTED};" in offers
    assert f"export const OFFER_ACCEPTED_SMALL = {rules.OFFER_ACCEPTED_SMALL};" in offers
    assert rules.OFFER_LEVEL == 0.8  # the words say "about 20% under"
    # Measured offers (the feed's accepted offers by bucket and rarity): the same bar and the same "far below".
    assert f"export const OFFER_MIN_SALES = {rules.OTD_OFFER_MIN_SALES};" in offers
    assert f"export const OFFER_FAR_BELOW = {rules.OTD_OFFER_FAR_BELOW};" in offers
    rates = (SRC / "lib" / "passRates.ts").read_text()
    assert f"export const PASS_BUCKETS: readonly PassBucket[] = {json.dumps(list(rules.PASS_BUCKETS))};" in rates
    assert f"export const PASS_RARITIES = {json.dumps(list(rules.PASS_RARITIES))} as const;" in rates
    one_in = round(1 / rules.OFFER_ACCEPTED)
    assert f"about 1 in {one_in} was accepted" in (SRC / "content" / "glossary.ts").read_text()


def test_the_glossary_says_the_rarity_ladder_the_planner_runs_on():
    ladder = {tier: (rating, mult) for tier, rating, mult in rules.OTD_LADDERS["player"]}
    text = (SRC / "content" / "glossary.ts").read_text()
    assert f"Common at {ladder['common'][0]} rating" in text
    assert f"Iconic at {ladder['iconic'][0]:,} for a player" in text
    assert f"Common {ladder['common'][1]}×, Legendary {ladder['legendary'][1]}×, Iconic {ladder['iconic'][1]}×" in text
