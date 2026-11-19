import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { defaultSeason, passList } from "../data/passList";
import { savePrefs } from "../data/prefs";
import { freshDevice, renderApp, seedDevice, setVisibility } from "../test/app";
import { NOW, sceneSnapshot } from "../test/scene";
import { passSnapshot } from "../test/passScene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const hero = () => screen.getByRole("region", { name: "Best deals for you right now" });
const rail = () => screen.getByRole("complementary", { name: "Your deals, prices and passes" });
const moving = () => screen.getByRole("region", { name: "Moving today" });
const movers = () => within(moving()).getAllByTestId("move-player").map((p) => p.textContent);
const passPanel = () => screen.getByRole("region", { name: "Pass worth getting" });
const opened = () => screen.queryByRole("region", { name: /^You opened/ });
const regular = (over = {}) =>
  savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000, ...over });
const min = (n: number) => n * 60_000;
const COMMUNITY = { community: "https://discord.gg/abc" };
const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Away from the page (in Real) for a while, then back. */
async function leaveAndReturn(advance: (ms: number) => Promise<void>) {
  setVisibility("hidden");
  await advance(min(1));
  setVisibility("visible");
}

describe("Today: the right column", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("runs Moving today, the pass worth getting and the community, in that order", () => {
    renderApp({ viewport: "desktop", snap: sceneSnapshot({ otd: passSnapshot().otd, links: COMMUNITY }) });
    const parts = [moving(), passPanel(), within(rail()).getByRole("link", { name: /Discord/ })];
    for (const part of parts) expect(rail()).toContainElement(part);
    expect(before(parts[0]!, parts[1]!) && before(parts[1]!, parts[2]!)).toBe(true);
    // The community link moves into the rail: the sidebar does not repeat it on Today.
    expect(screen.getAllByRole("link", { name: /Discord/ })).toHaveLength(1);
    expect(screen.queryByText(/Busiest/)).toBeNull();
  });

  it.each(["phone", "desktop"] as const)("puts each mover's face beside the name (%s)", (viewport) => {
    renderApp({ viewport });
    const rows = within(moving()).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const face = within(row).getByTestId("avatar");
      expect(face).toHaveClass("pav", "s28");
      expect(face.compareDocumentPosition(within(row).getByTestId("move-player")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("shows the top 4 movers on desktop, then See all moves to Prices", () => {
    renderApp({ viewport: "desktop" });
    expect(movers()).toEqual(["Ja'Marr Chase", "Anthony Edwards", "Mohamed Salah", "Macklin Celebrini"]);
    fireEvent.click(within(moving()).getByRole("tab", { name: "Fallers" }));
    expect(movers()).toEqual(["Connor McDavid", "Nikola Jokić"]);
    fireEvent.click(within(moving()).getByRole("link", { name: /See all moves/ }));
    expect(`${location.pathname}${location.hash}`).toBe("/prices");
    expect(screen.getByRole("heading", { name: "Prices moving today", level: 1 })).toBeInTheDocument();
    // Prices opens on the side the panel showed.
    expect(screen.getByRole("tab", { name: "Fallers" })).toHaveAttribute("aria-selected", "true");
  });

  it("respects the sport tab and says when there are not enough sales", () => {
    regular();
    renderApp({ viewport: "desktop" });
    fireEvent.click(screen.getByRole("tab", { name: /^NBA/ }));
    expect(movers()).toEqual(["Anthony Edwards"]);
    fireEvent.click(screen.getByRole("tab", { name: /^Soccer/ }));
    fireEvent.click(within(moving()).getByRole("tab", { name: "Fallers" }));
    expect(moving()).toHaveTextContent("Not enough sales yet today.");
  });

  it("offers the top pass in the visitor's budget and sport, in plain words, with its deals", () => {
    regular({ passBudget: 1000 });
    const snap = sceneSnapshot({ otd: passSnapshot().otd });
    renderApp({ viewport: "desktop", snap });
    const filters = {
      level: "regular" as const, budget: 1000, sport: "all", season: defaultSeason("regular"), soon: false,
      showAll: false, sort: "ret" as const, query: "",
    };
    const top = passList(snap, filters).top!;
    const panel = passPanel();
    expect(within(panel).getByRole("heading", { name: top.market.player_name })).toBeInTheDocument();
    expect(panel).toHaveTextContent(/Pays about [\d,]+ Rax a year on game days\. Your [\d,]+ comes back in about \d+ months?/);
    expect(top.rung.cost!).toBeLessThanOrEqual(1000);
    fireEvent.click(within(panel).getByRole("link", { name: `See deals for ${top.market.player_name}` }));
    expect(`${location.pathname}${location.hash}`).toBe("/deals");
    expect(screen.getByText(`${top.market.player_name} ${top.market.season_label}`)).toBeInTheDocument();
  });

  it("names the pass's limit only when it has one, and follows the sport", () => {
    regular({ sport: "nhl", passBudget: null });
    const snap = sceneSnapshot({ otd: passSnapshot().otd });
    renderApp({ viewport: "desktop", snap });
    const top = passList(snap, {
      level: "regular", budget: null, sport: "nhl", season: "all", soon: false, showAll: false, sort: "ret", query: "",
    }).top!;
    expect(top.market.sport).toBe("nhl");
    expect(within(passPanel()).getByRole("heading", { name: top.market.player_name })).toBeInTheDocument();
    if (top.rung.limit === null) expect(passPanel()).not.toHaveTextContent("it stops after");
    else expect(passPanel()).toHaveTextContent(/; it stops after (about )?[\d,]+ in total/);
  });

  it("says when there is no pass data yet", () => {
    renderApp({ viewport: "desktop" });
    expect(passPanel()).toHaveTextContent("No pass data yet.");
  });
});

describe("Today on a phone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("runs the top three, 5 more deals and See all, the top 3 movers, one pass; the invite to join sits right after the top three", () => {
    regular({ budget: null, level: "pro" });
    const deals = sceneSnapshot().deals;
    const extra = deals.map((d, i) => ({ ...d, listing_id: 200 + i, card_id: 200 + i }));
    renderApp({ snap: sceneSnapshot({ deals: [...deals, ...extra], otd: passSnapshot().otd, links: COMMUNITY }) });
    const more = screen.getByRole("region", { name: "More deals" });
    expect(within(more).getAllByTestId("player")).toHaveLength(5);
    const seeAll = within(more).getByRole("button", { name: /See all deals/ });
    expect(movers()).toEqual(["Ja'Marr Chase", "Anthony Edwards", "Mohamed Salah"]);
    const cta = screen.getByRole("link", { name: /Discord/ });
    const order = [hero(), cta, more, moving(), passPanel()];
    for (let i = 1; i < order.length; i++) expect(before(order[i - 1]!, order[i]!)).toBe(true);
    fireEvent.click(seeAll);
    expect(screen.getByRole("heading", { name: "All deals", level: 1 })).toBeInTheDocument();
  });
});

