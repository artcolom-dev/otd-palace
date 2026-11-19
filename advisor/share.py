"""A deal's public page, /d/<listing id>, and the card drawn for it: what a visitor sees when someone sends them a deal.

Everything here is a pure function of a snapshot's deal rows, so the web layer only has to find the row. The page is
standalone HTML (its style and its one small script are files the app serves, so the site's CSP holds: no inline style,
no inline script, no data: image); the card is a drawn SVG made of rectangles and escaped text, never a photo. Any text
that came from the data goes through `_text` (control characters out) and then `html.escape`.
"""

import html
import re

from advisor.injuries import benched, injury_words
from advisor.links import REAL_HOME
from advisor.real import RARITY_COLORS, RARITY_NAMES, season_label, sport_label
from advisor.rules import LEVELS, TWIN_MAX, TWIN_PRICE_BAND

GONE_WORDS = {
    "ended": "Its auction ended.",
    "countdown_started": "Someone started the countdown.",
    "outbid": "It was outbid.",
    "price_moved": "Its price changed.",
    "no_longer_a_deal": "It is no longer a deal.",
}
NAME_MAX_CHARS = 24  # a longer name is cut on the card, with an ellipsis
PLAIN_NAME = re.compile(r"[a-z0-9_-]{1,32}")  # what a sport must look like to be put in a photo address
# What XML 1.0 cannot hold (and a name has no use for); one of these would make a whole card unreadable.
_CONTROL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿  ]")

_NUMBERS = ("price", "reference", "discount", "rating", "ref_sample")


def _text(value: object) -> str:
    """Text from the data, safe to escape and to put in XML: control characters dropped."""
    return _CONTROL.sub("", value if isinstance(value, str) else "")


def valid_deal(row: object) -> bool:
    """Whether a snapshot row has what the page and the card draw; a row that lacks any of it is treated as unknown."""
    if not isinstance(row, dict):
        return False
    numbers = all(type(row.get(key)) in (int, float) for key in _NUMBERS)
    ids = all(type(row.get(key)) is int for key in ("listing_id", "player_id", "season", "rarity"))
    words = all(isinstance(row.get(key), str) for key in ("sport", "player_name"))
    return numbers and ids and words and row.get("kind") in ("target", "bid") and 0 <= row["rarity"] < len(RARITY_NAMES)


def find_deal(snapshot: dict, listing_id: int, ended) -> tuple[dict, bool] | None:
    """The deal with this listing id and whether it has gone: live in the snapshot (the best of its kinds), else among
    its gone rows, else what `ended(listing_id)` remembers. None when there is no such deal, or its row is unreadable."""
    for key, is_gone in (("deals", False), ("gone", True)):
        rows = snapshot.get(key)
        found = [row for row in rows if isinstance(row, dict) and row.get("listing_id") == listing_id] if isinstance(rows, list) else []
        found = [row for row in found if valid_deal(row)]
        if found:
            return max(found, key=lambda row: row["discount"]), is_gone
    row = ended(listing_id)
    return (row, True) if valid_deal(row) else None


def safe_deals(snapshot: dict) -> list[dict]:
    """The live deals anybody may be pointed at: what the lowest level (New) shows, which has no auctions, no falling
    market and no thin usual price. The page does not know who is asking."""
    level = (snapshot.get("levels") or {}).get("new") if isinstance(snapshot.get("levels"), dict) else None
    level = level if isinstance(level, dict) else LEVELS["new"]
    rows = snapshot.get("deals")
    return [
        row
        for row in (rows if isinstance(rows, list) else [])
        if valid_deal(row)
        and row["discount"] >= level["min_discount"]
        and row.get("confidence") in level["confidence"]
        and row["kind"] in level["kinds"]
        and not (level.get("hide_falling") and row.get("falling"))
        and not (level.get("hide_hurt") and benched(row.get("injury")))
    ]


def _player_season(row: dict) -> tuple:
    return row["sport"], row["season"], row["player_id"]


