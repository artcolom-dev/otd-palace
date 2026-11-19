"""Universal links into Real's web app.

A card or a marketplace listing is addressed by a short path under the Real site:
the path is a Hashids encoding (salt "routing", minimum length 11) of four numbers,
(kind, 0, 0, id). The kind says what the id refers to: 20 for a card, 30 for a listing.
"""

from hashids import Hashids

REAL_HOME = "https://www.realapp.com/"  # Real's own home page: where sample data links, since its listings are invented
_BASE = REAL_HOME
_CARD = 20
_LISTING = 30
_routes = Hashids(salt="routing", min_length=11)


def _link(kind: int, item_id: int) -> str:
    return _BASE + _routes.encode(kind, 0, 0, item_id)


def card_url(card_id: int) -> str:
    """The Real link for a card."""
    return _link(_CARD, card_id)


def listing_url(listing_id: int) -> str:
    """The Real link for a marketplace listing."""
    return _link(_LISTING, listing_id)
