"""Pass rows carrying the feed's five new fields, shaped on the live probe of 2026-11-18 (three passes, real figures).

- Wembanyama NBA 2027 (current season): rate_traded 38.46 from the 5-7 tape; the build cell is common 5-7 at 30.36
  (11 sales); the shelf pays 38 to 53 a point; accepted offers clear near 9 a point, far below listings.
- Gibbs NFL 2024 (past): rate_traded 164.38, carried by 18 Mystic sales at 212 a point; the build cell is legendary
  7+ at 29.17 (7 sales); one Mystic listing on the shelf at 25,000.
- Matthews NHL 2023 (past): rate_traded 19.12 from the 5-7 tape (21.43 on the row served today, from 0-3); the build
  cell is uncommon 5-7 at 20.34 (7 sales); accepted offers clear near 30 a point, ABOVE listings.

Names are the probe's labels only; the ids are made up. `READ_AT` is when the three shelves were read.
"""

import copy

READ_AT = "2026-11-18T23:06:20Z"
EMPTY = {"rate": None, "sales": 0, "span_d": None, "by_rarity": {}}


def bucket(rate, sales, span, by, offers=None) -> dict:
    return {"rate": rate, "sales": sales, "span_d": span, "by_rarity": by, "offers": offers or dict(EMPTY)}


def part(rate, sales, span, by) -> dict:
    return {"rate": rate, "sales": sales, "span_d": span, "by_rarity": by}


def rates(**filled) -> dict:
    """The four buckets, the ones not given empty ("5-7" is spelled b57, and so on)."""
    names = {"b03": "0-3", "b35": "3-5", "b57": "5-7", "b7": "7+"}
    out = {b: bucket(None, 0, None, {}) for b in ("0-3", "3-5", "5-7", "7+")}
    for short, value in filled.items():
        out[names[short]] = value
    return out


WEMBY_EXTRA = {
    "rate_bucket": "5-7",
    "rates_by_bucket": rates(
        b35=bucket(40.54, 50, 0.1, {"common": [37.8, 32], "uncommon": [44.42, 10], "rare": [44.23, 8]},
                   part(9.38, 50, 1.0, {"common": [9.52, 31], "uncommon": [8.7, 10], "rare": [8.51, 6],
                                        "epic": [8.0, 1], "legendary": [18.18, 2]})),
        b57=bucket(38.46, 50, 0.1, {"common": [30.36, 11], "uncommon": [36.84, 24], "rare": [42.31, 7],
                                    "epic": [41.18, 5], "legendary": [52.24, 3]},
                   part(9.18, 50, 1.0, {"common": [8.93, 23], "uncommon": [8.96, 13], "rare": [9.19, 6],
                                        "epic": [28.98, 4], "legendary": [12.31, 4]})),
    ),
    "rate_build": 30.36,
    "rate_build_from": {"bucket": "5-7", "rarity": "common", "sales": 11},
    "shelf_auctions": {"read_at": READ_AT, "listings": [
        [2.9, 110, 110, 160, 1, 870, False, "common"],
        [5.2, 200, 200, 280, 1, 3582, False, "common"],
        [3.7, 150, 150, 190, 0, 3720, False, "common"],
        [3.7, 150, 150, 190, 0, 4530, False, "rare"],
        [5.6, 230, 230, 310, 0, 5880, False, "common"],
        [2.3, 110, 110, 110, 0, 6960, False, "common"],
        [5.3, 270, 270, 270, 0, 2862, False, "common"],
        [5.7, 300, 300, 300, 0, 0, False, "common"],
        [3.8, 200, 200, 200, 0, 3330, False, "common"],
        [8.3, 500, 500, 500, 0, 5478, False, "legendary"],
    ]},
}

GIBBS_EXTRA = {
    "rate_bucket": "7+",
    "rates_by_bucket": rates(
        b7=bucket(164.38, 30, 90.0, {"common": [27.89, 2], "uncommon": [15.58, 1], "rare": [32.44, 2],
                                     "legendary": [29.17, 7], "mystic": [212.33, 18]},
                  part(36.24, 50, 42.5, {"common": [41.1, 8], "uncommon": [42.3, 4], "rare": [40.97, 4],
                                         "legendary": [32.47, 31], "mystic": [136.99, 3]})),
    ),
    "rate_build": 29.17,
    "rate_build_from": {"bucket": "7+", "rarity": "legendary", "sales": 7},
    "shelf_auctions": {"read_at": READ_AT, "listings": [[7.3, 25000, 25000, 25000, 0, 125406, False, "mystic"]]},
}

MATTHEWS_EXTRA = {
    "rate_bucket": "5-7",
    "rates_by_bucket": rates(
        b57=bucket(19.12, 15, 75.9, {"common": [15.56, 2], "uncommon": [20.34, 7], "rare": [19.04, 4],
                                     "legendary": [19.12, 2]},
                   part(29.49, 50, 21.3, {"common": [39.22, 6], "uncommon": [30.54, 16], "rare": [26.43, 16],
                                          "epic": [28.08, 6], "legendary": [28.99, 6]})),
    ),
    "rate_build": 20.34,
    "rate_build_from": {"bucket": "5-7", "rarity": "uncommon", "sales": 7},
    "shelf_auctions": {"read_at": READ_AT, "listings": [
        [3.2, 130, 130, 130, 0, 21156, False, "uncommon"],
        [1.7, 70, 70, 70, 0, 21156, False, "rare"],
        [5.1, 210, 210, 210, 0, 21156, False, "common"],
    ]},
}

# Measured by bucket and rarity, but no cell has 5 listing sales: the build rate is null.
THIN_EXTRA = {
    "rate_bucket": "3-5",
    "rates_by_bucket": rates(b35=bucket(22.0, 6, 30.0, {"common": [18.0, 3], "rare": [40.0, 3]})),
    "rate_build": None,
    "rate_build_from": None,
    "shelf_auctions": None,
}


def extra(name: str) -> dict:
    """A fresh copy of one scene's five fields."""
    return copy.deepcopy({"wemby": WEMBY_EXTRA, "gibbs": GIBBS_EXTRA, "matthews": MATTHEWS_EXTRA,
                          "thin": THIN_EXTRA}[name])
