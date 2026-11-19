"""The name is OTD Palace everywhere a person reads it: the pages, the share pages and cards, the notifications, the
bot's answers and the server's own texts. The old name, Market Palace, is left only where it is kept on purpose, each
listed below with why (the pictures are drawn from these sources: scripts/render_icons.py)."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Everything a visitor or a member is shown comes from here. advisor/static is the build of frontend/src, so it is the
# sources that are read; the front end's tests are not shipped.
SHIPPED = ["advisor", "frontend/src", "frontend/public", "frontend/index.html", "scripts", "server.py"]
TEXT = {".py", ".ts", ".tsx", ".css", ".html", ".svg", ".js", ".json", ".webmanifest", ".txt", ".md"}
OLD = re.compile(r"market[\s_-]*palace", re.IGNORECASE)

# file -> {a piece of the line that may still say it: why}
KEPT = {
    "advisor/discord_gate.py": {
        'SESSION_SALT = "market-palace.session"': "a new salt would sign every member out",
        'STATE_SALT = "market-palace.login"': "a sign-in under way across the deploy would fail",
    },
    "advisor/privacy.py": {
        "OTD Palace (formerly Market Palace)": "who we are: the same people under the old name",
    },
}


def shipped_files():
    for entry in SHIPPED:
        path = ROOT / entry
        files = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
        for file in files:
            rel = file.relative_to(ROOT).as_posix()
            if rel.startswith("advisor/static/") or "node_modules" in rel or "__pycache__" in rel:
                continue
            if file.suffix not in TEXT or re.search(r"\.test\.tsx?$|/test-setup\.ts$", rel):
                continue
            yield rel, file


def test_no_text_a_person_reads_still_says_market_palace():
    left = []
    for rel, file in shipped_files():
        for number, line in enumerate(file.read_text(encoding="utf-8").splitlines(), 1):
            if OLD.search(line) and not any(piece in line for piece in KEPT.get(rel, {})):
                left.append(f"{rel}:{number}: {line.strip()[:120]}")
    assert left == []


def test_the_old_name_is_kept_only_where_it_is_listed_and_every_listed_place_still_holds_it():
    for rel, pieces in KEPT.items():
        text = (ROOT / rel).read_text(encoding="utf-8")
        for piece in pieces:
            assert piece in text, (rel, piece)  # a place kept on purpose that changed: update the list


def test_the_name_is_otd_palace_on_the_page_the_manifest_and_the_server():
    import json

    from advisor import share, web

    manifest = json.loads((ROOT / "frontend/public/manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["name"] == manifest["short_name"] == web.HOME_TITLE == "OTD Palace"
    assert "<title>OTD Palace</title>" in (ROOT / "frontend/index.html").read_text(encoding="utf-8")
    assert '<meta property="og:site_name" content="OTD Palace">' in share.preview_tags("t", "d", None)
    assert ">OTD Palace</span>" in (ROOT / "frontend/src/components/Brand.tsx").read_text(encoding="utf-8")
