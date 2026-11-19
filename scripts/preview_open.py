"""See the free site and a member's site side by side, on this machine only and with no Discord at all: the demo market
and a fake Discord gate (its Discord is a stand-in that answers every call itself, so nothing leaves the machine).

    uv run python scripts/preview_open.py [port]        # default port 8796, http://localhost:<port>

It prints a session cookie for each state (a member "in", "out" of the server, "banned" by it). A browser with no
cookie is a visitor who is not signed in; to be one of the others, send the printed `Cookie:` header (a browser
extension, or Playwright's `extra_http_headers`). A member "in" can link a sample account (any username) to see the
linked site. The login button goes to Discord's real page: do not follow it here. Needs the front end built (`npm --prefix frontend run build`).
"""

import secrets
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from waitress import serve  # noqa: E402

from advisor import discord_gate as dg  # noqa: E402
from advisor.collector import run_collector  # noqa: E402
from advisor.importer import DemoImporter  # noqa: E402
from advisor.members import MemberLinks  # noqa: E402
from advisor.sources.fixture import FixtureSource  # noqa: E402
from advisor.store import SnapshotStore  # noqa: E402
from advisor.web import create_app  # noqa: E402

DEMO = ROOT / "advisor" / "fixtures" / "demo_raw.json"
STATIC = ROOT / "advisor" / "static"
UID = "111122223333444455"


def fake_discord(method, url, headers, body):  # noqa: ANN001, ANN201 - the gate's transport signature
    """Discord, played locally: everyone is who they say and in the server."""
    if url.endswith("/oauth2/token"):
        return 200, b'{"access_token": "local-preview-token"}'
    if url.endswith("/users/@me"):
        return 200, b'{"id": "%s", "username": "preview", "global_name": "Preview"}' % UID.encode()
    return (201, b"{}") if method == "PUT" else (200, b"{}")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8796
    env = {
        "ADVISOR_DISCORD_CLIENT_ID": "123456789012345678",
        "ADVISOR_DISCORD_CLIENT_SECRET": "preview-client-secret-" + secrets.token_hex(8),
        "ADVISOR_DISCORD_BOT_TOKEN": "preview-bot-token-" + secrets.token_hex(8),
        "ADVISOR_DISCORD_GUILD_ID": "876543210987654321",
        "ADVISOR_SESSION_SECRET": secrets.token_urlsafe(48),
        "ADVISOR_PUBLIC_URL": f"http://localhost:{port}",
    }
    config = dg.config_from_env(env)
    gate = dg.DiscordGate(config, dg.DiscordClient(config, transport=fake_discord))
    store = SnapshotStore()
    stop = threading.Event()
    threading.Thread(target=run_collector, args=(FixtureSource(DEMO), store, stop, 5.0),
                     kwargs={"demo": True, "accounts": True}, daemon=True).start()
    # A member can link a sample account (any username, made from the sample passes); the links live in a temporary
    # directory that goes with the process.
    links = MemberLinks(Path(tempfile.mkdtemp(prefix="preview-links-")) / "member-links.json")
    now = int(gate._clock())
    print(f"Preview on http://localhost:{port} (demo market, fake Discord gate). Cookies:")
    for state in dg.STATES:
        print(f"  {state:>6}: Cookie: {dg.SESSION_COOKIE}={gate._session(UID, 'Preview', now, now, state)}")
    sys.stdout.flush()
    serve(create_app(store, STATIC, gate=gate, links=links, importer=DemoImporter(store)), host="127.0.0.1", port=port,
          threads=8)


if __name__ == "__main__":
    main()