describe("Since your last visit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("tells a returning visitor about their players, above the top three, and can be dismissed", () => {
    regular();
    seedDevice({ lastVisitAt: NOW - min(12), follows: ["nba:22", "nba:44"], visits: 1 });
    renderApp({ viewport: "desktop" });
    const note = screen.getByRole("note", { name: "Since your last visit" });
    expect(note).toHaveTextContent("Since your last visit: 2 new deals on your players · Edwards +31% today");
    expect(before(note, hero())).toBe(true);
    fireEvent.click(within(note).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("note", { name: "Since your last visit" })).toBeNull();
  });

  it("shows their deals on the Deals tab", () => {
    regular();
    seedDevice({ lastVisitAt: NOW - min(12), follows: ["nba:22"] });
    renderApp({ viewport: "desktop" });
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(`${location.pathname}${location.hash}`).toBe("/deals");
    expect(screen.getByRole("tab", { name: /My players/ })).toHaveAttribute("aria-selected", "true");
  });

  it("stays quiet on a first visit and within 10 minutes of the last", () => {
    seedDevice({ lastVisitAt: NOW - min(9), follows: ["nfl:11"] });
    renderApp({ viewport: "desktop" });
    expect(screen.queryByRole("note", { name: "Since your last visit" })).toBeNull();
  });

  /** The phone keeps the page alive in the background: hidden for 40 minutes, then back. A new visit. */
  async function backAfter40Minutes() {
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(min(40));
    });
    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(local.get().visits).toBe(2);
  }
  const sinceNote = () => screen.queryByRole("note", { name: "Since your last visit" });

  it("counts from the visit that just ended when a page left open is come back to after a while", async () => {
    regular();
    seedDevice({ lastVisitAt: NOW - min(12), follows: ["nba:22", "nba:44"], visits: 1 });
    renderApp({ viewport: "desktop" });
    expect(sinceNote()).toHaveTextContent("2 new deals on your players · Edwards +31% today");
    await backAfter40Minutes();
    // Both deals were on screen during the visit that just ended: nothing new about them, only today's move.
    expect(sinceNote()).toHaveTextContent("Since your last visit: Edwards +31% today");
    expect(sinceNote()).not.toHaveTextContent("new deal");
  });

  it("puts the note away for one visit only: a page left open says it again on the next", async () => {
    regular();
    seedDevice({ lastVisitAt: NOW - min(12), follows: ["nba:22", "nba:44"], visits: 1 });
    renderApp({ viewport: "desktop" });
    fireEvent.click(within(sinceNote()!).getByRole("button", { name: "Dismiss" }));
    expect(sinceNote()).toBeNull();
    await backAfter40Minutes();
    expect(sinceNote()).toHaveTextContent("Since your last visit: Edwards +31% today");
  });

  it("remembers the visit when the page is hidden and when it closes", () => {
    renderApp();
    setVisibility("hidden");
    expect(local.get().lastVisitAt).toBe(Date.now());
    setVisibility("visible");
    vi.setSystemTime(NOW + min(5));
    window.dispatchEvent(new Event("pagehide"));
    expect(local.get().lastVisitAt).toBe(NOW + min(5));
  });
});

