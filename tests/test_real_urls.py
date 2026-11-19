"""Each view of the site has its own address (/deals, /prices, /passes, /plan; "/" is Today), served as the page with
that view's own title, line and canonical address, so a search engine can list each one. Unknown addresses keep their
real 404. /sitemap.xml lists the public views; robots.txt points at it."""

import gzip
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from advisor import web
from advisor.store import SnapshotStore
from advisor.web import create_app
from tests.test_gate_web import as_member, log_in, make as make_gated

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT_TAG = '<script id="snapshot" type="application/json">'
# The built page's head as index.html writes it: a title and a line the server replaces per view.
HTML = ('<!doctype html><html><head><meta charset="UTF-8" /><title>OTD Palace</title>\n'
        '<meta name="description" content="The built line." />\n<!--PREVIEW-->\n</head>'
        "<body><div id=root></div><!--SNAPSHOT--></body></html>")
VIEW_PATHS = ("/", "/deals", "/prices", "/passes", "/plan")
SITE = "https://otdpalace.com"


def client(tmp_path, snapshot=None, html=HTML):
    (tmp_path / "index.html").write_text(html)
    store = SnapshotStore()
    store.publish(snapshot or {"version": 1, "sports": ["nba"]})
    return create_app(store, tmp_path).test_client()


def head_of(page: str) -> str:
    return page.split("</head>", 1)[0]


def meta(page: str, attr: str, name: str) -> list[str]:
    return re.findall(rf'<meta {attr}="{re.escape(name)}" content="([^"]*)"', head_of(page))


def canonical(page: str) -> list[str]:
    return re.findall(r'<link rel="canonical" href="([^"]*)"', head_of(page))


def title(page: str) -> list[str]:
    return re.findall(r"<title>([^<]*)</title>", head_of(page))


@pytest.mark.parametrize("path", VIEW_PATHS)
def test_each_view_has_its_own_address_served_as_the_page(tmp_path, path):
    r = client(tmp_path).get(path)
    assert r.status_code == 200 and r.mimetype == "text/html"
    page = r.get_data(as_text=True)
    assert SNAPSHOT_TAG in page and '<div id=root>' in page
    assert r.headers["Cache-Control"] == "no-cache"


@pytest.mark.parametrize("path", ["/today", "/dealz", "/deals/", "/deals/101", "/Deals", "/plan.html", "/prices/x",
                                  "/admin2", "/account"])
def test_an_unknown_address_keeps_its_real_404(tmp_path, path):
    r = client(tmp_path).get(path)
    assert r.status_code == 404
    assert "Page not found" in r.get_data(as_text=True)


@pytest.mark.parametrize("path", VIEW_PATHS)
def test_each_view_carries_its_own_title_line_and_canonical_address(tmp_path, path):
    page = client(tmp_path).get(path).get_data(as_text=True)
    want_title, want_line = web.VIEWS[path]
    url = SITE + path
    assert title(page) == [want_title]
    assert meta(page, "name", "description") == [want_line]
    assert canonical(page) == [url]
    assert meta(page, "property", "og:title") == [want_title]
    assert meta(page, "property", "og:description") == [want_line]
    assert meta(page, "property", "og:url") == [url]
    assert meta(page, "property", "og:image") == [f"{SITE}/og.png"]  # the one picture of the site, for now
    assert "The built line." not in page and "<!--PREVIEW-->" not in page


def test_the_views_titles_and_lines_differ_and_name_the_site(tmp_path):
    titles = [web.VIEWS[p][0] for p in VIEW_PATHS]
    lines = [web.VIEWS[p][1] for p in VIEW_PATHS]
    assert len(set(titles)) == len(titles) and len(set(lines)) == len(lines)
    assert all("OTD Palace" in t and len(t) <= 70 for t in titles)
    assert all(50 <= len(line) <= 170 for line in lines)
    assert set(web.VIEWS) == set(VIEW_PATHS)


def test_the_canonical_address_is_the_gates_public_one_when_there_is_a_gate(tmp_path):
    c, gate, _ = make_gated(tmp_path)
    (tmp_path / "index.html").write_text(HTML)
    page = c.get("/passes").get_data(as_text=True)
    assert canonical(page) == [f"{gate.public_url}/passes"]
    assert meta(page, "property", "og:url") == [f"{gate.public_url}/passes"]
    assert meta(page, "property", "og:image") == [f"{gate.public_url}/og.png"]


