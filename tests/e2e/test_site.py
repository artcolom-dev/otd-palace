"""The site in a real browser, against the real server (see conftest.py), at a phone (390x844) and a desktop
(1280x800) where the layout differs."""

import json
import re
import time
from urllib.parse import urlsplit

import pytest
from playwright.sync_api import expect

from tests.e2e.conftest import POLL_S, VIEWPORTS

REAL = "https://www.realapp.com/"
TITLES = {"today": "Today", "deals": "All deals", "prices": "Prices moving today", "passes": "On This Day passes"}


def go_tab(visit, tab: str) -> None:
    visit.go(f"/#{tab}")
    expect(visit.page.get_by_role("heading", level=1, name=TITLES[tab])).to_be_attached()
    visit.settle(300)  # the lazy views draw their first frame


def pill(page):
    """The live line: the phone's pill in its top bar, the desktop's line in its top bar."""
    return page.locator("[data-testid=live-pill], [data-testid=live-line]")


ROW_PRICE = re.compile(r"(\d[\d,]*) (?:to start|top bid)")


def deal_prices(page) -> list[int]:
    """The price of every deal in the Deals list: a row of the table on desktop, an item of the list on a phone."""
    region = page.get_by_role("region", name="All deals")
    rows = region.get_by_role("row").or_(region.get_by_role("listitem")).evaluate_all(
        "rows => rows.map(r => r.innerText.replace(/\\s+/g, ' '))"
    )
    return [int(m.group(1).replace(",", "")) for row in rows if (m := ROW_PRICE.search(row))]


def pick_max_price(page, phone: bool, choice: str) -> None:
    """`choice` is "50", "200", "1,000" or "any": a chip that opens a sheet on a phone, a row of buttons on desktop."""
    if phone:
        page.get_by_role("button", name=re.compile(r"^Max ")).click()
        label = "Any price" if choice == "any" else f"≤{choice}"
        page.get_by_role("dialog").get_by_role("radio", name=re.compile(rf"^{re.escape(label)}")).click()
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_have_count(0)
    else:
        group = page.get_by_role("group", name=re.compile(r"^Max price per card"))
        group.get_by_role("button", name="Any" if choice == "any" else f"≤{choice}", exact=True).click()


# --- Today ------------------------------------------------------------------------------------------------------

def test_today_ranks_the_top_three_and_the_list_goes_on_at_four(visit):
    visit.go("/#today", wait_until="domcontentloaded")
    page = visit.page
    tops = page.get_by_role("region", name="Best deals for you right now")
    expect(tops.get_by_role("listitem")).to_have_count(3, timeout=2000)
    for rank in (1, 2, 3):
        expect(tops.get_by_role("img", name=f"Rank {rank}")).to_be_visible(timeout=2000)
    expect(tops.get_by_role("img", name="Rank 4")).to_have_count(0)
    expect(page.get_by_role("region", name="More deals").get_by_role("img", name="Rank 4")).to_be_visible(timeout=2000)
    visit.assert_clean()


@pytest.mark.parametrize("width", [360, 390, 1280, 1440])
def test_no_horizontal_scroll_on_any_tab(make_visit, width):
    visit = make_visit(width, 800)
    for tab in TITLES:
        go_tab(visit, tab)
        wide = visit.page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        assert wide <= 0, f"{tab} at {width}: the page is {wide}px wider than the window"
    visit.assert_clean()


@pytest.mark.parametrize("width", [360, 390])
def test_the_phone_top_bar_keeps_every_button_on_screen_with_and_without_the_bell(make_visit, width):
    """The bar holds the brand, the live pill, the account and the search; where alerts are on, the bell too. Every
    one of them stays inside the window, and the pill then keeps its dot and word (the age is left to screen readers)."""
    visit = make_visit(width, 800)
    go_tab(visit, "today")
    page = visit.page
    inside = """() => [...document.querySelector('header.top').children]
        .map(el => [el.className, Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().right)])
        .filter(([, left, right]) => left < 0 || right > document.documentElement.clientWidth)"""
    assert page.evaluate(inside) == [], "a part of the top bar is off the screen"
    assert "s ago" in pill(page).inner_text()
    # The bell as the page draws it where alerts are on (the test server has none): an icon button before the account's.
    page.evaluate("""() => {
        const account = document.querySelector('header.top .accbtn');
        const bell = account.cloneNode(true);
        bell.className = 'icb bell';
        account.before(bell);
    }""")
    assert page.evaluate(inside) == [], "with the bell, a part of the top bar is off the screen"
    ago = page.locator("header.top .live .ago")
    assert ago.evaluate("el => el.getBoundingClientRect().width") <= 1  # clipped for the eye
    assert "s ago" in ago.evaluate("el => el.textContent")  # still there for a screen reader
    expect(page.locator("header.top .brand .bn")).to_be_visible()


