// Deals by rarity on the page: the member's working strip (live counts, the filter, "and rarer", All, the keys, the
// saved choice, "Rarest first", the empty state) and the visitor's locked strip (the server's counts, a tap opens the
// join page and filters nothing, nothing from a member's deals).
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Prefs, savePrefs } from "../data/prefs";
import type { Locked, Snapshot } from "../data/types";
import { freshDevice, renderApp } from "../test/app";
import { makeGone } from "../test/fixtures";
import { NOW, sceneDeals, sceneSnapshot } from "../test/scene";
import { lockedCounts } from "./RarityStrip";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const ANON = '{"gate":true,"member":false,"state":"anon"}';
const OUT = '{"gate":true,"member":false,"state":"out"}';
const BANNED = '{"gate":true,"member":false,"state":"banned"}';
const MEMBER = '{"gate":true,"member":true,"state":"in"}';

const prefs = (over: Partial<Prefs> = {}) =>
  savePrefs({ level: "pro", budget: null, sport: "all", sort: "best", tab: "deals", passBudget: null, ...over });
const strip = () => screen.getByRole("radiogroup", { name: "Filter by rarity" });
const chip = (name: RegExp | string) => within(strip()).getByRole("radio", { name });
const rarer = () => screen.getByRole("switch", { name: "And rarer" });
const saved = () => JSON.parse(localStorage.getItem("advisor.prefs.v1")!) as Prefs;
const table = () => screen.getByRole("table", { name: "All deals" });
const rowNames = () =>
  within(table()).getAllByRole("row").slice(1).map((r) => within(r).getByTestId("player").textContent);

