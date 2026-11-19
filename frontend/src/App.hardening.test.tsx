// The front end's answers to the site audit: paused data that says so, a first load that cannot get the market,
// sample data that never passes for the live market, one title per tab, and counts that agree.
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePrefs } from "./data/prefs";
import { freshDevice, renderApp, restoreVisibility } from "./test/app";
import { RULES } from "./test/fixtures";
import { passSnapshot } from "./test/passScene";
import { sceneSnapshot } from "./test/scene";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));

const nav = () => screen.getByRole("navigation", { name: "Sections" });
const hero = () => screen.getByRole("region", { name: "Best deals for you right now" });
const tiles = () => within(hero()).getAllByRole("listitem");
const offline = () => Promise.reject(new TypeError("offline"));
const PAUSED = "Paused · prices may have changed";

describe("site audit, front end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreVisibility();
    document.title = "";
  });

  describe("when the server stops answering (I4)", () => {
    it("pauses after two failed polls, long before the data is old, and both pills say the same words", async () => {
      const desk = renderApp({ viewport: "desktop", respond: offline });
      expect(screen.getByTestId("live-line")).toHaveTextContent(/^Live/);
      await desk.advance(10_000);
      expect(screen.getByTestId("live-line")).toHaveTextContent(PAUSED);
      desk.unmount();

      const phone = renderApp({ respond: offline });
      await phone.advance(10_000);
      expect(screen.getByTestId("live-pill")).toHaveTextContent(PAUSED);
    });

    it.each(["phone", "desktop"] as const)("dims every top tile and labels every Open, which stays usable (%s)", async (viewport) => {
      const { advance } = renderApp({ viewport, respond: offline });
      for (const t of tiles()) expect(t).not.toHaveAttribute("data-stale");
      expect(within(hero()).queryByText(PAUSED)).toBeNull();

      await advance(10_000);
      for (const t of tiles()) expect(t).toHaveAttribute("data-stale");
      const notice = within(hero()).getByRole("status"); // said once, above the best tile's buttons
      expect(notice).toHaveTextContent(PAUSED);
      const opens = within(hero()).getAllByRole("link", { name: /^Open/ });
      expect(opens).toHaveLength(2);
      for (const open of opens) {
        expect(open).toHaveAttribute("href");
        expect(open).not.toHaveAttribute("aria-disabled");
        expect(open).toHaveAccessibleDescription(PAUSED);
        expect(open.getAttribute("aria-describedby")).toBe(notice.id);
      }
    });

    it("says paused in the phone's count line, and drops the deals-taken count it can no longer vouch for", async () => {
      savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000 });
      const { advance } = renderApp({ respond: offline, snap: sceneSnapshot({ taken_10m: 3 }) });
      const line = () => screen.getByText(/for you/, { selector: ".dmeta" });
      expect(line()).toHaveTextContent(/^\d+ deals for you · 3 taken in the last 10 min$/);
      await advance(10_000);
      expect(line()).toHaveTextContent(/^Paused · \d+ deals for you$/);
    });

    it("marks Moving today as paused and describes its rows by it", async () => {
      const { advance } = renderApp({ viewport: "desktop", respond: offline });
      const moving = () => screen.getByRole("region", { name: "Moving today" });
      expect(moving()).not.toHaveAttribute("data-stale");
      await advance(10_000);
      expect(moving()).toHaveAttribute("data-stale");
      expect(moving()).toHaveTextContent(PAUSED);
      const rows = within(moving()).getAllByRole("link", { name: /^See deals for/ });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toHaveAccessibleDescription(PAUSED);
    });

    it.each(["phone", "desktop"] as const)("describes every row's Open as paused, links kept (%s)", async (viewport) => {
      savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000 });
      const { advance } = renderApp({ viewport, respond: offline });
      const list = () =>
        viewport === "phone" ? screen.getByRole("list", { name: "All deals" }) : screen.getByRole("table", { name: "All deals" });
      const opens = () => within(list()).getAllByRole("link");
      for (const open of opens()) expect(open).not.toHaveAccessibleDescription(PAUSED);
      await advance(10_000);
      expect(opens().length).toBeGreaterThan(2);
      for (const open of opens()) {
        expect(open).toHaveAttribute("href");
        expect(open).toHaveAccessibleDescription(PAUSED);
      }
    });

    it("comes back to live on the next answer", async () => {
      let down = true;
      const { advance } = renderApp({
        viewport: "desktop",
        respond: () => (down ? offline() : new Response(null, { status: 304 })),
      });
      await advance(10_000);
      expect(tiles()[0]).toHaveAttribute("data-stale");
      down = false;
      await advance(5_000);
      expect(tiles()[0]).not.toHaveAttribute("data-stale");
      expect(screen.getByTestId("live-line")).toHaveTextContent(/^Live/);
    });
  });

  describe("a first load that cannot get the market (I5)", () => {
    it.each([
      ["the server does not answer", () => new Response(JSON.stringify({ error: "warming up" }), { status: 503 })],
      ["the answer cannot be read", () => new Response(JSON.stringify({ version: 3 }), { status: 200 })],
    ])("says so after three failed polls when %s, with Retry and the footer", async (_name, respond) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { advance, fetchImpl } = renderApp({ snap: null, respond });
      await advance(0);
      await advance(5_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("skeleton")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();

      await advance(5_000);
      expect(screen.getByRole("alert")).toHaveTextContent("Can't load the market right now. Retrying every few seconds.");
      expect(screen.getByText("Not affiliated with Real.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await advance(0);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it("shows the market as soon as Retry gets it", async () => {
      let up = false;
      const { advance } = renderApp({
        snap: null,
        respond: () =>
          up
            ? new Response(JSON.stringify(sceneSnapshot()), { status: 200, headers: { ETag: '"1"' } })
            : new Response(null, { status: 503 }),
      });
      await advance(10_000);
      up = true;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await advance(0);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(hero()).toBeInTheDocument();
    });
  });

  describe("sample data (I7)", () => {
    const demo = () => sceneSnapshot({ rules: { ...RULES, demo: true } });
    const BANNER = "Sample data, not the live market";

    it.each(["phone", "desktop"] as const)("says so on every tab, and the pill reads Demo (%s)", (viewport) => {
      renderApp({ viewport, snap: { ...demo(), otd: passSnapshot().otd } });
      for (const tab of [/Today/, /Deals/, /Prices/, /Passes/]) {
        fireEvent.click(within(nav()).getByRole("link", { name: tab }));
        expect(screen.getByRole("region", { name: "Sample data" })).toHaveTextContent(BANNER);
      }
      const pill = viewport === "phone" ? screen.getByTestId("live-pill") : screen.getByTestId("live-line");
      expect(pill).toHaveTextContent(/^Demo · /);
      expect(pill).not.toHaveTextContent("Live");
    });

    it.each(["phone", "desktop"] as const)("gives the Demo pill a still dot, never the breathing live one (%s)", (viewport) => {
      renderApp({ viewport, snap: demo() });
      const pill = viewport === "phone" ? screen.getByTestId("live-pill") : screen.getByTestId("live-line");
      expect(pill.querySelector(".dot")).not.toHaveClass("on");
    });

    it("keeps the breathing dot for the live market", () => {
      renderApp({ viewport: "desktop" });
      expect(screen.getByTestId("live-line").querySelector(".dot")).toHaveClass("on");
    });

    it("has no banner and reads Live on the live market", () => {
      renderApp({ viewport: "desktop" });
      expect(screen.queryByText(BANNER)).toBeNull();
      expect(screen.getByTestId("live-line")).toHaveTextContent(/^Live · /);
    });

    it("still pauses on demo data that stops", async () => {
      const { advance } = renderApp({ snap: demo(), respond: offline });
      await advance(10_000);
      expect(screen.getByTestId("live-pill")).toHaveTextContent(PAUSED);
    });
  });

  describe("titles and headings (M10)", () => {
    it("names the tab in the document title", () => {
      renderApp({ viewport: "desktop" });
      expect(document.title).toBe("Today · OTD Palace");
      for (const [name, title] of [
        [/Deals/, "Deals · OTD Palace"],
        [/Prices/, "Prices · OTD Palace"],
        [/Passes/, "Passes · OTD Palace"],
        [/Today/, "Today · OTD Palace"],
      ] as const) {
        fireEvent.click(within(nav()).getByRole("link", { name }));
        expect(document.title).toBe(title);
      }
    });

    it("keeps the title the server wrote for the address it opened on, until another tab is chosen", () => {
      const served = "OTD Palace · Real card deals, prices and passes today";
      document.title = served;
      renderApp({ viewport: "desktop" });
      expect(document.title).toBe(served);
      fireEvent.click(within(nav()).getByRole("link", { name: /Deals/ }));
      expect(document.title).toBe("Deals · OTD Palace");
      fireEvent.click(within(nav()).getByRole("link", { name: /Today/ }));
      expect(document.title).toBe("Today · OTD Palace");
    });

    it("gives Today and Passes their section name as the h1, the players' names under it", () => {
      const today = renderApp({ viewport: "desktop" });
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Today");
      expect(within(hero()).getByRole("heading", { level: 2 })).toBeInTheDocument();
      expect(within(hero()).getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
      today.unmount();
      renderApp({ viewport: "desktop", hash: "passes", snap: passSnapshot() });
      expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["On This Day passes"]);
    });
  });

  describe("counts that agree (M17)", () => {
    it("says how many more deals sit under the top three, the same number as the All tab", () => {
      savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000 });
      renderApp();
      const all = screen.getByRole("tab", { name: /^All/ });
      const n = Number(all.textContent?.replace(/\D/g, ""));
      expect(screen.getByText(/for you$/, { selector: ".dmeta" })).toHaveTextContent(new RegExp(`^${n} more deals? for you$`));
    });
  });

  describe("landmarks (M9)", () => {
    it("puts the phone's welcome strip and level meaning inside landmarks", () => {
      renderApp();
      expect(screen.getByRole("region", { name: "Welcome" })).toHaveTextContent("Tap a deal to open it in Real.");
      const filters = screen.getByRole("region", { name: "Level and budget" });
      expect(within(filters).getByRole("radiogroup")).toBeInTheDocument();
    });

    it("names the table's action column with text, not an empty header", () => {
      savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000 });
      renderApp({ viewport: "desktop" });
      const header = within(screen.getByRole("table", { name: "More deals" })).getAllByRole("columnheader").at(-1)!;
      expect(header).not.toHaveAttribute("aria-label");
      expect(header).toHaveTextContent("Open");
    });
  });

  describe("the desktop popover and focus (M8)", () => {
    const openTip = () => {
      const anchor = within(hero()).getAllByRole("button", { name: /^Explain/ })[0]!;
      fireEvent.click(anchor);
      const dialog = screen.getByRole("dialog");
      const close = within(dialog).getByRole("button", { name: "Close" });
      expect(close).toHaveFocus();
      return { anchor, close };
    };

    it("closes when Tab leaves it and gives focus back to its anchor", () => {
      renderApp({ viewport: "desktop" });
      const { anchor, close } = openTip();
      fireEvent.keyDown(close, { key: "Tab" });
      act(() => close.blur()); // past the popover's last button: nowhere in the page
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(anchor).toHaveFocus();
    });

    it("closes when Shift+Tab leaves it into the page, and gives focus back to its anchor", () => {
      renderApp({ viewport: "desktop" });
      const { anchor, close } = openTip();
      fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
      act(() => within(nav()).getAllByRole("link").at(-1)!.focus());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(anchor).toHaveFocus();
    });

    it("forgets a Tab once its key is up: focus sent elsewhere later stays there", () => {
      renderApp({ viewport: "desktop" });
      const { close } = openTip();
      fireEvent.keyDown(close, { key: "Tab" });
      fireEvent.keyUp(close, { key: "Tab" });
      const search = screen.getByRole("searchbox", { name: "Search a player" });
      act(() => search.focus());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(search).toHaveFocus();
    });

    it("forgets a Tab on a pointer press: focus sent elsewhere after it stays there", () => {
      renderApp({ viewport: "desktop" });
      const { close } = openTip();
      fireEvent.keyDown(close, { key: "Tab" });
      fireEvent.pointerDown(screen.getByRole("dialog"));
      const search = screen.getByRole("searchbox", { name: "Search a player" });
      act(() => search.focus());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(search).toHaveFocus();
    });

    it("stays open when the window itself loses focus (another app, another tab)", () => {
      renderApp({ viewport: "desktop" });
      const { close } = openTip();
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      act(() => close.blur());
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("closes and leaves focus where it was sent when something else takes it", () => {
      renderApp({ viewport: "desktop" });
      openTip();
      const search = screen.getByRole("searchbox", { name: "Search a player" });
      act(() => search.focus());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(search).toHaveFocus();
    });
  });

  it("stops polling in a background tab (I3)", async () => {
    const { advance, fetchImpl } = renderApp();
    await advance(5_000);
    const before = fetchImpl.mock.calls.length;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await advance(60_000);
    expect(fetchImpl.mock.calls.length).toBe(before);
  });
});
