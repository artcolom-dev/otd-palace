import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePrefs } from "../data/prefs";
import { priceCurveSwitch } from "../lib/priceCurveSwitch";
import { freshDevice, renderApp } from "../test/app";
import { sceneMoves, sceneSnapshot } from "../test/scene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const page = () => screen.getByRole("region", { name: "Prices moving today" });
const rows = () => within(page()).getAllByRole("listitem");
const row = (name: string) => rows().find((r) => within(r).queryByText(name)) as HTMLElement;

/** The scene's moves; Chase (236 today) carries six finished days with one missing, Edwards a single day. */
function curvedSnapshot() {
  const moves = sceneMoves();
  moves.risers[0] = { ...moves.risers[0]!, curve: [[6, 160, 4], [5, 170, 3], [4, 168, 9], [2, 190, 5], [1, 210, 12]] };
  moves.risers[1] = { ...moves.risers[1]!, curve: [[1, 70, 3]] };
  return sceneSnapshot({ moves });
}

describe("Prices: a move's curve", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "prices", passBudget: 5000 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    priceCurveSwitch.on = true;
  });

  it("draws the market's days and says the span it really covers, its two ends and the change", () => {
    renderApp({ hash: "prices", viewport: "desktop", snap: curvedSnapshot() });
    const curve = within(row("Ja'Marr Chase")).getByTestId("move-curve");
    expect(curve).toHaveTextContent("Last 7 days: 160 → 236");
    expect(curve).toHaveTextContent("Typical sale over the last 7 days: from 160 to 236 Rax, up 48%.");
    expect(curve).toHaveClass("up");
    expect(curve.querySelectorAll("circle")).toHaveLength(6); // five days and today
    expect(curve.querySelectorAll("path")).toHaveLength(2); // 6-5-4, then 2-1-today: day 3 is a gap
    expect(curve.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws nothing for a move with too few days, and leaves its row as it was", () => {
    renderApp({ hash: "prices", viewport: "desktop", snap: curvedSnapshot() });
    const edwards = row("Anthony Edwards");
    expect(within(edwards).queryByTestId("move-curve")).toBeNull();
    expect(within(edwards).getByTestId("move-prices")).toHaveTextContent("84 ← 64");
    expect(edwards).toHaveClass("curved"); // the list still keeps the column, so the rows stay in line
  });

  it("keeps the row a link to the player's deals: the curve takes no tap of its own", () => {
    renderApp({ hash: "prices", viewport: "desktop", snap: curvedSnapshot() });
    const chase = row("Ja'Marr Chase");
    expect(within(chase).getByRole("link", { name: /See deals for Ja'Marr Chase/ })).toBeInTheDocument();
    expect(within(chase).getByTestId("move-curve").querySelector("a, button")).toBeNull();
  });

  it("is on a phone too, under the prices", () => {
    renderApp({ hash: "prices", viewport: "phone", snap: curvedSnapshot() });
    expect(within(row("Ja'Marr Chase")).getByTestId("move-curve")).toHaveTextContent("Last 7 days: 160 → 236");
  });

  it("lays the list out as before when no move has a curve", () => {
    renderApp({ hash: "prices", viewport: "desktop" });
    expect(within(page()).queryByTestId("move-curve")).toBeNull();
    for (const r of rows()) expect(r).not.toHaveClass("curved");
    expect(within(page()).getByRole("list", { name: "Risers" })).not.toHaveClass("curved");
  });

  it("draws none with the switch off, whatever the snapshot carries", () => {
    priceCurveSwitch.on = false;
    renderApp({ hash: "prices", viewport: "desktop", snap: curvedSnapshot() });
    expect(within(page()).queryByTestId("move-curve")).toBeNull();
    for (const r of rows()) expect(r).not.toHaveClass("curved");
  });

  it("is not on Today's panel: the curve is the Prices page's", () => {
    savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000 });
    renderApp({ viewport: "desktop", snap: curvedSnapshot() });
    expect(screen.queryByTestId("move-curve")).toBeNull();
  });
});
