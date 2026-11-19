"""The feed's five optional pass fields (advisor/pass_rates.py): read strictly, a misfit left out alone; the build
rate; the shelf's auctions at a moment; the accepted-offer cells served to the browser."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from advisor.pass_rates import (
    EXTRA_FIELDS,
    bucket_of,
    cell_rate,
    clean_extra,
    live_auctions,
    market_build_rate,
    offer_cells,
    served_build_rate,
)
from tests.factories import make_pass
from tests.pass_scenes import READ_AT, extra

READ = datetime.fromisoformat(READ_AT.replace("Z", "+00:00"))


def row(name: str = "wemby", **over) -> dict:
    return {"rate_traded": 38.46, **extra(name), **over}


# --- reading -----------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["wemby", "gibbs", "matthews", "thin"])
def test_the_probed_rows_read_whole(name):
    fields, dropped = clean_extra(row(name))
    assert dropped == []
    assert set(fields) == set(EXTRA_FIELDS)
    want = extra(name)
    if want["shelf_auctions"] is not None:  # ratings come back as floats, the rest as sent
        for listing in want["shelf_auctions"]["listings"]:
            listing[0] = float(listing[0])
    assert fields == want


def test_a_row_without_the_fields_reads_nothing_and_drops_nothing():
    assert clean_extra({"rate_traded": 10.0, "shelf": []}) == ({}, [])


def test_all_five_null_read_as_null():
    fields, dropped = clean_extra({"rate_traded": None, **{name: None for name in EXTRA_FIELDS}})
    assert dropped == [] and fields == {name: None for name in EXTRA_FIELDS}


def _broken(name: str, change) -> tuple[dict, list[str]]:
    r = row()
    change(r)
    return clean_extra(r)


BREAKS = {
    "rate_bucket": [
        lambda r: r.update(rate_bucket="9+"),
        lambda r: r.update(rate_bucket=5),
        lambda r: r.update(rate_traded=None),  # a bucket for a rate that is not there
    ],
    "rates_by_bucket": [
        lambda r: r.update(rates_by_bucket=[]),
        lambda r: r["rates_by_bucket"].pop("0-3"),
        lambda r: r["rates_by_bucket"].update({"9+": r["rates_by_bucket"]["0-3"]}),
        lambda r: r["rates_by_bucket"]["3-5"].update(rate="40"),
        lambda r: r["rates_by_bucket"]["3-5"].update(rate=float("nan")),
        lambda r: r["rates_by_bucket"]["3-5"].update(rate=0),
        lambda r: r["rates_by_bucket"]["3-5"].update(rate=100_000_001),
        lambda r: r["rates_by_bucket"]["3-5"].update(sales=True),
        lambda r: r["rates_by_bucket"]["3-5"].update(sales=-1),
        lambda r: r["rates_by_bucket"]["3-5"].update(sales=49.0),
        lambda r: r["rates_by_bucket"]["3-5"].update(span_d=None),
        lambda r: r["rates_by_bucket"]["3-5"].update(span_d=-0.1),
        lambda r: r["rates_by_bucket"]["3-5"].update(extra=1),
        lambda r: r["rates_by_bucket"]["3-5"]["by_rarity"].update(golden=[30.0, 5]),
        lambda r: r["rates_by_bucket"]["3-5"]["by_rarity"].update(common=[37.8]),
        lambda r: r["rates_by_bucket"]["3-5"]["by_rarity"].update(common=[37.8, 0]),
        lambda r: r["rates_by_bucket"]["3-5"]["by_rarity"].update(common=[37.8, 45]),  # rarities over the whole
        lambda r: r["rates_by_bucket"]["0-3"].update(rate=12.0),  # a rate with no sale
        lambda r: r["rates_by_bucket"]["0-3"]["offers"].update(span_d=1.0),
        lambda r: r["rates_by_bucket"]["3-5"]["offers"].pop("by_rarity"),
        lambda r: r["rates_by_bucket"]["3-5"]["offers"].update(offers={}),
    ],
    "shelf_auctions": [
        lambda r: r.update(shelf_auctions=[]),
        lambda r: r["shelf_auctions"].update(read_at="2026-11-18 23:06:20"),
        lambda r: r["shelf_auctions"].update(read_at="2026-11-18T23:06:20.5Z"),
        lambda r: r["shelf_auctions"].update(read_at="2026-13-18T23:06:20Z"),
        lambda r: r["shelf_auctions"].update(extra=1),
        lambda r: r["shelf_auctions"]["listings"].append([2.0, 100, 100, 100, 0, 60, False, "common"]),  # 11
        lambda r: r["shelf_auctions"]["listings"][0].pop(),
        lambda r: r["shelf_auctions"]["listings"][0].__setitem__(0, 0),
        lambda r: r["shelf_auctions"]["listings"][0].__setitem__(1, 110.5),
        lambda r: r["shelf_auctions"]["listings"][0].__setitem__(1, 0),
        lambda r: r["shelf_auctions"]["listings"][0].__setitem__(2, "110"),
        lambda r: r["shelf_auctions"]["listings"][0].__setitem__(4, -1),
        lambda r: r["shelf_auctions"]["listings"][0].__setitem__(5, -5),
        lambda r: r["shelf_auctions"]["listings"][0].__setitem__(6, 0),
        lambda r: r["shelf_auctions"]["listings"][0].__setitem__(7, "golden"),
    ],
}


@pytest.mark.parametrize(("field", "change"), [(f, c) for f, cs in BREAKS.items() for c in cs])
def test_a_field_that_does_not_fit_is_left_out_alone(field, change):
    fields, dropped = _broken(field, change)
    assert field in dropped
    assert field not in fields
    others = set(EXTRA_FIELDS) - {field} - set(dropped)
    assert others <= set(fields)
    if field != "rates_by_bucket":  # the build cell is checked against the rates; a misfit there leaves it unchecked
        assert fields["rate_build"] == 30.36


@pytest.mark.parametrize("change", [
    lambda r: r.update(rate_build="30.36"),
    lambda r: r.update(rate_build=-1),
    lambda r: r.update(rate_build=None),  # half a pair
    lambda r: r.update(rate_build_from=None),
    lambda r: r["rate_build_from"].update(sales=4),  # under the feed's own bar
    lambda r: r["rate_build_from"].update(bucket="9+"),
    lambda r: r["rate_build_from"].update(rarity="Common"),
    lambda r: r["rate_build_from"].update(extra=1),
    lambda r: r.update(rate_build=30.0),  # not the cell the rates hold
])
def test_the_build_rate_and_its_cell_stand_or_fall_together(change):
    fields, dropped = _broken("rate_build", change)
    assert {"rate_build", "rate_build_from"} <= set(dropped)
    assert "rate_build" not in fields and "rate_build_from" not in fields
    assert fields["rates_by_bucket"] is not None and fields["shelf_auctions"] is not None


def test_a_build_cell_is_checked_against_the_rates_only_when_they_came():
    r = row()
    r["rates_by_bucket"] = "broken"
    fields, dropped = clean_extra(r)
    assert dropped == ["rates_by_bucket"] and fields["rate_build"] == 30.36


def test_past_the_size_cap_the_shelf_goes_first_then_the_rates():
    r = row()
    r["shelf_auctions"]["listings"] = [[9.99, 99_999_999, 99_999_999, 99_999_999, 999_999, 99_999_999, False, "legendary"]] * 10
    size = len(json.dumps({k: r[k] for k in EXTRA_FIELDS}, separators=(",", ":")))
    assert size > 1500
    fields, dropped = clean_extra(r)
    assert dropped == ["shelf_auctions"] and fields["rates_by_bucket"] is not None and fields["rate_build"] == 30.36


def test_the_probed_rows_fit_under_the_cap():
    for name in ("wemby", "gibbs", "matthews"):
        assert len(json.dumps(extra(name), separators=(",", ":"))) <= 1500


# --- the build rate ------------------------------------------------------------------------------------------------

def _market(name: str, **over):
    fields, _ = clean_extra({"rate_traded": over.get("rate_traded", 38.46), **extra(name)})
    return make_pass(**{**fields, **over})


def test_the_build_rate_is_the_feeds_cell_when_there_is_one():
    rate = market_build_rate(_market("wemby", rate_traded=38.46))
    assert (rate.rate, rate.thin, rate.bucket, rate.rarity, rate.sales) == (30.36, False, "5-7", "common", 11)
    assert market_build_rate(_market("gibbs", rate_traded=164.38)).rate == 29.17


def test_without_a_cell_the_traded_rate_stands_in_flagged_thin():
    rate = market_build_rate(_market("thin", rate_traded=22.0, rate_sales=6))
    assert (rate.rate, rate.thin, rate.bucket, rate.rarity, rate.sales) == (22.0, True, "3-5", None, 6)


def test_a_row_without_the_fields_is_priced_as_before_and_never_thin():
    rate = market_build_rate(make_pass(rate_traded=10.0, rate_sales=20))
    assert (rate.rate, rate.thin, rate.sales) == (10.0, False, 20)
    assert market_build_rate(make_pass(rate_traded=None)).rate is None


def test_the_served_build_rate_reads_the_same():
    assert served_build_rate({"rate_traded": 38.46, "rate_sales": 100}).thin is False
    assert served_build_rate({"rate_traded": 38.46, "rate_sales": 100, "rate_build": None}).thin is True
    got = served_build_rate({"rate_traded": 38.46, "rate_sales": 100, "rate_build": 30.36,
                             "rate_build_from": {"bucket": "5-7", "rarity": "common", "sales": 11}})
    assert (got.rate, got.thin, got.sales) == (30.36, False, 11)


# --- the shelf's auctions ------------------------------------------------------------------------------------------

def test_buckets_follow_the_feed():
    assert [bucket_of(r) for r in (0.5, 3.0, 3.01, 5.0, 7.0, 7.1, 9.5, -5.5)] == ["0-3", "0-3", "3-5", "3-5", "5-7", "7+", "7+", "5-7"]
    assert bucket_of(0) is None


def test_a_listing_is_judged_against_its_own_cell():
    rates = extra("wemby")["rates_by_bucket"]
    assert cell_rate(rates, "5-7", "common") == 30.36
    assert cell_rate(rates, "5-7", "legendary") == 38.46  # 3 sales: the bucket's
    assert cell_rate(rates, "0-3", "common") is None


def test_fresh_and_ending_soon_the_shelf_pays_its_pay_and_an_auction_over_is_dropped():
    market = _market("wemby")
    got = live_auctions(market, READ + timedelta(minutes=10))
    assert len(got) == 9  # the 5.7 had ended when the page was read
    assert all(firm for _r, _p, firm in got)
    assert got[0] == (2.9, 110, True)
    assert [pay for _r, pay, _f in got] == [110, 200, 150, 150, 230, 110, 270, 200, 500]


def test_far_from_its_end_or_read_long_ago_a_pay_is_only_an_opening():
    market = _market("wemby")
    later = live_auctions(market, READ + timedelta(hours=1))  # five have ended by then
    assert later == ((3.7, 150, True), (3.7, 150, True), (5.6, 230, True), (2.3, 110, True), (8.3, 500, True))
    fields = extra("wemby")
    fields["shelf_auctions"]["listings"] = [[5.2, 200, 200, 280, 1, 3 * 3600 + 1800, False, "common"]]
    ending = make_pass(rate_traded=38.46, **clean_extra({"rate_traded": 38.46, **fields})[0])
    assert live_auctions(ending, READ + timedelta(hours=3)) == ((5.2, 200, True),)  # 30 min left, read 3 h ago
    assert live_auctions(ending, READ + timedelta(hours=3, seconds=1)) == ((5.2, 200, False),)  # read too long ago
    matthews = live_auctions(_market("matthews", rate_traded=19.12), READ + timedelta(minutes=5))  # 6 h left
    assert matthews == ((3.2, 130, False), (1.7, 70, False), (5.1, 210, False))


def test_an_ended_auction_is_dropped_and_the_rest_keep_their_order():
    market = _market("wemby")
    got = live_auctions(market, READ + timedelta(seconds=871))
    assert 2.9 not in [r for r, _p, _f in got]


def test_a_house_listing_or_one_far_under_its_cell_is_an_opening():
    fields = extra("wemby")
    fields["shelf_auctions"]["listings"] = [
        [5.2, 200, 200, 280, 1, 3582, True, "common"],   # house
        [5.2, 60, 60, 280, 0, 3582, False, "common"],    # 11.5 a point against 30.36: a floor opening
        [5.2, 80, 80, 280, 0, 3582, False, "common"],    # 15.4: just over half
    ]
    market = make_pass(rate_traded=38.46, **clean_extra({"rate_traded": 38.46, **fields})[0])
    assert live_auctions(market, READ) == ((5.2, 200, False), (5.2, 60, False), (5.2, 80, True))


def test_an_unknown_end_is_an_opening_and_no_reading_is_none():
    fields = extra("wemby")
    fields["shelf_auctions"]["listings"] = [[5.2, 200, 200, 280, 1, None, False, "common"]]
    market = make_pass(rate_traded=38.46, **clean_extra({"rate_traded": 38.46, **fields})[0])
    assert live_auctions(market, READ) == ((5.2, 200, False),)
    assert live_auctions(make_pass(), READ) is None


# --- offers --------------------------------------------------------------------------------------------------------

def test_offer_cells_hold_what_rests_on_five_offers_with_the_same_cells_listing_rate():
    assert offer_cells(extra("wemby")["rates_by_bucket"]) == [
        ["3-5", None, 9.38, 50, 40.54], ["3-5", "common", 9.52, 31, 37.8], ["3-5", "uncommon", 8.7, 10, 44.42],
        ["3-5", "rare", 8.51, 6, 44.23],
        ["5-7", None, 9.18, 50, 38.46], ["5-7", "common", 8.93, 23, 30.36], ["5-7", "uncommon", 8.96, 13, 36.84],
        ["5-7", "rare", 9.19, 6, 42.31],
    ]
    assert offer_cells(extra("matthews")["rates_by_bucket"])[2] == ["5-7", "uncommon", 30.54, 16, 20.34]
    assert offer_cells(None) is None
    assert offer_cells(extra("thin")["rates_by_bucket"]) == []
