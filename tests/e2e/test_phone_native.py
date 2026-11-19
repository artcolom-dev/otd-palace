"""What makes the phone site behave like an app, in a real browser at 390x844 (see conftest.py): the page under an
open sheet stays put, and each tab keeps where it was read to."""

import pytest
from playwright.sync_api import expect

from tests.e2e.conftest import VIEWPORTS


@pytest.fixture
def phone_visit(make_visit):
    return make_visit(*VIEWPORTS["phone"])


def tab(page, name: str):
    return page.get_by_role("navigation", name="Sections").get_by_role("link", name=name)


def touch_scroll(page, y: int, distance: int) -> None:
    """A finger dragged up the screen by `distance` px from (200, y): Chromium's own touch scroll."""
    cdp = page.context.new_cdp_session(page)
    cdp.send("Input.synthesizeScrollGesture",
             {"x": 200, "y": y, "yDistance": -distance, "gestureSourceType": "touch", "speed": 1500})
    cdp.detach()
    page.wait_for_timeout(300)


def test_the_page_under_an_open_sheet_does_not_scroll(phone_visit):
    visit = phone_visit
    page = visit.page
    visit.go("/#deals")
    page.get_by_role("button", name="Sort").first.click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible()
    visit.settle(500)
    before = page.evaluate("scrollY")
    touch_scroll(page, 120, 400)  # on the dimmed page above the sheet
    assert page.evaluate("scrollY") == before
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    touch_scroll(page, 500, 400)
    assert page.evaluate("scrollY") > before  # closed, the page scrolls again
    visit.assert_clean()


def test_each_tab_keeps_where_it_was_read_to(phone_visit):
    visit = phone_visit
    page = visit.page
    visit.go("/#deals")
    expect(page.get_by_role("heading", level=1, name="All deals")).to_be_attached()
    visit.settle(300)
    page.evaluate("window.scrollTo(0, 700)")
    visit.settle(200)
    read_to = page.evaluate("scrollY")
    assert read_to > 600

    tab(page, "Prices").click()
    expect(page.get_by_role("heading", level=1, name="Prices moving today")).to_be_attached()
    visit.settle(300)
    assert page.evaluate("scrollY") == 0  # a tab not yet read starts at its top

    tab(page, "Deals").click()
    expect(page.get_by_role("heading", level=1, name="All deals")).to_be_attached()
    visit.settle(300)
    assert abs(page.evaluate("scrollY") - read_to) <= 2  # back where it was left

    tab(page, "Deals").click()  # the open tab again: back to its top
    for _ in range(20):  # it glides there (the site's CSP forbids wait_for_function's eval)
        if page.evaluate("scrollY") == 0:
            break
        visit.settle(100)
    assert page.evaluate("scrollY") == 0

    page.evaluate("window.scrollTo(0, 400)")
    visit.settle(200)
    tab(page, "Prices").click()
    expect(page.get_by_role("heading", level=1, name="Prices moving today")).to_be_attached()
    visit.settle(300)
    page.go_back()  # the back button lands on the page as it was left too
    expect(page.get_by_role("heading", level=1, name="All deals")).to_be_attached()
    visit.settle(300)
    assert abs(page.evaluate("scrollY") - 400) <= 2
    visit.assert_clean()


def test_todays_list_under_the_top_three_shows_whole_names_at_390(phone_visit):
    """The rank (4, 5, 6...) rides on the face, as the top three's do on their cards, so the name keeps the room."""
    visit = phone_visit
    page = visit.page
    visit.go("/#today")
    names = page.locator("ul.list.ranked .nmt")
    expect(names.first).to_be_visible()
    cut = names.evaluate_all("els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent)")
    assert cut == []
    ranks = page.locator("ul.list.ranked .rk[role=img]")
    assert ranks.first.get_attribute("aria-label") == "Rank 4"
    face = page.locator("ul.list.ranked .pav").first.bounding_box()
    rank = ranks.first.bounding_box()
    assert rank["x"] < face["x"] + face["width"] / 2 and rank["y"] < face["y"] + face["height"] / 2  # on the face's corner
    visit.assert_clean()
