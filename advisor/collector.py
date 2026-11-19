"""The collector loop: ask a source for data, build a snapshot, publish it, and wait; back off when it fails."""

import logging
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone

from advisor.gone import GoneTracker
from advisor.rules import BACKOFF_CAP_S, BACKOFF_TRANSIENT_CAP_S, COLLECT_INTERVAL_S, COLLECT_LOG_EVERY_S, VERSION_PER_S
from advisor.snapshot import build_snapshot
from advisor.sources.base import Source
from advisor.sources.feed import FeedError
from advisor.store import SnapshotStore

log = logging.getLogger(__name__)

_monotonic = time.monotonic  # how long a round took, and when the last one was logged
# Failures that pass by themselves (a stale document, a feed out of reach): retried within BACKOFF_TRANSIENT_CAP_S.
TRANSIENT_ERRORS = (FeedError, OSError)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _learned(history, raw, as_of):
    """`history` once it has read this round's sales, or None when there is none or it failed to (logged): the
    snapshot is then built without curves."""
    if history is None:
        return None
    try:
        history.learn(raw.sales, as_of)
    except Exception:  # noqa: BLE001 - a curve is never worth a round
        log.exception("the price history could not learn a round")
        return None
    return history


def run_collector(
    source: Source,
    store: SnapshotStore,
    stop: threading.Event,
    interval_s: float = COLLECT_INTERVAL_S,
    now: Callable[[], datetime] = utc_now,
    wait: Callable[[float], bool] | None = None,
    demo: bool = False,
    dispatcher=None,
    first_version: int | None = None,
    injuries=None,
    resale=None,
    accounts: bool = False,
    history=None,
) -> None:
    """Refresh the store every `interval_s` seconds until `stop` is set.

    Each round asks the source about one moment (`now()`) and publishes the snapshot of that moment
    under the next version number, with the deals that went away since the last published round (see
    `advisor.gone`). The first version is `first_version`, by default the start time in milliseconds (see
    VERSION_PER_S), so a restart never serves a version a client already holds. A round that fails keeps the
    store serving its last snapshot: the store records only the error's class name, since what an error says can
    name private hosts, paths or tokens, and the whole of it goes to the server's log. The wait then doubles for
    every failure in a row, up to BACKOFF_CAP_S (BACKOFF_TRANSIENT_CAP_S when the feed was only stale or out of reach,
see TRANSIENT_ERRORS), and goes back to `interval_s` after the next success. A round is logged at INFO (how long it
took, its outcome, the version published) when its outcome changes, and otherwise at most every COLLECT_LOG_EVERY_S.
    `wait(seconds)` sleeps and says whether to stop; by default it is `stop.wait`. `demo` marks every snapshot as
    sample data (see `build_snapshot`). A snapshot is made as of the moment its data describes (`raw.fetched_at`),
    which for the live feed is the time its document was built: the page then sees how old the market really is.

    With a push `dispatcher` (see `advisor.push`), each snapshot carries its link and is handed to it, with its
    moment, once published; the dispatcher only queues it, and nothing it raises stops a round.
    With an `injuries` view (see `advisor.injuries`), each snapshot carries ESPN's note on a hurt player; with a
    `resale` view (see `advisor.resale`), how many recent listings of a deal's player sold. `accounts` says the site
    can read a Real account's passes (`links.accounts`: the page then offers to link one).
    With a price `history` (see `advisor.price_history`), each round's sales are read into it first, then each move
    carries its market's finished days; a history that cannot learn is logged and never costs a round.
    """
    wait = stop.wait if wait is None else wait
    tracker = GoneTracker()
    version = (int(time.time() * VERSION_PER_S) if first_version is None else first_version) - 1
    delay = interval_s
    push = None if dispatcher is None else dispatcher.link
    logged: tuple[str | None, float] = (None, 0.0)  # the outcome last logged, and when
    while not stop.is_set():
        started = _monotonic()
        try:
            moment = now()
            raw = source.fetch(moment)
            as_of = raw.fetched_at  # the moment the data describes: the fetch, or for the feed when it was built
            curve = _learned(history, raw, as_of)
            snapshot = tracker.apply(build_snapshot(raw, as_of, version + 1, demo=demo, push=push, injuries=injuries, resale=resale, accounts=accounts, history=curve), raw, as_of)
            store.publish(snapshot)
        except Exception as error:
            store.record_error(type(error).__name__)
            log.warning("refresh failed, the last snapshot stays served: %r", error)
            cap = BACKOFF_TRANSIENT_CAP_S if isinstance(error, TRANSIENT_ERRORS) else BACKOFF_CAP_S
            delay = min(delay * 2, max(cap, interval_s))
            outcome = f"failed ({type(error).__name__})"
            said = f"{outcome}, retry in {delay:g} s"
        else:
            version += 1
            delay = interval_s
            outcome, said = "ok", f"ok, version {version} published"
            if dispatcher is not None:
                try:
                    dispatcher.notify(snapshot, moment)
                except Exception:  # noqa: BLE001 - alerts are never worth a round
                    log.exception("the push dispatcher refused a snapshot")
        ended = _monotonic()
        if outcome != logged[0] or ended - logged[1] >= COLLECT_LOG_EVERY_S:
            log.info("collector round %s in %.2f s", said, ended - started)
            logged = (outcome, ended)
        if wait(delay):
            return
