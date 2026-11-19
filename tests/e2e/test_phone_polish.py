"""The phone polish pass (the internal research notes, "Polish, 18 November"): what the QA pass left, each held by a
check in a real browser held like a phone (touch, a phone's user agent): the Earn more Rax sheet's tabs and fields, the
404 page's brand link, the wide layout held sideways, a scrolled popover's close button, the welcome card under 320 px,
Safari's page zoom at 260 px and the visitor's live pill when it is only its dot."""

import re

import pytest
from playwright.sync_api import expect

from tests.e2e.test_phone_qa import make_phone, open_tab  # noqa: F401 - make_phone is a fixture

TOUCH = 44  # the tap size every control a finger aims at gets on a touch screen


# --- the Earn more Rax sheet -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("size", [(390, 844), (844, 390)], ids=["upright", "sideways"])
def test_the_earn_sheets_tabs_and_fields_are_44px_on_a_touch_screen(make_phone, size):
    """Its level tabs (New, Starting, Growing, Big) were 36 px tall and its two sum fields 42 px."""
    visit = make_phone(*size)
    open_tab(visit, "today")
    visit.page.get_by_role("button", name="Earn more Rax").first.click()
    tabs = visit.page.locator(".earn-tabs [role=tab]")
    expect(tabs.first).to_be_visible()
    seen = visit.page.evaluate("""() => ({
        tabs: [...document.querySelectorAll('.earn-tabs [role=tab]')].map(b => b.getBoundingClientRect().height),
        fields: [...document.querySelectorAll('.earn-calc input')].map(b => b.getBoundingClientRect().height)})""")
    assert len(seen["tabs"]) == 4 and len(seen["fields"]) == 2, seen
    assert min(seen["tabs"] + seen["fields"]) >= TOUCH - 0.5, seen
    visit.assert_clean()


# --- the 404 page ----------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("width", [320, 390])
def test_the_404_pages_brand_link_is_44px_tall(make_phone, width):
    """The server's own page (advisor/web.py NOT_FOUND_PAGE, styled by /error.css): its brand link home was 40 px."""
    visit = make_phone(width)
    visit.go("/no-such-page")
    brand = visit.page.get_by_role("link", name="OTD Palace")
    expect(brand).to_be_visible()
    box = brand.bounding_box()
    assert box["height"] >= TOUCH - 0.5, box
    assert box["x"] >= 0 and box["x"] + box["width"] <= width, box


# --- the wide layout on a touch screen (a phone held sideways) -------------------------------------------------------

# Every control a finger aims at, but text: links and buttons inside a line of words (WCAG's inline exception), the ⓘ
# and the small stars beside a name, and the table's sort headers; each of those has the shared 44 px tap area drawn
# around it (base.css). A field counts by its box when the box is its label (a tap anywhere in it lands in the field).
CONTROLS = """(skip) => [...document.querySelectorAll('a[href], button, [role=tab], input, select')]
    .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.matches(skip))
    .filter(e => !(e.tagName === 'INPUT' && ['checkbox', 'radio', 'range', 'hidden'].includes(e.type)))
    .map(e => {
        const box = (e.tagName === 'INPUT' && e.closest('label')) || e;
        const r = box.getBoundingClientRect();
        return {what: `${e.tagName.toLowerCase()}.${e.className} "${(e.getAttribute('aria-label') || e.textContent
            || e.placeholder || '').trim().slice(0, 30)}"`, h: r.height, w: r.width};
    })
    .filter(c => c.w > 0 && c.h < 43.5)
    .map(c => `${c.what} ${Math.round(c.h)} px`)"""
# A deal's "Pass" pill (.dpass-chip) is drawn small in its line, its 44 px tap area drawn around it as the ⓘ's is.
INLINE = "p a, .howlink, .tlink, .ib, .star:not(.lg), .plink, .hs, .member-out, .sr, nav.tabbar a, .dpass-chip"


