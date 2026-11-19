"""The phone QA pass (the internal research notes): what was cut, overlapping or too small on a phone, each held by a
check in a real browser held like a phone (touch, a phone's user agent), at the widths phones have: 320 (the narrowest
still sold, and a 390 phone at 125 % text), 360, 375, 390, 430, and 844 x 390 for one held sideways."""

import re
from collections.abc import Callable, Iterator

import pytest
from playwright.sync_api import Browser, BrowserContext, expect

from tests.e2e.conftest import GatedServer, Server, Visit, _watch

ANDROID = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile "
           "Safari/537.36")
TABS = ("today", "deals", "prices", "passes", "plan")


@pytest.fixture
def make_phone(browser: Browser, server: Server) -> Iterator[Callable[..., Visit]]:
    """`make_phone(width, height=780, on=server, cookie=None)`: a fresh phone (touch, mobile) with its page watched."""
    contexts: list[BrowserContext] = []

    def make(width: int, height: int = 780, on: Server | None = None, cookie: str | None = None) -> Visit:
        target = on or server
        context = browser.new_context(viewport={"width": width, "height": height}, has_touch=True, is_mobile=True,
                                      user_agent=ANDROID, extra_http_headers={"Cookie": cookie} if cookie else {})
        contexts.append(context)
        return _watch(context, target.url)

    yield make
    for context in contexts:
        context.close()


def open_tab(visit: Visit, tab: str) -> None:
    visit.go(f"/#{tab}")
    expect(visit.page.locator("main h1")).to_be_attached()
    visit.settle(500)


# --- the live pill in the top bar -------------------------------------------------------------------------------------

PILL = """() => {
    const word = document.querySelector('header.top .live .lw');
    const shown = word && getComputedStyle(word).position !== 'absolute';
    const vw = document.documentElement.clientWidth;
    const out = [...document.querySelector('header.top').children]
        .filter(el => { const r = el.getBoundingClientRect(); return r.right > vw + 0.5 || r.left < -0.5; })
        .map(el => el.className);
    return {cut: Boolean(shown && word.scrollWidth > word.clientWidth + 0.5), out};
}"""


def pill_problems(visit: Visit, widths) -> list:
    bad = []
    for width in widths:
        visit.page.set_viewport_size({"width": width, "height": 780})
        visit.settle(60)
        seen = visit.page.evaluate(PILL)
        if seen["cut"]:
            bad.append(f"{width}: the pill's word is cut")
        if seen["out"]:
            bad.append(f"{width}: off the screen: {seen['out']}")
    return bad


def test_the_pill_never_shows_a_cut_word_for_a_member(make_phone):
    """A member's bar (brand, pill, settings, account, search): the pill shows its word whole ("Demo", "Live") or, where
    there is no room, its dot alone; never "De…". 260 is a 390 phone at 150 % (Safari's page zoom)."""
    visit = make_phone(430)
    open_tab(visit, "today")
    assert pill_problems(visit, range(260, 432, 2)) == []
    visit.assert_clean()


def test_the_pill_never_shows_a_cut_word_beside_continue_with_discord(make_phone, gated_server: GatedServer):
    """A visitor's bar carries Continue with Discord: at 390 the pill read "De…"; below 320 the button ran off the
    screen."""
    visit = make_phone(430, on=gated_server)
    open_tab(visit, "today")
    expect(visit.page.get_by_role("link", name=re.compile("Continue")).first).to_be_visible()
    assert pill_problems(visit, range(260, 432, 2)) == []
    visit.assert_clean()


# --- a deal's row -----------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("width", [320, 360])
def test_a_deal_row_keeps_the_players_name_readable_on_a_narrow_phone(make_phone, width):
    """At 320 a deal row gave the name 36 px ("Pa…") and cut the usual price ("usu…"): the price and its chip go under
    the name there, so the name has the row's width and the facts line wraps rather than end in an ellipsis."""
    visit = make_phone(width)
    for tab in ("today", "deals"):
        open_tab(visit, tab)
        rows = visit.page.evaluate("""() => [...document.querySelectorAll('main .list .prow')].map(row => {
            const name = row.querySelector('.nmt');
            const facts = [...row.querySelectorAll('.ln')].filter(l => l.scrollWidth > l.clientWidth + 1);
            return {name: name.textContent, width: name.clientWidth, cut: name.scrollWidth > name.clientWidth + 1,
                    facts: facts.map(l => l.textContent)};
        })""")
        assert rows, f"{tab}: no deal rows"
        for row in rows:
            assert row["width"] >= 120 or not row["cut"], f"{tab} at {width}: {row['name']} gets {row['width']} px"
            assert row["facts"] == [], f"{tab} at {width}: {row['name']}: cut {row['facts']}"
    visit.assert_clean()


