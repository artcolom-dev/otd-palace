from dataclasses import replace
from datetime import timedelta

from advisor.deals import find_deals
from advisor.links import listing_url
from advisor.rules import DEAL_LINK
from tests.factories import NOW, five_sales, make_fmv, make_listing, make_raw, make_sale


def test_target_deal_numbers():
    [d] = find_deals(make_raw(listings=[make_listing(target_price=300)], sales=five_sales()), NOW)
    # floor(420 x 0.9) = 378, minus the 10 rax listing fee, minus the 300 paid.
    assert (d.kind, d.price, d.reference, d.gap, d.flip_margin, d.discount) == ("target", 300, 420, 120, 68, 0.286)
    assert (d.url, d.ref_source, d.ref_tier, d.bucket) == (listing_url(1), "sales", None, "3-5")


def test_every_deal_links_to_its_auction():
    # The owner asked that every deal open the auction itself (Real link kind 30), not the card page.
    assert DEAL_LINK == "listing"
    listings = [make_listing(id=7, card_id=100, target_price=300), make_listing(id=8, card_id=100, min_bid=300)]
    deals = find_deals(make_raw(listings=listings, sales=five_sales()), NOW)
    assert {(d.kind, d.url) for d in deals} == {("target", listing_url(7)), ("bid", listing_url(8))}


def test_target_just_under_threshold_is_not_a_deal():
    # Ends in five hours so the bid path cannot fire: this isolates the target threshold.
    listing = make_listing(target_price=340, ends_at=NOW + timedelta(hours=5))
    assert find_deals(make_raw(listings=[listing], sales=five_sales()), NOW) == []


def test_medium_confidence_needs_thirty_percent():
    # Ends in five hours so the bid path cannot fire: this isolates the target threshold.
    later = NOW + timedelta(hours=5)
    fmv = {100: make_fmv(card_id=100, median=600, sale_count=3)}
    assert find_deals(make_raw(listings=[make_listing(target_price=430, ends_at=later)], fmv=fmv), NOW) == []
    assert find_deals(make_raw(listings=[make_listing(target_price=410, ends_at=later)], fmv=fmv), NOW)[0].confidence == "medium"


def test_bid_deal_only_when_ending_within_two_hours():
    soon = make_listing(id=1, current_bid=200, ends_at=NOW + timedelta(minutes=90))
    late = make_listing(id=2, current_bid=200, ends_at=NOW + timedelta(hours=3))
    deals = find_deals(make_raw(listings=[soon, late], sales=five_sales()), NOW)
    assert [(d.listing_id, d.kind, d.price) for d in deals] == [(1, "bid", 200)]


def test_ended_listing_is_never_a_deal():
    assert find_deals(make_raw(listings=[make_listing(target_price=100, ends_at=NOW)], sales=five_sales()), NOW) == []


def test_biggest_margin_after_fees_first_even_when_its_discount_is_smaller():
    # Two markets: a 2,700 rax star card 700 under (25.9 %) and a 420 rax card 270 under (64.3 %). Resold at the usual
    # price, the star leaves 2,430 - 10 - 2,000 = 420 after fees, the cheap card 378 - 10 - 150 = 218: the star first.
    star = make_listing(id=1, rating=6.4, target_price=2000)
    cheap = make_listing(id=2, rating=4.2, target_price=150)
    sales = five_sales((2600, 2650, 2700, 2750, 2800), bucket="5-7") + five_sales()
    deals = find_deals(make_raw(listings=[star, cheap], sales=sales), NOW)
    assert [(d.listing_id, d.discount, d.flip_margin) for d in deals] == [(1, 0.259, 420), (2, 0.643, 218)]


def test_a_deal_that_loses_after_fees_is_still_a_deal_listed_after_the_others():
    # A 40 rax card at 28 (30 % under) leaves 36 - 10 - 28 = -2 after fees. Someone may want the card, so it stays a
    # deal, but after one that leaves a profit though it is less under (a 420 rax card at 300, 28.6 %: +68).
    small = make_listing(id=1, card_id=7, player_id=12, rating=2.0, target_price=28)
    sales = five_sales((38, 40, 40, 40, 42), card_id=7, player_id=12, bucket="1.5-3") + five_sales()
    deals = find_deals(make_raw(listings=[small, make_listing(id=2, target_price=300)], sales=sales), NOW)
    assert [(d.listing_id, d.discount, d.flip_margin) for d in deals] == [(2, 0.286, 68), (1, 0.3, -2)]


