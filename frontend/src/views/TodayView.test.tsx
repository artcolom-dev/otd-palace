import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { savePrefs } from "../data/prefs";
import { toOpenUrl } from "../lib/openLink";
import { trackOut } from "../lib/track";
import { animate, freshDevice, renderApp } from "../test/app";
import { makeDeal, makeGone } from "../test/fixtures";
import { NOW, sceneDeals, sceneSnapshot } from "../test/scene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const tops = () => screen.getByRole("region", { name: "Best deals for you right now" });
const tiles = () => within(tops()).getAllByRole("listitem");
const tile = (rank: number) => tiles()[rank - 1]!;
const tileNames = () => tiles().map((t) => within(t).getByRole("heading", { level: 3 }).textContent);
const more = () => screen.getByRole("region", { name: "More deals" });
const listNames = () => within(more()).queryAllByTestId("player").map((p) => p.textContent);
const empty = () => screen.getByRole("region", { name: "Best deal for you right now" });
const regular = (over = {}) =>
  savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000, ...over });
const better = () =>
  makeDeal({
    now: NOW, listing_id: 120, player_id: 120, sport: "nfl", player_name: "Puka Nacua", price: 60, reference: 150,
    discount: 0.6, gap: 90, flip_margin: 65, // the most after fees at New: it ranks first
  });

