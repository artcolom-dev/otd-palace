from datetime import timedelta

from advisor.reference import Reference, reference_for
from tests.factories import NOW, five_sales, make_fmv, make_listing, make_sale


def test_five_recent_sales_give_a_high_confidence_median():
    assert reference_for(make_listing(), five_sales(), {}, NOW) == Reference(420, "sales", 5, "high", None)


def test_four_sales_fall_back_to_fmv_with_three_sales():
    ref = reference_for(make_listing(), five_sales()[:4], {100: make_fmv(card_id=100, median=600, tier="player", sale_count=3)}, NOW)
    assert ref == Reference(600, "fmv", 3, "medium", "player")


def test_thin_fmv_gives_no_reference():
    assert reference_for(make_listing(), five_sales()[:4], {100: make_fmv(card_id=100, median=600, sale_count=2)}, NOW) is None


def test_old_sales_and_other_buckets_do_not_count():
    sales = five_sales()[:4] + [make_sale(sold_at=NOW - timedelta(days=8)), make_sale(bucket="5-7")]
    assert reference_for(make_listing(), sales, {}, NOW) is None
