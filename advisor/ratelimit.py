"""Token buckets per key (an address), in memory only: nothing about who asked is ever written anywhere."""

import threading
import time
from collections import OrderedDict
from collections.abc import Callable


class TokenBuckets:
    """Each key may take `capacity` tokens at once, refilled at `per_s` tokens a second up to `capacity`.

    The table holds at most `max_keys` keys; a new key pushes out the one least recently seen. Safe to use from
    several threads at once. `clock` returns seconds on any monotonic scale.
    """

    def __init__(self, capacity: int, per_s: float, max_keys: int, clock: Callable[[], float] = time.monotonic):
        self._capacity = float(capacity)
        self._per_s = per_s
        self._max_keys = max_keys
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()  # key -> (tokens, as of)

    def take(self, key: str, cost: int = 1) -> bool:
        """Takes `cost` tokens from `key`'s bucket: whether there were that many (none are taken otherwise)."""
        now = self._clock()
        with self._lock:
            tokens, then = self._buckets.pop(key, (self._capacity, now))
            tokens = min(self._capacity, tokens + max(0.0, now - then) * self._per_s)
            allowed = tokens >= cost
            self._buckets[key] = (tokens - cost if allowed else tokens, now)
            while len(self._buckets) > self._max_keys:
                self._buckets.popitem(last=False)
            return allowed

    def __len__(self) -> int:
        with self._lock:
            return len(self._buckets)