def twins(subject: dict, pool: list[dict], limit: int = TWIN_MAX, band: float = TWIN_PRICE_BAND) -> list[dict]:
    """Deals like `subject`, for when it is gone: the same player-season first, then the same sport within `band` of
    its price (inclusive) and at least its rating; the best discount first in each group (the nearer price, then the
    lower listing id, break a tie). Never the subject's own listing, one row per listing (its better kind), at most
    `limit`. The browser's lib/twins.ts says the same."""
    best: dict[int, dict] = {}
    for row in pool:
        listing = row["listing_id"]
        if listing == subject["listing_id"]:
            continue
        have = best.get(listing)
        if have is None or (row["discount"], -row["price"]) > (have["discount"], -have["price"]):
            best[listing] = row
    same, close = [], []
    for row in best.values():
        if _player_season(row) == _player_season(subject):
            same.append(row)
        elif (
            row["sport"] == subject["sport"]
            and abs(row["price"] - subject["price"]) <= band * subject["price"]
            and row["rating"] >= subject["rating"]
        ):
            close.append(row)
    same.sort(key=lambda row: (-row["discount"], row["price"], row["listing_id"]))
    close.sort(key=lambda row: (-row["discount"], abs(row["price"] - subject["price"]), row["listing_id"]))
    return (same + close)[:limit]


# --- words -------------------------------------------------------------------------------------------------------


def _rax(n: float) -> str:
    return f"{round(n):,}"


def _pct(share: float) -> str:
    return f"{int(share * 100 + 0.5)}%"


def _sport(sport: str) -> str:
    return sport_label(sport)


def _season(row: dict) -> str:
    """The deal's season as Real writes it: "2025-26" for NBA 2026, "2026" for NFL."""
    return season_label(_text(row["sport"]), row["season"])


def _unit(row: dict) -> str:
    return "to start" if row["kind"] == "target" else "top bid"


def _meta(row: dict) -> str:
    return f"{_sport(_text(row['sport']))} {_season(row)} · {row['rating']:.1f} rating · {RARITY_NAMES[row['rarity']]}"


def _meta_html(row: dict) -> str:
    """The meta line for a page: the same words as `_meta`, with the rarity as Real's colour swatch beside its name."""
    esc = html.escape
    rarity = row["rarity"]
    return (
        f"<span>{esc(_sport(_text(row['sport'])))} {esc(_season(row))} · {row['rating']:.1f} rating</span>"
        f'<span class="rar r{rarity}"><i class="sw" aria-hidden="true"></i>{esc(RARITY_NAMES[rarity])}</span>'
    )


def _initials(name: str) -> str:
    parts = name.split()
    letters = (parts[0][:1] + parts[-1][:1]) if len(parts) > 1 else parts[0][:1] if parts else ""
    return letters.upper()


def real_link(row: dict, demo: bool) -> str:
    """Where Open in Real goes: the deal's own https link into Real; Real's home page for sample data (its listings
    are invented) and for anything that is not such a link."""
    url = row.get("url")
    if demo or not isinstance(url, str) or not url.startswith(REAL_HOME) or any(c in url for c in " \t\r\n\"'<>"):
        return REAL_HOME
    return url


# --- the card ----------------------------------------------------------------------------------------------------

_FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
# The site's palette (frontend/src/styles/tokens.css): Real's black ground, its two greys for text, its green.
_TEXT, _MUTED, _SURFACE, _GOOD, _STALE = "#d9d9d9", "#8a8e94", "#0d0d0e", "#00a163", "#5c6367"


def _cut(name: str) -> str:
    return name if len(name) <= NAME_MAX_CHARS else name[: NAME_MAX_CHARS - 1].rstrip() + "…"