# --- the filters ----------------------------------------------------------------------------------------------------

def test_level_new_never_shows_a_bid_deal(visit):
    page = visit.page
    for _ in range(3):  # across a few polls: the demo market keeps moving
        for tab in ("today", "deals"):
            go_tab(visit, tab)
            assert page.get_by_text("top bid").count() == 0, f"a bid deal at New on {tab}"
            assert page.get_by_text("Current bid").count() == 0
        visit.settle(2500)
    go_tab(visit, "deals")
    page.get_by_role("radio", name="Pro").click()  # and the check can see one when it is allowed
    expect(page.get_by_text("top bid").first).to_be_visible()
    page.get_by_role("radio", name="New").click()
    expect(page.get_by_text("top bid")).to_have_count(0)
    visit.assert_clean()


def test_max_price_narrows_the_list_and_any_price_brings_it_back(visit, phone):
    page = visit.page
    go_tab(visit, "deals")
    before = deal_prices(page)
    assert len(before) >= 5 and max(before) > 50, before
    pick_max_price(page, phone, "50")
    narrow = deal_prices(page)
    assert narrow and max(narrow) <= 50 and len(narrow) < len(before), narrow
    pick_max_price(page, phone, "any")
    assert len(deal_prices(page)) >= len(before)
    visit.assert_clean()


def test_a_budget_of_one_rax_says_nothing_fits_and_clearing_brings_deals_back(visit, phone):
    page = visit.page
    go_tab(visit, "today")
    if phone:  # the panel is on the page
        scope = page.locator("section.buddy")
    else:  # the panel is on Today's rail too, and the top bar's button opens it
        page.get_by_role("button", name="What can I do with…").click()
        scope = page.get_by_role("dialog")
    box = scope.get_by_role("textbox", name="Your balance in Rax")
    box.fill("1")
    expect(scope.get_by_text("With 1 Rax, no deal fits right now.")).to_be_visible()
    expect(scope.get_by_role("link", name=re.compile(r"Opens in Real$"))).to_have_count(0)
    box.fill("")
    expect(scope.get_by_text("Type what you have to spend")).to_be_visible()
    box.fill("150")
    expect(scope.get_by_text(re.compile(r"With 150 Rax, the best you can do right now is \d+ deals?"))).to_be_visible()
    expect(scope.get_by_role("link", name=re.compile(r"Opens in Real$")).first).to_be_visible()
    visit.assert_clean()


# --- links out -----------------------------------------------------------------------------------------------------

def test_every_outbound_deal_link_goes_to_real_and_opens_safely(visit):
    page = visit.page
    seen = 0
    for tab in ("today", "deals"):
        go_tab(visit, tab)
        outbound = page.locator("a[href^='http']").evaluate_all(
            "links => links.map(a => ({href: a.href, rel: a.rel, target: a.target, text: a.textContent.slice(0, 40)}))"
        )
        for link in outbound:
            assert link["href"].startswith(REAL), link
            assert link["href"] == REAL, link  # the sample market has no real listing: the home page, never a made-up one
            assert "noopener" in link["rel"].split(), link
            assert link["target"] == "_blank", link
        seen += len(outbound)
        # and nothing else on the page leads off the site: only the page's own addresses, tabs and Real
        hrefs = page.locator("a[href]").evaluate_all("links => links.map(a => a.getAttribute('href'))")
        assert all(h.startswith(("#", "/", REAL)) for h in hrefs), [h for h in hrefs if not h.startswith(("#", "/", REAL))]
    assert seen >= 20
    visit.assert_clean()


# --- a server that stops --------------------------------------------------------------------------------------------

def test_after_the_server_stops_the_pill_reads_paused_and_every_open_says_so(make_visit, killable_server, viewport):
    visit = make_visit(*VIEWPORTS[viewport], on=killable_server)
    page = visit.page
    go_tab(visit, "today")
    expect(pill(page)).not_to_contain_text("Paused")
    killable_server.kill()
    started = time.monotonic()
    # Two failed polls in a row (POLL_S apart), and a little room for the request that was in flight.
    expect(pill(page)).to_contain_text("Paused · prices may have changed", timeout=(2 * POLL_S + 4) * 1000)
    assert time.monotonic() - started <= 2 * POLL_S + 4
    opens = page.locator("main a[aria-label^='Open ']:not([aria-label^='Open Real:']), main a[aria-label$='Opens in Real'], "
                         "main a:has-text('Open in Real')")
    assert opens.count() >= 3
    for link in opens.evaluate_all(
        """links => links.map(a => {
            const id = a.getAttribute('aria-describedby');
            const note = id ? document.getElementById(id) : null;
            return {label: a.getAttribute('aria-label') || a.textContent, note: note ? note.textContent : null};
        })"""
    ):
        assert link["note"] and "Paused" in link["note"], link
    # No error page, no blank: the last market is still on screen.
    expect(page.get_by_role("region", name="Best deals for you right now").get_by_role("listitem")).to_have_count(3)


