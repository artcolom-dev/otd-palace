import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { savePrefs } from "../data/prefs";
import { trackOut } from "../lib/track";
import { freshDevice, renderApp, seedDevice } from "../test/app";
import { RULES, makeDeal, makeGone } from "../test/fixtures";
import { NOW, sceneDeals, sceneSnapshot } from "../test/scene";
import { passSnapshot } from "../test/passScene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const regular = (tab = "today") =>
  savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: tab as "today", passBudget: 5000 });
const tile1 = () => within(screen.getByRole("region", { name: "Best deals for you right now" })).getAllByRole("listitem")[0]!;
const flush = () => act(async () => void (await Promise.resolve()));

function setNavigator(over: { share?: unknown; clipboard?: unknown }) {
  for (const [key, value] of Object.entries(over)) Object.defineProperty(navigator, key, { configurable: true, value });
}

describe("the helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    Reflect.deleteProperty(navigator, "share");
    Reflect.deleteProperty(navigator, "clipboard");
  });

  describe("Share", () => {
    it("sits on the best tile and shares the deal's page through the share sheet", async () => {
      regular();
      renderApp({ viewport: "desktop" });
      const share = vi.fn().mockResolvedValue(undefined);
      setNavigator({ share });
      fireEvent.click(within(tile1()).getByRole("button", { name: "Share" }));
      await flush();
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ url: `${location.origin}/d/105`, title: "Josh Allen · OTD Palace" }),
      );
    });

    it("copies the link when the browser has no share sheet, says so, and stops saying so", async () => {
      regular();
      renderApp({ viewport: "phone" });
      const writeText = vi.fn().mockResolvedValue(undefined);
      setNavigator({ clipboard: { writeText } });
      fireEvent.click(within(tile1()).getByRole("button", { name: "Share" }));
      await flush();
      expect(writeText).toHaveBeenCalledWith(`${location.origin}/d/105`);
      expect(within(tile1()).getAllByText("Link copied").length).toBeGreaterThan(0);
      await act(async () => void (await vi.advanceTimersByTimeAsync(2600)));
      expect(within(tile1()).queryByText("Link copied")).toBeNull();
    });

    it("hands the link over to be copied by hand when nothing can copy it", async () => {
      regular();
      renderApp({ viewport: "phone" });
      fireEvent.click(within(tile1()).getByRole("button", { name: "Share" }));
      await flush();
      expect(screen.getByLabelText("Copy this link")).toHaveValue(`${location.origin}/d/105`);
    });

    it("is also in the open-on-phone popover and in the why-it's-a-deal sheet", async () => {
      regular();
      renderApp({ viewport: "desktop" });
      fireEvent.click(within(tile1()).getByRole("button", { name: /Open on phone/ }));
      expect(within(screen.getByRole("dialog", { name: "Open on your phone" })).getByRole("button", { name: "Share" })).toBeInTheDocument();
      fireEvent.click(within(tile1()).getByRole("button", { name: "Explain why it's a deal" }));
      expect(within(screen.getByRole("dialog", { name: "Why it's a deal" })).getByRole("button", { name: "Share" })).toBeInTheDocument();
    });
  });

  describe("Similar deals", () => {
    const edwards = (over = {}) => makeDeal({ now: NOW, listing_id: 150, sport: "nba", player_id: 44, player_name: "Anthony Edwards", price: 80, reference: 110, rating: 5.0, discount: 0.27, ...over });
    const nba = (id: number, over = {}) =>
      makeDeal({ now: NOW, listing_id: id, sport: "nba", player_id: id, player_name: `Guard ${id}`, ...over });
    const field = () => [
      ...sceneDeals(),
      edwards(),
      nba(130, { price: 90, rating: 5.2, discount: 0.35, reference: 140 }),
      nba(131, { price: 150, rating: 6, discount: 0.4, reference: 250 }), // too dear
      nba(132, { price: 70, rating: 4, discount: 0.4, reference: 117 }), // under the rating
      nba(133, { price: 75, rating: 5, discount: 0.3, reference: 107 }),
      nba(134, { price: 80, rating: 5.5, discount: 0.28, reference: 111 }),
    ];
    const gone = () => makeGone({ ...edwards(), reason: "ended", now: NOW });
    const wentAway = async (viewport: "phone" | "desktop") => {
      regular("deals");
      const { push } = renderApp({ viewport, snap: sceneSnapshot({ deals: field() }) });
      await push(sceneSnapshot({ version: 2, deals: field().filter((d) => d.listing_id !== 150), gone: [gone()] }));
    };
    const names = (box: HTMLElement) =>
      within(within(box).getByRole("list", { name: "Similar deals" })).getAllByRole("link").map((a) => a.getAttribute("aria-label")?.split(",")[0]);

    it("shows three on a dimmed gone row of the table: the same player-season first, never the same listing", async () => {
      await wentAway("desktop");
      const row = screen.getByRole("table", { name: "All deals" }).querySelector<HTMLElement>('[data-key="150:target"]')!;
      expect(row).toHaveClass("gone");
      // Edwards (104) is the same player-season; then the best discounts at a close price: 130 (35%), 133 (30%)
      expect(names(row)).toEqual(["Anthony Edwards", "Guard 130", "Guard 133"]);
    });

    it("shows them on a gone row of the phone list too, and opening one counts the click", async () => {
      await wentAway("phone");
      const row = screen.getByRole("list", { name: "All deals" }).querySelector<HTMLElement>('[data-key="150:target"]')!;
      expect(names(row)).toHaveLength(3);
      fireEvent.click(within(row).getByRole("link", { name: /^Guard 130,/ }));
      expect(trackOut).toHaveBeenCalledWith(expect.objectContaining({ panel: "deals", target: "listing" }));
      expect(local.isOpened(130)).toBe(true);
    });

    it("is not drawn on a live row", async () => {
      regular("deals");
      renderApp({ viewport: "desktop", snap: sceneSnapshot({ deals: field() }) });
      expect(screen.queryByRole("list", { name: "Similar deals" })).toBeNull();
    });

    it("offers deals like an opened one that has ended, in the 'You opened' strip", () => {
      seedDevice({
        opened: [
          {
            key: "999:target", listing_id: 999, kind: "target", sport: "nba", player_id: 44, player_name: "Anthony Edwards",
            price: 80, reference: 110, rarity: 3, season: 2026, rating: 5, at: NOW - 5 * 60_000,
          },
        ],
      });
      renderApp({ viewport: "desktop" });
      const strip = screen.getByRole("region", { name: /You opened 1 deal/ });
      expect(within(strip).getByRole("list", { name: "Similar deals" })).toHaveTextContent("Anthony Edwards");
    });

    it("does not offer any for an opened deal that is still live", () => {
      seedDevice({
        opened: [
          {
            key: "104:target", listing_id: 104, kind: "target", sport: "nba", player_id: 44, player_name: "Anthony Edwards",
            price: 70, reference: 95, rarity: 3, at: NOW - 5 * 60_000,
          },
        ],
      });
      renderApp({ viewport: "desktop" });
      const strip = screen.getByRole("region", { name: /You opened 1 deal/ });
      expect(within(strip).queryByRole("list", { name: "Similar deals" })).toBeNull();
    });
  });

  describe("What can I do with…", () => {
    const card = () => screen.getByRole("region", { name: "What can I do with…" });
    const type = (scope: HTMLElement, value: string) =>
      fireEvent.change(within(scope).getByLabelText("Your balance in Rax"), { target: { value } });

    it("is a card on Today: the best deals a balance can buy, in one sentence, each row an auction to open", () => {
      renderApp({ viewport: "desktop" });
      type(card(), "840");
      expect(within(card()).getByTestId("buddy-say")).toHaveTextContent(
        "With 840 Rax, the best you can do right now is 2 deals: 230 Rax for cards usually worth 325, so you save about 95.",
      );
      const rows = within(card()).getByRole("list", { name: "Deals to buy" });
      expect(within(rows).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(
        expect.arrayContaining([sceneDeals()[0]!.url]),
      );
      expect(within(card()).getByText("Falling deals are left out", { exact: false })).toBeInTheDocument();
      fireEvent.click(within(rows).getAllByRole("link")[0]!);
      expect(trackOut).toHaveBeenCalledWith(expect.objectContaining({ panel: "deals", target: "listing" }));
    });

    it("remembers the balance on this device, and asks for a number when it is not one", () => {
      renderApp({ viewport: "desktop" });
      type(card(), "840");
      expect(local.get().balance).toBe(840);
      type(card(), "eight");
      expect(local.get().balance).toBeNull();
      expect(card()).toHaveTextContent("Type a whole number of Rax, like 840.");
      type(card(), "");
      expect(card()).toHaveTextContent("Type what you have to spend");
    });

    it("opens with the last balance already worked out", () => {
      seedDevice({ balance: 1250 });
      renderApp({ viewport: "desktop" });
      expect(within(card()).getByLabelText("Your balance in Rax")).toHaveValue("1,250");
      expect(within(card()).getByTestId("buddy-say")).toHaveTextContent("With 1,250 Rax");
    });

    it("says nothing fits when nothing does", () => {
      seedDevice({ balance: 20 });
      renderApp({ viewport: "desktop" });
      expect(within(card()).getByTestId("buddy-say")).toHaveTextContent("With 20 Rax, no deal fits right now.");
    });

    it("leads with the passes the balance can build when they give more back in a year, each opening its pass", () => {
      seedDevice({ balance: 5000 });
      renderApp({ viewport: "desktop", snap: sceneSnapshot({ otd: passSnapshot().otd }) });
      expect(within(card()).getByTestId("buddy-say")).toHaveTextContent(/^With 5,000 Rax, passes pay you most: \d passes for about/);
      const passes = within(card()).getByTestId("buddy-pass");
      expect(within(passes).getByRole("heading", { name: /Passes to build/ })).toBeInTheDocument();
      expect(within(passes).getByRole("button", { name: "Explain Rax back in a year" })).toBeInTheDocument();
      const rows = within(passes).getAllByRole("button").filter((b) => b.classList.contains("nx"));
      expect(rows.length).toBeGreaterThan(1);
      expect(rows[0]!).toHaveTextContent(/about [\d,]+ Rax a year/);
      expect(rows[0]!).toHaveTextContent(/[\d,]+ Rax/);
      expect(passes).toHaveTextContent(/estimate/i);
      expect(passes).toHaveTextContent(/Starts paying (this month|in [A-Z])/);
      // Offers: the cheaper way to the same passes, an expectation with its ⓘ.
      const offer = within(passes).getByTestId("buddy-offer");
      expect(offer).toHaveTextContent(/Cheaper with offers: offer about 20% under the usual price/);
      expect(offer).toHaveTextContent("about 1 in 6 is accepted");
      expect(within(offer).getByRole("button", { name: "Explain offer" })).toHaveAttribute("title", expect.stringContaining("most are refused"));
      // The deals come after, as the other way.
      const order = [...card().querySelectorAll("[data-testid=buddy-pass], .bbdeals")].map((el) => el.className);
      expect(order[0]).toContain("bbpasses");
      const first = rows[0]!;
      const name = first.querySelector("b")?.textContent ?? "";
      act(() => {
        fireEvent.click(first);
      });
      expect(screen.getByRole("dialog")).toHaveTextContent(name.split(" ")[0] ?? "");
    });

    it("says what a pass is, in plain words, at the New level only", () => {
      seedDevice({ balance: 5000 });
      savePrefs({ level: "new", budget: 200, sport: "all", sort: "best", tab: "today", passBudget: 1000 });
      renderApp({ viewport: "phone", snap: sceneSnapshot({ otd: passSnapshot().otd }) });
      expect(card()).toHaveTextContent("A pass is your card for one player (or team) and season");
      expect(within(card()).getByRole("button", { name: "Explain pass" })).toBeInTheDocument();
      expect(within(card()).getByRole("button", { name: "Explain rarity" })).toBeInTheDocument();
    });

    it("keeps the Pro level free of the word explanations: the same answer, no ⓘ", () => {
      seedDevice({ balance: 5000 });
      savePrefs({ level: "pro", budget: null, sport: "all", sort: "best", tab: "today", passBudget: null });
      renderApp({ viewport: "desktop", snap: sceneSnapshot({ otd: passSnapshot().otd }) });
      expect(within(card()).getByTestId("buddy-say")).toHaveTextContent(/passes pay you most/);
      expect(within(card()).getByTestId("buddy-offer")).toBeInTheDocument();
      expect(within(card()).queryAllByRole("button", { name: /^Explain / })).toEqual([]);
      expect(card()).not.toHaveTextContent("A pass is your card");
    });

    it("goes to deals, and says how far the cheapest pass is, when no pass fits the balance", () => {
      seedDevice({ balance: 150 });
      renderApp({ viewport: "desktop", snap: sceneSnapshot({ otd: passSnapshot().otd }) });
      expect(within(card()).getByTestId("buddy-say")).not.toHaveTextContent("passes pay you most");
      expect(within(card()).getByTestId("buddy-save-up")).toHaveTextContent(/^No pass that pays back fits 150 Rax yet: the cheapest costs about [\d,]+/);
    });

    it("has no wallet in a phone's top bar: the brand name stays, and the Today card is the phone's way in", () => {
      seedDevice({ balance: 840 });
      renderApp({ viewport: "phone" });
      expect(screen.queryByRole("button", { name: "What can I do with my Rax?" })).toBeNull();
      const bar = document.querySelector(".app.phone .top")!;
      expect(within(bar as HTMLElement).getByText("OTD Palace")).toBeInTheDocument();
      expect(within(card()).getByLabelText("Your balance in Rax")).toHaveValue("840");
      expect(within(card()).getByTestId("buddy-say")).toHaveTextContent("With 840 Rax");
    });

    it("keeps to the sport the visitor chose, says so, and keeps the balance as its budget", () => {
      seedDevice({ balance: 1250 });
      savePrefs({ level: "regular", budget: 50, sport: "nhl", sort: "best", tab: "today", passBudget: 5000 });
      renderApp({ viewport: "desktop" });
      const say = within(card()).getByTestId("buddy-say");
      expect(say).toHaveTextContent("With 1,250 Rax, the best you can do right now in NHL is");
      const links = within(card()).getAllByRole("link");
      expect(links.length).toBeGreaterThan(0);
      for (const a of links) expect(a.getAttribute("aria-label")).toMatch(/McDavid|Celebrini/);
      expect(card()).toHaveTextContent("in NHL. Falling deals are left out");
    });

    it("shows every sport when none is chosen", () => {
      seedDevice({ balance: 1250 });
      savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000 });
      renderApp({ viewport: "desktop" });
      expect(within(card()).getByTestId("buddy-say")).not.toHaveTextContent(" in NHL");
      expect(within(card()).getAllByRole("link").length).toBeGreaterThan(2);
    });

    it("is a button with its words in the desktop top bar", () => {
      renderApp({ viewport: "desktop" });
      fireEvent.click(screen.getByRole("button", { name: "What can I do with…" }));
      expect(screen.getByRole("dialog", { name: "What can I do with…" })).toBeInTheDocument();
    });

    it("does not say what to do while the data is paused", async () => {
      seedDevice({ balance: 840 });
      const { advance } = renderApp({ viewport: "desktop", respond: () => new Response(null, { status: 503 }) });
      await advance(16_000);
      const say = within(card()).getByTestId("buddy-say");
      expect(say).toHaveTextContent("Prices are paused right now, so we cannot say what 840 Rax can do.");
      expect(say).not.toHaveTextContent("best you can do");
      expect(within(card()).queryByRole("list", { name: "Deals to buy" })).toBeNull();
    });
  });

  describe("Selling a card?", () => {
    const sheet = () => screen.getByRole("dialog", { name: "Selling a card?" });
    const pick = (label: string, value: string) =>
      fireEvent.change(within(sheet()).getByLabelText(label), { target: { value } });
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Selling a card?" }));

    it("recommends a list price from the usual price, with its sample, what the seller keeps and the three bars", () => {
      renderApp({ viewport: "desktop", hash: "prices" });
      open();
      pick("Player", "nfl:11");
      const result = within(sheet()).getByTestId("sell-result");
      expect(result).toHaveTextContent("List at 219 Rax.");
      expect(result).toHaveTextContent("Cards listed at 0.95× the usual price or less sold about 99 in 100 times; at 1.2×, only about 3 in 10.");
      expect(result).toHaveTextContent("230 Rax");
      expect(result).toHaveTextContent("middle price of 8 sales in the last 7 days");
      expect(result).toHaveTextContent("187 Rax after Real's 10% and the 10 Rax listing fee");
      expect(result).toHaveTextContent("Typical, not a promise: measured on past sales.");
      const bars = within(result).getByRole("list", { name: "How often a card sells at each price" });
      expect(within(bars).getAllByRole("listitem").map((li) => li.querySelector<HTMLElement>(".meter")!.style.getPropertyValue("--fill"))).toEqual(["0.9900", "0.9000", "0.2900"]);
      expect(within(bars).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
        expect.stringContaining("219 Rax"),
        expect.stringContaining("242 Rax"),
        expect.stringContaining("276 Rax"),
      ]);
    });

    it("follows the picked season and rating band", () => {
      renderApp({ viewport: "desktop", hash: "prices" });
      open();
      pick("Player", "nfl:11");
      pick("Rating", "7-9");
      expect(within(sheet()).getByTestId("sell-result")).toHaveTextContent("List at 224 Rax.");
      expect(within(sheet()).getByTestId("sell-result")).toHaveTextContent("last 24 hours");
    });

    it("says when few sales stand behind the usual price", () => {
      renderApp({ viewport: "desktop", hash: "prices" });
      open();
      pick("Player", "nfl:55");
      expect(within(sheet()).getByTestId("sell-result")).toHaveTextContent("Real's own estimate, from 4 sales");
      expect(within(sheet()).getByTestId("sell-result")).toHaveTextContent("Few sales behind it");
    });

    it("is in the phone's player search too", () => {
      renderApp({ viewport: "phone" });
      fireEvent.click(screen.getByRole("button", { name: "Search a player" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Find a player" })).getByRole("button", { name: "Selling a card?" }));
      expect(sheet()).toBeInTheDocument();
    });

    it("is not offered when the snapshot carries no figures", () => {
      renderApp({ viewport: "desktop", hash: "prices", snap: sceneSnapshot({ rules: { ...RULES, sell_curve: undefined } }) });
      expect(screen.queryByRole("button", { name: "Selling a card?" })).toBeNull();
    });

    it("says the usual price may be out of date while paused", async () => {
      const { advance } = renderApp({ viewport: "desktop", hash: "prices", respond: () => new Response(null, { status: 503 }) });
      await advance(16_000);
      open();
      pick("Player", "nfl:11");
      expect(within(sheet()).getByTestId("sell-result")).toHaveTextContent("Paused");
    });
  });
});