def test_unbid_auction_ending_soon_is_a_bid_deal_at_its_minimum_bid():
    [d] = find_deals(make_raw(listings=[make_listing(min_bid=100)], sales=five_sales()), NOW)
    assert (d.kind, d.price, d.num_bids) == ("bid", 100, 0)


def test_free_listing_is_never_a_deal():
    listing = make_listing(min_bid=0, target_price=0, ends_at=NOW + timedelta(hours=5))
    assert find_deals(make_raw(listings=[listing], sales=five_sales()), NOW) == []


def test_deals_are_cut_at_the_maximum(monkeypatch):
    monkeypatch.setattr("advisor.deals.MAX_DEALS", 2)
    listings = [make_listing(id=i, target_price=100 + i) for i in range(5)]
    deals = find_deals(make_raw(listings=listings, sales=five_sales()), NOW)
    assert [d.listing_id for d in deals] == [0, 1]


def test_minted_by_real_listing_is_never_a_deal():
    # Real lists its fresh mints at a fixed 10 rax: far under the reference, but not a seller's mistake.
    minted = make_listing(target_price=10, min_bid=10, minted_by_real=True)
    assert find_deals(make_raw(listings=[minted], sales=five_sales()), NOW) == []
    assert find_deals(make_raw(listings=[replace(minted, minted_by_real=False)], sales=five_sales()), NOW) != []


def star_sales(prices=(2600, 2650, 2700, 2750, 2800)):
    """Five sales of a 5-7 bucket card with a median of 2,700."""
    return five_sales(prices, bucket="5-7")


def test_flip_margin_counts_listing_fee():
    # floor(2,700 x 0.9) = 2,430, minus the 10 rax listing fee, minus the 1,850 paid.
    listing = make_listing(rating=6.4, target_price=1850)
    [d] = find_deals(make_raw(listings=[listing], sales=star_sales()), NOW)
    assert (d.reference, d.price, d.flip_margin) == (2700, 1850, 570)


def test_flip_margin_is_a_number_even_under_200():
    # Under a 200 rax reference the fees eat most of any resale; the margin is still given, honestly thin.
    [d] = find_deals(make_raw(listings=[make_listing(target_price=100)], sales=five_sales((140, 145, 150, 155, 160))), NOW)
    assert (d.reference, d.flip_margin) == (150, 25)  # floor(150 x 0.9) - 10 - 100
    [d] = find_deals(make_raw(listings=[make_listing(target_price=10)], sales=five_sales((14, 15, 15, 15, 16))), NOW)
    assert (d.reference, d.flip_margin) == (15, -7)  # floor(13.5) - 10 - 10: a loss, and said so
    [d] = find_deals(make_raw(listings=[make_listing(target_price=100)], sales=five_sales((190, 195, 200, 205, 210))), NOW)
    assert (d.reference, d.flip_margin) == (200, 70)  # floor(200 x 0.9) - 10 - 100


def test_a_target_price_already_bid_is_not_a_target_deal():
    # Someone bid the target: the 10-minute countdown has started, and the target price is not on offer any more.
    taken = make_listing(target_price=300, current_bid=300, num_bids=1, ends_at=NOW + timedelta(hours=5))
    assert find_deals(make_raw(listings=[taken], sales=five_sales()), NOW) == []
    above = replace(taken, current_bid=310)
    assert find_deals(make_raw(listings=[above], sales=five_sales()), NOW) == []
    # A bid under the target leaves the target price on offer.
    under = replace(taken, current_bid=280)
    [d] = find_deals(make_raw(listings=[under], sales=five_sales()), NOW)
    assert (d.kind, d.price) == ("target", 300)


def test_a_target_price_already_bid_can_still_be_a_bid_deal_in_the_countdown():
    # 8 minutes left and the bid to beat (300) still 28.6 % under the reference of 420: a bid deal.
    taken = make_listing(target_price=300, current_bid=300, num_bids=1, ends_at=NOW + timedelta(minutes=8))
    [d] = find_deals(make_raw(listings=[taken], sales=five_sales()), NOW)
    assert (d.kind, d.price, d.discount) == ("bid", 300, 0.286)