def render_card(row: dict, gone: bool = False) -> str:
    """The deal drawn as a card: its rarity's frame, the rating, the name, the price and how far under the usual price
    it is. Shapes and escaped text only, so it is safe as an image and as a document; no photo."""
    color = _STALE if gone else RARITY_COLORS[row["rarity"]]
    name = _cut(_text(row["player_name"]))
    size = 30 if len(name) <= 14 else 26 if len(name) <= 19 else 22
    rarity = RARITY_NAMES[row["rarity"]]
    pill = "Gone" if gone else f"{_pct(row['discount'])} under"
    pill_color = _MUTED if gone else _GOOD
    word = _text(f"{_sport(_text(row['sport']))} {_season(row)}")
    esc = html.escape
    label = f"{name}, rating {row['rating']:.1f}, {rarity}"
    detail = f"{_rax(row['price'])} Rax {_unit(row)}, usual price {_rax(row['reference'])}"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 448" width="320" height="448" role="img" '
        f'aria-labelledby="t d" font-family="{_FONT}">'
        f'<title id="t">{esc(label)}</title><desc id="d">{esc(detail)}</desc>'
        f'<rect x="3" y="3" width="314" height="442" rx="24" fill="{_SURFACE}" stroke="{color}" stroke-width="3"/>'
        f'<rect x="18" y="18" width="284" height="156" rx="16" fill="{color}" fill-opacity="0.16"/>'
        f'<text x="34" y="50" fill="{color}" font-size="17" font-weight="700" letter-spacing="0.5">{esc(rarity)}</text>'
        f'<text x="34" y="138" fill="{_TEXT}" font-size="88" font-weight="800" letter-spacing="-2">{row["rating"]:.1f}</text>'
        f'<text x="286" y="156" fill="{_MUTED}" font-size="15" text-anchor="end">rating</text>'
        f'<text x="34" y="214" fill="{_TEXT}" font-size="{size}" font-weight="700">{esc(name)}</text>'
        f'<text x="34" y="240" fill="{_MUTED}" font-size="16">{esc(word)}</text>'
        f'<rect x="34" y="262" width="252" height="1" fill="{color}" fill-opacity="0.4"/>'
        f'<text x="34" y="322" fill="{_TEXT}" font-size="54" font-weight="800" letter-spacing="-1">{esc(_rax(row["price"]))}</text>'
        f'<text x="34" y="348" fill="{_MUTED}" font-size="16">Rax {esc(_unit(row))}</text>'
        f'<text x="34" y="376" fill="{_MUTED}" font-size="15">usual {esc(_rax(row["reference"]))}</text>'
        f'<rect x="34" y="388" width="134" height="38" rx="19" fill="{pill_color}" fill-opacity="0.16"/>'
        f'<text x="101" y="413" fill="{pill_color}" font-size="17" font-weight="700" text-anchor="middle">{esc(pill)}</text>'
        "</svg>"
    )


# --- the page ----------------------------------------------------------------------------------------------------


def _face(row: dict) -> str:
    """The player's face: initials on a tint, and over them the photo from our own proxy when the sport is a plain name
    (a photo that is missing leaves the initials). The ring is the rarity's class, not a style."""
    esc = html.escape
    sport = _text(row["sport"])
    photo = (
        f'<img src="/img/players/{sport}/{row["player_id"]}" alt="" width="64" height="64" loading="lazy">'
        if PLAIN_NAME.fullmatch(sport)
        else ""
    )
    return f'<span class="face r{row["rarity"]}"><span class="ini">{esc(_initials(_text(row["player_name"])))}</span>{photo}</span>'


def _similar(rows: list[dict]) -> str:
    if not rows:
        return ""
    esc = html.escape
    items = "".join(
        f'<li><a class="tw" href="/d/{row["listing_id"]}">{_face(row)}'
        f'<span class="tn"><span class="tnm">{esc(_text(row["player_name"]))}</span>'
        f'<span class="tm">{esc(_meta(row))}</span></span>'
        f'<span class="tp"><span class="tpr">{_rax(row["price"])} Rax</span>'
        f'<span class="tpc">{_pct(row["discount"])} under</span></span></a></li>'
        for row in rows
    )
    return f'<section class="similar" aria-labelledby="sim"><h2 id="sim">Similar deals</h2><ul>{items}</ul></section>'


# The one picture under every link to the site (scripts/render_icons.py draws it): our logo, name and drawn cards. It
# names no player and shows no photo or price, so the same file is right for a deal, an account and the home page.
OG_IMAGE = "og.png"
OG_ALT = "OTD Palace: real card deals, priced from real sales"
_ORIGIN = re.compile(r"https?://[^/?#\s]+")


def _origin(url: str) -> str | None:
    """The scheme and host of a page's own address, which a preview image's address must carry in full."""
    found = _ORIGIN.match(url)
    return found.group(0) if found else None


def preview_tags(title: str, description: str, url: str | None) -> list[str]:
    """What a link preview reads (Open Graph and Twitter): the title and line, the page's own address and, when that
    address has a host, the one picture of the site, whose address must be in full."""
    esc = html.escape
    tags = [
        '<meta property="og:site_name" content="OTD Palace">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:title" content="{esc(title)}">',
        f'<meta property="og:description" content="{esc(description)}">',
    ]
    image = None
    if url:
        tags.append(f'<meta property="og:url" content="{esc(url)}">')
        origin = _origin(url)
        image = f"{origin}/{OG_IMAGE}" if origin else None
    if image:
        tags += [
            f'<meta property="og:image" content="{esc(image)}">',
            '<meta property="og:image:width" content="1200">',
            '<meta property="og:image:height" content="630">',
            f'<meta property="og:image:alt" content="{esc(OG_ALT)}">',
        ]
    tags += [
        f'<meta name="twitter:card" content="{"summary_large_image" if image else "summary"}">',
        f'<meta name="twitter:title" content="{esc(title)}">',
        f'<meta name="twitter:description" content="{esc(description)}">',
    ]
    if image:
        tags.append(f'<meta name="twitter:image" content="{esc(image)}">')
    return tags