describe("Today: the visitor's top three", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("puts the first three deals of the visitor's own list on tiles ranked 1 to 3, and the list goes on at 4", () => {
    regular();
    renderApp({ viewport: "desktop" });
    // Allen leaves the most after fees (+142). Jokić is next but falling: under the default sort a falling deal comes
    // after every deal that is not, so it closes the list rather than taking tile 2.
    expect(tileNames()).toEqual(["Josh Allen", "Ja'Marr Chase", "Connor McDavid"]);
    expect(tiles().map((t) => within(t).getByRole("img", { name: /^Rank \d$/ }).getAttribute("aria-label"))).toEqual([
      "Rank 1", "Rank 2", "Rank 3",
    ]);
    expect(within(tile(1)).getByText("Best now")).toBeInTheDocument();
    expect(within(tile(2)).queryByText("Best now")).toBeNull();
    expect(listNames()).toEqual(["Anthony Edwards", "Macklin Celebrini", "Mohamed Salah", "Nikola Jokić"]);
    const ranks = within(more()).getAllByRole("img", { name: /^Rank \d+$/ }).map((r) => r.getAttribute("aria-label"));
    expect(ranks).toEqual(["Rank 4", "Rank 5", "Rank 6", "Rank 7"]);
  });

  it("counts on the sport tabs only the deals under the tiles", () => {
    regular();
    renderApp({ viewport: "desktop" });
    const tabs = within(more()).getByRole("tablist");
    expect(within(tabs).getByRole("tab", { name: /^All/ })).toHaveTextContent("All4");
    expect(within(tabs).getByRole("tab", { name: /^NHL/ })).toHaveTextContent("NHL1"); // McDavid is tile 1
    expect(within(tabs).getByRole("tab", { name: /^NBA/ })).toHaveTextContent("NBA2");
    expect(within(tabs).queryByRole("tab", { name: /^NFL/ })).toBeNull(); // Chase and Allen are tiles: no empty tab
  });

  it("shows the best one in full: who, the big price, how far under usual, the clock sentence, two ways to open", () => {
    renderApp({ viewport: "desktop" });
    const t = tile(1);
    expect(within(t).getByRole("heading", { level: 3 })).toHaveTextContent("Ja'Marr Chase");
    expect(t).toHaveTextContent("NFL 2026");
    expect(t).toHaveTextContent("7.1 rating");
    expect(t).toHaveTextContent("Epic");
    expect(t).toHaveTextContent("fits your 200 max");
    expect(within(t).getByTestId("tile-price")).toHaveTextContent("160to start");
    expect(within(t).getByText("usually sells for 230").tagName).toBe("S");
    expect(within(t).getByTestId("tile-pct")).toHaveTextContent("−30%");
    expect(within(t).getByTestId("hero-how")).toHaveTextContent("Bid 160 to start the 10-min countdown. Listed 4 min ago.");
    expect(within(t).getByRole("link", { name: /Open in Real/ })).toBeInTheDocument();
    expect(within(t).getByRole("button", { name: /Open on phone/ })).toBeInTheDocument();
    expect(within(t).getByRole("button", { name: "Follow Ja'Marr Chase" })).toBeInTheDocument();
    expect(t).not.toHaveTextContent("after fees"); // resale is not New's business
  });

  it("shows the next two short: who, the price, how far under usual, one Open and the phone", () => {
    renderApp({ viewport: "desktop" });
    const t = tile(2);
    expect(within(t).getByRole("heading", { level: 3 })).toHaveTextContent("Anthony Edwards");
    expect(within(t).getByTestId("tile-meta")).toHaveTextContent("NBA 2025-26 · 5.9Rare");
    // The rarity has a line of its own, so a narrow tile never cuts its name ("Co…") on the nowrap line above it.
    const meta = within(t).getByTestId("tile-meta");
    expect(meta.querySelectorAll(".tml")).toHaveLength(2);
    expect(meta.querySelectorAll(".tml")[1]).toHaveTextContent("Rare");
    expect(within(t).getByTestId("tile-price")).toHaveTextContent("70to start");
    expect(within(t).getByText("usually sells for 95").tagName).toBe("S");
    expect(within(t).getByTestId("tile-pct")).toHaveTextContent("−26%");
    expect(within(t).queryByTestId("hero-how")).toBeNull();
    const links = within(t).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Open Anthony Edwards in Real");
    expect(links[0]).toHaveTextContent(/^Open$/);
    expect(within(t).getByRole("button", { name: "Open Anthony Edwards on your phone" })).toBeInTheDocument();
    expect(within(t).getByRole("button", { name: "Follow Anthony Edwards" })).toBeInTheDocument();
  });

  it("is not a link as a whole tile: only its buttons open the deal", () => {
    renderApp();
    for (const t of tiles()) {
      expect(t.closest("a")).toBeNull();
      expect(t.querySelector(".rl")).toBeNull();
    }
  });

  it("shows only the tiles there are, and the list says there is nothing more without a 0 count", () => {
    renderApp(); // New, 200 max: Chase and Edwards only
    expect(tileNames()).toEqual(["Ja'Marr Chase", "Anthony Edwards"]);
    expect(within(more()).queryAllByTestId("player")).toEqual([]);
    expect(more().querySelector("[data-empty]")).toHaveTextContent("hidden at New"); // the list's own nudge
    expect(more()).not.toHaveTextContent(/\b0 more deals?/);
    expect(document.querySelector(".dmeta")).toBeNull(); // no "0 more deals for you" line on a phone
    // Nothing under the tiles: no "All 0" tab, no sort and no words for a list that is not there.
    expect(within(more()).queryByRole("tablist")).toBeNull();
    expect(within(more()).queryByRole("button", { name: /^Sort/ })).toBeNull();
    expect(within(more()).queryByText("Words:")).toBeNull();
  });

  it("counts as hidden at New only the deals New does not show, never the tiles above", () => {
    renderApp(); // New, 200 max: Chase and Edwards are the tiles; Regular at 200 adds Jokić (falling), McDavid and
    // Celebrini (live auctions) and Salah (20% under): four
    expect(tileNames()).toEqual(["Ja'Marr Chase", "Anthony Edwards"]);
    expect(more().querySelector("[data-empty]")).toHaveTextContent(/^4 deals are hidden at New/);
  });

  it("on desktop too, an empty list under the tiles keeps only its nudge", () => {
    renderApp({ viewport: "desktop" });
    expect(tileNames()).toEqual(["Ja'Marr Chase", "Anthony Edwards"]);
    expect(within(more()).queryByRole("tablist")).toBeNull();
    expect(within(more()).queryByRole("button", { name: /^Sort/ })).toBeNull();
    expect(more().querySelector("[data-empty]")).toHaveTextContent("hidden at New");
  });

  it("says how many more deals sit under the tiles on a phone", () => {
    regular();
    renderApp();
    expect(screen.getByText(/more deals? for you/, { selector: ".dmeta" })).toHaveTextContent(/^4 more deals for you/);
  });

  it("shows a live auction's bid and its clock, and a falling price greyed with its tag", () => {
    regular({ sort: "under" }); // McDavid's auction is the biggest % under
    renderApp({ viewport: "desktop" });
    expect(within(tile(1)).getByTestId("tile-price")).toHaveTextContent("64top bid");
    expect(within(tile(1)).getByTestId("hero-how")).toHaveTextContent("Top bid 64: bid more before it ends. Ends in 22 min.");
  });

  it("lets a falling deal hold a tile under another sort, greyed with its tag, a plain tag on a phone", () => {
    regular({ sort: "newest" });
    const desk = renderApp({ viewport: "desktop" });
    expect(tileNames()).toEqual(["Ja'Marr Chase", "Nikola Jokić", "Josh Allen"]);
    expect(within(tile(2)).getByTestId("tile-pct")).toHaveClass("grey");
    expect(within(tile(2)).getByRole("button", { name: /falling/ })).toBeInTheDocument();
    desk.unmount();
    renderApp();
    expect(within(tile(2)).queryByRole("button", { name: /falling/ })).toBeNull(); // no tap target under 44 px
    expect(within(tile(2)).getByText("falling")).toBeInTheDocument();
  });

  it("says Best now only under the default sort, and marks a thin sample or an auction on tiles 2 and 3", () => {
    regular({ sort: "cheapest" });
    renderApp({ viewport: "desktop" });
    expect(tileNames()).toEqual(["Macklin Celebrini", "Mohamed Salah", "Connor McDavid"]);
    expect(screen.queryByText("Best now")).toBeNull();
    expect(within(tile(1)).getByRole("img", { name: "Rank 1" })).toBeInTheDocument();
    expect(within(tile(2)).getByTestId("tile-marks")).toHaveTextContent("thin"); // a usual price under 200
    expect(within(tile(3)).getByTestId("tile-marks")).toHaveTextContent("auction");
  });

  it("marks a medium-confidence sample as thin on a short tile", () => {
    regular();
    renderApp({ viewport: "desktop" });
    expect(within(tile(3)).getByTestId("tile-marks")).toHaveTextContent("thin"); // Josh Allen, 4 sales, Real's estimate
    expect(within(tile(2)).queryByTestId("tile-marks")).toBeNull(); // Chase: 8 sales, usual 230
  });

  it("gives one player one tile: another listing of the same player stays in the list", () => {
    regular();
    const twin = makeDeal({
      now: NOW, listing_id: 130, card_id: 30, sport: "nhl", player_id: 33, player_name: "Connor McDavid", price: 70,
      reference: 112, discount: 0.375, flip_margin: 30,
    });
    renderApp({ viewport: "desktop", snap: sceneSnapshot({ deals: [...sceneDeals(), twin] }) });
    expect(tileNames()).toEqual(["Josh Allen", "Ja'Marr Chase", "Connor McDavid"]);
    expect(listNames()[0]).toBe("Connor McDavid");
  });

  it("counts a click on a list row with its rank on Today", () => {
    regular();
    renderApp({ viewport: "desktop" });
    fireEvent.click(within(more()).getByRole("link", { name: "Open Anthony Edwards in Real" }));
    expect(trackOut).toHaveBeenLastCalledWith({ panel: "deals", target: "listing", level: "regular", sport: "all", pos: 3 });
  });

  it("keeps the list and its pill when every tile went away while a new deal waits", async () => {
    const { push, advance } = renderApp();
    const [chase, edwards] = sceneDeals();
    await push(sceneSnapshot({
      version: 2,
      deals: [better()],
      gone: [makeGone({ ...chase!, reason: "countdown_started", now: NOW }), makeGone({ ...edwards!, reason: "outbid", now: NOW })],
    }));
    await advance(2000);
    fireEvent.click(screen.getByRole("button", { name: /1 new deal/ }));
    expect(tileNames()).toEqual(["Puka Nacua"]);
  });

  it("explains why it's a deal: the usual price with its sample, and from Regular what a resale leaves", () => {
    const first = renderApp({ viewport: "desktop" });
    fireEvent.click(within(tile(1)).getByRole("button", { name: "Explain why it's a deal" }));
    const sheet = screen.getByRole("dialog", { name: "Why it's a deal" });
    expect(sheet).toHaveTextContent("8 sales this week put it near 230, and a player listed it, not Real.");
    expect(sheet).toHaveTextContent("Middle price of the last 8 sales of this card type, past 7 days.");
    expect(sheet).not.toHaveTextContent("After fees");
    first.unmount();
    regular({ sort: "under" }); // McDavid's auction first
    renderApp({ viewport: "desktop" });
    fireEvent.click(within(tile(1)).getByRole("button", { name: "Explain why it's a deal" }));
    const full = screen.getByRole("dialog", { name: "Why it's a deal" });
    expect(full).toHaveTextContent("+19 if resold at 104");
    expect(full).toHaveTextContent("11.6 per rating pt");
    expect(full).toHaveTextContent("Live auction; this is the bid to beat.");
  });

  it("tags a tile whose deal leaves no profit after fees, and its explanation says so plainly", () => {
    regular({ sort: "cheapest" }); // Celebrini first: 62 usual, 46 top bid, -1 after fees
    renderApp({ viewport: "desktop" });
    expect(within(tile(1)).getByRole("button", { name: /no profit after fees/ })).toBeInTheDocument();
    fireEvent.click(within(tile(1)).getByRole("button", { name: "Explain why it's a deal" }));
    const sheet = screen.getByRole("dialog", { name: "Why it's a deal" });
    expect(sheet).toHaveTextContent("Below its usual price, but no profit to resell after fees.");
  });

  it("opens the auction in Real from any tile, counts the click with its rank and marks the deal opened", () => {
    renderApp();
    const open = within(tile(1)).getByRole("link", { name: /Open in Real/ });
    expect(open).toHaveAttribute("href", toOpenUrl(sceneDeals()[0]!.url, navigator.userAgent));
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(open);
    expect(trackOut).toHaveBeenCalledWith({ panel: "hero", target: "listing", level: "new", sport: "all", pos: 0 });
    expect(local.isOpened(101)).toBe(true);
    fireEvent.click(within(tile(2)).getByRole("link", { name: "Open Anthony Edwards in Real" }));
    expect(trackOut).toHaveBeenLastCalledWith({ panel: "hero", target: "listing", level: "new", sport: "all", pos: 1 });
    expect(local.isOpened(104)).toBe(true);
  });

  it("counts a middle-click on Open in Real too", () => {
    renderApp();
    fireEvent(within(tile(1)).getByRole("link", { name: /Open in Real/ }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(trackOut).toHaveBeenCalledWith({ panel: "hero", target: "listing", level: "new", sport: "all", pos: 0 });
    expect(local.isOpened(101)).toBe(true);
  });

  it("offers to open on a phone with a QR code on desktop only, counted and marked opened", async () => {
    const { unmount } = renderApp();
    expect(within(tops()).queryByRole("button", { name: /on (your )?phone/ })).not.toBeInTheDocument();
    unmount();
    const { advance } = renderApp({ viewport: "desktop" });
    fireEvent.click(within(tile(1)).getByRole("button", { name: /Open on phone/ }));
    const pop = screen.getByRole("dialog", { name: "Open on your phone" });
    await vi.dynamicImportSettled(); // the generator loads when the first code is asked for
    await advance(0);
    const qr = within(pop).getByRole("img", { name: /QR code/ });
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d/);
    expect(pop).toHaveTextContent("Ja'Marr Chase · 160 to start");
    expect(trackOut).toHaveBeenCalledWith({ panel: "hero", target: "listing", level: "new", sport: "all", pos: 0 });
    expect(local.isOpened(101)).toBe(true);
  });

  it("keeps its order when a better deal arrives: it waits behind the pill, and a tap ranks it", async () => {
    const { push } = renderApp();
    await push(sceneSnapshot({ version: 2, deals: [...sceneDeals(), better()] }));
    expect(tileNames()).toEqual(["Ja'Marr Chase", "Anthony Edwards"]);
    fireEvent.click(screen.getByRole("button", { name: /1 new deal/ }));
    expect(tileNames()).toEqual(["Puka Nacua", "Ja'Marr Chase", "Anthony Edwards"]);
  });

  it("dims a tile whose deal went away, says why, then moves the next deals up with a short rise", async () => {
    const { push, advance } = renderApp();
    await push(sceneSnapshot({
      version: 2, deals: sceneDeals().slice(1), gone: [makeGone({ ...sceneDeals()[0]!, reason: "countdown_started", now: NOW })],
    }));
    expect(tile(1)).toHaveTextContent("Someone started the countdown · finding the next best deal");
    const open = within(tile(1)).getByRole("link", { name: /Open in Real/ });
    expect(open).toHaveAttribute("aria-disabled", "true");
    expect(open).toHaveAccessibleDescription("Someone started the countdown · finding the next best deal");
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    expect(fireEvent(open, middle)).toBe(false); // a middle-click opens nothing either
    animate.mockClear();
    await advance(2000);
    expect(tileNames()).toEqual(["Anthony Edwards"]);
    expect(animate.mock.contexts).toContain(tile(1));
  });

  it("moves nothing while the pointer is on the tiles, and moves up once it leaves", async () => {
    const { push, advance } = renderApp({ viewport: "desktop" });
    fireEvent.pointerEnter(tops(), { pointerType: "mouse" });
    await push(sceneSnapshot({
      version: 2, deals: sceneDeals().slice(1), gone: [makeGone({ ...sceneDeals()[0]!, reason: "countdown_started", now: NOW })],
    }));
    await advance(5000);
    expect(tileNames()).toEqual(["Ja'Marr Chase", "Anthony Edwards"]);
    fireEvent.pointerLeave(tops(), { pointerType: "mouse" });
    await advance(1000);
    expect(tileNames()).toEqual(["Anthony Edwards"]);
  });

  it("moves without the rise when the visitor asks for less motion", async () => {
    const { push, advance } = renderApp({ reducedMotion: true });
    await push(sceneSnapshot({
      version: 2, deals: sceneDeals().slice(1), gone: [makeGone({ ...sceneDeals()[0]!, reason: "outbid", now: NOW })],
    }));
    animate.mockClear();
    await advance(2000);
    expect(tileNames()).toEqual(["Anthony Edwards"]);
    expect(animate.mock.contexts).not.toContain(tile(1));
  });

  it("changes at once when the visitor changes the filter", () => {
    regular(); // at New both deals are tiles, so no sport tab counts any: Regular leaves NBA two under the tiles
    renderApp({ viewport: "desktop" });
    fireEvent.click(screen.getByRole("tab", { name: /NBA/ }));
    expect(tileNames()).toEqual(["Anthony Edwards", "Nikola Jokić"]);
  });

  it("lights up the tile a notification points at", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled as unknown as Element["scrollIntoView"];
    const { advance } = renderApp({ search: "?open=104" });
    await advance(50);
    expect(tile(2)).toHaveClass("alerted");
    expect(scrolled.mock.contexts).toContain(tile(2));
    await advance(8000);
    expect(tile(2)).not.toHaveClass("alerted");
  });

  it("keeps one h1 on Today, the tiles' names under a heading of their own", () => {
    renderApp({ viewport: "desktop" });
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Today"]);
    expect(within(tops()).getByRole("heading", { level: 2 })).toHaveTextContent("Best deals for you right now");
  });

  it("with no deal at all under the budget, nudges to the next preset that has one, and the nudge sets it", () => {
    savePrefs({ level: "new", budget: 50, sport: "all", sort: "best", tab: "today", passBudget: 1000 });
    renderApp();
    expect(within(empty()).getByRole("heading", { level: 2 })).toHaveTextContent("No deal for you right now");
    expect(screen.queryByRole("region", { name: "More deals" })).toBeNull();
    fireEvent.click(within(empty()).getByRole("button", { name: "Show up to 200" }));
    expect(tileNames()).toEqual(["Ja'Marr Chase", "Anthony Edwards"]);
  });

  it("at New with deals only at Regular, says how many wait there and switches level on a click", () => {
    savePrefs({ level: "new", budget: null, sport: "all", sort: "best", tab: "today", passBudget: 1000 });
    const live = [
      makeDeal({ now: NOW, listing_id: 201, kind: "bid", price: 60, reference: 120, ends_at: new Date(NOW + 120_000).toISOString() }),
      makeDeal({ now: NOW, listing_id: 202, kind: "bid", price: 70, reference: 130, ends_at: new Date(NOW + 240_000).toISOString() }),
    ];
    renderApp({ snap: sceneSnapshot({ deals: live }) });
    expect(within(empty()).getByRole("heading", { level: 2 })).toHaveTextContent("No deal for you right now");
    expect(empty()).toHaveTextContent("2 deals are live at Regular: auctions about to end, which New keeps out.");
    fireEvent.click(within(empty()).getByRole("button", { name: "Switch to Regular" }));
    expect(screen.queryByRole("heading", { name: "No deal for you right now" })).toBeNull();
    expect(tileNames().length).toBeGreaterThan(0); // one tile per player
  });

  it("nudges toward any deal that fits a bigger budget, not only the safest ones", () => {
    regular({ budget: 200 });
    const thin = makeDeal({ now: NOW, listing_id: 140, confidence: "medium", ref_sample: 3, price: 300, reference: 420 });
    renderApp({ snap: sceneSnapshot({ deals: [thin] }) });
    expect(within(empty()).getByRole("heading", { level: 2 })).toHaveTextContent("No deal for you right now");
    expect(empty()).toHaveTextContent("Nothing fits your level, budget and sport right now. The cheapest deal is 300.");
    expect(within(empty()).getByRole("button", { name: "Show up to 1,000" })).toBeInTheDocument();
  });

  it("leaves slots for what comes next: since your last visit above the tiles, the opened deals atop the rail", () => {
    renderApp({ viewport: "desktop" });
    const since = document.querySelector("[data-slot=since]");
    expect(since).not.toBeNull();
    expect(since!.compareDocumentPosition(tops()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rail = screen.getByRole("complementary", { name: "Your deals, prices and passes" });
    expect(rail.firstElementChild).toHaveAttribute("data-slot", "opened");
  });
});