def test_per_point_and_ref_per_point():
    listing = make_listing(rating=6.4, target_price=1850)
    [d] = find_deals(make_raw(listings=[listing], sales=star_sales()), NOW)
    assert (d.per_point, d.ref_per_point) == (289.1, 421.9)  # 289.0625 and 421.875, rounded half up


def test_per_point_is_none_for_an_unrated_card():
    [d] = find_deals(make_raw(listings=[make_listing(rating=0.0, target_price=300)], sales=five_sales(bucket="0-1.5")), NOW)
    assert (d.per_point, d.ref_per_point) == (None, None)


def test_a_deal_carries_when_it_was_listed():
    listed = make_listing(id=1, target_price=300, created_at=NOW - timedelta(minutes=7))
    unknown = make_listing(id=2, target_price=300, created_at=None)
    deals = find_deals(make_raw(listings=[listed, unknown], sales=five_sales()), NOW)
    assert [(d.listing_id, d.listed_at) for d in deals] == [(1, NOW - timedelta(minutes=7)), (2, None)]


def test_deals_sorted_by_margin_then_discount_then_newest(monkeypatch):
    monkeypatch.setattr("advisor.deals.MAX_DEALS_PER_PLAYER", 1000)  # one test player owns every listing here
    later = NOW + timedelta(hours=5)
    hour_ago = NOW - timedelta(hours=1)
    listings = [
        make_listing(id=6, target_price=300, created_at=hour_ago, ends_at=NOW + timedelta(hours=4)),
        make_listing(id=3, target_price=300, created_at=None, ends_at=NOW + timedelta(hours=1)),  # unknown age: last
        make_listing(id=1, target_price=300, created_at=hour_ago, ends_at=later),
        make_listing(id=5, target_price=300, created_at=hour_ago, ends_at=NOW + timedelta(hours=4)),
        make_listing(id=4, target_price=300, created_at=NOW - timedelta(minutes=10), ends_at=later),  # newest
        make_listing(id=2, target_price=210, created_at=NOW - timedelta(hours=3), ends_at=later),  # biggest discount
    ]
    deals = find_deals(make_raw(listings=listings, sales=five_sales()), NOW)
    # 2 leaves the most after fees (and is the biggest discount); then the newest; then the soonest to end; then the lower
    # listing id; unknown age last.
    assert [d.listing_id for d in deals] == [2, 4, 5, 6, 1, 3]


def test_falling_flag_from_falling_markets():
    # Player 10 sold at 500 last week and at 380 today (-24 %); player 11 holds steady.
    falling = (
        [make_sale(price=500, sold_at=NOW - timedelta(days=3)) for _ in range(5)]
        + [make_sale(price=380, sold_at=NOW - timedelta(hours=2)) for _ in range(5)]
    )
    steady = five_sales(player_id=11)
    listings = [make_listing(id=1, target_price=300), make_listing(id=2, player_id=11, target_price=300)]
    deals = find_deals(make_raw(listings=listings, sales=falling + steady), NOW)
    assert {d.listing_id: d.falling for d in deals} == {1: True, 2: False}


def test_the_falling_flag_is_whatever_falling_markets_says(monkeypatch):
    calls = []

    def fake(sales, now):
        calls.append((tuple(sales), now))
        return frozenset({("nba", 2026, 10, "3-5")})

    monkeypatch.setattr("advisor.deals.falling_markets", fake)
    listings = [make_listing(id=1, target_price=300), make_listing(id=2, season=2025, target_price=300)]
    sales = five_sales() + five_sales(season=2025)
    deals = find_deals(make_raw(listings=listings, sales=sales), NOW)
    assert {d.listing_id: d.falling for d in deals} == {1: True, 2: False}
    assert calls == [(tuple(sales), NOW)]