def _head(title: str, description: str, url: str | None) -> str:
    esc = html.escape
    tags = [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="robots" content="noindex">',
        f"<title>{esc(title)}</title>",
        f'<meta name="description" content="{esc(description)}">',
        *preview_tags(title, description, url),
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
        '<link rel="stylesheet" href="/share.css">',
    ]
    return "\n".join(tags)


def _frame(head: str, body: str, demo: bool) -> str:
    banner = '<p class="demo"><b>Sample data</b>, not the live market</p>' if demo else ""
    return (
        f'<!doctype html>\n<html lang="en">\n<head>\n{head}\n</head>\n<body>\n'
        '<header class="top"><a class="brand" href="/"><img src="/logo.svg" alt="" width="32" height="32">'
        f"<span>OTD Palace</span></a></header>\n{banner}\n<main>\n{body}\n</main>\n"
        '<footer>Not affiliated with Real. OTD Palace only shows deals on Real\'s marketplace; it sells nothing.</footer>\n'
        '<script src="/share.js" defer></script>\n</body>\n</html>\n'
    )


def render_page(row: dict, gone: bool, similar: list[dict], url: str | None, demo: bool = False,
                gated: bool = False) -> str:
    """The page for one deal. `url` is its own address (for og:url); `similar` the twins shown on a gone deal. `gated`
    (the Discord gate is on and the visitor is not in our server yet): the way to more deals says what it asks."""
    esc = html.escape
    name = _text(row["player_name"])
    price, usual = _rax(row["price"]), _rax(row["reference"])
    sales = f"{_rax(row['ref_sample'])} {'sale' if row['ref_sample'] == 1 else 'sales'}"
    if gone:
        title = f"{name}: this deal has gone · OTD Palace"
        description = "This deal has gone. See similar deals on OTD Palace."
    else:
        title = f"{name} · {price} Rax, {_pct(row['discount'])} under usual · OTD Palace"
        description = (
            f"{name}, {_meta(row)}: {price} Rax {_unit(row)}, {_pct(row['discount'])} under the usual {usual}. "
            "Deals move fast."
        )
    link = real_link(row, demo)
    say = (
        f"Bid {price} to start the 10-minute countdown."
        if row["kind"] == "target"
        else f"Top bid {price}: bid more before the auction ends."
    )
    falling = (
        '<p class="note">Its market is falling today, so the usual price may be above what it sells for now.</p>'
        if row.get("falling")
        else ""
    )
    words = injury_words(row.get("injury"))
    hurt = (
        f'<p class="note">ESPN lists this player as hurt: {esc(words[1])}. A price far under usual is often the '
        "injury, so check the news before you bid.</p>"
        if words
        else ""
    )
    if words and not gone:
        description += f" ESPN lists the player as {words[0].lower()}."
    sport = _text(row["sport"])
    if gone:
        reason = GONE_WORDS.get(row.get("reason"), GONE_WORDS["no_longer_a_deal"])
        bar = f'<p class="gonebar"><b>This deal has gone</b> {esc(reason)}</p>'
        buttons = '<a class="btn ghost" href="/">See more deals</a>'
        if row.get("reason") != "ended":
            buttons = (
                f'<a class="btn fill" href="{esc(link)}" target="_blank" rel="noopener noreferrer" data-out="" '
                f'data-sport="{esc(sport)}">Open in Real</a>{buttons}'
            )
        lines = ""
    else:
        bar = ""
        buttons = (
            f'<a class="btn fill" href="{esc(link)}" target="_blank" rel="noopener noreferrer" data-out="" '
            f'data-sport="{esc(sport)}">Open in Real</a><a class="btn ghost" href="/">See more deals</a>'
        )
        lines = f'<div class="lines"><p class="say">{say} Prices move fast: check it in Real before you bid.</p>{falling}{hurt}</div>'
    alt = f"The card: {name}, rating {row['rating']:.1f}, {RARITY_NAMES[row['rarity']]}"
    body = (
        f'{bar}<article class="deal{" gone" if gone else ""}">'
        f'<div class="who">{_face(row)}<div><h1>{esc(name)}</h1><p class="meta">{_meta_html(row)}</p></div></div>'
        f'<div class="price"><b>{price}</b><span class="unit">Rax {_unit(row)}</span>'
        f'<span class="usual">usual price {usual}, from {sales}</span>'
        f'<span class="pct">{_pct(row["discount"])} under</span></div>'
        f"{lines}<div class=\"go\">{buttons}</div>{GATE_LINE if gated else ''}"
        f'<img class="art" src="/d/{row["listing_id"]}/card.svg" alt="{esc(alt)}" width="320" height="448">'
        f"</article>{_similar(similar) if gone else ''}"
    )
    return _frame(_head(title, description, url), body, demo)