describe("You opened… got one?", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("asks when the page comes back after an Open, and Got it adds what was saved, counting up", async () => {
    const { advance } = renderApp({ viewport: "desktop" });
    await advance(5000);
    fireEvent.click(within(hero()).getByRole("link", { name: /Open in Real/ })); // Chase: 160, usually 230
    await advance(5000);
    expect(opened()).toBeNull(); // still on the page: nothing to ask yet
    await leaveAndReturn(advance);
    const strip = opened()!;
    expect(rail().firstElementChild).toContainElement(strip);
    expect(within(strip).getByRole("heading", { level: 2 })).toHaveTextContent("You opened 1 deal — got one?");
    expect(strip).toHaveTextContent("160 to start");
    fireEvent.click(within(strip).getByRole("button", { name: "Got it: Ja'Marr Chase" }));
    expect(local.get().saved).toBe(70);
    expect(strip).toHaveTextContent("Nice, you saved 70 Rax");
    const saved = () => screen.getByTestId("saved-total");
    await advance(700);
    expect(saved()).toHaveTextContent("Saved 70 Rax");
    await advance(3000);
    expect(opened()).toBeNull();
  });

  it("never counts the same listing twice", async () => {
    const { advance } = renderApp({ viewport: "desktop" });
    await advance(5000);
    fireEvent.click(within(hero()).getByRole("link", { name: /Open in Real/ }));
    await leaveAndReturn(advance);
    fireEvent.click(screen.getByRole("button", { name: "Got it: Ja'Marr Chase" }));
    fireEvent.click(within(hero()).getByRole("link", { name: /Open in Real/ }));
    await leaveAndReturn(advance);
    expect(screen.queryByRole("button", { name: "Got it: Ja'Marr Chase" })).toBeNull();
    expect(local.get().saved).toBe(70);
  });

  it("asks about opens of an earlier page load, for 30 minutes, and Not this time puts it away", async () => {
    seedDevice({
      opened: [
        { key: "104:target", listing_id: 104, kind: "target", sport: "nba", player_id: 44, player_name: "Anthony Edwards",
          price: 70, reference: 95, rarity: 3, at: NOW - min(3) },
        { key: "101:target", listing_id: 101, kind: "target", sport: "nfl", player_id: 11, player_name: "Ja'Marr Chase",
          price: 160, reference: 230, rarity: 4, at: NOW - min(29) },
      ],
    });
    const { advance } = renderApp();
    const strip = opened()!;
    expect(before(strip, hero())).toBe(true); // a phone asks above the top three
    expect(strip).toHaveTextContent("You opened 2 deals — got one?");
    await advance(min(2));
    expect(strip).toHaveTextContent("You opened 1 deal — got one?"); // Chase's open is now over 30 minutes old
    fireEvent.click(within(strip).getByRole("button", { name: "Not this time" }));
    expect(opened()).toBeNull();
    await leaveAndReturn(advance);
    expect(opened()).toBeNull();
  });
});

