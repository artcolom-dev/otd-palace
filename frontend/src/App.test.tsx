import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPrefs, savePrefs } from "./data/prefs";
import { trackOut } from "./lib/track";
import { freshDevice, renderApp } from "./test/app";
import { LEVELS, RULES, isoAt } from "./test/fixtures";
import { NOW, sceneDeals, sceneSnapshot } from "./test/scene";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));

const nav = () => screen.getByRole("navigation", { name: "Sections" });

describe("the shell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("routing", () => {
    it("opens on Today, with Today, Deals, Prices, Passes and Your plan in the menu", () => {
      renderApp();
      const links = within(nav()).getAllByRole("link");
      expect(links.map((a) => a.textContent?.replace(/\d+/g, "").trim())).toEqual(["Today", "Deals", "Prices", "Passes", "Your plan"]);
      expect(within(nav()).getByRole("link", { name: /Today/ })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("region", { name: "Best deals for you right now" })).toBeInTheDocument();
    });

    it("moves between tabs by their own addresses and remembers the last one", () => {
      const { unmount } = renderApp();
      fireEvent.click(within(nav()).getByRole("link", { name: /Deals/ }));
      expect(location.pathname).toBe("/deals");
      expect(location.hash).toBe("");
      expect(screen.getByRole("heading", { name: "All deals", level: 1 })).toBeInTheDocument();
      expect(loadPrefs(LEVELS).tab).toBe("deals");
      unmount();
      renderApp();
      expect(within(nav()).getByRole("link", { name: /Deals/ })).toHaveAttribute("aria-current", "page");
      expect(location.pathname).toBe("/deals"); // the bare address takes the remembered tab's own
    });

    it.each(["phone", "desktop"] as const)("links each tab in the menu by its own address (%s)", (viewport) => {
      renderApp({ viewport });
      const hrefs = within(nav()).getAllByRole("link").map((a) => a.getAttribute("href"));
      expect(hrefs).toEqual(["/", "/deals", "/prices", "/passes", "/plan"]);
    });

    it.each([
      ["/deals", "All deals"],
      ["/prices", "Prices moving today"],
      ["/passes", "On This Day passes"],
      ["/plan", "Your plan"],
    ])("opens the tab its address names (%s)", (path, heading) => {
      renderApp({ path });
      expect(screen.getByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
      expect(location.pathname).toBe(path);
    });

    it("opens the tab an old #tab link names, and moves it to the tab's own address", () => {
      renderApp({ hash: "passes" });
      expect(screen.getByRole("heading", { name: "On This Day passes", level: 1 })).toBeInTheDocument();
      expect(`${location.pathname}${location.hash}`).toBe("/passes");
      act(() => {
        history.replaceState(null, "", "#prices"); // an old link inside a page, followed
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(screen.getByRole("heading", { name: "Prices moving today", level: 1 })).toBeInTheDocument();
      expect(`${location.pathname}${location.hash}`).toBe("/prices");
    });

    it.each([["market", "/prices"], ["otd", "/passes"], ["today", "/"]])("takes the old #%s to %s", (hash, path) => {
      renderApp({ path: "/deals", hash });
      expect(`${location.pathname}${location.hash}`).toBe(path);
    });

    it("keeps the query a notification opened with while it moves an old link", () => {
      renderApp({ hash: "deals", search: "?open=101" });
      expect(location.pathname).toBe("/deals");
    });

    it.each(["%", "100%", "nowhere"])("lands on the default tab from a broken address (#%s)", (hash) => {
      renderApp({ hash });
      expect(within(nav()).getByRole("link", { name: /Today/ })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("region", { name: "Best deals for you right now" })).toBeInTheDocument();
      expect(`${location.pathname}${location.hash}`).toBe("/");
    });

    it("takes a first-time visitor back to Today from the first tab they open", async () => {
      const { advance } = renderApp();
      expect(`${location.pathname}${location.hash}`).toBe("/");
      fireEvent.click(within(nav()).getByRole("link", { name: /Deals/ }));
      expect(screen.getByRole("heading", { name: "All deals", level: 1 })).toBeInTheDocument();
      history.back();
      await advance(50);
      expect(`${location.pathname}${location.hash}`).toBe("/");
      expect(within(nav()).getByRole("link", { name: /Today/ })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("region", { name: "Best deals for you right now" })).toBeInTheDocument();
    });

    it("follows back and forward between the tabs' addresses", async () => {
      const { advance } = renderApp();
      fireEvent.click(within(nav()).getByRole("link", { name: /Deals/ }));
      fireEvent.click(within(nav()).getByRole("link", { name: /Prices/ }));
      expect(location.pathname).toBe("/prices");
      history.back();
      await advance(50);
      expect(location.pathname).toBe("/deals");
      expect(screen.getByRole("heading", { name: "All deals", level: 1 })).toBeInTheDocument();
      history.back();
      await advance(50);
      expect(location.pathname).toBe("/");
      expect(within(nav()).getByRole("link", { name: /Today/ })).toHaveAttribute("aria-current", "page");
      history.forward();
      await advance(50);
      expect(location.pathname).toBe("/deals");
      expect(within(nav()).getByRole("link", { name: /Deals/ })).toHaveAttribute("aria-current", "page");
      expect(loadPrefs(LEVELS).tab).toBe("deals");
    });

    it("gives Prices its own page of moves, without the hero", () => {
      renderApp({ hash: "prices" });
      expect(screen.getByRole("region", { name: "Prices moving today" })).toBeInTheDocument();
      expect(screen.queryByText(/coming next/i)).toBeNull();
      expect(screen.queryByRole("region", { name: "Best deals for you right now" })).not.toBeInTheDocument();
    });

    it.each(["phone", "desktop"] as const)("adds no history entry for the tab already open (%s)", (viewport) => {
      renderApp({ viewport });
      const push = vi.spyOn(history, "pushState");
      fireEvent.click(within(nav()).getByRole("link", { name: /Today/ }));
      expect(push).not.toHaveBeenCalled();
      expect(location.pathname).toBe("/");
      fireEvent.click(within(nav()).getByRole("link", { name: /Deals/ }));
      expect(push).toHaveBeenCalledTimes(1);
      fireEvent.click(within(nav()).getByRole("link", { name: /Deals/ }));
      expect(push).toHaveBeenCalledTimes(1);
      expect(location.pathname).toBe("/deals");
      push.mockRestore();
    });
  });

  describe("level", () => {
    it("starts on New with its one-line meaning, and each level says what it means", () => {
      renderApp();
      const group = screen.getByRole("radiogroup", { name: "Level" });
      expect(within(group).getByRole("radio", { name: "New" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByText("Safest deals, plain words.")).toBeInTheDocument();
      fireEvent.click(within(group).getByRole("radio", { name: "Regular" }));
      expect(screen.getByText("More deals, auctions ending soon.")).toBeInTheDocument();
      fireEvent.click(within(group).getByRole("radio", { name: "Pro" }));
      // The site's third level is not the app's paid Real Pro (truth audit, finding 17): it says so where it is picked.
      expect(screen.getByText("Everything, with resale profit. Free here, not Real Pro.")).toBeInTheDocument();
    });

    it("moves through the levels with the arrow keys, Home and End", () => {
      renderApp();
      const group = screen.getByRole("radiogroup", { name: "Level" });
      const radio = (name: string) => within(group).getByRole("radio", { name });
      radio("New").focus();
      fireEvent.keyDown(radio("New"), { key: "End" });
      expect(radio("Pro")).toHaveAttribute("aria-checked", "true");
      expect(radio("Pro")).toHaveFocus();
      fireEvent.keyDown(radio("Pro"), { key: "Home" });
      expect(radio("New")).toHaveAttribute("aria-checked", "true");
      expect(radio("New")).toHaveFocus();
      fireEvent.keyDown(radio("New"), { key: "ArrowRight" });
      expect(radio("Regular")).toHaveFocus();
    });

    it("resets the budget to the level's own when the level changes", () => {
      renderApp({ viewport: "desktop" });
      const budget = screen.getByRole("group", { name: /Max price per card/ });
      expect(within(budget).getByRole("button", { name: "≤200" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(within(budget).getByRole("button", { name: "Any" }));
      fireEvent.click(screen.getByRole("radio", { name: "Regular" }));
      expect(within(budget).getByRole("button", { name: "≤1,000" })).toHaveAttribute("aria-pressed", "true");
      expect(loadPrefs(LEVELS)).toMatchObject({ level: "regular", budget: 1000 });
    });
  });

  describe("budget", () => {
    it("offers the served presets, null as Any", () => {
      renderApp({ viewport: "desktop" });
      const budget = screen.getByRole("group", { name: /Max price per card/ });
      expect(within(budget).getAllByRole("button").map((b) => b.textContent)).toEqual(["≤50", "≤200", "≤1,000", "Any"]);
    });

    it("opens as a sheet from one chip on a phone", () => {
      renderApp();
      fireEvent.click(screen.getByRole("button", { name: /Max ≤200/ }));
      const sheet = screen.getByRole("dialog", { name: "Max price per card" });
      fireEvent.click(within(sheet).getByRole("radio", { name: /Any price/ }));
      expect(loadPrefs(LEVELS).budget).toBeNull();
      expect(screen.getByRole("button", { name: /Max Any/ })).toBeInTheDocument();
    });
  });

  describe("live line", () => {
    it("says how fresh the data is and how many deals are open, and hides a count of zero taken", () => {
      renderApp({ viewport: "desktop", snap: sceneSnapshot({ taken_10m: 0 }) });
      const line = screen.getByTestId("live-line");
      expect(line).toHaveTextContent("Live · updated 0s ago · 2 deals open");
      expect(line).not.toHaveTextContent("taken");
    });

    it("adds the deals taken in the last 10 minutes when there are some", () => {
      renderApp({ viewport: "desktop", snap: sceneSnapshot({ taken_10m: 3 }) });
      expect(screen.getByTestId("live-line")).toHaveTextContent(
        "Live · updated 0s ago · 2 deals open · 3 taken in 10 min",
      );
    });

    it("counts one deal in the singular", () => {
      const one = sceneSnapshot({ deals: sceneDeals().slice(0, 1), taken_10m: 0 });
      const { unmount } = renderApp({ viewport: "desktop", snap: one });
      expect(screen.getByTestId("live-line")).toHaveTextContent("Live · updated 0s ago · 1 deal open");
      unmount();
      renderApp({ snap: one, hash: "deals" });
      expect(screen.getByText(/for you$/, { selector: ".dmeta" })).toHaveTextContent(/^1 deal for you$/);
    });

    it("pauses on stale data: the list greys but its links still work, and it does not claim to be disabled", () => {
      savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000 });
      renderApp({ viewport: "desktop", snap: sceneSnapshot({ generated_at: isoAt(NOW - 600_000) }) });
      expect(screen.getByTestId("live-line")).toHaveTextContent("Paused · prices may have changed");
      const table = screen.getByRole("table", { name: "More deals" });
      expect(table).toHaveClass("stale");
      expect(table).not.toHaveAttribute("aria-disabled");
      expect(within(table).getAllByRole("link")[0]).toHaveAttribute("href");
    });

    it("shows a skeleton while there is no data yet", () => {
      renderApp({ snap: null });
      expect(screen.getByTestId("skeleton")).toHaveAttribute("aria-busy", "true");
    });
  });

  describe("first visit", () => {
    it("puts a sheet away when the visitor moves to another tab", () => {
      renderApp();
      fireEvent.click(within(screen.getByRole("region", { name: "Welcome" })).getByRole("button", { name: "How it works" }));
      expect(screen.getByRole("dialog", { name: "How it works" })).toBeInTheDocument();
      fireEvent.click(within(nav()).getByRole("link", { name: /Deals/ }));
      expect(screen.queryByRole("dialog", { name: "How it works" })).toBeNull();
    });

    it("welcomes, explains in three steps, and remembers the dismissal", () => {
      const desk = renderApp({ viewport: "desktop" });
      const welcome = () => screen.queryByRole("region", { name: "Welcome" });
      expect(welcome()).toHaveTextContent(
        "We check every Real auction against recent sales. Tap a deal to open it in Real. Real is a sports card app; Rax is its in-app currency.How it worksNew to Real?",
      );
      desk.unmount();
      const { unmount } = renderApp();
      const note = welcome()!;
      expect(note).toHaveTextContent(/^Tap a deal to open it in Real\. Real is a sports card app; Rax is its in-app currency\.\s*How it works\s*New to Real\?$/);
      fireEvent.click(within(note).getByRole("button", { name: "How it works" }));
      const sheet = screen.getByRole("dialog", { name: "How it works" });
      expect(within(sheet).getAllByRole("listitem")).toHaveLength(3);
      fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
      // Someone who never played: what Real is, first, with Real's own site.
      fireEvent.click(within(note).getByRole("button", { name: "New to Real?" }));
      const how = screen.getByRole("dialog", { name: "How Real works" });
      expect(within(how).getAllByRole("heading", { level: 3 })[0]).toHaveTextContent("New to Real?");
      // The count under the title is the count of answers in the list, not a number written once and left behind.
      const answers = within(how).getAllByRole("heading", { level: 3 }).length;
      expect(answers).toBeGreaterThan(10);
      expect(how).toHaveTextContent(`${answers} short answers`);
      expect(within(how).getByRole("link", { name: /Get Real at realapp\.com/ })).toHaveAttribute("href", "https://www.realapp.com/");
      fireEvent.click(within(how).getByRole("button", { name: "Close" }));
      fireEvent.click(screen.getByRole("button", { name: "Dismiss the welcome" }));
      expect(welcome()).not.toBeInTheDocument();
      unmount();
      renderApp();
      expect(welcome()).not.toBeInTheDocument();
    });

    it.each(["phone", "desktop"] as const)("welcomes on Today and Deals only (%s)", (viewport) => {
      const welcome = () => screen.queryByRole("button", { name: "Dismiss the welcome" });
      renderApp({ viewport });
      expect(welcome()).toBeInTheDocument();
      fireEvent.click(within(nav()).getByRole("link", { name: /Deals/ }));
      expect(welcome()).toBeInTheDocument();
      fireEvent.click(within(nav()).getByRole("link", { name: /Prices/ }));
      expect(welcome()).toBeNull();
      fireEvent.click(within(nav()).getByRole("link", { name: /Passes/ }));
      expect(welcome()).toBeNull();
    });
  });

  describe("phone sheets: one tab stop, the arrows move between the choices", () => {
    const keysThrough = (group: HTMLElement) => {
      const radios = within(group).getAllByRole("radio");
      const checked = radios.findIndex((r) => r.getAttribute("aria-checked") === "true");
      expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(radios.map((_, i) => (i === checked ? "0" : "-1")));
      radios[checked]!.focus();
      fireEvent.keyDown(radios[checked]!, { key: "ArrowDown" });
      const next = radios[(checked + 1) % radios.length]!;
      expect(next).toHaveFocus();
      expect(next).toHaveAttribute("tabindex", "0");
      expect(radios[checked]).toHaveAttribute("tabindex", "-1");
      fireEvent.keyDown(next, { key: "End" });
      expect(radios[radios.length - 1]).toHaveFocus();
      fireEvent.keyDown(radios[radios.length - 1]!, { key: "ArrowDown" });
      expect(radios[0]).toHaveFocus();
      fireEvent.keyDown(radios[0]!, { key: "ArrowUp" });
      expect(radios[radios.length - 1]).toHaveFocus();
      fireEvent.keyDown(radios[radios.length - 1]!, { key: "Home" });
      expect(radios[0]).toHaveFocus();
      expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toEqual([radios[0]]);
    };

    it("the sort sheet", () => {
      renderApp({ hash: "deals" }); // Today at New has nothing under its tiles to sort
      fireEvent.click(screen.getByRole("button", { name: /^Sort/ }));
      keysThrough(within(screen.getByRole("dialog", { name: "Sort deals" })).getByRole("radiogroup"));
    });

    it("the budget sheet", () => {
      renderApp();
      fireEvent.click(screen.getByRole("button", { name: /^Max/ }));
      keysThrough(screen.getByRole("radiogroup", { name: "Max price per card" }));
    });

    it("the pass budget sheet", () => {
      renderApp({ hash: "passes" });
      fireEvent.click(screen.getByRole("button", { name: "Filters" }));
      fireEvent.click(screen.getByRole("button", { name: /^Max/ }));
      keysThrough(screen.getByRole("radiogroup", { name: "Max to spend per pass" }));
    });
  });

  describe("player search", () => {
    it("filters the deals by player on desktop, accents aside, and clears with one tap", () => {
      savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000 });
      renderApp({ viewport: "desktop" });
      fireEvent.change(screen.getByRole("searchbox", { name: "Search a player" }), { target: { value: "jokic" } });
      const table = screen.getByRole("table", { name: "All deals" });
      expect(within(table).getAllByTestId("player").map((p) => p.textContent)).toEqual(["Nikola Jokić"]);
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      expect(within(table).getAllByTestId("player")).toHaveLength(7);
    });

    it("opens as a sheet from the search icon on a phone, and picking a player shows their deals", () => {
      savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000 });
      renderApp();
      fireEvent.click(screen.getByRole("button", { name: "Search a player" }));
      const sheet = screen.getByRole("dialog", { name: "Find a player" });
      fireEvent.change(within(sheet).getByRole("searchbox", { name: "Player name" }), { target: { value: "mcd" } });
      fireEvent.click(within(sheet).getByRole("button", { name: /Connor McDavid/ }));
      expect(within(screen.getByRole("list", { name: "All deals" })).getAllByTestId("player").map((p) => p.textContent))
        .toEqual(["Connor McDavid"]);
    });
  });

  describe("footer and community", () => {
    it("says it is not affiliated, and tags sample data", () => {
      renderApp({ snap: sceneSnapshot({ rules: { ...RULES, demo: true } }) });
      expect(screen.getAllByText("Not affiliated with Real.").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Sample data").length).toBeGreaterThan(0);
    });

    it("has no sample tag on live data, and no community link until there is one", () => {
      renderApp();
      expect(screen.queryByText("Sample data")).not.toBeInTheDocument();
      expect(screen.queryByText(/pinged on Discord/)).not.toBeInTheDocument();
    });

    it("links the community when it is set and counts the click", () => {
      renderApp({ snap: sceneSnapshot({ links: { community: "https://discord.gg/abc" } }) });
      const link = screen.getByRole("link", { name: /Every deal, your own plan, deals pinged/ });
      expect(link).toHaveAttribute("href", "https://discord.gg/abc");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      fireEvent.click(link);
      expect(trackOut).toHaveBeenCalledWith({ panel: "community", target: "community", level: "new", sport: "all", pos: 0 });
    });
  });
});
