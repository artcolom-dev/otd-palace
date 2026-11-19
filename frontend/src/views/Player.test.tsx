import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { savePrefs } from "../data/prefs";
import { addDays, localDay } from "../lib/routine";
import { trackOut } from "../lib/track";
import { freshDevice, renderApp, seedDevice } from "../test/app";
import { makeDeal } from "../test/fixtures";
import { MACKINNON, passSnapshot } from "../test/passScene";
import { NOW } from "../test/scene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const TODAY = localDay(NOW);
const snap = passSnapshot({
  deals: [makeDeal({ listing_id: 41, sport: "nba", player_id: 999, player_name: "Someone Else", price: 150, reference: 330, flip_margin: 130, discount: 0.5, now: NOW })],
});
const level = (l: "new" | "regular" | "pro", tab = "today", sport = "all") =>
  savePrefs({ level: l, budget: 1000, sport, sort: "best", tab: tab as "today", passBudget: 5000 });
const day = () => screen.getByRole("region", { name: "Your day" });
const flush = () => act(async () => void (await Promise.resolve()));
const box = (name: RegExp | string) => within(day()).getByRole("checkbox", { name });

describe("Your day", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("is on Today for New, with five things, each saying what it earns, and the poll trap under the claim", () => {
    renderApp({ snap, viewport: "desktop" });
    const items = within(day()).getAllByRole("checkbox");
    expect(items).toHaveLength(5);
    expect(within(day()).getByText("Claim the passes you hold")).toBeInTheDocument();
    expect(within(day()).getByText("Pays Rax. Passes of past seasons: 2 claims per sport a day. This season's pay after each game.")).toBeInTheDocument();
    expect(within(day()).getByText("Earns karma. Open the game in the app.")).toBeInTheDocument();
    expect(within(day()).getByText("Pays Rax (Real Pro): 100 down to 10 for the top 10, plus 10 per exact pick.")).toBeInTheDocument();
    expect(within(day()).getByText("A pass applied to a poll cannot be claimed until the poll ends.")).toBeInTheDocument();
    expect(within(day()).getByText(/^Earns karma: 10 per poll win, up to 100 if wagered\. 1,000 karma is 5 Rax: a slow start, not a plan\./)).toBeInTheDocument();
    expect(day()).not.toHaveTextContent(/karma (is|are) worth|a day for free/i);
  });

  it("is off for Regular and Pro until the visitor turns it on, and can be put away again", () => {
    level("regular");
    renderApp({ snap, viewport: "desktop" });
    expect(screen.queryByRole("region", { name: "Your day" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show your daily checklist" }));
    expect(day()).toBeInTheDocument();
    expect(local.get().routine.show).toBe(true);
    fireEvent.click(within(day()).getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Your day" })).toBeNull();
    expect(local.get().routine.show).toBe(false);
    expect(screen.getByRole("button", { name: "Show your daily checklist" })).toBeInTheDocument();
  });

  it("fills the ring as items are ticked, on this device, and counts the day from 3", () => {
    renderApp({ snap, viewport: "phone" });
    expect(within(day()).getByRole("img", { name: "0 of 5 done today" })).toBeInTheDocument();
    expect(day()).toHaveTextContent("Tick 3 things to start a streak.");
    fireEvent.click(box(/Claim the passes/));
    fireEvent.click(box(/Answer the daily polls/));
    expect(within(day()).getByRole("img", { name: "2 of 5 done today" })).toBeInTheDocument();
    expect(local.get().routine.done).toEqual([]);
    fireEvent.click(box(/Watch one live game/));
    expect(local.get().routine).toMatchObject({ day: TODAY, ticks: ["claim", "polls", "game"], done: [TODAY] });
    expect(day()).toHaveTextContent("Streak: 1 day");
    fireEvent.click(box(/Watch one live game/));
    expect(local.get().routine.done).toEqual([]);
  });

  it("starts afresh at the device's midnight, keeping the streak it built", async () => {
    seedDevice({ routine: { show: null, day: addDays(TODAY, -1), ticks: ["claim", "polls", "game"], done: [addDays(TODAY, -1)] } });
    const { advance } = renderApp({ snap, viewport: "desktop" });
    expect(day()).toHaveTextContent("Streak: 1 day");
    expect(within(day()).getByRole("img", { name: "0 of 5 done today" })).toBeInTheDocument(); // yesterday's ticks are not today's
    fireEvent.click(box(/Check today's best deals/));
    fireEvent.click(box(/Answer the daily polls/));
    fireEvent.click(box(/Set your daily lineup/));
    expect(day()).toHaveTextContent("Streak: 2 days");
    const midnight = new Date(NOW);
    midnight.setHours(24, 0, 0, 0); // the device's next midnight, whatever its time zone
    act(() => vi.setSystemTime(midnight.getTime() + 1500));
    await advance(2000);
    expect(within(day()).getByRole("img", { name: "0 of 5 done today" })).toBeInTheDocument();
    expect(day()).toHaveTextContent("Streak: 2 days"); // one missed day not yet: today is still to do
  });

  it("forgives one missed day, shows the grace as used, and never calls it a failure", () => {
    seedDevice({ routine: { show: null, day: "", ticks: [], done: [addDays(TODAY, -4), addDays(TODAY, -3), addDays(TODAY, -1)] } });
    renderApp({ snap, viewport: "desktop" });
    expect(day()).toHaveTextContent("Streak: 3 days");
    expect(day().querySelector(".rtn-grace")).toHaveTextContent(/^Grace day used \(\w{3}\)$/);
    expect(day()).not.toHaveTextContent(/lost|broke|fail|missed a day!/i);
  });

  it("shows a grace day as ready while there is one", () => {
    seedDevice({ routine: { show: null, day: "", ticks: [], done: [addDays(TODAY, -2), addDays(TODAY, -1)] } });
    renderApp({ snap, viewport: "desktop" });
    expect(day().querySelector(".rtn-grace")).toHaveTextContent("1 grace day ready");
  });

  it("links the app's things to Real's home, counted as the routine panel, and Deals to this site's Deals", () => {
    renderApp({ snap, viewport: "desktop" });
    const link = within(day()).getByRole("link", { name: "Open Real: Answer the daily polls" });
    expect(link).toHaveAttribute("href", "https://www.realapp.com/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    fireEvent.click(link);
    expect(trackOut).toHaveBeenCalledWith({ panel: "routine", target: "app", level: "new", sport: "all", pos: 1 });
    expect(within(day()).queryByRole("link", { name: /Check today's best deals/ })).toBeNull();
    fireEvent.click(within(day()).getByRole("button", { name: "See today's deals" }));
    expect(`${location.pathname}${location.hash}`).toBe("/deals");
  });

  it("reads a corrupt store as an empty checklist and still works", () => {
    localStorage.setItem("advisor.local.v1", JSON.stringify({ routine: { day: 5, ticks: { a: 1 }, done: "yes", show: "x" } }));
    local.reload();
    renderApp({ snap, viewport: "phone" });
    expect(within(day()).getByRole("img", { name: "0 of 5 done today" })).toBeInTheDocument();
    fireEvent.click(box(/Claim the passes/));
    expect(local.get().routine.ticks).toEqual(["claim"]);
  });
});

describe("Your first pass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());
  const card = () => screen.getByRole("region", { name: "Your first pass" });

  it("names the cheapest sensible pass with what it costs and pays, an estimate", () => {
    renderApp({ snap, viewport: "desktop" });
    expect(within(card()).getByText("Nathan MacKinnon 2025-26")).toBeInTheDocument();
    expect(card()).toHaveTextContent("NHL · Common · about 260 Rax");
    expect(card()).toHaveTextContent("Pays about 1,000 Rax a year (estimate).");
  });

  it("fills a bar from the balance typed, which is the one balance the buddy uses too", () => {
    renderApp({ snap, viewport: "desktop" });
    expect(within(card()).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(card()).toHaveTextContent("255 Rax to go.");
    fireEvent.change(within(card()).getByLabelText("Rax you have now"), { target: { value: "100" } });
    expect(local.get().balance).toBe(100);
    expect(within(card()).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "39");
    expect(card()).toHaveTextContent("155 Rax to go of 255.");
    // Offers: the same pass for less, if enough are accepted (10 rating at 4.4 a point instead of 5.5).
    expect(within(card()).getByTestId("first-offer")).toHaveTextContent(
      "Cheaper with offers: offer under the usual price on many of its cards. If enough are accepted it costs about 240 Rax, so about 140 to go.",
    );
    expect(within(screen.getByRole("region", { name: "What can I do with…" })).getByLabelText("Your balance in Rax")).toHaveValue("100");
  });

  it("works out no time until the visitor gives their own daily Rax, then says it is their estimate", () => {
    seedDevice({ balance: 100 });
    renderApp({ snap, viewport: "desktop" });
    expect(card()).not.toHaveTextContent(/days? to go/);
    expect(card()).toHaveTextContent("we do not guess what an account earns");
    fireEvent.change(within(card()).getByLabelText("Rax I make on a typical day (optional)"), { target: { value: "20" } });
    expect(local.get().dailyRax).toBe(20);
    expect(card()).toHaveTextContent("About 8 days to go (your estimate).");
    fireEvent.change(within(card()).getByLabelText("Rax you have now"), { target: { value: "300" } });
    expect(card()).toHaveTextContent("You have enough for it.");
    expect(card()).not.toHaveTextContent(/days? to go/);
  });

  it("opens Deals on that pass's cards", () => {
    renderApp({ snap, viewport: "desktop" });
    fireEvent.click(within(card()).getByRole("button", { name: /See cards for this pass/ }));
    expect(`${location.pathname}${location.hash}`).toBe("/deals");
    expect(screen.getByRole("button", { name: "Clear the card filter" })).toBeInTheDocument(); // Deals shows only that pass's cards
  });

  it("is gone once the visitor holds a pass, and for a snapshot with no pass to name", () => {
    seedDevice({ passes: [{ key: MACKINNON.key, tier: "common" }] });
    renderApp({ snap, viewport: "desktop" });
    expect(screen.queryByRole("region", { name: "Your first pass" })).toBeNull();
  });
});

describe("Your next Rax", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());
  const card = () => screen.getByRole("region", { name: "Your next Rax" });

  it("sits under the top three on a desktop, and after the buddy on a phone", () => {
    level("regular");
    const { unmount } = renderApp({ snap, viewport: "desktop" });
    expect(document.querySelector('.lcol .slot[data-slot="next"]')).toContainElement(card());
    unmount();
    renderApp({ snap, viewport: "phone" });
    const heads = [...document.querySelectorAll(".page.today section h2")].map((h) => h.textContent);
    expect(heads.indexOf("Your next Rax")).toBe(heads.indexOf("What can I do with…") + 1);
  });

  it("says where a free player starts, then ranks the moves by return per Rax, each with its cost and what it returns", () => {
    level("regular");
    renderApp({ snap, viewport: "desktop" });
    const order = within(card()).getByText("Where to start").parentElement!;
    expect(order).toHaveTextContent("Your free pass in each sport, on different game days.");
    expect(order).toHaveTextContent("Small, safe deals only while no pass fits your Rax.");
    const rows = within(within(card()).getByRole("list", { name: "Your next moves" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/^Add a pass in [A-Z]+: a daily claim is free/); // the NHL one is the pass worth getting beside it
    expect(rows[0]).toHaveTextContent(/about [\d,]+ a year \(estimate\)/);
    expect(rows[0]).toHaveTextContent(/Resale|Resellable|cards resell/);
    expect(card()).toHaveTextContent("Estimates, not promises");
  });

  it("on Today, never repeats the pass worth getting beside it, and leads to all the passes", () => {
    level("regular");
    for (const viewport of ["desktop", "phone"] as const) {
      const { unmount } = renderApp({ snap, viewport });
      const pick = within(screen.getByRole("region", { name: "Pass worth getting" })).getByRole("heading", { level: 3 });
      const rows = within(within(card()).getByRole("list", { name: "Your next moves" })).getAllByRole("listitem");
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row).not.toHaveTextContent(pick.textContent!);
      expect(within(card()).getByRole("link", { name: /See all passes/ })).toHaveAttribute("href", "#passes");
      unmount();
    }
  });

  it("opens a pass's card from its row", () => {
    level("regular");
    renderApp({ snap, viewport: "desktop" });
    const rows = within(card()).getByRole("list", { name: "Your next moves" });
    fireEvent.click(within(rows).getAllByRole("button")[0]!);
    expect(screen.getByRole("dialog", { name: /pass$/ })).toBeInTheDocument();
  });

  it("is the fuller list on Passes: five moves, and none of it while paused for the deals", async () => {
    level("regular", "passes");
    renderApp({ snap, viewport: "desktop", hash: "passes" });
    const full = within(within(card()).getByRole("list", { name: "Your next moves" })).getAllByRole("listitem");
    expect(full.length).toBeGreaterThan(3);
    expect(full.length).toBeLessThanOrEqual(5);
    expect(local.get().passes).toEqual([]);
  });

  it("leaves out deals while paused, and says so", async () => {
    level("regular");
    const { advance } = renderApp({ snap, viewport: "desktop", respond: () => new Response(null, { status: 503 }) });
    await advance(16_000);
    expect(card()).not.toHaveTextContent("Someone Else");
  });

  it("lifts a pass the visitor holds over a rung, with its cost and what it adds", () => {
    level("regular");
    seedDevice({ passes: [{ key: MACKINNON.key, tier: "uncommon" }], balance: 1000 });
    renderApp({ snap, viewport: "desktop" });
    expect(card()).not.toHaveTextContent("Where to start");
    expect(card()).toHaveTextContent("Lift Nathan MacKinnon to Epic"); // 4x to 10x: the lift that returns the most per Rax
    expect(card()).toHaveTextContent("adds about 3,500 a year (estimate)");
  });
});

describe("the 12-month plan", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());
  const plan = () => screen.getByRole("region", { name: "12-month plan" });

  it("is for Regular and Pro, and for anyone holding a pass, not for a New visitor with none", () => {
    renderApp({ snap, viewport: "desktop", hash: "passes" });
    expect(screen.queryByRole("region", { name: "12-month plan" })).toBeNull();
  });

  it("shows New once a pass is held", () => {
    seedDevice({ passes: [{ key: MACKINNON.key, tier: "uncommon" }] });
    renderApp({ snap, viewport: "desktop", hash: "passes" });
    expect(plan()).toBeInTheDocument();
  });

  it("asks for the balance, then gives a labelled chart, and its steps and a table behind one disclosure, and says what it assumes", () => {
    level("regular", "passes");
    renderApp({ snap, viewport: "desktop", hash: "passes" });
    expect(plan()).toHaveTextContent("Type the Rax you have to see a plan.");
    fireEvent.change(within(plan()).getByLabelText("Rax you have now"), { target: { value: "400" } });
    expect(local.get().balance).toBe(400);
    act(() => void vi.advanceTimersByTime(50));
    expect(within(plan()).getByTestId("snowball-say")).toHaveTextContent(
      "In 12 months your passes could pay about 5,800 Rax a year, up from 0 now (estimate).",
    );
    // The steps are the plan's own "what to add": they sit with the table, behind "Show as a table", closed at first,
    // because the page's list of next moves already says what to add now.
    const behind = within(plan()).getByText("Show as a table").closest("details")!;
    expect(behind).not.toHaveAttribute("open");
    const steps = within(behind).getByRole("list", { name: "Steps" });
    expect(steps).toHaveTextContent("Now: add Nathan MacKinnon 2025-26 Uncommon for 370, adds about 1,500 a year");
    expect(steps).toHaveTextContent("and 1 more steps (see the table)");
    expect(behind).toContainElement(within(plan()).getByRole("table"));
    expect(behind).not.toContainElement(within(plan()).getByTestId("snowball-say")); // the year's figure stays in the open
    const chart = within(plan()).getByRole("img", { name: /Rax a year the passes pay over the next 12 months/ });
    expect(chart.querySelector("path.snw-line")).not.toBeNull();
    expect(chart.textContent).toContain("Months from now");
    expect(chart.textContent).toContain("Rax a year");
    const table = within(plan()).getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(14);
    expect(plan()).toHaveTextContent("Uses today's prices, no price changes. An estimate, not a promise");
    expect(plan().querySelector("[style]")).toBeNull();
  });

  it("says when the balance reaches nothing", () => {
    level("regular", "passes");
    seedDevice({ balance: 50 });
    renderApp({ snap, viewport: "desktop", hash: "passes" });
    expect(plan()).toHaveTextContent("That is not enough for a pass that pays back yet.");
  });
});

describe("How Real works", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());
  const sheet = () => screen.getByRole("dialog", { name: "How Real works" });

  it("opens from the footer with all its answers, in a modal that Escape closes, and gives the address back", async () => {
    renderApp({ snap, viewport: "desktop" });
    fireEvent.click(screen.getAllByRole("button", { name: "How Real works" })[0]!);
    expect(sheet()).toHaveAttribute("aria-modal", "true");
    expect(within(sheet()).getAllByRole("heading", { level: 3 })).toHaveLength(15);
    expect(location.hash).toBe("#how");
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog", { name: "How Real works" })).toBeNull();
    expect(`${location.pathname}${location.hash}`).toBe("/");
  });

  it("opens from the footer on a phone too", () => {
    renderApp({ snap, viewport: "phone" });
    fireEvent.click(screen.getAllByRole("button", { name: "How Real works" })[0]!);
    expect(within(sheet()).getAllByRole("heading", { level: 3 })).toHaveLength(15);
  });

  it("opens at an answer from its address, and keeps the tab the visitor was on", async () => {
    renderApp({ snap, viewport: "desktop", hash: "how/fees" });
    expect(sheet()).toBeInTheDocument();
    expect(location.hash).toBe("#how/fees");
    expect(within(sheet()).getByRole("heading", { level: 3, name: "Fees" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(`${location.pathname}${location.hash}`).toBe("/");
  });

  it("opens when the address changes to it", () => {
    renderApp({ snap, viewport: "desktop" });
    act(() => {
      history.replaceState(null, "", "#how/countdown");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(sheet()).toBeInTheDocument();
  });

  it("searches its answers, and says when none matches", () => {
    renderApp({ snap, viewport: "desktop", hash: "how" });
    const box = within(sheet()).getByRole("searchbox", { name: "Search how Real works" });
    fireEvent.change(box, { target: { value: "soft close" } });
    expect(within(sheet()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["No instant buy, and the countdown"]);
    fireEvent.change(box, { target: { value: "zzzz" } });
    expect(within(sheet()).queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(sheet()).toHaveTextContent("Nothing matches.");
    fireEvent.change(box, { target: { value: "" } });
    expect(within(sheet()).getAllByRole("heading", { level: 3 })).toHaveLength(15);
  });

  it("is offered by the ⓘ of a word that has a fuller answer, and opens at it", () => {
    renderApp({ snap, viewport: "desktop" });
    fireEvent.click(screen.getByRole("button", { name: "Explain On This Day" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "On This Day" })).getByRole("button", { name: "How Real works" }));
    expect(location.hash).toBe("#how/passes");
    expect(sheet()).toBeInTheDocument();
  });
});

describe("a held pass this site does not list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());

  it("counts on the Passes tab once an account's analysis brought its valuation, and is a bare key before", () => {
    const theirs = { ...MACKINNON, key: "nhl:2019:player:777", season: 2019, season_state: "past" as const, season_progress: 1, player_id: 777, player_name: "Lone Wolf" };
    seedDevice({ passes: [{ key: theirs.key, tier: "rare" }] });
    const panel = () => screen.getByRole("region", { name: "My passes" });
    const showList = () => {
      const show = within(panel()).queryByRole("button", { name: /^Show my/ }); // the list's open state outlives a page
      if (show) fireEvent.click(show);
    };
    const before = renderApp({ snap: passSnapshot(), viewport: "desktop", hash: "passes" });
    showList();
    expect(within(panel()).getByText("A pass not in today's data")).toBeInTheDocument();
    before.unmount();
    seedDevice({ passes: [{ key: theirs.key, tier: "rare" }], heldMarkets: [theirs] });
    renderApp({ snap: passSnapshot(), viewport: "desktop", hash: "passes" });
    showList();
    expect(within(panel()).queryByText("A pass not in today's data")).toBeNull();
    expect(within(panel()).getByText(/Lone Wolf/)).toBeInTheDocument();
    expect(screen.getByTestId("passes-total")).not.toHaveTextContent(/^0$/);
  });
});