def test_a_sales_priced_deal_says_what_reals_own_estimate_says_when_it_is_far_off():
    listing = make_listing(target_price=300)
    far = find_deals(make_raw(listings=[listing], sales=five_sales(), fmv={100: make_fmv(median=560, sale_count=9)}), NOW)
    assert far[0].ref_source == "sales" and far[0].real_estimate == 560  # usual 420, Real says 560: a third off
    near = find_deals(make_raw(listings=[listing], sales=five_sales(), fmv={100: make_fmv(median=440, sale_count=9)}), NOW)
    assert near[0].real_estimate is None  # within REAL_ESTIMATE_GAP of the sales: nothing worth saying
    none = find_deals(make_raw(listings=[listing], sales=five_sales()), NOW)
    assert none[0].real_estimate is None


def test_a_bid_deal_read_long_ago_is_not_shown_a_target_deal_is_kept_with_its_age():
    """A bid on an auction about to end moves by the minute: a price last read over BID_READ_MAX_AGE_S ago is a guess."""
    from advisor.rules import BID_READ_MAX_AGE_S

    soon = NOW + timedelta(minutes=3)
    fresh = make_listing(id=1, target_price=None, min_bid=100, ends_at=soon, seen_at=NOW - timedelta(seconds=BID_READ_MAX_AGE_S - 5))
    old = make_listing(id=2, target_price=None, min_bid=100, ends_at=soon, seen_at=NOW - timedelta(seconds=BID_READ_MAX_AGE_S + 5))
    unknown = make_listing(id=3, target_price=None, min_bid=100, ends_at=soon, seen_at=None)  # read at the snapshot's moment
    target_old = make_listing(id=4, target_price=300, seen_at=NOW - timedelta(minutes=40))
    deals = find_deals(make_raw(listings=[fresh, old, unknown, target_old], sales=five_sales()), NOW)
    assert sorted(d.listing_id for d in deals) == [1, 3, 4]


def test_one_player_cannot_fill_the_list_only_his_best_deals_count():
    from advisor.rules import MAX_DEALS_PER_PLAYER

    listings = [make_listing(id=i, card_id=100 + i, player_id=10, target_price=100 + 10 * i) for i in range(MAX_DEALS_PER_PLAYER + 3)]
    other = make_listing(id=99, card_id=500, player_id=11, target_price=300)
    sales = [make_sale(card_id=100 + i, player_id=10, price=p) for i in range(MAX_DEALS_PER_PLAYER + 3) for p in (400, 420, 500, 380, 450)]
    sales += [make_sale(card_id=500, player_id=11, price=p) for p in (400, 420, 500, 380, 450)]
    deals = find_deals(make_raw(listings=listings + [other], sales=sales), NOW)
    mine = [d for d in deals if d.player_id == 10]
    assert len(mine) == MAX_DEALS_PER_PLAYER
    assert sorted(d.listing_id for d in mine) == [0, 1, 2][:MAX_DEALS_PER_PLAYER]  # the cheapest asks: the biggest margins
    assert [d.listing_id for d in deals if d.player_id == 11] == [99]


def test_a_deal_carries_its_latest_sales_as_evidence_newest_first():
    from advisor.rules import RECENT_SALES_SHOWN

    sales = [make_sale(price=400 + i, sold_at=NOW - timedelta(hours=i + 1)) for i in range(8)]
    [deal] = find_deals(make_raw(listings=[make_listing(target_price=300)], sales=sales), NOW)
    assert deal.recent_sales == tuple((400 + i, (i + 1) * 3600) for i in range(RECENT_SALES_SHOWN))
    fmv_only = find_deals(make_raw(listings=[make_listing(target_price=200)], fmv={100: make_fmv(median=400, sale_count=9)}), NOW)
    assert fmv_only[0].recent_sales == ()  # priced on Real's estimate: no sales of ours to show


def test_a_target_deal_read_hours_ago_is_not_shown():
    """A cheap target price goes fast: past TARGET_READ_MAX_AGE_S since its last read, it is likely taken."""
    from advisor.rules import TARGET_READ_MAX_AGE_S

    recent = make_listing(id=1, target_price=300, seen_at=NOW - timedelta(seconds=TARGET_READ_MAX_AGE_S - 60))
    stale = make_listing(id=2, target_price=300, seen_at=NOW - timedelta(seconds=TARGET_READ_MAX_AGE_S + 60))
    deals = find_deals(make_raw(listings=[recent, stale], sales=five_sales()), NOW)
    assert [d.listing_id for d in deals] == [1]
