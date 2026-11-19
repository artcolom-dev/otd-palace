"""End-to-end harness: the real server as a subprocess on a free port, and Chromium (Playwright) in front of it.

The server runs the replay demo (`ADVISOR_SOURCE=replay`) refreshed every second, with a data directory of its own and
no network of its own: its photo fetches go to a proxy that refuses, so a run asks ESPN for nothing (the faces are the
initials, and /img/players/ answers 404). ADVISOR_STALE_AFTER_S is 12 here, not 3: the page polls every `poll_s` = 5 s
and counts the data stale once a new version has not arrived for `stale_after_s`, so anything under 5 would make the
pill flicker to "Paused" between two polls. The pause test kills its own server and waits for the failed polls.

Needs the front end built (`npm --prefix frontend run build`) and Chromium (`uv run playwright install chromium`);
without the build the tests fail, saying so; without Chromium they are skipped.
"""

import os
import re
import socket
import subprocess
import sys
import time
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from urllib.error import URLError

import pytest
from playwright.sync_api import Browser, BrowserContext, Page, Playwright, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "advisor" / "static" / "index.html"
STALE_AFTER_S = 12
POLL_S = 5  # advisor.rules.POLL_S: how often the page asks the server for a new snapshot
VIEWPORTS = {"phone": (390, 844), "desktop": (1280, 800)}


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@dataclass
class Server:
    process: subprocess.Popen
    port: int
    log: Path

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def alive(self) -> bool:
        return self.process.poll() is None

    def kill(self) -> None:
        """Stops this server by its own PID, and waits for it."""
        if self.alive():
            self.process.kill()
        self.process.wait(timeout=10)

    def get_json(self, path: str):
        import json

        with urllib.request.urlopen(f"{self.url}{path}", timeout=5) as answer:
            return json.loads(answer.read())


def _start_server(data_dir: Path) -> Server:
    if not BUILD.exists():
        pytest.fail("the front end is not built: run `npm --prefix frontend run build` first", pytrace=False)
    port = _free_port()
    # A clean environment: nothing of the developer's own settings (feed, keys, tokens, community link) gets in.
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env |= {
        "ADVISOR_SOURCE": "replay",
        "ADVISOR_STALE_AFTER_S": str(STALE_AFTER_S),
        "ADVISOR_INTERVAL_S": "1",
        "ADVISOR_DATA_DIR": str(data_dir),
        "PORT": str(port),
        "https_proxy": "http://127.0.0.1:9",  # nothing out there: the photo fetches fail at once
        "HTTPS_PROXY": "http://127.0.0.1:9",
    }
    log = data_dir / "server.log"
    data_dir.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        [sys.executable, "server.py"], cwd=ROOT, env=env, stdout=log.open("w"), stderr=subprocess.STDOUT
    )
    server = Server(process, port, log)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if not server.alive():
            pytest.fail(f"the server stopped at start:\n{log.read_text()}", pytrace=False)
        try:
            with urllib.request.urlopen(f"{server.url}/api/snapshot", timeout=2) as answer:
                if answer.status == 200:
                    return server
        except (URLError, OSError):
            time.sleep(0.2)
    server.kill()
    pytest.fail("the server did not answer in 30 s", pytrace=False)


@pytest.fixture(scope="session")
def server(tmp_path_factory) -> Iterator[Server]:
    running = _start_server(tmp_path_factory.mktemp("e2e-data"))
    yield running
    running.kill()


@pytest.fixture
def killable_server(tmp_path) -> Iterator[Server]:
    """A server of its own for a test that stops it."""
    running = _start_server(tmp_path)
    yield running
    running.kill()


@dataclass
class GatedServer(Server):
    """scripts/preview_open.py: the demo market behind a Discord gate whose Discord is a local stand-in (nothing leaves
    the machine). A browser with no cookie is a visitor not signed in; `cookies[state]` is the `Cookie:` header of a
    member "in" the server, "out" of it or "banned"."""

    cookies: dict[str, str] = field(default_factory=dict)