# --- a pass's row -----------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("width", [320, 360, 390])
def test_a_pass_row_says_its_season_and_its_rax_a_year_whole(make_phone, width):
    """Best passes on a phone: the season ran under the "pays back by end of" column ("NBA 2024-2") and the Rax a year
    ended in "12,…". Every line of a row is whole now, and a season never breaks at its hyphen."""
    visit = make_phone(width)
    open_tab(visit, "passes")
    rows = visit.page.evaluate("""() => [...document.querySelectorAll('main .prow.pass')].map(row => ({
        name: row.querySelector('.nmt').textContent,
        cut: [...row.querySelectorAll('.ln')].filter(l => l.scrollWidth > l.clientWidth + 1).map(l => l.textContent),
        split: [...row.querySelectorAll('.season')].filter(s => s.getClientRects().length > 1).map(s => s.textContent),
        past: (() => { const pc = row.querySelector('.pc').getBoundingClientRect();
                       return [...row.querySelectorAll('.ln')].filter(l => l.getBoundingClientRect().right > pc.left + 0.5)
                              .map(l => l.textContent); })(),
    }))""")
    assert rows, "no pass rows"
    for row in rows:
        assert row["cut"] == [], f"{width}: {row['name']}: cut {row['cut']}"
        assert row["split"] == [], f"{width}: {row['name']}: the season breaks {row['split']}"
        assert row["past"] == [], f"{width}: {row['name']}: runs under the payback column {row['past']}"
    visit.assert_clean()


# --- fields ----------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("size", [(844, 390), (390, 844)], ids=["sideways", "upright"])
def test_every_field_is_16px_or_more_so_an_iphone_does_not_zoom_in(make_phone, size):
    """Safari zooms the page into a field whose text is under 16 px, and stays zoomed. Held sideways a phone gets the
    wide layout, whose search field was 14 px."""
    visit = make_phone(*size)
    small = []
    for tab in TABS:
        open_tab(visit, tab)
        small += visit.page.evaluate("""(tab) => [...document.querySelectorAll('input, select, textarea')]
            .filter(el => !['checkbox', 'radio', 'range', 'hidden'].includes(el.type) && el.getClientRects().length)
            .filter(el => parseFloat(getComputedStyle(el).fontSize) < 16)
            .map(el => `${tab}: ${el.getAttribute('aria-label') || el.placeholder || el.name} ${getComputedStyle(el).fontSize}`)""", tab)
    assert small == []
    visit.assert_clean()


# --- a phone held sideways -------------------------------------------------------------------------------------------

def test_a_popover_fits_a_phone_held_sideways(make_phone, gated_server: GatedServer):
    """Held sideways (844 x 390) a phone gets the wide layout, whose overlays are popovers that close when the page
    scrolls. A linked member's account popover ran past the 390 px window (645 px with every perk): its bottom (the
    perks, Delete my data) could not be reached. It scrolls inside itself now and fits the window."""
    cookie = gated_server.cookies["in"]
    visit = make_phone(844, 390, on=gated_server, cookie=cookie)
    page = visit.page
    visit.go("/#today")
    linked = page.request.post(f"{gated_server.url}/api/me/link", data={"username": "sideways"},
                               headers={"Cookie": cookie, "Origin": gated_server.url})
    assert linked.ok, linked.status
    open_tab(visit, "today")
    page.get_by_role("button", name=re.compile(r"@sideways")).first.click()
    pop = page.locator(".pop")
    expect(pop).to_be_visible()
    box = pop.evaluate("""p => { const r = p.getBoundingClientRect(); const s = getComputedStyle(p);
        return {top: r.top, bottom: r.bottom, scrolls: p.scrollHeight > p.clientHeight + 1, overflow: s.overflowY}; }""")
    assert box["top"] >= 0 and box["bottom"] <= 390.5, box
    assert not box["scrolls"] or box["overflow"] in ("auto", "scroll"), box
    last = pop.get_by_role("button", name="Delete my data")
    last.scroll_into_view_if_needed()
    expect(pop).to_be_visible()  # scrolling inside it does not close it
    expect(last).to_be_in_viewport()
    visit.assert_clean()


# --- the top tile's buttons ------------------------------------------------------------------------------------------

ONE_LINE = """() => [...document.querySelectorAll('main .tile .go .btn')].filter(b => b.getClientRects().length).map(b => {
    const tops = new Set();
    const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) tops.add(Math.round(r.top));
    }
    return {text: b.innerText.trim(), lines: tops.size, past: b.scrollWidth > b.clientWidth + 1};
})"""


@pytest.mark.parametrize("width", [320, 360])
@pytest.mark.parametrize("engine", ["chromium", "webkit"])
def test_the_top_tiles_buttons_say_open_in_real_on_one_line(request, server, width, engine):
    """"Open in Real" broke onto two lines in its 44 px button (WebKit at 320 and 360, Chromium at 320): the two
    buttons shared the row half and half. Each takes the room its words need now, on one line."""
    browser = request.getfixturevalue("browser" if engine == "chromium" else "webkit")
    options = {"viewport": {"width": width, "height": 800}, "has_touch": True}
    if engine == "chromium":
        options |= {"is_mobile": True, "user_agent": ANDROID}
    context = browser.new_context(**options)
    try:
        page = context.new_page()
        page.goto(f"{server.url}/#today")
        expect(page.get_by_role("link", name=re.compile("^Open in Real")).first).to_be_visible()
        page.wait_for_timeout(400)
        buttons = page.evaluate(ONE_LINE)
        assert buttons, "no tile buttons"
        assert [b for b in buttons if b["lines"] > 1 or b["past"]] == [], buttons
    finally:
        context.close()
