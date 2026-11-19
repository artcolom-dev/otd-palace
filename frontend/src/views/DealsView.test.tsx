import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { type Prefs, savePrefs } from "../data/prefs";
import { toOpenUrl } from "../lib/openLink";
import { trackOut } from "../lib/track";
import { freshDevice, renderApp } from "../test/app";
import { RULES, isoAt, makeDeal, makeGone } from "../test/fixtures";
import { NOW, sceneDeals, sceneSnapshot } from "../test/scene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const prefs = (over: Partial<Prefs> = {}) =>
  savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000, ...over });
const table = () => screen.getByRole("table", { name: "All deals" });
const bodyRows = () => within(table()).getAllByRole("row").slice(1);
const rowNames = () => bodyRows().map((r) => within(r).getByTestId("player").textContent);
const row = (name: string) => bodyRows().find((r) => within(r).getByTestId("player").textContent === name)!;
const headers = () => within(table()).getAllByRole("columnheader").map((h) => h.textContent?.trim()).filter(Boolean);
const list = () => screen.getByRole("list", { name: "All deals" });

describe("Deals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("columns and words", () => {
    it("keeps New to the basics", () => {
      prefs({ level: "new", budget: 200 });
      renderApp({ viewport: "desktop" });
      expect(headers()).toEqual(["Player", "Price", "Usual", "Cheaper", "Clock", "Open"]);
    });

    it("adds per rating pt, bids and after fees at Regular and Pro", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      expect(headers()).toEqual(["Player", "Price", "Per rating pt", "Usual", "Under", "Clock", "Bids", "After fees", "Open"]);
    });

    it("words each row the way a newcomer reads it", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      expect(row("Anthony Edwards")).toHaveTextContent("5.9 rating · Rare · NBA 2025-26");
      expect(within(row("Anthony Edwards")).getByRole("button", { name: "to start" })).toBeInTheDocument();
      expect(within(row("Connor McDavid")).getByRole("button", { name: "top bid" })).toBeInTheDocument();
      expect(row("Anthony Edwards")).toHaveTextContent("listed 9 m ago");
      expect(row("Connor McDavid")).toHaveTextContent("ends in 22 m");
      expect(within(row("Anthony Edwards")).getByTestId("pct")).toHaveTextContent("26%");
      expect(table()).not.toHaveTextContent(/pts|fair value/);
    });

    it("counts a Pro's sales in words on the phone list: 1 sale, 33 sales", () => {
      prefs({ level: "pro", budget: null });
      const one = makeDeal({ now: NOW, listing_id: 900, player_name: "Single Sale", ref_sample: 1, confidence: "medium" });
      renderApp({ snap: sceneSnapshot({ deals: [...sceneDeals(), one] }) });
      const item = (name: string) =>
        within(list()).getAllByRole("listitem").find((li) => within(li).queryByText(name)) as HTMLElement;
      expect(item("Single Sale")).toHaveTextContent("· 1 sale");
      expect(item("Single Sale")).not.toHaveTextContent("1 sales");
      expect(item("Mohamed Salah")).toHaveTextContent("· 33 sales");
    });

    it("tells two cards that read the same apart by their mint numbers, on the phone list and in the table", () => {
      prefs();
      const edwards = sceneDeals().find((d) => d.player_name === "Anthony Edwards")!;
      const copy = { ...edwards, listing_id: 901, card_id: 9901, mint: 77 };
      const snap = sceneSnapshot({ deals: [...sceneDeals(), copy] });
      const { unmount } = renderApp({ snap });
      const items = within(list()).getAllByRole("listitem").filter((li) => within(li).queryByText("Anthony Edwards"));
      expect(items.map((li) => li.textContent?.match(/#\d+/)?.[0]).sort()).toEqual(["#140", "#77"]);
      const salah = within(list()).getAllByRole("listitem").find((li) => within(li).queryByText("Mohamed Salah"))!;
      expect(salah).not.toHaveTextContent("#");
      unmount();
      renderApp({ snap, viewport: "desktop" });
      const rows = bodyRows().filter((r) => within(r).getByTestId("player").textContent === "Anthony Edwards");
      expect(rows.map((r) => r.textContent?.match(/#\d+/)?.[0]).sort()).toEqual(["#140", "#77"]);
      expect(row("Mohamed Salah")).not.toHaveTextContent("#");
    });

    it("says cheaper to New and under at Regular, on the phone list", () => {
      prefs({ level: "new", budget: 200 });
      const { unmount } = renderApp();
      expect(within(list()).getAllByRole("listitem")[1]).toHaveTextContent("26%cheaper");
      unmount();
      prefs();
      renderApp();
      expect(list()).toHaveTextContent("26%under");
    });
  });

  describe("after fees and falling", () => {
    it("always shows after fees at Regular: grey and thin under 200, a loss as a loss", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      const af = (name: string) => within(row(name)).getByTestId("after-fees");
      expect(af("Josh Allen")).toHaveTextContent("+142");
      expect(af("Josh Allen")).not.toHaveClass("thin");
      expect(af("Anthony Edwards")).toHaveTextContent("+5");
      expect(af("Anthony Edwards")).toHaveClass("thin");
      expect(row("Anthony Edwards")).toHaveTextContent("thin");
      expect(af("Mohamed Salah")).toHaveTextContent("−4");
      expect(af("Mohamed Salah")).toHaveClass("loss");
    });

    it("labels a deal that leaves no profit after fees, without hiding it, at every level and on the phone", () => {
      // A 40 Rax card at 28: 30 % under, but 36 - 10 - 28 = -2 after fees.
      const low = makeDeal({
        listing_id: 901, card_id: 901, player_id: 901, player_name: "Low Card", price: 28, reference: 40, discount: 0.3,
        gap: 12, flip_margin: -2, ends_at: isoAt(NOW + 3 * 3_600_000), listed_at: isoAt(NOW - 600_000),
      });
      const snap = sceneSnapshot({ deals: [...sceneDeals(), low] });
      const tag = (name: string) => within(row(name)).queryByRole("button", { name: /no profit after fees/ });
      prefs({ level: "new", budget: 200 });
      const first = renderApp({ viewport: "desktop", snap });
      expect(tag("Low Card")).toBeInTheDocument();
      first.unmount();
      prefs();
      const second = renderApp({ viewport: "desktop", snap });
      expect(tag("Mohamed Salah")).toBeInTheDocument();
      expect(tag("Josh Allen")).toBeNull();
      // Last in the default order: the deals that leave a profit come first.
      expect(rowNames().at(-1)).toBe("Mohamed Salah");
      second.unmount();
      prefs({ level: "new", budget: 200 });
      renderApp({ viewport: "phone", snap });
      const item = within(list()).getAllByRole("listitem").find((li) => li.textContent?.includes("Low Card"))!;
      expect(item).toHaveTextContent("Below its usual price, but no profit to resell after fees");
    });

    it("never shows falling deals to New; Regular greys their % and tags them", () => {
      prefs({ level: "new", budget: 200 });
      const { unmount } = renderApp({ viewport: "desktop" });
      expect(screen.queryByText("Nikola Jokić")).not.toBeInTheDocument();
      unmount();
      prefs();
      renderApp({ viewport: "desktop" });
      expect(within(row("Nikola Jokić")).getByRole("button", { name: /falling/ })).toBeInTheDocument();
      expect(within(row("Nikola Jokić")).getByTestId("pct")).toHaveClass("grey");
    });
  });

  describe("every deal opens its auction", () => {
    it("on desktop: an Open button per row, counted, then marked Opened", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      const open = within(row("Anthony Edwards")).getByRole("link", { name: /Open Anthony Edwards in Real/ });
      const deal = sceneDeals().find((d) => d.listing_id === 104)!;
      expect(open).toHaveAttribute("href", toOpenUrl(deal.url, navigator.userAgent));
      expect(open).toHaveAttribute("target", "_blank");
      expect(open).toHaveAttribute("rel", "noopener noreferrer");
      fireEvent.click(open);
      const pos = rowNames().indexOf("Anthony Edwards");
      expect(trackOut).toHaveBeenCalledWith({ panel: "deals", target: "listing", level: "regular", sport: "all", pos });
      expect(local.isOpened(104)).toBe(true);
      expect(within(row("Anthony Edwards")).getByRole("link", { name: /Opened/ })).toBeInTheDocument();
      expect(within(row("Anthony Edwards")).getByRole("button", { name: /Open Anthony Edwards on your phone/ }))
        .toBeInTheDocument();
    });

    it("on desktop: a middle-click on Open and the QR code are counted as opens too", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      const pos = (name: string) => rowNames().indexOf(name);
      const open = within(row("Anthony Edwards")).getByRole("link", { name: /Open Anthony Edwards in Real/ });
      fireEvent(open, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      expect(trackOut).toHaveBeenLastCalledWith({
        panel: "deals", target: "listing", level: "regular", sport: "all", pos: pos("Anthony Edwards"),
      });
      expect(local.isOpened(104)).toBe(true);
      fireEvent.click(within(row("Mohamed Salah")).getByRole("button", { name: "Open Mohamed Salah on your phone" }));
      expect(screen.getByRole("dialog", { name: "Open on your phone" })).toHaveTextContent("Mohamed Salah");
      expect(trackOut).toHaveBeenLastCalledWith({
        panel: "deals", target: "listing", level: "regular", sport: "all", pos: pos("Mohamed Salah"),
      });
      expect(local.isOpened(107)).toBe(true);
    });

    it("on a phone: the whole row is the link, named by its visible name and price, read once", () => {
      prefs();
      renderApp();
      const link = within(list()).getByRole("link", { name: "Anthony Edwards 70 to start" });
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).not.toHaveAttribute("aria-label");
      // the name and price are read as the link's name, not a second time as the row's text
      for (const id of link.getAttribute("aria-labelledby")!.split(" ")) {
        expect(link.closest("li")!.querySelector(`[id="${id}"]`)!.closest("[aria-hidden=true]")).not.toBeNull();
      }
      fireEvent.click(link);
      expect(trackOut).toHaveBeenCalledWith(expect.objectContaining({ panel: "deals", target: "listing" }));
      expect(within(list()).getByRole("link", { name: "Anthony Edwards 70 to start Opened" })).toBe(link);
      expect(link.closest("li")).toHaveTextContent("Opened");
      fireEvent(within(list()).getByRole("link", { name: /^Mohamed Salah/ }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      expect(local.isOpened(107)).toBe(true);
    });
  });

  describe("sort and sport", () => {
    it("sorts in the page, the best after fees first by default, the biggest % under as a choice", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      expect(rowNames()[0]).toBe("Josh Allen"); // +142 after fees, though only 27 % under
      fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
      const menu = screen.getByRole("menu", { name: "Sort deals" });
      expect(within(menu).getAllByRole("menuitemradio").map((b) => b.textContent)).toEqual([
        "Best after fees", "Ending soon", "Newest", "Cheapest", "Biggest % under", "Rarest first", "For passes",
      ]);
      fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Cheapest" }));
      expect(rowNames()[0]).toBe("Macklin Celebrini");
      fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
      fireEvent.click(within(screen.getByRole("menu", { name: "Sort deals" })).getByRole("menuitemradio", { name: "Biggest % under" }));
      expect(rowNames()[0]).toBe("Connor McDavid");
    });

    it("moves through the sort menu with the arrow keys, and Escape gives focus back to its button", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      const trigger = screen.getByRole("button", { name: /Sort/ });
      fireEvent.click(trigger);
      const menu = screen.getByRole("menu", { name: "Sort deals" });
      const item = (name: string) => within(menu).getByRole("menuitemradio", { name });
      expect(item("Best after fees")).toHaveFocus();
      fireEvent.keyDown(item("Best after fees"), { key: "ArrowDown" });
      expect(item("Ending soon")).toHaveFocus();
      fireEvent.keyDown(item("Ending soon"), { key: "ArrowUp" });
      fireEvent.keyDown(item("Best after fees"), { key: "ArrowUp" });
      expect(item("For passes")).toHaveFocus();
      fireEvent.keyDown(item("For passes"), { key: "Home" });
      expect(item("Best after fees")).toHaveFocus();
      fireEvent.keyDown(item("Best after fees"), { key: "End" });
      expect(item("For passes")).toHaveFocus();
      fireEvent.keyDown(item("For passes"), { key: "Escape" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it("moves through the sport tabs with the arrow keys, Home and End, one tab stop for all", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      const tab = (name: RegExp) => screen.getByRole("tab", { name });
      expect(screen.getAllByRole("tab").filter((t) => t.tabIndex === 0)).toEqual([tab(/^All/)]);
      tab(/^All/).focus();
      fireEvent.keyDown(tab(/^All/), { key: "ArrowRight" });
      expect(tab(/^NFL/)).toHaveAttribute("aria-selected", "true");
      expect(tab(/^NFL/)).toHaveFocus();
      fireEvent.keyDown(tab(/^NFL/), { key: "End" });
      expect(tab(/^Soccer/)).toHaveFocus();
      expect(rowNames()).toEqual(["Mohamed Salah"]);
      fireEvent.keyDown(tab(/^Soccer/), { key: "ArrowRight" });
      expect(tab(/^All/)).toHaveFocus();
      fireEvent.keyDown(tab(/^All/), { key: "ArrowLeft" });
      expect(tab(/^Soccer/)).toHaveFocus();
      fireEvent.keyDown(tab(/^Soccer/), { key: "Home" });
      expect(tab(/^All/)).toHaveAttribute("aria-selected", "true");
      expect(screen.getAllByRole("tab").filter((t) => t.tabIndex === 0)).toEqual([tab(/^All/)]);
    });

    it("tabs All and each served sport with its count, and My players once someone is followed", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
      expect(tabs()).toEqual(["All7", "NFL2", "NBA2", "NHL2", "Soccer1"]);
      fireEvent.click(within(row("Nikola Jokić")).getByRole("button", { name: "Follow Nikola Jokić" }));
      expect(tabs()[0]).toBe("My players1");
      expect(local.get().follows).toEqual(["nba:22"]);
      fireEvent.click(screen.getByRole("tab", { name: /My players/ }));
      expect(rowNames()).toEqual(["Nikola Jokić"]);
      fireEvent.click(within(row("Nikola Jokić")).getByRole("link", { name: /Open/ }));
      expect(trackOut).toHaveBeenCalledWith(expect.objectContaining({ sport: "mine", pos: 0 }));
    });

    it("pins a followed player's deals above the rest in All, with a star", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      const star = within(row("Mohamed Salah")).getByRole("button", { name: "Follow Mohamed Salah" });
      fireEvent.click(star);
      expect(star).toHaveAttribute("aria-pressed", "true");
      expect(star).toHaveClass("pop");
      expect(rowNames()[0]).toBe("Mohamed Salah");
    });

    it("says so on the sort button once a star pins players first, and not before", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      expect(screen.queryByText(/Players you star come first/)).toBeNull();
      fireEvent.click(within(row("Mohamed Salah")).getByRole("button", { name: "Follow Mohamed Salah" }));
      expect(screen.getByText("Players you star come first, then best after fees.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
      expect(within(screen.getByRole("menu", { name: "Sort deals" })).getByText("Players you star always come first.")).toBeInTheDocument();
    });
  });

  describe("empty", () => {
    it("nudges to the next budget that has a deal", () => {
      prefs({ level: "new", budget: 50 });
      renderApp({ viewport: "desktop" });
      expect(screen.getByText(/No deals under 50 right now/).closest("[data-empty]")).toHaveTextContent(
        "No deals under 50 right now — the cheapest is 70. Show up to 200?",
      );
      fireEvent.click(screen.getByRole("button", { name: "Show up to 200" }));
      expect(rowNames()).toEqual(["Ja'Marr Chase", "Anthony Edwards"]);
    });
  });

  describe("what the live feed covers", () => {
    const coverage = {
      sports: ["nba", "nfl", "nhl", "soccer"],
      listings_complete: true,
      sales_window_h: 168,
      otd_as_of: "2026-11-12T17:40:00Z",
    };
    const withCoverage = (over: Partial<typeof coverage> = {}, deals = sceneDeals()) =>
      sceneSnapshot({ deals, rules: { ...RULES, coverage: { ...coverage, ...over } } });
    const footer = () => document.querySelector(".tfoot");
    const PARTIAL = "We follow every player of each sport: the top ones about every half hour, the rest every few days, so a new deal can take a while to show.";

    it("says which covered sport has no open listing right now", () => {
      prefs();
      renderApp({ viewport: "desktop", snap: withCoverage({ sports: [...coverage.sports, "mlb", "wnba"] }) });
      expect(footer()).toHaveTextContent("No open listings in MLB and WNBA right now.");
    });

    it("says nothing about sports when every covered sport has listings", () => {
      prefs();
      renderApp({ viewport: "desktop", snap: withCoverage() });
      expect(footer()).not.toHaveTextContent("No open listings");
      expect(footer()).not.toHaveTextContent(PARTIAL);
    });

    it("owns up in the footer and in the empty box when the listings are partial", () => {
      prefs();
      const { unmount } = renderApp({ viewport: "desktop", snap: withCoverage({ listings_complete: false }) });
      expect(footer()).toHaveTextContent(PARTIAL);
      unmount();
      renderApp({ viewport: "desktop", snap: withCoverage({ listings_complete: false }, []) });
      expect(document.querySelector("[data-empty]")).toHaveTextContent(`No deals right now.`);
      expect(document.querySelector("[data-empty]")).toHaveTextContent(PARTIAL);
    });

    it("keeps the plain empty box when the listings are complete", () => {
      prefs();
      renderApp({ viewport: "desktop", snap: withCoverage({}, []) });
      expect(document.querySelector("[data-empty]")).not.toHaveTextContent("missing");
    });

    it("says nothing of the kind on the sample data, which carries no coverage", () => {
      prefs();
      renderApp({ viewport: "desktop" });
      expect(document.body).not.toHaveTextContent("No open listings");
      expect(document.body).not.toHaveTextContent("missing from our feed");
    });
  });

  describe("a list that stays still", () => {
    const fresh = makeDeal({
      now: NOW, listing_id: 130, player_id: 130, sport: "nba", player_name: "Paolo Banchero", price: 58,
      reference: 260, discount: 0.777, gap: 202, flip_margin: 166, // the most after fees: it sorts first
    });

    it("queues new deals behind a pill and inserts them on a tap, with focus on the first one", async () => {
      prefs();
      const { push } = renderApp({ viewport: "desktop" });
      await push(sceneSnapshot({ version: 2, deals: [...sceneDeals(), fresh] }));
      expect(rowNames()).not.toContain("Paolo Banchero");
      const pill = screen.getByRole("button", { name: /1 new deal/ });
      expect(screen.getByTestId("new-deals-said")).toHaveTextContent("1 new deal"); // heard once, politely
      fireEvent.click(pill);
      expect(rowNames()[0]).toBe("Paolo Banchero");
      expect(within(row("Paolo Banchero")).getByText("new")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /new deal/ })).not.toBeInTheDocument();
      expect(within(row("Paolo Banchero")).getByRole("link", { name: /Open Paolo Banchero/ })).toHaveFocus();
    });

    it("moves focus to the first new row on a phone too", async () => {
      prefs();
      const { push } = renderApp({ hash: "deals" });
      await push(sceneSnapshot({ version: 2, deals: [...sceneDeals(), fresh] }));
      fireEvent.click(screen.getByRole("button", { name: /1 new deal/ }));
      expect(within(list()).getByRole("link", { name: /^Paolo Banchero/ })).toHaveFocus();
    });

    it("holds a row that leaves while the pointer is on it, updates the rest in place, and lets go when it leaves", async () => {
      prefs();
      const { push } = renderApp({ viewport: "desktop" });
      const before = rowNames();
      fireEvent.pointerEnter(table(), { pointerType: "mouse" });
      // Allen leaves with no gone record; Salah, last, gets cheap enough to sort first on a merge
      const update = sceneDeals()
        .filter((d) => d.listing_id !== 105)
        .map((d) => (d.listing_id === 107 ? { ...d, price: 20, discount: 0.667 } : d));
      await push(sceneSnapshot({ version: 2, deals: update }));
      expect(rowNames()).toEqual(before);
      expect(row("Josh Allen")).toHaveClass("gone");
      expect(row("Josh Allen")).toHaveTextContent("No longer a deal");
      expect(row("Mohamed Salah")).toHaveTextContent("20");
      fireEvent.pointerLeave(table());
      expect(rowNames()).toEqual(before.filter((n) => n !== "Josh Allen"));
    });

    it("holds rows for a touch and for 1.5 s after a scroll, but never for a touch-pointer hover", async () => {
      prefs();
      const { push, advance } = renderApp({ viewport: "desktop" });
      const without = (id: number) => sceneDeals().filter((d) => d.listing_id !== id);
      fireEvent.pointerEnter(table(), { pointerType: "touch" });
      fireEvent.touchStart(table());
      await push(sceneSnapshot({ version: 2, deals: without(105) }));
      expect(rowNames()).toContain("Josh Allen");
      fireEvent.touchEnd(table());
      expect(rowNames()).not.toContain("Josh Allen");

      await push(sceneSnapshot({ version: 3, deals: sceneDeals() })); // Allen is back, behind the pill
      fireEvent.click(screen.getByRole("button", { name: /1 new deal/ }));
      expect(rowNames()).toContain("Josh Allen");
      setTimeout(() => fireEvent.scroll(window), 4000); // a scroll one second before the next poll lands
      await push(sceneSnapshot({ version: 4, deals: without(105) }));
      expect(rowNames()).toContain("Josh Allen");
      await advance(400);
      expect(rowNames()).toContain("Josh Allen");
      await advance(200);
      expect(rowNames()).not.toContain("Josh Allen");
    });

    it("takes a tap on the pill while frozen: the arrivals go in, and the rows it was holding go", async () => {
      prefs();
      const { push } = renderApp({ viewport: "desktop" });
      fireEvent.pointerEnter(table(), { pointerType: "mouse" });
      await push(sceneSnapshot({ version: 2, deals: [...sceneDeals().filter((d) => d.listing_id !== 105), fresh] }));
      expect(rowNames()).toContain("Josh Allen");
      expect(rowNames()).not.toContain("Paolo Banchero");
      fireEvent.click(screen.getByRole("button", { name: /1 new deal/ }));
      expect(rowNames()[0]).toBe("Paolo Banchero");
      expect(rowNames()).not.toContain("Josh Allen");
      fireEvent.pointerLeave(table());
      expect(rowNames()[0]).toBe("Paolo Banchero");
    });

    it("dims a deal that went away in its place, with the reason, and never shows one that was not on screen", async () => {
      prefs();
      const { push } = renderApp({ viewport: "desktop" });
      const before = rowNames();
      const mcdavid = sceneDeals().find((d) => d.listing_id === 103)!;
      await push(sceneSnapshot({
        version: 2,
        deals: sceneDeals().filter((d) => d.listing_id !== 103),
        gone: [
          makeGone({ ...mcdavid, reason: "outbid", now: NOW }),
          makeGone({ listing_id: 999, player_name: "Never Shown", sport: "nba", now: NOW }),
        ],
      }));
      expect(rowNames()).toEqual(before);
      expect(row("Connor McDavid")).toHaveTextContent("Outbid");
      expect(row("Connor McDavid")).toHaveClass("gone");
      expect(screen.queryByText("Never Shown")).not.toBeInTheDocument();
      await push(sceneSnapshot({ version: 3, deals: sceneDeals().filter((d) => d.listing_id !== 103), gone: [] }));
      expect(rowNames()).not.toContain("Connor McDavid");
    });
  });

  describe("countdowns", () => {
    it("tick, turn orange under a minute, flash +1 min when a late bid extends them, and leave at zero", async () => {
      prefs();
      const { push, advance } = renderApp({ viewport: "desktop" });
      const clock = () => within(row("Macklin Celebrini")).getByTestId("clock");
      expect(clock()).toHaveTextContent("ends in 0:49");
      expect(clock()).toHaveClass("hot");
      await advance(5000);
      expect(clock()).toHaveTextContent("ends in 0:44");
      const extended = sceneDeals().map((d) => (d.listing_id === 106 ? { ...d, ends_at: isoAt(NOW + 109_000) } : d));
      await push(sceneSnapshot({ version: 2, deals: extended }));
      expect(within(row("Macklin Celebrini")).getByText("+1 min")).toBeInTheDocument();
      await advance(120_000);
      expect(rowNames()).not.toContain("Macklin Celebrini");
    });
  });
});