@pytest.fixture(scope="session")
def gated_server(tmp_path_factory) -> Iterator[GatedServer]:
    if not BUILD.exists():
        pytest.fail("the front end is not built: run `npm --prefix frontend run build` first", pytrace=False)
    data_dir = tmp_path_factory.mktemp("e2e-gated")
    port = _free_port()
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env |= {"https_proxy": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9"}
    log = data_dir / "server.log"
    process = subprocess.Popen([sys.executable, "scripts/preview_open.py", str(port)], cwd=ROOT, env=env,
                               stdout=log.open("w"), stderr=subprocess.STDOUT)
    server = GatedServer(process, port, log)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if not server.alive():
            pytest.fail(f"the gated server stopped at start:\n{log.read_text()}", pytrace=False)
        found = dict(re.findall(r"^\s*(\w+): Cookie: (\S+)$", log.read_text(), flags=re.M))
        try:
            with urllib.request.urlopen(f"{server.url}/api/snapshot", timeout=2) as answer:
                if answer.status == 200 and found:
                    server.cookies = found
                    break
        except (URLError, OSError):
            pass
        time.sleep(0.2)
    else:
        server.kill()
        pytest.fail("the gated server did not answer in 30 s", pytrace=False)
    yield server
    server.kill()


@pytest.fixture(scope="session")
def playwright() -> Iterator[Playwright]:
    with sync_playwright() as running:
        yield running


@pytest.fixture(scope="session")
def browser(playwright: Playwright) -> Iterator[Browser]:
    if not Path(playwright.chromium.executable_path).exists():
        pytest.skip("Chromium is not installed: `uv run playwright install chromium`")
    chromium = playwright.chromium.launch()
    yield chromium
    chromium.close()


@pytest.fixture(scope="session")
def webkit(playwright: Playwright) -> Iterator[Browser]:
    """WebKit, held as an iPhone is by the checks that ask for it; skipped where it is not installed."""
    if not Path(playwright.webkit.executable_path).exists():
        pytest.skip("WebKit is not installed: `uv run playwright install webkit`")
    engine = playwright.webkit.launch()
    yield engine
    engine.close()


LOCAL_ONLY_ERRORS = re.compile(r"^Failed to load resource: the server responded with a status of 404")


@dataclass
class Visit:
    """A page with everything it did recorded: the console errors, the uncaught errors, the requests that left."""

    page: Page
    base: str
    errors: list[str] = field(default_factory=list)
    foreign: list[str] = field(default_factory=list)
    requests: list[str] = field(default_factory=list)

    def go(self, path: str = "/", **options) -> None:
        self.page.goto(f"{self.base}{path}", **options)

    def settle(self, ms: int = 400) -> None:
        self.page.wait_for_timeout(ms)

    def assert_clean(self) -> None:
        assert self.errors == [], f"console errors: {self.errors}"
        assert self.foreign == [], f"requests that left the local origin: {self.foreign}"


def _watch(context: BrowserContext, base: str) -> Visit:
    page = context.new_page()
    visit = Visit(page, base)

    def on_console(message) -> None:
        if message.type != "error":
            return
        url = (message.location or {}).get("url", "")
        # A photo the server has none of is a 404 the browser logs itself; that is no fault of the page.
        if LOCAL_ONLY_ERRORS.match(message.text) and "/img/players/" in url:
            return
        visit.errors.append(f"{message.text} ({url})")

    def on_request(request) -> None:
        visit.requests.append(request.url)
        if not request.url.startswith((base, "data:", "blob:")):
            visit.foreign.append(request.url)

    page.on("console", on_console)
    page.on("pageerror", lambda error: visit.errors.append(f"uncaught: {error}"))
    page.on("request", on_request)
    return visit


@pytest.fixture(params=sorted(VIEWPORTS))
def viewport(request) -> str:
    return request.param


@pytest.fixture
def make_visit(browser: Browser, server: Server) -> Iterator[Callable[..., Visit]]:
    """`make_visit(width, height, server=...)`: a fresh browser context (no saved choices) with its page watched."""
    contexts: list[BrowserContext] = []

    def make(width: int, height: int, on: Server | None = None) -> Visit:
        target = on or server
        context = browser.new_context(viewport={"width": width, "height": height})
        contexts.append(context)
        return _watch(context, target.url)

    yield make
    for context in contexts:
        context.close()


@pytest.fixture
def visit(make_visit, viewport) -> Visit:
    return make_visit(*VIEWPORTS[viewport])


@pytest.fixture
def phone(viewport) -> bool:
    return viewport == "phone"