def test_the_wide_layout_held_sideways_gives_every_control_44px(make_phone, gated_server):
    """Held sideways a phone gets the wide layout, whose controls were desktop-sized: 32 to 36 px buttons, chips, sort,
    level and budget choices, 42 px fields. On a coarse pointer they are 44 px, as upright."""
    visit = make_phone(844, 390, on=gated_server, cookie=gated_server.cookies["in"])
    small = []
    for tab in ("today", "deals", "prices", "passes", "plan"):
        open_tab(visit, tab)
        assert visit.page.evaluate("document.querySelector('.app').classList.contains('desk')")
        small += [f"{tab}: {c}" for c in visit.page.evaluate(CONTROLS, INLINE)]
    assert small == []
    visit.assert_clean()


def test_the_wide_layout_with_a_mouse_keeps_its_desktop_sizes(browser, gated_server):
    """The 44 px is for a finger only: with a mouse (a fine pointer) the desktop keeps its compact controls."""
    context = browser.new_context(viewport={"width": 1366, "height": 900},
                                  extra_http_headers={"Cookie": gated_server.cookies["in"]})
    try:
        page = context.new_page()
        page.goto(f"{gated_server.url}/#deals")
        expect(page.locator("main h1")).to_be_attached()
        page.wait_for_timeout(500)
        sizes = page.evaluate("""() => Object.fromEntries([['sort', '.sortbtn'], ['level', '.side .seg button'],
            ['chip', '.dhead .tabs button'], ['link', '.accbtn'], ['dismiss', '.welcome .icb']].map(([k, s]) => {
                const e = document.querySelector(s); return [k, e && Math.round(e.getBoundingClientRect().height)]; }))""")
        assert sizes == {"sort": 34, "level": 36, "chip": 34, "link": 36, "dismiss": 36}
    finally:
        context.close()


# --- a popover scrolled down -----------------------------------------------------------------------------------------

RING = """pop => {
    const x = pop.querySelector('[data-close]');
    const ring = 4; // base.css: a 2 px outline 2 px outside the control
    const r = x.getBoundingClientRect(), p = pop.getBoundingClientRect();
    return {focused: document.activeElement === x, scrolled: Math.round(pop.scrollTop),
            above: Math.round((p.top + pop.clientTop) - (r.top - ring)), below: Math.round(r.bottom - (p.top + pop.clientTop + pop.clientHeight))};
}"""


@pytest.mark.parametrize("engine", ["chromium", "webkit"])
def test_a_scrolled_popovers_close_button_keeps_its_whole_focus_ring_in_view(request, gated_server, engine):
    """A popover taller than the window scrolls inside itself (What the words mean, on a phone held sideways). Opened
    from the keyboard, its close button has the focus; scrolled down, the button went up under the popover's edge and
    the top of its focus ring (drawn outside the button) was cut first. The title row stays at the top now, the close
    button and its whole ring in view."""
    browser = request.getfixturevalue("browser" if engine == "chromium" else "webkit")
    context = browser.new_context(viewport={"width": 844, "height": 390}, has_touch=True)
    try:
        page = context.new_page()
        page.goto(f"{gated_server.url}/#deals")
        words = page.get_by_role("button", name="What the words mean").first
        words.scroll_into_view_if_needed()
        page.wait_for_timeout(400)                        # a popover closes when the page scrolls: let it settle
        words.focus()
        page.keyboard.press("Enter")
        pop = page.locator("div.pop[role=dialog]")
        expect(pop).to_be_visible()
        assert pop.evaluate("p => p.scrollHeight > p.clientHeight + 40"), "the popover does not scroll here"
        for top in (8, 60, 10_000):                       # a little, more, to the end
            pop.evaluate("(p, top) => { p.scrollTop = top; }", top)
            seen = pop.evaluate(RING)
            assert seen["focused"] and seen["scrolled"] > 0, seen
            assert seen["above"] <= 0 and seen["below"] <= 0, seen
    finally:
        context.close()


# --- the welcome card under 320 px (Safari's page zoom) --------------------------------------------------------------

