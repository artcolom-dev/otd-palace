"""What the collector needs from a source of market data."""

from datetime import datetime
from typing import Protocol

from advisor.model import RawData


class Source(Protocol):
    def fetch(self, now: datetime) -> RawData:
        """Everything the source knows as of `now` (aware UTC); raises when it cannot be reached."""
        ...
