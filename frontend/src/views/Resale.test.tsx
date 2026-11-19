import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResaleTag } from "../components/ResaleTag";
import { type Prefs, savePrefs } from "../data/prefs";
import type { Deal } from "../data/types";
import { freshDevice, renderApp } from "../test/app";
import { sceneDeals, sceneSnapshot } from "../test/scene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const prefs = (over: Partial<Prefs> = {}) =>
  savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000, ...over });

/** The scene's deals, with counts on three: Chase resells well, Edwards is slow to resell, McDavid is in between. */
function resaleScene() {
  const by: Record<string, Deal["resale"]> = {
    "Ja'Marr Chase": { listed: 40, sold: 28 },
    "Anthony Edwards": { listed: 20, sold: 3 },
    "Connor McDavid": { listed: 40, sold: 20 },
  };
  return sceneSnapshot({ deals: sceneDeals().map((d) => (by[d.player_name] ? { ...d, resale: by[d.player_name] } : d)) });
}
const table = () => screen.getByRole("table", { name: "All deals" });
const row = (name: string) =>
  within(table()).getAllByRole("row").slice(1).find((r) => within(r).getByTestId("player").textContent === name)!;

describe("Resale on the deals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("tags the clear cases at Regular, in plain words with the counts behind them, and leaves the middle alone", () => {
    prefs();
    renderApp({ snap: resaleScene(), viewport: "desktop" });
    expect(within(row("Ja'Marr Chase")).getByRole("button", { name: "Resells well · 28 of 40 recent listings sold (70%)" })).toHaveTextContent("Resells well");
    expect(within(row("Anthony Edwards")).getByRole("button", { name: /Slow to resell · 3 of 20 recent listings sold \(15%\)/ })).toHaveTextContent("Slow to resell");
    expect(within(row("Connor McDavid")).queryByRole("button", { name: /resell/i })).toBeNull();
  });

  it("keeps New to the basics: no resale tag there", () => {
    prefs({ level: "new", budget: 200 });
    renderApp({ snap: resaleScene(), viewport: "desktop" });
    expect(screen.queryByText("Resells well")).not.toBeInTheDocument();
    expect(screen.queryByText("Slow to resell")).not.toBeInTheDocument();
  });

  it("shows it in the phone list as a word, not a button too small to tap", () => {
    prefs();
    renderApp({ snap: resaleScene(), viewport: "phone" });
    const item = within(screen.getByRole("list", { name: "All deals" })).getAllByRole("listitem").find((li) => li.textContent?.includes("Chase"))!;
    expect(within(item).getByText("Resells well").closest(".resold")).toHaveTextContent("28 of 40 recent listings sold");
    expect(within(item).queryByRole("button", { name: /Resells well/ })).toBeNull();
  });

  it("shows nothing for a count it cannot read, and does not crash", () => {
    prefs();
    const snap = sceneSnapshot({ deals: sceneDeals().map((d) => ({ ...d, resale: { listed: "many", sold: null } as never })) });
    renderApp({ snap, viewport: "desktop" });
    expect(screen.queryByText("Resells well")).not.toBeInTheDocument();
    expect(table()).toBeInTheDocument();
  });
});

describe("The resale tag", () => {
  it("shows nothing when there is nothing clear to say", () => {
    const { container } = render(<ResaleTag resale={{ listed: 40, sold: 20 }} inert />);
    expect(container).toBeEmptyDOMElement();
  });
});
