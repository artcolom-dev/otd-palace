// What the site tells the admin panel it was used for (lib/activity.ts): the sort and sport picked, a sheet opened, a
// deal opened, an account looked up. Each place calls `track`; the queue and its sending are lib/activity.test.ts.
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Prefs, savePrefs } from "./data/prefs";
import { track } from "./lib/activity";
import { freshDevice, renderApp } from "./test/app";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));
vi.mock("./lib/activity", async (actual) => ({
  ...(await actual<typeof import("./lib/activity")>()),
  track: vi.fn(),
  startActivity: vi.fn(() => () => undefined),
}));

const prefs = (over: Partial<Prefs> = {}) =>
  savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000, ...over });
const calls = () => vi.mocked(track).mock.calls.map((c) => c.slice(0, 2));

describe("what the site reports it is used for", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    vi.mocked(track).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("the sort picked, and the sheet or menu it was picked in", () => {
    prefs();
    renderApp({ viewport: "desktop" });
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Sort deals" })).getByRole("menuitemradio", { name: "Cheapest" }));
    expect(calls()).toContainEqual(["sheet", "Sort deals"]);
    expect(calls()).toContainEqual(["sort", "cheapest"]);
  });

  it("the sport picked", () => {
    prefs();
    renderApp({ viewport: "desktop" });
    const tabs = screen.getAllByRole("tab").filter((t) => t.dataset.sport && t.dataset.sport !== "all");
    fireEvent.click(tabs[0]!);
    expect(calls()).toContainEqual(["sport", tabs[0]!.dataset.sport]);
  });

  it("a deal opened, by its listing", () => {
    prefs();
    renderApp({ viewport: "desktop" });
    const link = within(screen.getByRole("table", { name: "All deals" })).getAllByRole("link")[0]!;
    fireEvent.click(link);
    expect(vi.mocked(track).mock.calls.some(([kind, arg]) => kind === "deal" && typeof arg === "number")).toBe(true);
  });
});