WELCOME = """() => {
    const card = document.querySelector('.welcome');
    const x = card.querySelector('.icb').getBoundingClientRect();
    const words = [...card.querySelectorAll('.welcome-body > *')].map(e => e.getBoundingClientRect());
    return {overlap: words.filter(w => w.right > x.left + 0.5 && w.top < x.bottom && w.bottom > x.top).length,
            out: words.filter(w => w.right > card.getBoundingClientRect().right).length};
}"""


@pytest.mark.parametrize("engine", ["chromium", "webkit"])
def test_the_welcome_cards_close_button_never_sits_on_its_words(request, server, engine):
    """Under 320 px (a 390 phone at Safari's 150 %) the welcome's two links kept one line, which made its words wider
    than their column: the close button sat on the end of "Tap a deal to open it in Real." """
    browser = request.getfixturevalue("browser" if engine == "chromium" else "webkit")
    context = browser.new_context(viewport={"width": 320, "height": 700}, has_touch=True)
    try:
        page = context.new_page()
        page.goto(f"{server.url}/#today")
        expect(page.locator(".welcome")).to_be_visible()
        bad = []
        for width in range(240, 432, 4):
            page.set_viewport_size({"width": width, "height": 700})
            page.wait_for_timeout(40)
            seen = page.evaluate(WELCOME)
            if seen["overlap"] or seen["out"]:
                bad.append((width, seen))
        assert bad == []
    finally:
        context.close()


# --- Safari's page zoom past 150 % (260 px) --------------------------------------------------------------------------

@pytest.mark.parametrize("who", ["visitor", "member"])
def test_at_260px_passes_sort_and_deals_stay_on_the_screen(make_phone, gated_server, who):
    """A 390 phone at Safari's 150 % lays the page out at 260 px. Passes' Sort button ran off the screen beside "Best
    passes", and a visitor's Deals was 50 px too wide: the locked teaser's title ("38 more deals are hidden") took the
    no-wrap of the section's own heading."""
    visit = make_phone(260, on=gated_server, cookie=gated_server.cookies["in"] if who == "member" else None)
    for tab in ("deals", "passes"):
        open_tab(visit, tab)
        seen = visit.page.evaluate("""() => { const s = [...document.querySelectorAll('main .sortbtn')]
            .filter(b => b.getClientRects().length).map(b => Math.round(b.getBoundingClientRect().right));
            return {wide: document.documentElement.scrollWidth, sort: s}; }""")
        assert seen["wide"] <= 260, (tab, seen)
        assert all(right <= 260 for right in seen["sort"]), (tab, seen)
    visit.assert_clean()


# --- the live pill as its dot alone ----------------------------------------------------------------------------------

DOT_ONLY = """() => {
    const pill = document.querySelector('header.top .live');
    const word = pill.querySelector('.lw');
    const s = getComputedStyle(pill), r = pill.getBoundingClientRect();
    const border = parseFloat(s.borderTopWidth) > 0 && !/rgba\\(.*, 0\\)$|transparent/.test(s.borderTopColor);
    return {dotOnly: getComputedStyle(word).position === 'absolute', said: pill.textContent.trim(),
            capsule: border && Math.abs(r.width - r.height) > 1, w: Math.round(r.width), h: Math.round(r.height)};
}"""


@pytest.mark.parametrize("who, width", [("visitor", 390), ("visitor", 360), ("member", 320)])
def test_the_live_pill_as_its_dot_alone_is_a_round_dot_that_still_says_its_state(make_phone, gated_server, who,
                                                                                   width):
    """Where the bar has no room for its word (a visitor's bar at 390, beside Continue), the pill shows its dot alone and
    its word goes to a screen reader. The dot sat in the pill's outline, 23 x 30 px: an empty capsule, as if something
    had failed to load. It is a round dot now, and still says "Demo" (or "Live") to a screen reader."""
    visit = make_phone(width, on=gated_server, cookie=gated_server.cookies["in"] if who == "member" else None)
    open_tab(visit, "today")
    seen = visit.page.evaluate(DOT_ONLY)
    assert seen["dotOnly"], seen
    assert re.match(r"^(Demo|Live)\b", seen["said"]), seen
    assert not seen["capsule"], seen
    visit.assert_clean()
