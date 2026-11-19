"""Helpers for the shapes Real's data comes in: timestamps, signed ratings, value buckets."""

import re
from datetime import datetime, timezone

# A trailing "+00" / "-05" offset (hours only) that follows a clock time, e.g. "...01:33:56.75+00".
_HOURS_ONLY_OFFSET = re.compile(r"(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})$")


def parse_real_time(raw: str) -> datetime:
    """Parse one of Real's timestamp spellings into an aware UTC datetime.

    Accepts a space or "T" separator, microsecond or millisecond fractions, and an
    offset spelled "Z", "+00", "+00:00" or any other hour offset. A time with no
    offset, or text that is not a time at all, raises ValueError.
    """
    text = raw.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    text = _HOURS_ONLY_OFFSET.sub(r"\1\2:00", text)
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp has no UTC offset: {raw!r}")
    return parsed.astimezone(timezone.utc)


def real_rating(value: str | int | float) -> float:
    """A card rating as a non-negative float: Real sends it signed, sometimes as a string."""
    return abs(float(value))


_BUCKET_UPPER_BOUNDS = ((3.0, "1.5-3"), (5.0, "3-5"), (7.0, "5-7"), (9.0, "7-9"))


def bucket_of(rating: float) -> str:
    """The value bucket of a rating: "0-1.5" below 1.5, then (1.5, 3], (3, 5], (5, 7], (7, 9], "9+" above."""
    if rating < 1.5:
        return "0-1.5"
    for upper, label in _BUCKET_UPPER_BOUNDS:
        if rating <= upper:
            return label
    return "9+"