// The scene at Pro, any price: Common 1 (Salah), Uncommon 1 (McDavid), Rare 3, Epic 2 (Chase, Allen), the rest 0.
describe("the member's rarity strip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows All, then General to Iconic in Real's order, each with its live count, the empty ones quiet but there", () => {
    prefs();
    renderApp({ viewport: "desktop" });
    const names = within(strip()).getAllByRole("radio").map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual([
      "All 7 deals", "General 0 deals", "Common 1 deal", "Uncommon 1 deal", "Rare 3 deals",
      "Epic 2 deals", "Legendary 0 deals", "Mystic 0 deals", "Iconic 0 deals",
    ]);
    expect(chip("All 7 deals")).toHaveAttribute("aria-checked", "true");
    expect(chip(/^Legendary/)).toHaveClass("zero");
    expect(chip(/^Legendary/)).not.toBeDisabled();
    expect(chip(/^Epic/)).not.toHaveClass("zero");
    expect(chip(/^Epic/)).toHaveClass("rar-4");
    expect(chip(/^Epic/)).toHaveTextContent("Epic2");
  });

  it("filters the deals to the rarity picked, remembers it, and All clears it", () => {
    prefs();
    renderApp({ viewport: "desktop" });
    fireEvent.click(chip(/^Epic/));
    expect(chip(/^Epic/)).toHaveAttribute("aria-checked", "true");
    expect(rowNames().sort()).toEqual(["Ja'Marr Chase", "Josh Allen"]);
    expect(saved()).toMatchObject({ rarity: 4, rarer: false });
    // The counts stay each rarity's own, whatever is picked.
    expect(chip(/^Rare/)).toHaveAccessibleName("Rare 3 deals");
    fireEvent.click(chip(/^All /));
    expect(rowNames()).toHaveLength(7);
    expect(saved().rarity).toBeNull();
  });

  it("counts under the other filters: the sport, the budget and the level", () => {
    prefs({ sport: "nfl" });
    const { unmount } = renderApp({ viewport: "desktop" });
    expect(chip(/^All /)).toHaveAccessibleName("All 2 deals");
    expect(chip(/^Epic/)).toHaveAccessibleName("Epic 2 deals");
    expect(chip(/^Rare/)).toHaveAccessibleName("Rare 0 deals");
    unmount();
    prefs({ budget: 100 });
    const second = renderApp({ viewport: "desktop" });
    expect(chip(/^Epic/)).toHaveAccessibleName("Epic 0 deals");
    expect(chip(/^Rare/)).toHaveAccessibleName("Rare 2 deals"); // Edwards 70 and Celebrini 46; Jokić is 150
    second.unmount();
    prefs({ level: "new", budget: null });
    renderApp({ viewport: "desktop" });
    // New: no bids, no falling market, high confidence only: Edwards (Rare), Chase (Epic), Salah is 20% (under New's 25%).
    expect(chip(/^Rare/)).toHaveAccessibleName("Rare 1 deal");
    expect(chip(/^Epic/)).toHaveAccessibleName("Epic 1 deal");
    expect(chip(/^Uncommon/)).toHaveAccessibleName("Uncommon 0 deals");
  });

  it("'And rarer' keeps the rarity picked and every rarer one, and is off until a rarity is picked", () => {
    prefs();
    renderApp({ viewport: "desktop" });
    expect(rarer()).toBeDisabled();
    fireEvent.click(chip(/^Rare/));
    fireEvent.click(rarer());
    expect(rarer()).toHaveAttribute("aria-checked", "true");
    expect(rowNames()).toHaveLength(5); // three Rare, two Epic
    expect(chip(/^Epic/)).toHaveClass("inrange");
    expect(chip(/^Uncommon/)).not.toHaveClass("inrange");
    expect(saved()).toMatchObject({ rarity: 3, rarer: true });
  });

  it("comes back as it was left on this device", () => {
    prefs({ rarity: 2, rarer: true });
    renderApp({ viewport: "desktop" });
    expect(chip(/^Uncommon/)).toHaveAttribute("aria-checked", "true");
    expect(rarer()).toHaveAttribute("aria-checked", "true");
    expect(rowNames()).toHaveLength(6); // all but Salah (Common)
  });

  it("moves with the arrow keys, Home and End, one tab stop", () => {
    prefs({ rarity: 3 });
    renderApp({ viewport: "desktop" });
    const stops = within(strip()).getAllByRole("radio").filter((r) => r.tabIndex === 0);
    expect(stops).toEqual([chip(/^Rare/)]);
    chip(/^Rare/).focus();
    fireEvent.keyDown(chip(/^Rare/), { key: "ArrowRight" });
    expect(chip(/^Epic/)).toHaveAttribute("aria-checked", "true");
    expect(chip(/^Epic/)).toHaveFocus();
    fireEvent.keyDown(chip(/^Epic/), { key: "Home" });
    expect(chip(/^All /)).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(chip(/^All /), { key: "End" });
    expect(saved().rarity).toBe(7);
  });

  it("keeps a deal of the rarity picked that just went away, dimmed in its place", async () => {
    prefs({ rarity: 4 });
    const { push } = renderApp({ viewport: "desktop" });
    expect(rowNames().sort()).toEqual(["Ja'Marr Chase", "Josh Allen"]);
    const allen = sceneDeals().find((d) => d.listing_id === 105)!;
    const salah = sceneDeals().find((d) => d.listing_id === 107)!;
    await push(sceneSnapshot({
      version: 2,
      deals: sceneDeals().filter((d) => d.listing_id !== 105 && d.listing_id !== 107),
      gone: [makeGone({ ...allen, reason: "ended", now: NOW }), makeGone({ ...salah, reason: "ended", now: NOW })],
    }));
    expect(rowNames().sort()).toEqual(["Ja'Marr Chase", "Josh Allen"]);
    expect(screen.getByRole("radio", { name: "Epic 1 deal" })).toBeInTheDocument();
  });

  it("says when a rarity has no deal, and offers every rarity back", () => {
    prefs({ rarity: 5 });
    renderApp({ viewport: "desktop" });
    expect(screen.getByText(/No Legendary deals right now/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all rarities" }));
    expect(rowNames()).toHaveLength(7);
  });

  it("sorts the rarest first from the Sort menu", () => {
    prefs();
    renderApp({ viewport: "desktop" });
    fireEvent.click(screen.getByRole("button", { name: /^Sort/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Rarest first" }));
    // Epic first (best after fees first: Allen 142, Chase 37), then Rare, Uncommon, Common.
    expect(rowNames()).toEqual([
      "Josh Allen", "Ja'Marr Chase", "Nikola Jokić", "Anthony Edwards", "Macklin Celebrini", "Connor McDavid",
      "Mohamed Salah",
    ]);
    expect(saved().sort).toBe("rarest");
  });

  it("sits in a phone's Deals with thumb-sized chips, under the sport tabs", () => {
    prefs();
    renderApp({ viewport: "phone" });
    fireEvent.click(chip(/^Epic/));
    const rows = within(screen.getByRole("list", { name: "All deals" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const tabs = screen.getByRole("tablist", { name: "Filter by player or sport" });
    expect(tabs.compareDocumentPosition(strip()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is the member's for a member of the server and with the gate off, never the locked one", () => {
    prefs();
    const { unmount } = renderApp({ viewport: "desktop", me: MEMBER });
    expect(strip()).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /free with Discord/ })).not.toBeInTheDocument();
    unmount();
    renderApp({ viewport: "desktop" });
    expect(strip()).toBeInTheDocument();
  });
});

/** The free site's snapshot, as the server trims it (advisor/public.py): a few deals and the counts of the rest. */
function freeSnapshot(over: Partial<Locked> = {}): Snapshot {
  const whole = sceneSnapshot();
  return {
    ...whole,
    deals: whole.deals.slice(0, 3),
    gone: [],
    links: { community: "https://discord.gg/palace", push: null, accounts: false },
    locked: {
      deals: 42, risers: 7, fallers: 6, passes: 59, alerts: true, accounts: true,
      by_rarity: { "0": 9, "1": 12, "2": 8, "3": 6, "4": 3, "5": 4, "6": 0, "7": 1 },
      ...over,
    },
  };
}

const locked = () => screen.getByRole("group", { name: "Filter by rarity, free with Discord" });
const gateFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));

describe("the visitor's locked rarity strip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    document.getElementById("me")?.remove();
  });

  it.each([["anon", ANON], ["out", OUT]])("shows %s every rarity with the server's count of all deals", (_, me) => {
    prefs({ rarity: 2 }); // a choice made as a member earlier (Uncommon): the free list ignores it
    renderApp({ viewport: "desktop", snap: freeSnapshot(), me, gateFetch });
    const chips = within(locked()).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual([
      "General 9 deals", "Common 12 deals", "Uncommon 8 deals", "Rare 6 deals", "Epic 3 deals",
      "Legendary 4 deals", "Mystic 0 deals", "Iconic 1 deal",
    ]);
    expect(within(locked()).getByRole("button", { name: "Mystic 0 deals" })).toHaveClass("zero");
    expect(screen.queryByRole("radiogroup", { name: "Filter by rarity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "And rarer" })).not.toBeInTheDocument();
    // The free list as it is today: New's safe deals among the free three (Chase, an Epic), whatever rarity was kept.
    expect(rowNames()).toEqual(["Ja'Marr Chase"]);
  });

  it.each([["anon", ANON], ["out", OUT]])("opens the join page on a tap for %s, and filters nothing", async (_, me) => {
    prefs();
    renderApp({ viewport: "phone", snap: freeSnapshot(), me, gateFetch });
    const before = within(screen.getByRole("list", { name: "All deals" })).getAllByRole("listitem").length;
    await act(async () => {
      fireEvent.click(within(locked()).getByRole("button", { name: "Legendary 4 deals" }));
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(location.hash).toBe("#join");
    expect(screen.getByRole("list", { name: "With Discord" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("advisor.prefs.v1") ?? "{}").rarity ?? null).toBeNull();
    history.replaceState(null, "", "/deals");
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(within(screen.getByRole("list", { name: "All deals" })).getAllByRole("listitem")).toHaveLength(before);
  });

  it("is not shown to an account the server refused (no way in), nor from a snapshot without the counts", () => {
    prefs();
    const { unmount } = renderApp({ viewport: "desktop", snap: freeSnapshot(), me: BANNED, gateFetch });
    expect(screen.queryByRole("group", { name: /free with Discord/ })).not.toBeInTheDocument();
    unmount();
    renderApp({ viewport: "desktop", snap: freeSnapshot({ by_rarity: undefined }), me: ANON, gateFetch });
    expect(screen.queryByRole("group", { name: /free with Discord/ })).not.toBeInTheDocument();
  });

  it("counts from the server's numbers only, never from the deals on the page", () => {
    prefs();
    renderApp({ viewport: "desktop", snap: freeSnapshot({ by_rarity: { "5": 2 } }), me: ANON, gateFetch });
    // The free deals are Epic, Rare, Uncommon: none of that is counted here.
    expect(within(locked()).getByRole("button", { name: "Epic 0 deals" })).toBeInTheDocument();
    expect(within(locked()).getByRole("button", { name: "Legendary 2 deals" })).toBeInTheDocument();
  });
});

describe("lockedCounts: the free snapshot's rarity counts, read as counts and nothing else", () => {
  const base: Locked = { deals: 1, risers: 0, fallers: 0, passes: 0, alerts: false, accounts: false };

  it("gives eight whole counts, by Real's rarity index", () => {
    expect(lockedCounts({ ...base, by_rarity: { "0": 1, "5": 4, "7": 2 } })).toEqual([1, 0, 0, 0, 0, 4, 0, 2]);
  });

  it("reads anything that is not a whole count as 0, and keeps no other key", () => {
    const odd = { "0": "Jokić", "1": -2, "2": 1.5, "3": null, "4": { price: 90 }, "5": 3, "8": 9, name: "x" };
    const counts = lockedCounts({ ...base, by_rarity: odd as unknown as Record<string, number> });
    expect(counts).toEqual([0, 0, 0, 0, 0, 3, 0, 0]);
    expect(counts!.every((n) => Number.isInteger(n))).toBe(true);
  });

  it("is null for a snapshot without them", () => {
    expect(lockedCounts(base)).toBeNull();
    expect(lockedCounts({ ...base, by_rarity: [1, 2] as unknown as Record<string, number> })).toBeNull();
  });
});
