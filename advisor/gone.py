"""Deals that just went away: kept on the page for a moment, with the reason, so rows never vanish silently.

The collector runs every snapshot through one GoneTracker. The tracker remembers the deals it served last
round; a deal missing from this round's deals becomes a "gone" row, the deal exactly as it was served plus
why it went and when, and stays GONE_KEEP_S seconds. A deal is its listing and its kind, so a target deal whose
target price was bid has changed kind when the same listing stays on as a bid deal. A listing is never both a deal
and a gone row in one snapshot (the page, the share link and the alerts all go by the listing): such a row is not
shown, and one already kept leaves as soon as its listing is a deal again. A deal that is still that very deal (same
kind, same price), left out only by the list's caps (MAX_DEALS, MAX_DEALS_PER_PLAYER: a better deal of the same player
came), has not gone: it gets no row, so neither the page nor its shared link says so. Deals taken by someone (a bid on the
target, an outbid, an auction over) count towards `taken_10m` for TAKEN_WINDOW_S seconds whether or not their row is
shown, each card once.
"""

from datetime import datetime, timedelta

from advisor.deals import judge
from advisor.model import Listing, RawData
from advisor.reference import index_sales, listing_key
from advisor.rules import GONE_KEEP_S, TAKEN_WINDOW_S
from advisor.snapshot import iso_z

# The reasons that mean someone took the deal, as opposed to its price or the market moving.
TAKEN_REASONS = frozenset({"countdown_started", "outbid", "ended"})


def _target_was_bid(deal: dict, listing: Listing) -> bool:
    """Whether someone bid the target price, the one the deal was served at or the listing's own now."""
    bid, target = listing.current_bid, listing.target_price
    return bid is not None and (bid >= deal["price"] or (target is not None and bid >= target))


def _reason(deal: dict, listing: Listing | None, previous_target: int | None, now: datetime) -> str:
    """Why a deal of the last round is not a deal now, judged by its listing as this round sees it."""
    if listing is None or listing.ends_at <= now:
        return "ended"
    if deal["kind"] == "target" and _target_was_bid(deal, listing):
        return "countdown_started"
    if deal["kind"] == "bid" and listing.current_bid is not None and listing.current_bid > deal["price"]:
        return "outbid"
    if listing.target_price != previous_target:
        return "price_moved"
    return "no_longer_a_deal"


def _identity(deal: dict) -> tuple[int, str]:
    """What makes a deal the same deal from one round to the next: its listing and its kind."""
    return deal["listing_id"], deal["kind"]


class GoneTracker:
    """Adds `gone` and `taken_10m` to each snapshot, from what changed since the snapshot before it.

    It is fed one snapshot per collector round, in time order, from one thread.
    """

    def __init__(self) -> None:
        self._previous: list[dict] | None = None  # last round's deals as served; None before the first round
        self._previous_targets: dict[int, int | None] = {}  # their listings' target prices, by listing id
        self._gone: list[tuple[datetime, dict]] = []  # (when it went, row), newest first
        # (when, listing id) of each card taken, oldest first: one per listing, so a target taken at its countdown and
        # then won at its end, both inside the window, is one card taken, not two
        self._taken: list[tuple[datetime, int]] = []

    def apply(self, snapshot: dict, raw: RawData, now: datetime) -> dict:
        """A new snapshot: `snapshot` plus `gone` (newest first) and `taken_10m`; `snapshot` itself is left as it is."""
        deals = snapshot["deals"]
        listed = {deal["listing_id"] for deal in deals}  # a listing that is a deal is no gone row, whatever its kind
        current = {_identity(deal) for deal in deals}
        listings = {listing.id: listing for listing in raw.listings}

        new_rows: list[tuple[datetime, dict]] = []
        new_taken: list[tuple[datetime, int]] = []
        sales_index = None  # built for the first deal that needs judging again, once a round
        for deal in self._previous or ():
            listing_id = deal["listing_id"]
            if _identity(deal) in current:
                continue
            reason = _reason(deal, listings.get(listing_id), self._previous_targets.get(listing_id), now)
            if reason == "no_longer_a_deal":
                listing = listings[listing_id]  # a listing gone from the data is "ended"
                sales_index = index_sales(raw.sales) if sales_index is None else sales_index
                judged = judge(listing, sales_index.get(listing_key(listing), ()), raw.fmv, now)
                if judged is not None and judged[:2] == (deal["kind"], deal["price"]):
                    continue  # still this very deal: only the list's caps left it out, nothing about it went
            if listing_id not in listed:
                new_rows.append((now, {**deal, "reason": reason, "gone_at": iso_z(now)}))
            if reason in TAKEN_REASONS:
                new_taken.append((now, listing_id))

        keep_after = now - timedelta(seconds=GONE_KEEP_S)
        gone = [
            (went, row)
            for went, row in new_rows + self._gone
            if went > keep_after and row["listing_id"] not in listed
        ]
        count_after = now - timedelta(seconds=TAKEN_WINDOW_S)
        taken = [event for event in self._taken if event[0] > count_after]
        counted = {listing_id for _, listing_id in taken}
        for event in new_taken:
            if event[1] not in counted:
                taken.append(event)
                counted.add(event[1])

        self._previous = [dict(deal) for deal in deals]
        self._previous_targets = {
            deal["listing_id"]: listings[deal["listing_id"]].target_price
            for deal in deals
            if deal["listing_id"] in listings
        }
        self._gone = gone
        self._taken = taken
        return {**snapshot, "gone": [dict(row) for _, row in gone], "taken_10m": len(taken)}
