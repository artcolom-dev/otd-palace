import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { savePrefs } from "../data/prefs";
import { renderApp, freshDevice } from "../test/app";
import { makeDeal } from "../test/fixtures";
import { CHASE, JOKIC, JUDGE, MACKINNON, MCDAVID, MURRAY, PASS_MARKETS, SGA, THUNDER, WEMBANYAMA, otdOf, passSnapshot, servedOtd } from "../test/passScene";
import { setPassUi } from "./passState";

const snap = passSnapshot({
  deals: [
    makeDeal({ listing_id: 41, sport: "nhl", season: 2026, player_id: MACKINNON.player_id, player_name: "Nathan MacKinnon", price: 150, reference: 230, discount: 0.35 }),
    makeDeal({ listing_id: 42, sport: "nhl", season: 2025, player_id: MACKINNON.player_id, player_name: "Nathan MacKinnon", price: 150, reference: 230, discount: 0.35 }),
    makeDeal({ listing_id: 43, sport: "nba", player_id: 999, player_name: "Someone Else", price: 150, reference: 230, discount: 0.35 }),
  ],
});
const open = (o: Parameters<typeof renderApp>[0] = {}) => renderApp({ snap, hash: "passes", ...o });
const hero = () => screen.getByRole("region", { name: /top pick/i });
const list = () => screen.getByRole("table", { name: "Best passes" });
const row = (name: string) => within(list()).getByRole("button", { name: new RegExp(`Open the ${name}`) });
const drawer = () => screen.getByRole("dialog", { name: /pass$/ });
const press = (name: string | RegExp, root: HTMLElement = document.body) => fireEvent.click(within(root).getByRole("button", { name }));
// A phone keeps Level and Max price behind one "Filters" button on this page.
const showFilters = () => {
  const f = screen.queryByRole("button", { name: "Filters" });
  if (f?.getAttribute("aria-expanded") === "false") fireEvent.click(f);
};
const setLevel = (label: string) => {
  showFilters();
  fireEvent.click(screen.getAllByRole("radio", { name: label })[0]!);
};