# Under a shared deal's buttons while the Discord gate is on, for a visitor who is not in our server yet.
GATE_LINE = ('<p class="note">Browsing is free. Every live deal, deal pings and your own plan are free too, with Discord: '
             'one click and you\'re in.</p>')


def render_missing(demo: bool = False) -> str:
    """The page for a deal nobody remembers (a 404): it says so plainly and points at the deals that are up."""
    head = _head("This deal is no longer listed · OTD Palace", "This deal is no longer listed.", None)
    body = (
        '<article class="deal missing"><div class="who"><div><h1>This deal is no longer listed</h1>'
        '<p class="meta">It ended a while ago, or the link is not one of ours.</p></div></div>'
        '<div class="go"><a class="btn fill" href="/">See the deals that are up now</a></div></article>'
    )
    return _frame(head, body, demo)


def render_account(name: str, passes: int | None, url: str | None) -> str:
    """The preview page of a Real account's analysis (/a/<name>): a title and a line link previews can show, then
    straight on to the analysis on the site. `passes` is how many the site already knows the account holds, when it
    has read it lately; never a reason to read it."""
    esc = html.escape
    title = f"{name}'s Real passes · OTD Palace"
    if passes:
        description = (f"{name} holds {passes} {'pass' if passes == 1 else 'passes'} on Real. See what they pay a year, "
                       "sport by sport, and what to add next.")
    else:
        description = f"See what {name}'s Real passes pay a year, sport by sport, and what to add next."
    target = f"/#account/{esc(name)}"
    head = _head(title, description, url) + f'\n<meta http-equiv="refresh" content="0; url={target}">'
    body = (
        f'<article class="deal"><div class="who"><div><h1>{esc(name)}</h1>'
        f'<p class="meta">{esc(description)}</p></div></div>'
        f'<div class="go"><a class="btn fill" href="{target}">Open the analysis</a></div></article>'
    )
    return _frame(head, body, False)


SHARE_JS = """(function () {
  "use strict";
  function count(link) {
    var body = JSON.stringify({ panel: "share", target: "listing", level: "new", sport: link.getAttribute("data-sport") || "all", pos: 0 });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon("/api/out", new Blob([body], { type: "application/json" }))) return;
      fetch("/api/out", { method: "POST", body: body, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  // A player with no photo (the proxy answers 204): drop the broken image and leave the initials under it.
  Array.prototype.forEach.call(document.querySelectorAll(".face img"), function (img) {
    function drop() { if (img.parentNode) img.parentNode.removeChild(img); }
    if (img.complete && img.naturalWidth === 0) drop();
    else img.addEventListener("error", drop);
  });
  Array.prototype.forEach.call(document.querySelectorAll("a[data-out]"), function (link) {
    link.addEventListener("click", function () { count(link); });
    link.addEventListener("auxclick", function (e) { if (e.button === 1) count(link); });
  });
})();
"""