# --- no request leaves, no console error --------------------------------------------------------------------------------

def test_a_tour_of_the_site_asks_nothing_of_anyone_else(visit):
    page = visit.page
    for tab in TITLES:
        go_tab(visit, tab)
        visit.settle(500)
    visit.assert_clean()  # no console error (a Content-Security-Policy violation is one), no foreign request
    assert any("/img/players/" in url for url in visit.requests), "the photos come through our own /img/players/"
    assert all(urlsplit(url).netloc == urlsplit(visit.base).netloc for url in visit.requests if url.startswith("http"))


def test_deals_prices_and_passes_render_clean(visit):
    for tab in ("deals", "prices", "passes"):
        go_tab(visit, tab)
        expect(visit.page.locator("main")).not_to_be_empty()
    visit.assert_clean()


def test_a_pass_card_opens_clean(visit):
    page = visit.page
    go_tab(visit, "passes")
    page.get_by_role("button", name=re.compile(r"^Open the .* pass")).first.click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible()
    expect(dialog).to_contain_text("pass")
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    visit.assert_clean()


def test_your_day_ticks(visit):
    page = visit.page
    go_tab(visit, "today")
    expect(page.get_by_role("img", name="0 of 5 done today")).to_be_visible()
    page.get_by_role("checkbox", name=re.compile(r"^Claim the passes you hold")).check()
    expect(page.get_by_role("img", name="1 of 5 done today")).to_be_visible()
    expect(page.get_by_role("status").filter(has_text="1 of 5 done today")).to_be_visible()
    page.get_by_role("checkbox", name=re.compile(r"^Answer the daily polls")).check()
    expect(page.get_by_role("img", name="2 of 5 done today")).to_be_visible()
    page.get_by_role("checkbox", name=re.compile(r"^Claim the passes you hold")).uncheck()
    expect(page.get_by_role("img", name="1 of 5 done today")).to_be_visible()
    visit.assert_clean()


def test_the_how_real_works_sheet_opens_clean(visit):
    page = visit.page
    go_tab(visit, "today")
    page.get_by_role("button", name="How Real works").first.click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible()
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    visit.assert_clean()


# --- the share page and the 404 page ------------------------------------------------------------------------------

def test_the_share_page_of_a_live_deal(visit, server):
    deal = server.get_json("/api/snapshot")["deals"][0]
    answer = visit.page.goto(f"{visit.base}/d/{deal['listing_id']}")
    assert answer.status == 200
    expect(visit.page.get_by_role("heading", level=1)).to_contain_text(deal["player_name"])
    expect(visit.page.get_by_role("link", name=re.compile("Real"))).not_to_have_count(0)
    visit.assert_clean()


def test_the_share_page_of_a_deal_that_is_gone(visit, server):
    gone: list[int] = []
    deadline = time.monotonic() + 60
    while not gone and time.monotonic() < deadline:  # the demo market takes deals as it moves
        gone = [row["listing_id"] for row in server.get_json("/api/snapshot")["gone"]]
        if not gone:
            time.sleep(1)
    if not gone:
        pytest.skip("the demo market took no deal off the list in 60 s; the gone page is covered by tests/test_share.py")
    answer = visit.page.goto(f"{visit.base}/d/{gone[0]}")
    assert answer.status == 200
    expect(visit.page.get_by_text("This deal has gone")).to_be_visible()
    expect(visit.page.get_by_role("link", name="See more deals")).to_be_visible()
    visit.assert_clean()


def test_the_404_page(visit):
    for path in ("/no-such-page", "/d/1"):  # a path nobody serves, and a deal nobody remembers
        answer = visit.page.goto(f"{visit.base}{path}")
        assert answer.status == 404
        expect(visit.page.locator("body")).not_to_be_empty()
        assert visit.page.get_by_role("link").count() >= 1, "the 404 page offers a way back"
        # the browser logs the 404 of the page it was sent to; that line is the one expected, nothing else is
        expected = f"Failed to load resource: the server responded with a status of 404 (NOT FOUND) ({visit.base}{path})"
        assert expected in visit.errors
        visit.errors.remove(expected)
    visit.assert_clean()


# --- a long name -----------------------------------------------------------------------------------------------------

SPACED = "Christopher Montgomery-Featherstone"  # 35 characters, where lines can break
UNBROKEN = "Wolfeschlegelsteinhausenbergerdorff"  # 35 characters with no place to break