describe("Passes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());

  describe("level defaults", () => {
    it("New: at most 1,000 a pass, past seasons, one plain sentence per pass", () => {
      open({ viewport: "desktop" });
      expect(screen.getByRole("heading", { level: 2, name: "Nathan MacKinnon" })).toBeInTheDocument();
      // Legendary costs 2,290: within 1,000 the best is Uncommon.
      expect(within(hero()).getByText("Uncommon pass")).toBeInTheDocument();
      expect(within(hero()).getByText(/fits your 1,000 max/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "≤1,000" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Past" })).toHaveAttribute("aria-pressed", "true");
      expect(within(list()).queryByText("Ja'Marr Chase")).toBeNull(); // a season in progress
      expect(within(list()).getAllByText(/^About .* Rax a year · pays back by end of /).length).toBeGreaterThan(0);
      expect(screen.getByText("One pick per pass, in plain words.")).toBeInTheDocument();
    });

    it("Regular: 5,000 and every season, with the numbers; Pro: any budget", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      expect(screen.getByRole("button", { name: "≤5,000" })).toHaveAttribute("aria-pressed", "true");
      expect(within(hero()).getByText("Legendary pass")).toBeInTheDocument();
      expect(within(list()).getByText("Ja'Marr Chase")).toBeInTheDocument();
      expect(within(list()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(
        expect.arrayContaining(["Rax a year", "Limit"]),
      );
      setLevel("Pro");
      expect(screen.getByRole("button", { name: "Any" })).toHaveAttribute("aria-pressed", "true");
      expect(within(list()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(
        expect.arrayContaining(["On sale now", "Limit ÷ cost"]),
      );
    });

    it("the budget is remembered apart from the deals' one", () => {
      open({ viewport: "desktop" });
      press("≤20,000");
      expect(JSON.parse(localStorage.getItem("advisor.prefs.v1")!)).toMatchObject({ passBudget: 20000, budget: 200 });
    });
  });

  describe("the list", () => {
    it("labels projections, sets the team passes apart with their cost unknown, and shows all on request", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      const chase = row("Ja'Marr Chase").closest("[role=row]") as HTMLElement;
      expect(within(chase).getByText("projection")).toBeInTheDocument();
      const team = row("Oklahoma City Thunder").closest("[role=row]") as HTMLElement;
      expect(within(team).getAllByText("unknown").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(/Hidden: 1 never pays back/)).toBeInTheDocument();
      expect(within(list()).queryByText("Charles Oliveira")).toBeNull();
      press("Show all");
      expect(within(list()).getByText("Charles Oliveira")).toBeInTheDocument();
      expect(within(list()).getByText("Never pays back")).toBeInTheDocument();
    });

    it("Can be built within 3 weeks keeps the passes whose rating is on sale now", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      press("Can be built within 3 weeks");
      expect(within(list()).queryByText("Jamal Murray")).toBeNull();
      expect(within(list()).getByText("Nikola Jokić")).toBeInTheDocument();
      expect(screen.getByText(/3 short on cards/)).toBeInTheDocument();
    });

    it("filters by sport with counts", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      const tabs = screen.getByRole("tablist", { name: /sport/i });
      fireEvent.click(within(tabs).getByRole("tab", { name: /NHL/ }));
      expect(within(list()).getAllByRole("button", { name: /^Open the / }).map((b) => b.getAttribute("aria-label"))).toEqual([
        "Open the Nathan MacKinnon 2025-26 pass", "Open the Connor McDavid 2025-26 pass",
      ]);
    });

    it("leaves out a sport with no pass under these filters, and gives All no capped total", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      const tabs = screen.getByRole("tablist", { name: /sport/i });
      expect(within(tabs).queryByRole("tab", { name: /UFC/ })).toBeNull(); // its one pass never pays back
      expect(within(tabs).getByRole("tab", { name: "All" })).toBeInTheDocument();
      expect(within(tabs).getByRole("tab", { name: /NHL/ })).toHaveTextContent("NHL2");
    });

    it("says plainly when a pass's pay is months away, on a desk row and a phone row", () => {
      const withMlb = passSnapshot({ sports: ["nba", "nhl", "nfl", "mlb"], otd: otdOf([...PASS_MARKETS, JUDGE]) });
      for (const viewport of ["desktop", "phone"] as const) {
        const { unmount } = open({ viewport, snap: withMlb });
        setLevel("Regular");
        const judge = screen.getByRole("button", { name: /^Open the Aaron Judge 2026 pass/ }).closest(".tr, .prow") as HTMLElement;
        expect(within(judge).getByText("Pays from March — better bought in February")).toBeInTheDocument();
        const mack = screen.getByRole("button", { name: /^Open the Nathan MacKinnon 2025-26 pass/ }).closest(".tr, .prow") as HTMLElement;
        expect(within(mack).queryByText(/Pays from/)).toBeNull();
        unmount();
      }
      // On the MLB tab it is the top pick, and the pick says so too.
      open({ viewport: "desktop", snap: withMlb });
      setLevel("Regular");
      fireEvent.click(within(screen.getByRole("tablist", { name: /sport/i })).getByRole("tab", { name: /MLB/ }));
      expect(within(hero()).getByText("Pays from March — better bought in February")).toBeInTheDocument();
    });

    it("the top pick says what it was picked from, without the list's cap posing as a budget count", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      expect(within(hero()).getByText(/we list the 10 best passes of each sport/)).toBeInTheDocument();
      expect(hero()).toHaveTextContent(/Of those you don't hold yet that fit your 5,000 budget, it pays its cost back soonest from today/);
    });

    it("on a phone shows 20 passes, then 20 more at each tap, focus on the first new one, back to 20 on a new filter", () => {
      const many = Array.from({ length: 45 }, (_, i) => ({
        ...JOKIC, key: `nba:2025:player:${9000 + i}`, player_id: 9000 + i, player_name: `Player ${i}`,
      }));
      savePrefs({ level: "pro", budget: null, sport: "all", sort: "best", tab: "passes", passBudget: null });
      const otd = otdOf([...many, MACKINNON]);
      otd.picks.nba = many.map((m) => m.key); // the list shows each sport's picks: here all 45
      renderApp({ snap: passSnapshot({ otd }), hash: "passes", viewport: "phone" });
      const best = () => screen.getByRole("list", { name: "Best passes" });
      const rows = () => within(best()).getAllByRole("listitem");
      expect(rows()).toHaveLength(20);
      press(/Show 20 more/);
      expect(rows()).toHaveLength(40);
      expect(document.activeElement).toBe(within(rows()[20]!).getByRole("button", { name: /^Open the / }));
      press("Show the last 6");
      expect(rows()).toHaveLength(46);
      expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
      expect(document.activeElement).toBe(within(rows()[40]!).getByRole("button", { name: /^Open the / }));
      fireEvent.click(within(screen.getByRole("tablist", { name: /sport/i })).getByRole("tab", { name: /NBA/ }));
      expect(rows()).toHaveLength(20);
    });
  });

  describe("the pass card", () => {
    it("opens as a drawer: honest lines, month bars as an estimate, the ladder with its best and weak rows, the build", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      fireEvent.click(row("Nathan MacKinnon"));
      const card = drawer();
      expect(within(card).getByRole("heading", { name: "Nathan MacKinnon" })).toBeInTheDocument();
      expect(within(card).getByText(/Pays about/)).toHaveTextContent("Pays about 12,500 Rax a year, on ~84 game days");
      expect(within(card).getByText(/Costs about/)).toHaveTextContent("Costs about 2,300 to build · pays back by end of");
      expect(within(card).getByText(/Stops paying after/)).toHaveTextContent("Stops paying after 12,500 in total");
      expect(within(card).getByRole("list", { name: /Pay by month/ })).toBeInTheDocument();
      expect(within(card).getByText(/\(estimate\)/)).toBeInTheDocument();
      const ladder = within(card).getByRole("table", { name: "Rarities of this pass" });
      const best = within(ladder).getByRole("button", { name: /Legendary pass, most Rax back for your budget/ });
      expect(best).toHaveAttribute("aria-pressed", "true");
      expect(within(ladder).getByRole("button", { name: /Rare pass.*weak step/ })).toBeInTheDocument();
      // No General: a past season's General pays nothing On This Day.
      expect(within(ladder).queryByRole("button", { name: /General pass/ })).toBeNull();
      expect(within(card).getByText(/On sale now:/)).toHaveTextContent("On sale now: all 380 rating for 2,030 Rax");
      // Offers: the same rarity for less if enough are accepted, with its ⓘ (380 rating at 4.4 a point, not 5.5).
      const offer = within(card).getByTestId("pass-offer");
      expect(offer).toHaveTextContent(
        /^Cheaper with offers: about 4\.4 Rax a rating point \(usual 5\.5\), on many cards\. About 1 in 6 is accepted; if enough are, about 1,900 instead of 2,300/,
      );
      expect(within(offer).getByRole("button", { name: "Explain offer" })).toBeInTheDocument();
      // Another rarity: its own sentences and build.
      fireEvent.click(within(ladder).getByRole("button", { name: /^Show the Epic pass/ }));
      expect(within(card).getByText(/Pays about/)).toHaveTextContent("Pays about 5,000 Rax a year");
    });

    it("a General pick (a season being played) is minted, never bought on the shelf", () => {
      open({ viewport: "desktop", snap: passSnapshot({ otd: otdOf([...PASS_MARKETS, WEMBANYAMA]) }) });
      setLevel("Regular");
      fireEvent.click(row("Victor Wembanyama"));
      // Its limit of 0 is no lifetime limit: it pays its games left, and says so.
      expect(within(drawer()).getByText(/General pays only the games left this season, nothing On This Day/)).toBeInTheDocument();
      expect(within(drawer()).queryByText(/Stops paying after/)).toBeNull();
      expect(within(drawer()).getByText(/Mint the pass for 200/)).toBeInTheDocument();
      expect(within(drawer()).queryByText(/On sale now:/)).toBeNull();
      expect(within(drawer()).queryByTestId("pass-offer")).toBeNull(); // no card to offer on
    });

    it("a team rung's cost and payback are unknown, never guessed", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      fireEvent.click(row("Oklahoma City Thunder"));
      const ladder = within(drawer()).getByRole("table", { name: "Rarities of this pass" });
      const common = within(ladder).getByRole("button", { name: /^Show the Common pass/ }).closest("[role=row]") as HTMLElement;
      expect(within(common).getAllByText("unknown")).toHaveLength(2);
      // No General: a past season's General pays nothing On This Day.
      expect(within(ladder).queryByRole("button", { name: /^Show the General pass/ })).toBeNull();
    });

    it("a season in progress is a projection", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      fireEvent.click(row("Ja'Marr Chase"));
      expect(within(drawer()).getAllByText(/projection/i).length).toBeGreaterThan(0);
    });

    it("See these cards opens Deals on that player and season", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      fireEvent.click(row("Nathan MacKinnon"));
      press("See these cards", drawer());
      expect(`${location.pathname}${location.hash}`).toBe("/deals");
      expect(screen.getByText(/Showing/)).toHaveTextContent("Showing Nathan MacKinnon 2025-26 cards");
      const rows = screen.getAllByRole("link", { name: /Nathan MacKinnon|Someone Else/ });
      expect(rows).toHaveLength(1);
      press("Clear the card filter");
      expect(screen.getAllByRole("link", { name: /Nathan MacKinnon|Someone Else/ }).length).toBeGreaterThan(1);
    });

    it("on a phone it is a sheet", () => {
      open({ viewport: "phone" });
      fireEvent.click(screen.getAllByRole("button", { name: /^Open the Nathan MacKinnon/ })[0]!);
      const sheet = screen.getByRole("dialog", { name: /Nathan MacKinnon/ });
      expect(sheet.tagName).toBe("DIALOG");
      expect(within(sheet).getByText("When it pays")).toBeInTheDocument();
    });

    it("New sees the recommended rarity, the rest on request", () => {
      open({ viewport: "desktop" });
      fireEvent.click(row("Nathan MacKinnon"));
      const ladder = within(drawer()).getByRole("table", { name: "Rarities of this pass" });
      expect(within(ladder).getAllByRole("button", { name: /^Show the / })).toHaveLength(1);
      press("See all rarities", drawer());
      expect(within(ladder).getAllByRole("button", { name: /^Show the / }).length).toBe(MACKINNON.rungs.length);
    });
  });

  describe("my passes", () => {
    it("adds a pass by player, season and rarity, on this device only, and says how full its sport is", () => {
      open({ viewport: "desktop" });
      const panel = screen.getByRole("region", { name: "My passes" });
      expect(within(panel).getByText(/No passes on this device yet/)).toBeInTheDocument();
      press("Add a pass you own", panel);
      const pop = screen.getByRole("dialog", { name: "Add a pass you own" });
      fireEvent.change(within(pop).getByRole("searchbox", { name: "Player or team" }), { target: { value: "jok" } });
      press(/Nikola Jokić/, pop);
      press(/2024-25/, screen.getByRole("dialog", { name: /which season/i }));
      const step3 = screen.getByRole("dialog", { name: /how far is it built/i });
      fireEvent.click(within(step3).getByRole("radio", { name: "Epic" }));
      press("Add to my passes", step3);
      expect(local.get().passes).toEqual([{ key: JOKIC.key, tier: "epic" }]);
      expect(within(panel).getByText(/NBA:/)).toHaveTextContent("NBA: 1 pass — room on most days");
      // Epic: 6,000 a season, capped at its 5,000 limit.
      expect(screen.getByText("Your passes pay about")).toBeInTheDocument();
      expect(screen.getByTestId("passes-total")).toHaveTextContent("5,000");
    });

    it("finds and values a pass of this season the site serves for Deals only, when the visitor owns it", () => {
      // Served apart (current_markets), as the server does: never in the list, but a pass the visitor holds is theirs.
      const served = passSnapshot({ otd: servedOtd(PASS_MARKETS) });
      open({ viewport: "desktop", snap: served });
      expect(within(list()).queryByRole("button", { name: /Open the Ja'Marr Chase/ })).toBeNull();
      const panel = screen.getByRole("region", { name: "My passes" });
      press("Add a pass you own", panel);
      const pop = screen.getByRole("dialog", { name: "Add a pass you own" });
      fireEvent.change(within(pop).getByRole("searchbox", { name: "Player or team" }), { target: { value: "chase" } });
      press(/Ja'Marr Chase/, pop);
      press(/2026/, screen.getByRole("dialog", { name: /which season/i }));
      const step3 = screen.getByRole("dialog", { name: /how far is it built/i });
      fireEvent.click(within(step3).getByRole("radio", { name: "Common" }));
      press("Add to my passes", step3);
      expect(local.get().passes).toEqual([{ key: CHASE.key, tier: "common" }]);
      expect(within(panel).getByText(/NFL:/)).toHaveTextContent("NFL: 1 pass");
      expect(screen.getByText("Your passes pay about")).toBeInTheDocument();
      expect(screen.getByTestId("passes-total")).toHaveTextContent(/[1-9]/); // valued with the site's row
    });

    it("an exact rating counts at its rarity; a maxed pass pays nothing", () => {
      local.addPass({ key: JOKIC.key, rating: 212 });
      local.addPass({ key: MCDAVID.key, tier: "common", spent: true });
      open({ viewport: "desktop" });
      const panel = screen.getByRole("region", { name: "My passes" });
      press(/Show my 2 passes/, panel);
      expect(within(panel).getByText("Epic · 212 rating")).toBeInTheDocument();
      expect(within(panel).getByText(/pays nothing/)).toBeInTheDocument();
      press(`Remove ${"Connor McDavid 2025-26"}`, panel);
      expect(local.get().passes).toEqual([{ key: JOKIC.key, rating: 212 }]);
    });

    it("a pass removed by mistake comes back with Undo, in its place; the offer goes after a few seconds", () => {
      local.addPass({ key: JOKIC.key, rating: 212 });
      local.addPass({ key: MCDAVID.key, tier: "common" });
      local.addPass({ key: SGA.key, tier: "rare" });
      open({ viewport: "phone" });
      fireEvent.click(screen.getByRole("tab", { name: /My passes/ }));
      press("Remove Connor McDavid 2025-26");
      expect(local.get().passes.map((p) => p.key)).toEqual([JOKIC.key, SGA.key]);
      const offer = () => screen.queryByText(/^Removed /);
      expect(offer()).toHaveTextContent("Removed Connor McDavid 2025-26");
      expect(offer()!.closest("[aria-live=polite]")).not.toBeNull(); // read out as it comes
      press("Undo");
      expect(local.get().passes).toEqual([
        { key: JOKIC.key, rating: 212 },
        { key: MCDAVID.key, tier: "common" },
        { key: SGA.key, tier: "rare" },
      ]);
      expect(offer()).toBeNull();
      // Unanswered, the offer goes on its own and the pass stays removed.
      press("Remove Connor McDavid 2025-26");
      expect(offer()).not.toBeNull();
      act(() => vi.advanceTimersByTime(7000));
      expect(offer()).toBeNull();
      expect(local.get().passes.map((p) => p.key)).toEqual([JOKIC.key, SGA.key]);
    });

    it("a big account's list shows its passes 60 at a time", () => {
      local.addPass({ key: JOKIC.key, tier: "common" });
      for (let i = 0; i < 130; i++) local.addPass({ key: `nba:2019:player:${90_000 + i}`, tier: "rare" }); // not in today's data
      open({ viewport: "desktop" });
      const panel = screen.getByRole("region", { name: "My passes" });
      press(/Show my 131 passes/, panel);
      const rows = () => panel.querySelectorAll(".mlist > li").length;
      expect(rows()).toBe(60);
      press("Show 60 more of 131", panel);
      expect(rows()).toBe(120);
      press("Show 11 more of 131", panel);
      expect(rows()).toBe(131);
      expect(within(panel).queryByRole("button", { name: /more of/ })).toBeNull();
    });

    it("a pass added to a long list is shown at once, without unfolding the rest", () => {
      for (let i = 0; i < 130; i++) local.addPass({ key: `nba:2019:player:${90_000 + i}`, tier: "rare" });
      open({ viewport: "desktop" });
      const panel = screen.getByRole("region", { name: "My passes" });
      press(/Show my 130 passes/, panel);
      const last = "nba:2019:player:99999"; // a pass the data does not list: it goes at the very end
      act(() => {
        local.addPass({ key: last, tier: "rare" });
        setPassUi({ flash: last });
      });
      const keys = [...panel.querySelectorAll<HTMLElement>(".mlist > li")].map((li) => li.dataset.key);
      expect(keys).toHaveLength(61); // the first 60, and the one just added
      expect(keys.at(-1)).toBe(last);
      act(() => setPassUi({ flash: null }));
      expect(panel.querySelector(`[data-key="${last}"]`)).not.toBeNull(); // still there once the mark is gone
      expect(within(panel).getByRole("button", { name: "Show 60 more of 131" })).toBeInTheDocument();
    });

    it("teammates on the same days share the same 2 claims", () => {
      local.addPass({ key: JOKIC.key, tier: "common" });
      local.addPass({ key: MURRAY.key, tier: "common" });
      open({ viewport: "desktop" });
      expect(screen.getByText("Nikola Jokić and Jamal Murray play on the same days")).toBeInTheDocument();
    });

    it("a third teammate that hardly ever gets a claim is marked in the list; the two that take the claims are not", () => {
      const third = { ...MURRAY, key: "nba:2025:player:1099", player_id: 1099, player_name: "Third Wheel", base_1x: 100 };
      local.addPass({ key: JOKIC.key, tier: "common" });
      local.addPass({ key: MURRAY.key, tier: "common" });
      local.addPass({ key: third.key, tier: "common" });
      open({ viewport: "desktop", snap: passSnapshot({ otd: otdOf([...PASS_MARKETS, third]) }) });
      const panel = screen.getByRole("region", { name: "My passes" });
      press(/Show my 3 passes/, panel);
      const marked = within(panel).getAllByText("Rarely claimed");
      expect(marked).toHaveLength(1);
      expect(marked[0]!.closest("li")).toHaveTextContent("Third Wheel");
    });

    describe("what to add is said once per screen", () => {
      /** The headings of every block on screen that tells the visitor which pass to get next. */
      const addLists = () =>
        ["Your next Rax", "Best to add next", "Cheapest way to start"].filter((name) => screen.queryByRole("region", { name }) !== null);
      const moves = () =>
        within(within(screen.getByRole("region", { name: "Your next Rax" })).getByRole("list", { name: "Your next moves" })).getAllByRole("listitem");

      it("a desktop with a pass held: Your next Rax is the one list, with what each move adds a year as an estimate", () => {
        local.addPass({ key: JOKIC.key, tier: "common" });
        open({ viewport: "desktop" });
        setLevel("Regular");
        expect(addLists()).toEqual(["Your next Rax"]);
        const rows = moves();
        expect(rows.length).toBeGreaterThanOrEqual(3);
        expect(rows.length).toBeLessThanOrEqual(5);
        // a pass says what it adds a year, as an estimate; a deal, what is left after fees
        for (const row of rows) expect(row).toHaveTextContent(/about [\d,]+ a year \(estimate\)|after fees/);
        // the pass already held is never offered as one to get: it can only be lifted
        const offered = rows.filter((r) => /^Add a pass in/.test(r.textContent ?? "")).map((r) => r.querySelector("small")?.textContent ?? "");
        expect(offered.length).toBeGreaterThan(0);
        for (const name of offered) expect(name).not.toMatch(/^Nikola Jokić/);
        expect(rows.find((r) => /^Lift Nikola Jokić/.test(r.textContent ?? ""))).toBeDefined();
        // and it sits in the rail right under My passes, where the two lists it replaces were
        const rail = [...document.querySelectorAll(".prail > section")].map((s) => s.querySelector("h2")?.textContent);
        expect(rail.slice(0, 2)).toEqual([expect.stringMatching(/^My passes/), "Your next Rax"]);
      });

      it("a desktop with no pass yet: still one list, which says where to start", () => {
        open({ viewport: "desktop" });
        setLevel("Regular");
        expect(addLists()).toEqual(["Your next Rax"]);
        expect(screen.getByRole("region", { name: "Your next Rax" })).toHaveTextContent("Where to start");
      });

      it("a phone: Your next Rax on My passes, the cheapest way to start on Best passes, never both on one screen", () => {
        local.addPass({ key: JOKIC.key, tier: "common" });
        open({ viewport: "phone" });
        expect(addLists()).toEqual(["Cheapest way to start"]);
        fireEvent.click(screen.getByRole("tab", { name: /My passes/ }));
        expect(addLists()).toEqual(["Your next Rax"]);
        expect(moves().length).toBeGreaterThanOrEqual(3);
      });

      it("the 12-month plan names no pass in the open: its steps are behind its table, so its first month never repeats the list", () => {
        local.addPass({ key: JOKIC.key, tier: "common" });
        open({ viewport: "desktop" });
        setLevel("Regular");
        fireEvent.change(within(screen.getByRole("region", { name: "12-month plan" })).getByLabelText("Rax you have now"), { target: { value: "5000" } });
        act(() => void vi.advanceTimersByTime(50));
        const named = moves().map((row) => row.querySelector("small")?.textContent ?? "");
        expect(named.length).toBeGreaterThan(0);
        const plan = screen.getByRole("region", { name: "12-month plan" });
        const steps = within(plan).getByRole("list", { name: "Steps" });
        expect(steps.closest("details")).not.toBeNull();
        expect(steps.closest("details")).not.toHaveAttribute("open");
        expect(steps).toHaveTextContent(/add .+ for [\d,]+, adds about [\d,]+ a year/); // the plan does have steps to repeat
        // what the plan shows without a tap: its sentence, its field, its notes (the chart's dots only name a step on hover)
        const shown = [...plan.querySelectorAll(":scope > *:not(.snw-res), .snw-res > *:not(details):not(svg)")].map((el) => el.textContent ?? "").join(" ");
        expect(shown).toContain("In 12 months your passes could pay about");
        const players = named.map((line) => /^([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+)+)/u.exec(line)?.[1]).filter((n): n is string => !!n);
        expect(players.length).toBeGreaterThan(0);
        for (const player of players) expect([player, shown.includes(player)]).toEqual([player, false]);
      });
    });

    it("on a phone My passes is its own view", () => {
      open({ viewport: "phone" });
      // The count is its own word in the tab's name, not glued to it ("My passes0").
      expect(screen.getByRole("tab", { name: "My passes 0" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: /My passes/ }));
      expect(screen.getByRole("button", { name: "Add a pass you own" })).toBeInTheDocument();
      expect(screen.queryByRole("table", { name: "Best passes" })).toBeNull();
    });

    it("next to 'On this device only', the way to carry them to another device (desktop and phone)", () => {
      open({ viewport: "desktop" });
      const panel = screen.getByRole("region", { name: "My passes" });
      press("Use it on another device", panel);
      const sheet = screen.getByRole("dialog", { name: "Use it on another device" });
      expect(within(sheet).getByRole("button", { name: "Copy my code" })).toBeInTheDocument();
      expect(within(sheet).getByLabelText("Restore from a code")).toBeInTheDocument();
    });

    it("on a phone, My passes has it too", () => {
      open({ viewport: "phone" });
      fireEvent.click(screen.getByRole("tab", { name: /My passes/ }));
      press("Use it on another device");
      expect(screen.getByRole("dialog", { name: "Use it on another device" })).toBeInTheDocument();
    });
  });

  describe("the rest of the tab", () => {
    it("cheapest way to start (a phone's Best passes): the best Common or Uncommon entry in a sport not held", () => {
      open({ viewport: "phone" });
      const start = screen.getByRole("region", { name: "Cheapest way to start" });
      expect(within(start).getByText("Nathan MacKinnon 2025-26")).toBeInTheDocument();
      act(() => {
        local.addPass({ key: MCDAVID.key, tier: "common" });
      });
      expect(within(start).getByText("Nikola Jokić 2024-25")).toBeInTheDocument();
    });

    it("the rating planner is Pro's: what a held rating is worth", () => {
      open({ viewport: "desktop" });
      expect(screen.queryByRole("region", { name: "Rating planner" })).toBeNull();
      setLevel("Pro");
      const planner = screen.getByRole("region", { name: "Rating planner" });
      fireEvent.change(within(planner).getByRole("combobox", { name: "rating on" }), { target: { value: JOKIC.key } });
      fireEvent.change(within(planner).getByRole("spinbutton", { name: "I have" }), { target: { value: "212" } });
      expect(within(planner).getByText(/212 rating on/)).toHaveTextContent(
        "212 rating on Nikola Jokić 2024-25 = Epic. 32 of it pays nothing until Legendary at 380.",
      );
      expect(within(planner).getByText(/Add 168 rating/)).toBeInTheDocument();
    });

    it("how passes work, in plain words", () => {
      open({ viewport: "desktop" });
      const how = screen.getByRole("region", { name: "How passes work" });
      expect(within(how).getByText(/2 passes per sport each day/)).toBeInTheDocument();
      expect(within(how).getByText(/Boosters/)).toBeInTheDocument();
    });

    it("rarity colours come from the rarity tokens, by the rarity's index", () => {
      const { container } = open({ viewport: "desktop" });
      setLevel("Regular");
      const swatches = container.querySelectorAll(".sw");
      expect(swatches.length).toBeGreaterThan(0);
      // The swatch takes its colour from its own rar-N, or from the RarityTag around it.
      for (const s of swatches) expect(`${s.className} ${s.parentElement?.className}`).toMatch(/\brar-[0-7]\b/);
    });

    it("unknown sport filter and no passes at all: a calm empty state", () => {
      renderApp({ snap: passSnapshot({ otd: { ...snap.otd, markets: [], picks: {}, starters: {} } }), hash: "passes", viewport: "desktop" });
      expect(screen.getByText(/No pass data yet/)).toBeInTheDocument();
    });
  });

  describe("more of the tab", () => {
    it("the sidebar's budget is the pass budget on Passes and the card budget elsewhere", () => {
      open({ viewport: "desktop" });
      expect(screen.getByText("Max to spend per pass")).toBeInTheDocument();
      expect(screen.queryByText("Max price per card")).toBeNull();
      expect(screen.getByText("One pick per pass, in plain words.")).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole("link", { name: /Deals/ })[0]!);
      expect(screen.getByText("Max price per card")).toBeInTheDocument();
      expect(screen.queryByText("Max to spend per pass")).toBeNull();
    });

    it("on a phone Level and Max price sit behind one Filters button, closed at first", () => {
      open({ viewport: "phone" });
      const button = screen.getByRole("button", { name: "Filters" });
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("radio", { name: "Regular" })).toBeNull();
      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "true");
      expect(screen.getAllByRole("radio", { name: "Regular" }).length).toBeGreaterThan(0);
    });

    it("on a phone the budget chip opens the pass budgets", () => {
      open({ viewport: "phone" });
      showFilters();
      fireEvent.click(screen.getByRole("button", { name: /Max ≤1,000/ }));
      const sheet = screen.getByRole("dialog", { name: "Max to spend per pass" });
      fireEvent.click(within(sheet).getByRole("radio", { name: "≤20,000" }));
      expect(JSON.parse(localStorage.getItem("advisor.prefs.v1")!)).toMatchObject({ passBudget: 20000 });
      expect(screen.getByRole("button", { name: /Max ≤20,000/ })).toBeInTheDocument();
    });

    it("a pass's card adds it straight at its rarity step, by exact rating, and Back goes to the player", () => {
      open({ viewport: "desktop" });
      fireEvent.click(row("Nathan MacKinnon"));
      press("I own this pass", drawer());
      const step = screen.getByRole("dialog", { name: /how far is it built/i });
      press("Exact rating", step);
      fireEvent.change(within(step).getByRole("spinbutton", { name: "Rating on this pass" }), { target: { value: "120" } });
      expect(within(step).getByText("Rare")).toBeInTheDocument(); // 120 reaches Rare
      fireEvent.click(within(step).getByRole("checkbox", { name: /maxed/ }));
      press("Add to my passes", step);
      expect(local.get().passes).toEqual([{ key: MACKINNON.key, rating: 120, spent: true }]);
      expect(screen.queryByRole("dialog", { name: /pass$/ })).toBeNull(); // the card closed
      const panel = screen.getByRole("region", { name: "My passes" });
      expect(within(panel).getByText(/pays nothing/)).toBeInTheDocument(); // added and listed
      // Back from the rarity step of a new flow leads to the player search.
      press("Add a pass you own", panel);
      fireEvent.change(screen.getByRole("searchbox", { name: "Player or team" }), { target: { value: "murray" } });
      press(/Jamal Murray/, screen.getByRole("dialog", { name: "Add a pass you own" }));
      press("Back", screen.getByRole("dialog", { name: /which season/i }));
      expect(screen.getByRole("dialog", { name: "Add a pass you own" })).toBeInTheDocument();
    });

    it("a rarity is needed before adding", () => {
      open({ viewport: "desktop" });
      press("Add a pass you own", screen.getByRole("region", { name: "My passes" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Player or team" }), { target: { value: "zzz" } });
      expect(screen.getByText(/No player called “zzz”/)).toBeInTheDocument();
      fireEvent.change(screen.getByRole("searchbox", { name: "Player or team" }), { target: { value: "jok" } });
      press(/Nikola Jokić/, screen.getByRole("dialog", { name: "Add a pass you own" }));
      press(/2024-25/, screen.getByRole("dialog", { name: /which season/i }));
      const step = screen.getByRole("dialog", { name: /how far is it built/i });
      expect(within(step).getByRole("button", { name: "Add to my passes" })).toHaveAttribute("aria-disabled", "true");
      press("Add to my passes", step);
      expect(local.get().passes).toEqual([]);
    });

    it("the month bars take their height through the CSSOM, a share of the tallest", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      fireEvent.click(row("Nathan MacKinnon"));
      const bars = within(drawer()).getByRole("list", { name: /Pay by month/ }).querySelectorAll("i");
      const heights = Array.from(bars, (b) => Number((b as HTMLElement).style.getPropertyValue("--h")));
      expect(heights).toHaveLength(12);
      expect(Math.max(...heights)).toBe(1);
      expect(heights.some((h) => h === 0)).toBe(true); // an NHL summer pays nothing
    });

    it("the search box filters the passes by name", () => {
      open({ viewport: "desktop" });
      setLevel("Regular");
      fireEvent.change(screen.getByRole("searchbox", { name: /Search a player/ }), { target: { value: "jok" } });
      expect(within(list()).getAllByRole("button", { name: /^Open the / }).map((b) => b.getAttribute("aria-label"))).toEqual([
        "Open the Nikola Jokić 2024-25 pass",
      ]);
    });

    it("See these cards with none on sale says so, and leads back to every deal", () => {
      renderApp({ snap: passSnapshot(), hash: "passes", viewport: "desktop" });
      setLevel("Regular");
      fireEvent.click(row("Nikola Jokić"));
      press("See these cards", drawer());
      expect(screen.getByText(/No Nikola Jokić 2024-25 cards are a deal right now/)).toBeInTheDocument();
      press("Show all deals");
      expect(screen.queryByText(/Showing/)).toBeNull();
    });
  });

  it("team, never and current markets are in the scene", () => {
    expect([THUNDER.kind, CHASE.season_state, SGA.best, WEMBANYAMA.best]).toEqual(["team", "current", "common", "general"]);
  });
});