_SHARE_CSS = """:root {
  color-scheme: dark;
  --bg: #000000; --surface: #151515; --raise: #1d1f21; --line: #25282a; --line-hi: #3a3f42;
  --text: #d9d9d9; --muted: #8a8e94; --faint: #82878d; --accent: #f5893a; --accent-hover: #f89b55;
  --on-accent: #1b1004; --good: #00a163; --c: @RARITY_0@;
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.top { padding: 10px 16px; border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; color: var(--text); font-weight: 700; text-decoration: none; }
.brand img { border-radius: 8px; }
.demo { margin: 0; padding: 8px 16px; background: var(--raise); font-size: 13px; text-align: center; }
main { flex: 1; width: 100%; max-width: 880px; margin: 0 auto; padding: 20px 16px 32px; }
.gonebar { margin: 0 0 12px; padding: 12px 16px; border: 1px dashed var(--line-hi); border-radius: 12px; color: var(--muted); }
.gonebar b { color: var(--text); }
.deal {
  display: grid; gap: 16px; padding: 20px; border: 1px solid var(--line); border-radius: 16px;
}
.who { display: flex; align-items: center; gap: 14px; min-width: 0; }
.who > div { min-width: 0; }
h1 { margin: 0; font-size: 1.625rem; line-height: 1.15; letter-spacing: -0.02em; overflow-wrap: anywhere; text-wrap: balance; }
h2 { margin: 0 0 8px; font-size: 1.0625rem; color: var(--muted); }
.meta { margin: 4px 0 0; color: var(--muted); font-size: 0.9375rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0 12px; }
.face {
  position: relative; flex: none; display: grid; place-items: center; width: 64px; height: 64px; overflow: hidden;
  border-radius: 50%; background: #1f3b68; border: 3px solid var(--c); font-weight: 700; color: #fff;
}
.face img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 0; }
@RARITY_CLASSES@
.price { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.price b { font-size: 2.5rem; line-height: 1; letter-spacing: -0.02em; font-weight: 800; }
.unit { color: var(--muted); }
.usual { color: var(--muted); font-size: 0.9375rem; }
.rar { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--text); }
.sw { display: inline-block; flex: none; width: 9px; height: 12px; border-radius: 2px; border: 2px solid var(--c);
  background: color-mix(in srgb, var(--c) 30%, var(--bg)); }
.pct { padding: 3px 10px; border-radius: 999px; background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); font-weight: 700; font-size: 0.9375rem; }
.lines { display: grid; gap: 8px; }
.say, .note { margin: 0; color: var(--muted); max-width: 52ch; }
.note { font-size: 0.9375rem; }
.go { display: flex; flex-wrap: wrap; gap: 10px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 10px 20px; border-radius: 8px;
  font-weight: 700; text-decoration: none; color: var(--accent); border: 1px solid var(--accent);
}
.btn.fill { border-radius: 999px; background: var(--accent); color: var(--on-accent); }
.btn:active, .tw:active { opacity: 0.7; }
.art { width: 100%; max-width: 260px; height: auto; justify-self: center; }
.gone .price b, .gone h1 { color: var(--faint); }
.gone .pct { background: var(--raise); color: var(--muted); }
.similar { margin-top: 24px; }
.similar ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.tw {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 56px;
  padding: 10px 8px; margin: 0 -8px; border-bottom: 1px solid var(--line); color: var(--text); text-decoration: none;
}
.tw .face { width: 40px; height: 40px; border-width: 2px; font-size: 0.8125rem; }
.tn, .tp { display: grid; min-width: 0; }
.tp { text-align: right; }
.tnm { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tm { color: var(--muted); font-size: 0.8125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpr { font-weight: 700; }
.tpc { color: var(--good); font-size: 0.8125rem; font-weight: 700; }
footer { padding: 16px; color: var(--faint); font-size: 0.8125rem; text-align: center; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (hover: hover) {
  .btn:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .btn.fill:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .tw:hover { background: var(--surface); }
}
@media (min-width: 720px) {
  .deal {
    grid-template-columns: minmax(0, 1fr) 280px; grid-template-rows: auto auto auto auto 1fr;
    grid-template-areas: "who art" "price art" "say art" "go art" "rest art";
    column-gap: 40px; padding: 28px;
  }
  .who { grid-area: who; } .price { grid-area: price; } .lines { grid-area: say; } .go { grid-area: go; align-self: start; }
  .art { grid-area: art; max-width: 280px; }
  .missing { grid-template-columns: 1fr; grid-template-areas: none; }
  .missing > * { grid-area: auto; }
}
"""

# The rarity classes come from the one table (advisor/real.py), so a share page, the site and Discord draw one scale.
SHARE_CSS = _SHARE_CSS.replace("@RARITY_CLASSES@", "\n".join(f".r{n} {{ --c: {color}; }}" for n, color in enumerate(RARITY_COLORS))).replace(
    "@RARITY_0@", RARITY_COLORS[0]
)
