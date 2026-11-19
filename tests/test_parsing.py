from datetime import datetime, timedelta, timezone

import pytest

from advisor.parsing import bucket_of, parse_real_time, real_rating

EXPECTED = datetime(2026, 7, 16, 1, 33, 56, 753521, tzinfo=timezone.utc)


@pytest.mark.parametrize("raw", [
    "2026-07-16 01:33:56.753521+00",
    "2026-07-16T01:33:56.753521Z",
    "2026-07-16T01:33:56.753521+00:00",
])
def test_real_time_spellings_agree(raw):
    assert parse_real_time(raw) == EXPECTED


def test_cursor_millisecond_form():
    assert parse_real_time("2026-07-16T01:33:56.753Z") == datetime(2026, 7, 16, 1, 33, 56, 753000, tzinfo=timezone.utc)


def test_offset_is_converted_to_utc():
    t = parse_real_time("2026-07-16T03:33:56+02:00")
    assert t == datetime(2026, 7, 16, 1, 33, 56, tzinfo=timezone.utc) and t.utcoffset() == timedelta(0)


@pytest.mark.parametrize("raw", ["2026-07-16 01:33:56", "", "soon"])
def test_naive_or_garbage_is_refused(raw):
    with pytest.raises(ValueError):
        parse_real_time(raw)


@pytest.mark.parametrize("value,expected", [("-6.4", 6.4), (-2, 2.0), ("12", 12.0), (4.2, 4.2)])
def test_real_rating_is_absolute(value, expected):
    assert real_rating(value) == expected


@pytest.mark.parametrize("rating,bucket", [(1.4, "0-1.5"), (1.5, "1.5-3"), (3.0, "1.5-3"), (3.1, "3-5"),
    (5.0, "3-5"), (7.0, "5-7"), (9.0, "7-9"), (9.1, "9+"), (16.8, "9+")])
def test_value_buckets(rating, bucket):
    assert bucket_of(rating) == bucket