describe("Saved with OTD Palace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("sits in the sidebar on desktop once above 0, with what it counts", () => {
    seedDevice({ saved: 1240, got: [1, 2] });
    renderApp({ viewport: "desktop" });
    const side = screen.getByRole("complementary", { name: "Menu and filters" });
    const saved = within(side).getByTestId("saved-total");
    expect(saved).toHaveTextContent("Saved 1,240 Rax");
    expect(saved).toHaveTextContent("with OTD Palace");
    fireEvent.click(within(saved).getByRole("button", { name: "Explain saved with OTD Palace" }));
    expect(screen.getByText("Counted on this device from deals you marked.")).toBeInTheDocument();
  });

  it("is not there at 0", () => {
    renderApp({ viewport: "desktop" });
    expect(screen.queryByTestId("saved-total")).toBeNull();
  });

  it("sits under the top three on a phone", () => {
    seedDevice({ saved: 95 });
    renderApp();
    const saved = screen.getByTestId("saved-total");
    expect(saved).toHaveTextContent("Saved 95 Rax with OTD Palace");
    expect(before(hero(), saved)).toBe(true);
  });

  it("takes the pass total's place in the sidebar on the Passes tab", () => {
    seedDevice({ saved: 300 });
    renderApp({ viewport: "desktop", hash: "passes", snap: passSnapshot() });
    const side = screen.getByRole("complementary", { name: "Menu and filters" });
    expect(within(side).getByTestId("saved-total")).toHaveTextContent("Saved 300 Rax");
    expect(within(side).queryByText(/Your passes pay about/)).toBeNull();
  });
});

describe("Add to home screen", () => {
  const ua = (value: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(value);
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const card = () => screen.queryByRole("region", { name: "Add OTD Palace to your home screen" });

  function offerInstall() {
    const prompt = vi.fn(async () => undefined);
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
    });
    act(() => void window.dispatchEvent(event));
    return { prompt, event };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("is offered from the second visit on Android, and Add asks the browser", async () => {
    seedDevice({ visits: 1, lastVisitAt: NOW - min(120) });
    const { advance } = renderApp();
    const { prompt, event } = offerInstall();
    await advance(0);
    expect(event.defaultPrevented).toBe(true);
    expect(card()).toHaveTextContent("Add OTD Palace to your home screen");
    fireEvent.click(within(card()!).getByRole("button", { name: "Add" }));
    expect(prompt).toHaveBeenCalled();
    await advance(0);
    expect(card()).toBeNull();
  });

  it("says Share, then Add to Home Screen on an iPhone", () => {
    ua(IPHONE);
    seedDevice({ visits: 3, lastVisitAt: NOW - min(120) });
    renderApp();
    expect(card()).toHaveTextContent("Tap Share, then Add to Home Screen");
  });

  it("is not offered on a first visit, once installed, on desktop, or once dismissed", async () => {
    ua(IPHONE);
    const { unmount } = renderApp();
    expect(card()).toBeNull(); // the first visit
    unmount();
    seedDevice({ visits: 1, lastVisitAt: NOW - min(120) });
    const standalone = renderApp({ standalone: true });
    expect(card()).toBeNull();
    standalone.unmount();
    seedDevice({ visits: 4, lastVisitAt: NOW - min(120) });
    const desk = renderApp({ viewport: "desktop" });
    expect(card()).toBeNull();
    desk.unmount();
    seedDevice({ visits: 4, lastVisitAt: NOW - min(120) });
    const phone = renderApp();
    fireEvent.click(within(card()!).getByRole("button", { name: "Not now" }));
    expect(card()).toBeNull();
    phone.unmount();
    renderApp();
    expect(card()).toBeNull();
    expect(local.get().installDismissed).toBe(true);
  });
});
