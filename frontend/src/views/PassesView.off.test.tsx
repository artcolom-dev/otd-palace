// With the "Build to" switch off (lib/buildToSwitch.ts, advisor/rules.py BUILD_TO_ON), the Passes tab is byte for byte
// what it was before the mode was written: these pages were saved from integration c2e7a61, before any of it, and
// each must still render to the very same HTML. The scene holds a pass on a build rate and a thin one, and the device
// keeps a "Build to" choice (Legendary), so neither the choice nor the certainty may show while the switch is off.
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../data/types";
import { BUILD_TO_ON, buildToSwitch } from "../lib/buildToSwitch";
import { toBasis } from "../lib/passes";
import { freshDevice, renderApp } from "../test/app";
import { JOKIC, MCDAVID, PASS_MARKETS, otdOf, passSnapshot, served } from "../test/passScene";

// Jokić priced on a build rate (common 5-7 cards, 11 sales); McDavid measured with no cell of 5 sales: thin.
const BUILT = served({ ...toBasis(JOKIC), rate_build: 8, rate_build_from: { bucket: "5-7", rarity: "common", sales: 11 }, rate_bucket: "5-7" });
const THIN = served({ ...toBasis(MCDAVID), rate_build: null, rate_bucket: "7+" });
const MARKETS = PASS_MARKETS.map((m) => (m.key === JOKIC.key ? BUILT : m.key === MCDAVID.key ? THIN : m));
const member = passSnapshot({ otd: otdOf(MARKETS) });

/** The free site's snapshot as advisor/public.py trims it: each sport's first 5 picks and its starter, plus `locked`. */
function free(): Snapshot {
  const otd = member.otd;
  const picks = Object.fromEntries(Object.entries(otd.picks).map(([s, keys]) => [s, keys.slice(0, 5)]));
  const named = new Set([...Object.values(picks).flat(), ...Object.values(otd.starters)]);
  return {
    ...member,
    deals: member.deals.slice(0, 3),
    gone: [],
    links: { community: "https://discord.gg/palace", push: null, accounts: false },
    otd: { as_of: otd.as_of, sports: otd.sports, markets: otd.markets.filter((m) => named.has(m.key)), picks, starters: otd.starters },
    locked: {
      deals: 42, risers: 7, fallers: 6, passes: 59, alerts: true, accounts: true,
      by_rarity: { "0": 9, "1": 12, "2": 8, "3": 6, "4": 3, "5": 4, "6": 0, "7": 1 },
    },
  };
}

const ANON = '{"gate":true,"member":false,"state":"anon"}';
const gateFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));

/** A device that saved the level and a "Build to" choice of Legendary (index 5), in the stored prefs' own shape. */
function keep(level: "new" | "regular" | "pro") {
  const budget = { new: 1000, regular: 5000, pro: null }[level];
  localStorage.setItem(
    "advisor.prefs.v1",
    JSON.stringify({ sport: "all", budget: 200, level, sort: "best", tab: "passes", passBudget: budget, rarity: null, rarer: false, buildTo: 5 }),
  );
}

const page = () => document.querySelector(".passes-page")!.outerHTML;

describe("Passes with the Build to switch off", () => {
  it("is off on the site (advisor/rules.py BUILD_TO_ON, the same by tests/test_copy_parity.py)", () => {
    expect(BUILD_TO_ON).toBe(false);
    expect(buildToSwitch.on).toBe(false);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    buildToSwitch.on = false; // these pages are the switch off's, whatever the site's switch says
  });
  afterEach(() => {
    vi.useRealTimers();
    buildToSwitch.on = BUILD_TO_ON;
    document.getElementById("me")?.remove();
  });

  it.each([
    ["desktop", "new"],
    ["desktop", "regular"],
    ["desktop", "pro"],
    ["phone", "new"],
    ["phone", "regular"],
    ["phone", "pro"],
  ] as const)("a member's %s page at %s is the page of before", async (viewport, level) => {
    keep(level);
    renderApp({ snap: member, viewport, hash: "passes" });
    await expect(page()).toMatchFileSnapshot(`./__snapshots__/passes-off/member-${viewport}-${level}.html`);
  });

  it("a member's desktop list with Show all on is the list of before", async () => {
    keep("regular");
    renderApp({ snap: member, viewport: "desktop", hash: "passes" });
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    await expect(page()).toMatchFileSnapshot("./__snapshots__/passes-off/member-desktop-showall.html");
  });

  it.each(["desktop", "phone"] as const)("a visitor's %s page is the page of before", async (viewport) => {
    keep("regular");
    renderApp({ snap: free(), viewport, hash: "passes", me: ANON, gateFetch });
    await expect(page()).toMatchFileSnapshot(`./__snapshots__/passes-off/visitor-${viewport}.html`);
  });
});