@pytest.mark.parametrize(("width", "swap"), [(390, False), (320, False), (320, True)])
def test_a_35_character_name_wraps_without_overflow(make_visit, width, swap):
    """`swap` gives the unbroken name to the rows that had the spaced one, so each place meets both."""
    assert len(SPACED) == len(UNBROKEN) == 35
    visit = make_visit(width, 844)
    page = visit.page

    def rename(body: dict) -> dict:
        for i, deal in enumerate(body.get("deals", [])):
            deal["player_name"] = (SPACED, UNBROKEN)[(i + swap) % 2]
        for i, market in enumerate(body.get("otd", {}).get("markets", [])):
            if market.get("kind") == "player":
                market["player_name"] = (SPACED, UNBROKEN)[(i + swap) % 2]
        return body

    def serve(route) -> None:
        response = route.fetch()
        if response.status != 200:
            return route.fulfill(response=response)
        text = response.text()
        if route.request.url.rstrip("/").endswith("/api/snapshot") or "/api/snapshot?" in route.request.url:
            return route.fulfill(response=response, body=json.dumps(rename(json.loads(text))))

        def inline(match: re.Match) -> str:
            data = json.dumps(rename(json.loads(match.group(2)))).replace("</", "<\\/")
            return f"{match.group(1)}{data}{match.group(3)}"

        route.fulfill(response=response, body=re.sub(r'(<script id="snapshot"[^>]*>)(.*?)(</script>)', inline, text, flags=re.S))

    page.route(lambda url: urlsplit(url).path in ("/", "/api/snapshot"), serve)
    for tab in ("today", "deals", "passes", "prices", "plan"):
        visit.go(f"/#{tab}")
        visit.settle(600)
        assert page.get_by_text(SPACED).count() >= 1 or tab in ("passes", "prices", "plan")
        problems = page.evaluate(
            """(names) => {
                const bad = [];
                const wide = document.documentElement.scrollWidth - window.innerWidth;
                if (wide > 0) bad.push('page is ' + wide + 'px wider than the window');
                for (const el of document.querySelectorAll('main *')) {
                    if (el.children.length || !names.some(n => el.textContent.includes(n))) continue;
                    const box = el.getBoundingClientRect();
                    const where = el.tagName.toLowerCase() + '.' + el.className + ' "' + el.textContent.slice(0, 20) + '"';
                    // Nothing leaves the window, whatever it is.
                    if (box.right > window.innerWidth + 0.5 || box.left < -0.5) bad.push(where + ' leaves the window');
                    // A headline name never spills out of its box sideways: it wraps inside it (two lines at most), or the
                    // box holds it to one line, clips it and ends it in an ellipsis. Text past the box that nothing clips
                    // is the failure.
                    if (/^h[1-3]$/.test(el.tagName.toLowerCase())) {
                        const range = document.createRange();
                        range.selectNodeContents(el);
                        const past = [...range.getClientRects()].some(r => r.right > box.right + 1 || r.left < box.left - 1);
                        const style = getComputedStyle(el);
                        const clipped = style.overflowX !== 'visible' && style.textOverflow === 'ellipsis';
                        if (past && !clipped) bad.push(where + ' runs past its box and nothing clips it');
                    }
                }
                return bad;
            }""",
            [SPACED, UNBROKEN],
        )
        assert problems == [], f"{tab}: {problems}"
    visit.assert_clean()


# --- one list of what to add per screen -------------------------------------------------------------------------------

def test_passes_says_what_to_add_once_per_screen(visit, phone):
    """"Your next Rax" is the one list of what to add where it is drawn (the desktop rail, a phone's My passes); the
    cheapest way to start only shows on the screen without it; the 12-month plan keeps its steps behind its table."""
    go_tab(visit, "passes")
    page = visit.page
    if phone:  # a phone keeps Level and Max price behind one Filters button on this page
        page.get_by_role("button", name="Filters").click()
    page.get_by_role("radio", name="Regular").first.click()
    lists = ("Your next Rax", "Best to add next", "Cheapest way to start")

    def shown() -> list[str]:
        return [name for name in lists if page.get_by_role("region", name=name).count() > 0]

    if phone:
        assert shown() == ["Cheapest way to start"]
        page.get_by_role("tab", name=re.compile("My passes")).click()
    assert shown() == ["Your next Rax"]
    expect(page.get_by_role("region", name="Your next Rax").get_by_role("list", name="Your next moves").get_by_role("listitem").first).to_be_visible()
    plan = page.get_by_role("region", name="12-month plan")
    plan.get_by_label("Rax you have now").fill("5000")
    expect(plan.get_by_test_id("snowball-say")).to_be_visible()
    steps = plan.locator(".snw-steps")
    expect(steps).to_be_hidden()  # there, behind the table's disclosure
    plan.get_by_text("Show as a table").click()
    expect(steps).to_be_visible()
    expect(steps).to_contain_text(re.compile(r"add .+ for [\d,]+, adds about [\d,]+ a year"))
    visit.assert_clean()
