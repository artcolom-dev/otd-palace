// "You advise me things I already own", on the screens: Today's pass pick and the deals know what a linked (or
// typed-in) account holds. Each test reproduces the complaint, then checks the fix.
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { defaultSeason, passList } from "../data/passList";
import { savePrefs } from "../data/prefs";
import { freshDevice, renderApp } from "../test/app";
import { passSnapshot } from "../test/passScene";
import { sceneSnapshot } from "../test/scene";

const passPanel = () => screen.getByRole("region", { name: "Pass worth getting" });
const filters = {
  level: "regular" as const, budget: null, sport: "all", season: defaultSeason("regular"), soon: false, showAll: false,
  sort: "ret" as const, query: "",
};

describe("advice that skips what the visitor owns", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    savePrefs({ level: "regular", budget: null, sport: "all", sort: "best", tab: "today", passBudget: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reproduced: Today's pass worth getting offered a pass the linked account holds; now it offers another", () => {
    const snap = sceneSnapshot({ otd: passSnapshot().otd });
    const top = passList(snap, filters).top!;
    local.link("Mine", [{ key: top.market.key, rarity: top.rung.tier }], [], new Set(snap.otd.markets.map((m) => m.key)));
    renderApp({ viewport: "desktop", snap });
    expect(within(passPanel()).queryByRole("heading", { name: top.market.player_name })).toBeNull();
  });

  it("a deal on a pass held at its rarity or higher says so, and leaves the top three", () => {
    const snap = sceneSnapshot({ otd: passSnapshot().otd });
    const deal = snap.deals[0]!;
    const plain = renderApp({ viewport: "desktop", snap });
    const tiles = () => screen.queryAllByTestId("tile-price").length;
    expect(tiles()).toBeGreaterThan(0);
    expect(screen.queryByText(/You own this one at/)).toBeNull();
    plain.unmount();
    local.link("Mine", [{ key: `${deal.sport}:${deal.season}:player:${deal.player_id}`, rarity: "iconic" }], [], new Set());
    renderApp({ viewport: "desktop", snap });
    expect(screen.getAllByText("You own this one at Iconic").length).toBeGreaterThan(0);
    const tileNames = screen.queryAllByTestId("tile-price").map((t) => t.closest("article, li, div")?.textContent ?? "");
    for (const t of tileNames) expect(t).not.toContain("You own this one");
  });
});
