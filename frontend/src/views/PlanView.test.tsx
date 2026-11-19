import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_CHOICE_KEY } from "../lib/planChoice";
import { freshDevice, renderApp, seedDevice } from "../test/app";
import { JOKIC, MURRAY, passSnapshot } from "../test/passScene";

const withCoverage = () => {
  const snap = passSnapshot();
  return { ...snap, rules: { ...snap.rules, coverage: { sports: ["nba"], listings_complete: false, sales_window_h: 168, otd_as_of: null } } };
};
const open = (o: Parameters<typeof renderApp>[0] = {}) => renderApp({ snap: withCoverage(), hash: "plan", viewport: "desktop", ...o });
const linked = () =>
  seedDevice({
    passes: [{ key: JOKIC.key, tier: "common", from: "real" }, { key: MURRAY.key, tier: "common", from: "real" }],
    link: { username: "Shaedon", at: Date.now(), count: 2 },
  });

describe("Your plan: nothing linked", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());

  it("asks where the visitor is with Real, with three big choices", () => {
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Your plan" })).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Where are you with Real?" });
    expect(within(group).getAllByRole("button").map((b) => b.querySelector("b")?.textContent)).toEqual([
      "I haven't started",
      "I just started",
      "I have passes: link my account",
    ]);
    expect(screen.queryByText("Your first steps")).toBeNull();
    // Under the third choice: what linking reads, before the visitor taps it.
    const third = within(group).getByRole("button", { name: /link my account/ });
    expect(within(third).getByText("Reads your public profile. No password.")).toBeInTheDocument();
  });

  it("on a phone the level and budget row is left out of Your plan", () => {
    open({ viewport: "phone" });
    expect(screen.queryByRole("region", { name: "Level and budget" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
  });

  it("I haven't started: the first steps and the first passes with their numbers, remembered on this device", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /I haven't started/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Your first steps" })).toBeInTheDocument();
    expect(screen.getByText(/A General pays nothing On This Day/)).toBeInTheDocument();
    expect(screen.getByText(/daily streak poll/i)).toBeInTheDocument();
    const first = screen.getByRole("heading", { level: 2, name: /best first passes right now/ }).closest("section")!;
    expect(within(first).getAllByRole("button").length).toBeGreaterThan(0);
    for (const b of within(first).getAllByRole("button")) expect(b.textContent).toMatch(/Costs about [\d,]+ Rax · adds about [\d,]+ Rax a year/);
    expect(screen.getByText(/10% plus a 10 Rax listing fee/)).toBeInTheDocument();
    expect(screen.getByText(/put your Rax in passes first/)).toBeInTheDocument();
    expect(screen.getByText(/Offers under the usual price are the cheapest way to build a pass/)).toBeInTheDocument();
    expect(screen.getByText(/lockout is possible/)).toBeInTheDocument();
    expect(localStorage.getItem(PLAN_CHOICE_KEY)).toBe("start");
  });

  it("comes back to the choice made, and lets it be changed", () => {
    localStorage.setItem(PLAN_CHOICE_KEY, "new");
    open();
    expect(screen.getByRole("heading", { level: 2, name: "Your first passes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /I just started/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /I haven't started/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Your first steps" })).toBeInTheDocument();
    expect(localStorage.getItem(PLAN_CHOICE_KEY)).toBe("start");
  });

  it("I have passes: opens the link field, and saves nothing", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /I have passes: link my account/ }));
    expect(screen.getByPlaceholderText("Your Real username")).toBeInTheDocument();
    expect(localStorage.getItem(PLAN_CHOICE_KEY)).toBeNull();
  });

  it("works when the browser refuses its storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      open();
      fireEvent.click(screen.getByRole("button", { name: /I haven't started/ }));
      expect(screen.getByRole("heading", { level: 2, name: "Your first steps" })).toBeInTheDocument();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("without a way to read an account, the link choice is not offered to work", () => {
    open({ snap: passSnapshot() });
    fireEvent.click(screen.getByRole("button", { name: /I have passes: link my account/ }));
    expect(screen.queryByPlaceholderText("Your Real username")).toBeNull();
  });
});

describe("Your plan: a linked account", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    linked();
  });
  afterEach(() => vi.useRealTimers());

  it("says up to, in rax a year, the type, the way to the next type and the one move with its cost and payback", () => {
    open();
    act(() => void vi.advanceTimersByTime(600)); // the figure counts up for 500 ms
    expect(screen.getByText("Your passes can pay up to")).toBeInTheDocument();
    const year = screen.getByRole("heading", { level: 2, name: /Rax a year/ });
    expect(year.textContent).toMatch(/^[\d,]+ Rax a year$/);
    const n = Number(year.textContent!.replace(/[^\d]/g, ""));
    expect(n).toBeGreaterThan(0);
    expect(screen.getByText(/Up to: what your passes can pay if you claim every claim day for a year\. A day you skip pays nothing\./)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /^Way to / })).toBeInTheDocument();
    expect(screen.getByText(/of the way to/)).toBeInTheDocument();
    const one = screen.getByRole("heading", { level: 2, name: "Your best next move" }).closest("section")!;
    expect(within(one).getAllByRole("button")).toHaveLength(1);
    expect(within(one).getByRole("button").textContent).toMatch(/Costs about [\d,]+ Rax · adds about [\d,]+ Rax a year/);
    expect(within(one).getByRole("button").textContent).toMatch(/pays back by end of [A-Z]/);
  });

  it("ends with do, skip and watch for the type, then the ladder with the visitor's type marked", () => {
    open();
    const type = screen.getByRole("heading", { level: 2, name: /^For a .* account$/ });
    const name = /For a (.*) account/.exec(type.textContent!)![1]!;
    const lines = type.closest("section")!;
    expect(within(lines).getAllByRole("term").map((t) => t.textContent)).toEqual(["Do", "Skip", "Watch"]);
    const ladder = screen.getByRole("heading", { level: 2, name: "What each type is" }).closest("section")!;
    const items = within(ladder).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("b")?.textContent)).toEqual(["Giant", "Big", "Strong", "Steady", "Starter", "Not earning yet"]);
    const here = items.filter((li) => li.getAttribute("aria-current") === "true");
    expect(here).toHaveLength(1);
    expect(here[0]!.querySelector("b")?.textContent).toBe(name);
    expect(within(here[0]!).getByText("You are here")).toBeInTheDocument();
  });

  it("shows the linked account with Refresh and Unlink, and never the choices", () => {
    open();
    expect(screen.getByTestId("link-chip")).toHaveTextContent("Linked: @Shaedon");
    expect(screen.queryByText("Where are you with Real?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(screen.getByRole("group", { name: "Where are you with Real?" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Unlinked. Your passes from Real left this site.");
  });

  it("an account whose passes pay nothing is Not earning yet and is shown its first passes, not a made-up figure", () => {
    seedDevice({ passes: [{ key: "nba:1999:player:424242", tier: "general", from: "real" }], link: { username: "Shaedon", at: Date.now(), count: 1 } });
    open();
    expect(screen.getByText("No pass pays you yet")).toBeInTheDocument();
    expect(screen.queryByText(/Your passes can pay up to/)).toBeNull();
    expect(screen.getByText(/Your first paying pass makes you a Starter\./)).toBeInTheDocument();
  });
});