def test_a_view_page_is_made_once_per_snapshot_and_view_and_gzipped(tmp_path):
    c = client(tmp_path)
    first, again = c.get("/deals"), c.get("/deals")
    assert first.get_data() == again.get_data()
    packed = c.get("/deals", headers={"Accept-Encoding": "gzip"})
    assert packed.headers["Content-Encoding"] == "gzip" and "accept-encoding" in packed.headers["Vary"].lower()
    assert gzip.decompress(packed.get_data()) == first.get_data()
    # Each view keeps its own page: asking for one never hands out another's head.
    assert canonical(c.get("/").get_data(as_text=True)) == [SITE + "/"]
    assert canonical(c.get("/deals").get_data(as_text=True)) == [SITE + "/deals"]
    assert canonical(c.get("/prices").get_data(as_text=True)) == [SITE + "/prices"]


def test_a_new_snapshot_reaches_every_view(tmp_path):
    (tmp_path / "index.html").write_text(HTML)
    store = SnapshotStore()
    store.publish({"version": 1, "sports": ["nba"]})
    c = create_app(store, tmp_path).test_client()
    assert '"version":1' in c.get("/plan").get_data(as_text=True)
    store.publish({"version": 2, "sports": ["nba"]})
    assert '"version":2' in c.get("/plan").get_data(as_text=True)


def test_a_view_answers_503_while_the_front_end_is_not_built(tmp_path):
    store = SnapshotStore()
    store.publish({"version": 1})
    r = create_app(store, tmp_path).test_client().get("/deals")
    assert r.status_code == 503


def test_a_page_without_the_markers_is_served_unchanged_but_for_the_snapshot(tmp_path):
    html = "<html><body><div id=root></div><!--SNAPSHOT--></body></html>"
    page = client(tmp_path, html=html).get("/deals").get_data(as_text=True)
    assert page.startswith("<html><body><div id=root></div>" + SNAPSHOT_TAG)


def test_with_the_gate_each_view_gets_the_free_site_or_the_members_page_like_home(tmp_path):
    c, _, _ = make_gated(tmp_path)
    anon = c.get("/deals").get_data(as_text=True)
    assert '"locked":' in anon and "Secret Name" not in anon
    assert '{"gate":true,"member":false,"state":"anon"}' in anon
    session = log_in(c, "/deals")
    member = c.get("/deals", headers=as_member(session)).get_data(as_text=True)
    assert "Secret Name" in member and '"locked":' not in member
    assert '{"gate":true,"member":true,"state":"in"}' in member


# --- the sitemap and robots.txt ---------------------------------------------------------------------------------------


def sitemap_urls(body: bytes) -> list[str]:
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    return [loc.text for loc in ET.fromstring(body).findall("s:url/s:loc", ns)]


def test_the_sitemap_lists_the_public_views_and_nothing_private(tmp_path):
    r = client(tmp_path).get("/sitemap.xml")
    assert r.status_code == 200 and r.mimetype == "application/xml"
    urls = sitemap_urls(r.get_data())
    assert urls == [SITE + p for p in VIEW_PATHS] + [SITE + "/privacy"]
    body = r.get_data(as_text=True)
    assert "/admin" not in body and "/a/" not in body and "/d/" not in body and "/api/" not in body
    assert "max-age" in r.headers["Cache-Control"]


def test_the_sitemap_uses_the_gates_public_address(tmp_path):
    c, gate, _ = make_gated(tmp_path)
    r = c.get("/sitemap.xml")
    assert r.status_code == 200
    assert sitemap_urls(r.get_data())[0] == gate.public_url + "/"
    assert "cookie" not in r.headers.get("Vary", "").lower()  # the same list for everyone


def test_the_sitemap_answers_even_before_the_front_end_is_built(tmp_path):
    store = SnapshotStore()
    assert create_app(store, tmp_path).test_client().get("/sitemap.xml").status_code == 200


def test_robots_txt_points_at_the_sitemap():
    robots = (ROOT / "frontend" / "public" / "robots.txt").read_text()
    assert "Sitemap: https://otdpalace.com/sitemap.xml" in robots.splitlines()
    assert "Allow: /" in robots.splitlines()


# --- what stays out of a search engine --------------------------------------------------------------------------------


def test_an_accounts_page_tells_search_engines_not_to_list_it(tmp_path):
    class Importer:
        def lookup(self, name):
            raise AssertionError("never read")

        def cached(self, name):
            return None

    (tmp_path / "index.html").write_text(HTML)
    c = create_app(SnapshotStore(), tmp_path, importer=Importer()).test_client()
    r = c.get("/a/someone")
    assert r.status_code == 200
    assert '<meta name="robots" content="noindex">' in r.get_data(as_text=True)


def test_the_views_are_listable_by_search_engines(tmp_path):
    page = client(tmp_path).get("/deals").get_data(as_text=True)
    assert "noindex" not in page