describe("Your plan: on Today", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());

  it("a compact card for a linked account, at the top of the rail, with the way to the whole plan", () => {
    linked();
    renderApp({ snap: withCoverage(), viewport: "desktop" });
    const rail = screen.getByRole("complementary", { name: "Your deals, prices and passes" });
    const card = within(rail).getByRole("heading", { level: 2, name: "Your plan" }).closest("section")!;
    expect(within(card).getByText("Your passes can pay up to")).toBeInTheDocument();
    expect(within(card).queryByText(/Best next move/)).toBeNull(); // "Your next Rax" below says it: never twice
    expect(within(card).getByText(/Up to: if you claim every claim day\./)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("link", { name: /See your whole plan/ }));
    expect(`${location.pathname}${location.hash}`).toBe("/plan");
    expect(screen.getByRole("heading", { level: 1, name: "Your plan" })).toBeInTheDocument();
  });

  it("for a visitor with nothing linked: the question, small, and the first step once answered", () => {
    renderApp({ snap: withCoverage(), viewport: "phone" });
    const card = screen.getByRole("heading", { level: 2, name: "Your plan" }).closest("section")!;
    expect(within(card).getByText("Where are you with Real?")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /I haven't started/ }));
    expect(within(card).getByText("First step")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /See the whole plan/ })).toBeInTheDocument();
  });
});

