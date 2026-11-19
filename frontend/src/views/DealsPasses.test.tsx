// Deals speak about passes: a deal whose card builds a pass the site tracks says how much of the next rarity it is,
// at what price per point against the pass's usual, and what to offer; its "Pass" chip opens that pass.
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePrefs, type LevelKey } from "../data/prefs";
import type { Snapshot } from "../data/types";
import { local } from "../data/local";
import { makeDeal } from "../test/fixtures";
import { freshDevice, renderApp } from "../test/app";
import { JOKIC, MURRAY, SGA, passSnapshot, served } from "../test/passScene";
import { toBasis } from "../lib/passes";
import { PASS_DEALS_ON, PASS_DEALS_PCT_MIN, passDealsSwitch } from "../components/PassDeals";
import { OFFER_HINT_ON, offerHintSwitch } from "../lib/offerHintSwitch";
import { NOW } from "../test/scene";
import type { Locked } from "../data/types";

const ANON = '{"gate":true,"member":false,"state":"anon"}';
const OUT = '{"gate":true,"member":false,"state":"out"}';
const BANNED = '{"gate":true,"member":false,"state":"banned"}';
const MEMBER = '{"gate":true,"member":true,"state":"in"}';
const noGate = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));

// A Jokić 2024-25 card (his pass trades at 10 a point): 6 rating at 9 a point, and a card of nobody's tracked pass.
const jokic = makeDeal({
  now: NOW, listing_id: 501, sport: "nba", season: 2025, player_id: 1001, player_name: "Nikola Jokić", rating: 6, price: 54,
  per_point: 9, reference: 90, discount: 0.4, flip_margin: 20,
});
const other = makeDeal({ now: NOW, listing_id: 502, sport: "nba", season: 2027, player_id: 9999, player_name: "Nobody Tracked" });

function snapWith(over: Partial<Snapshot> = {}): Snapshot {
  return passSnapshot({ deals: [jokic, other], ...over });
}

function prefs(level: LevelKey) {
  savePrefs({ level, budget: null, sport: "all", sort: "best", tab: "deals", passBudget: null });
}

describe("the pass line on deals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  for (const viewport of ["phone", "desktop"] as const) {
    it(`on ${viewport}: only the deal that builds a tracked pass carries it`, () => {
      prefs("regular");
      renderApp({ viewport, snap: snapWith(), hash: "deals" });
      const lines = screen.getAllByTestId("deal-pass");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.textContent).toContain("6 of the 10 rating to Common");
      expect(lines[0]!.textContent).toContain("9.0 a point (usual 10.0)");
      expect(lines[0]!.textContent).toMatch(/offer about 48.*1 in 6/i);
    });
  }

  it("its chip opens the pass, at the rarity the card counts toward", () => {
    prefs("regular");
    renderApp({ viewport: "phone", snap: snapWith(), hash: "deals" });
    fireEvent.click(screen.getByRole("button", { name: `Open ${JOKIC.player_name} ${JOKIC.season_label}'s pass` }));
    const dialog = document.querySelector("dialog[open]") as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(within(dialog).getAllByText(new RegExp(JOKIC.player_name)).length).toBeGreaterThan(0);
  });

  it("the chip's tap does not open the auction under it", () => {
    prefs("regular");
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderApp({ viewport: "phone", snap: snapWith(), hash: "deals" });
    const chip = screen.getByRole("button", { name: /Open Nikola Jokić .*'s pass/ });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      chip.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("New reads the player and season, Pro the short form", () => {
    prefs("new");
    const a = renderApp({ viewport: "phone", snap: snapWith(), hash: "deals" });
    expect(screen.getByTestId("deal-pass").textContent).toContain("Builds Nikola Jokić 2024-25's pass");
    a.unmount();
    prefs("pro");
    renderApp({ viewport: "phone", snap: snapWith(), hash: "deals" });
    expect(screen.getByTestId("deal-pass").textContent).toContain("6/10 to Common · 9.0/pt");
  });

  it("starts from a linked account's holding: 25 held and this card make Uncommon", () => {
    prefs("regular");
    local.link("Mine", [{ key: JOKIC.key, rarity: "common", rating: 25 }], [], new Set([JOKIC.key]));
    renderApp({ viewport: "phone", snap: snapWith(), hash: "deals" });
    const line = screen.getByTestId("deal-pass").textContent ?? "";
    expect(line).toContain("Your pass:");
    expect(line).toContain("+6 rating, enough for Uncommon");
  });

  it("says nothing about passes on a gone row", () => {
    prefs("regular");
    const gone = { ...jokic, reason: "ended" as const, gone_at: new Date(NOW).toISOString() };
    renderApp({ viewport: "phone", snap: snapWith({ deals: [other], gone: [gone] }), hash: "deals" });
    expect(screen.queryByTestId("deal-pass")).toBeNull();
  });
});

describe("the offer hint on deals (what accepted offers went for)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    offerHintSwitch.on = true;
  });
  afterEach(() => {
    offerHintSwitch.on = OFFER_HINT_ON;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // Jokić's 2024-25 cards rated 5 to 7: 23 accepted offers cleared at 4.2 a point, where listings sold at 10.
  const measured = { ...JOKIC, offers: [["5-7", null, 4.2, 23, 10]] } as typeof JOKIC;
  const withOffers = (over: Partial<Snapshot> = {}) => {
    const snap = snapWith(over);
    return { ...snap, otd: { ...snap.otd, markets: snap.otd.markets.map((m) => (m.key === JOKIC.key ? measured : m)) } };
  };
  const HINT = "Offers accepted ~4.2/pt (23 offers): ~25 for this card · listings ~10.0/pt · ~1 in 6 accepted · needs Real Pro";
  const SPOKEN =
    "Offers on cards like it were accepted at about 4.2 Rax a rating point (23 offers): about 25 Rax for this card. Listings of the same cards sell at about 10.0 a point. About 1 in 6 offers is accepted. Making an offer needs Real Pro.";

  for (const viewport of ["phone", "desktop"] as const) {
    it(`on ${viewport}: a member at Pro reads it as the pass line's offer`, () => {
      prefs("pro");
      renderApp({ viewport, snap: withOffers(), hash: "deals", me: MEMBER, gateFetch: noGate() });
      const line = screen.getByTestId("deal-pass");
      const short = within(line).getByTestId("deal-offer-short");
      expect(short.textContent).toBe(HINT);
      // The short form is for the eye; a screen reader gets the full sentences instead.
      expect(short).toHaveAttribute("aria-hidden", "true");
      expect(within(line).getByText(SPOKEN)).toHaveClass("sr");
      expect(line.textContent).toContain("6/10 to Common · 9.0/pt"); // the pass line stays
      expect(line.textContent).not.toMatch(/offers clear/); // said once, not twice
    });
  }

  it("with the gate off, Pro reads it too", () => {
    prefs("pro");
    renderApp({ viewport: "phone", snap: withOffers(), hash: "deals" });
    expect(screen.getByTestId("deal-offer-short").textContent).toBe(HINT);
  });

  it("stands alone, with no Pass chip, on a deal whose pass has nothing else to say", () => {
    prefs("pro");
    // No rarity of this pass pays back: no pass line, but the offers on its cards were still measured.
    const dead = { ...measured, rungs: measured.rungs.map((r) => ({ ...r, pays_back: false })) };
    const snap = withOffers();
    const only = { ...snap, otd: { ...snap.otd, markets: snap.otd.markets.map((m) => (m.key === JOKIC.key ? dead : m)) } };
    renderApp({ viewport: "phone", snap: only, hash: "deals", me: MEMBER, gateFetch: noGate() });
    const line = screen.getByTestId("deal-pass");
    expect(line.textContent).toBe(`${HINT}${SPOKEN}`); // nothing but the hint: its short form, and the spoken one
    expect(within(line).queryByRole("button", { name: /Open .*'s pass/ })).toBeNull();
  });

  it("the other levels read the line as before", () => {
    for (const level of ["new", "regular"] as const) {
      prefs(level);
      const view = renderApp({ viewport: "phone", snap: withOffers(), hash: "deals", me: MEMBER, gateFetch: noGate() });
      expect(screen.queryByTestId("deal-offer")).toBeNull();
      expect(screen.getByTestId("deal-pass").textContent).not.toMatch(/were accepted|Offers accepted ~/);
      view.unmount();
    }
  });

  it("a visitor at Pro reads nothing new, signed in or not", () => {
    for (const me of [ANON, OUT]) {
      prefs("pro");
      const view = renderApp({ viewport: "phone", snap: withOffers(), hash: "deals", me, gateFetch: noGate() });
      expect(screen.queryByTestId("deal-offer")).toBeNull();
      view.unmount();
    }
  });

  it("the free site's snapshot never carries it, whoever reads it", () => {
    prefs("pro");
    const locked: Locked = { deals: 3, risers: 0, fallers: 0, passes: 5, alerts: true, accounts: true };
    renderApp({ viewport: "phone", snap: withOffers({ locked }), hash: "deals", me: MEMBER, gateFetch: noGate() });
    expect(screen.queryByTestId("deal-offer")).toBeNull();
  });

  it("off, Pro reads the line as before the hint", () => {
    offerHintSwitch.on = false;
    prefs("pro");
    renderApp({ viewport: "phone", snap: withOffers(), hash: "deals", me: MEMBER, gateFetch: noGate() });
    expect(screen.queryByTestId("deal-offer")).toBeNull();
    expect(screen.getByTestId("deal-pass").textContent).toMatch(/offers clear ~4\.2\/pt, 23 accepted/);
  });

  it("is on, as the server's rule says", () => {
    expect(OFFER_HINT_ON).toBe(true);
  });
});

describe("the For passes sort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("puts the deals that build a pass first, says how many do, and is remembered", () => {
    prefs("regular");
    const rich = { ...other, flip_margin: 900 }; // first by best after fees
    renderApp({ viewport: "phone", snap: snapWith({ deals: [rich, jokic] }), hash: "deals" });
    const first = () => screen.getAllByTestId("player")[0]!.textContent;
    expect(first()).toBe("Nobody Tracked");
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    expect(screen.getByText("1 deal here builds a pass we track.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /For passes/ }));
    expect(first()).toBe("Nikola Jokić");
    expect(JSON.parse(localStorage.getItem("advisor.prefs.v1")!).sort).toBe("passes");
  });
});

describe("Pass deals at the top of Deals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    passDealsSwitch.on = true; // the block's own tests, whatever the site's switch says
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    passDealsSwitch.on = PASS_DEALS_ON;
  });

  // Jokić's cards on sale at 8 and 9 a point, his usual 10: Common for less than usual.
  const cheapShelf = (): Snapshot => {
    const snap = snapWith({ deals: [other] });
    const markets = snap.otd.markets.map((m) => (m.key === JOKIC.key ? served({ ...toBasis(m), shelf: [[6, 48], [5, 45]], shelf_count: 2 }) : m));
    return { ...snap, otd: { ...snap.otd, markets } };
  };
  const block = () => screen.queryByRole("region", { name: "Pass deals" });

  for (const viewport of ["phone", "desktop"] as const) {
    it(`on ${viewport}: names the pass, the rating on sale against the usual, what it pays, and opens the pass`, () => {
      prefs("regular");
      renderApp({ viewport, snap: cheapShelf(), hash: "deals" });
      const region = block()!;
      expect(region).not.toBeNull();
      expect(region.textContent).toContain("Nikola Jokić 2024-25");
      expect(region.textContent).toContain("11 rating on sale for 93 Rax plus the mint: 8.5 a point (usual 10.0).");
      expect(region.textContent).toMatch(/Common pays about [\d,]+ Rax a year/);
      expect(region.textContent).toContain("Real Pro");
      expect(within(region).getByRole("link", { name: /See all passes/ })).toHaveAttribute("href", "#passes");
      fireEvent.click(within(region).getByRole("button", { name: /Nikola Jokić 2024-25/ }));
      expect(screen.getByRole("dialog", { name: /Nikola Jokić 2024-25/ })).toBeInTheDocument();
    });
  }

  it("is not there when no pass has cards on sale under its usual rate", () => {
    prefs("regular");
    const snap = snapWith();
    const bare = { ...snap, otd: { ...snap.otd, markets: snap.otd.markets.map((m) => served({ ...toBasis(m), shelf: [], shelf_count: 0 })) } };
    renderApp({ viewport: "phone", snap: bare, hash: "deals" });
    expect(block()).toBeNull();
  });

  it("leaves the claims a sport's live passes take: two NBA passes held, no NBA pass deal", () => {
    prefs("regular");
    local.addPass({ key: MURRAY.key, tier: "common" });
    local.addPass({ key: SGA.key, tier: "common" });
    renderApp({ viewport: "phone", snap: cheapShelf(), hash: "deals" });
    expect(block()?.textContent ?? "").not.toContain("Nikola Jokić");
  });

  it("a member sees the block as ever: the whole snapshot, the passes, their prices and the way to each", () => {
    prefs("regular");
    renderApp({ viewport: "phone", snap: cheapShelf(), hash: "deals", me: MEMBER, gateFetch: noGate() });
    const region = block()!;
    expect(region.textContent).toContain("Nikola Jokić 2024-25");
    expect(region.textContent).toContain("93 Rax");
    expect(within(region).queryByRole("link", { name: /Unlock it all free|Join the server/ })).toBeNull();
    document.getElementById("me")?.remove();
  });
  it("follows the sport tab", () => {
    savePrefs({ level: "regular", budget: null, sport: "nfl", sort: "best", tab: "deals", passBudget: null });
    const a = renderApp({ viewport: "phone", snap: cheapShelf(), hash: "deals" });
    expect(block()).toBeNull(); // no NFL pass has cards on sale
    a.unmount();
    savePrefs({ level: "regular", budget: null, sport: "nba", sort: "best", tab: "deals", passBudget: null });
    renderApp({ viewport: "phone", snap: cheapShelf(), hash: "deals" });
    expect(block()!.textContent).toContain("Nikola Jokić");
    expect(block()!.textContent).not.toContain("MacKinnon");
  });
});

// "Pass deals" is for members of our Discord server. Anyone else gets a locked place for it: how many passes the cards
// on sale build for less today and the best saving (two numbers the server counts, `locked.pass_deals`), blank rows
// shaped like the block, and the way in. No pass, name, price or offer of the block, even when the free snapshot holds
// passes with cards on sale under their usual rate.
describe("Pass deals on the free site: locked", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    passDealsSwitch.on = true;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    passDealsSwitch.on = PASS_DEALS_ON;
    document.getElementById("me")?.remove();
  });

  const LOCKED: Locked = { deals: 42, risers: 7, fallers: 6, passes: 59, alerts: true, accounts: true };
  // The free snapshot's own Jokić pass has cards on sale under its usual rate: the old block named it.
  const freeSnap = (passDeals: Locked["pass_deals"]): Snapshot => {
    const snap = snapWith({ deals: [other] });
    const markets = snap.otd.markets.map((m) => (m.key === JOKIC.key ? served({ ...toBasis(m), shelf: [[6, 48], [5, 45]], shelf_count: 2 }) : m));
    return { ...snap, otd: { ...snap.otd, markets }, locked: { ...LOCKED, pass_deals: passDeals } };
  };
  const block = () => screen.queryByRole("region", { name: "Pass deals" });

  for (const viewport of ["phone", "desktop"] as const) {
    it(`on ${viewport}: says how many passes and the best saving, and shows no pass, price or offer`, () => {
      prefs("regular");
      renderApp({ viewport, snap: freeSnap({ passes: 7, best_pct: 31 }), hash: "deals", me: ANON, gateFetch: noGate() });
      const region = block()!;
      expect(region).not.toBeNull();
      expect(region.textContent).toContain("Cards on sale now build 7 passes for less than usual.");
      expect(within(region).getByRole("heading", { name: "The best one costs at least 31% less than usual" })).toBeInTheDocument();
      // A member lands on every sport, where the block lists the first 3: the line says so, not "each one" of 7.
      expect(region.textContent).toContain("Discord members see the best 3: the pass, what its cards cost and what it pays.");
      expect(within(region).getByRole("link", { name: /Unlock it all free/ })).toHaveAttribute("href", "/auth/discord?next=%2Fdeals"); // back to Deals, unlocked
      expect(within(region).getByRole("link", { name: "What you get" })).toHaveAttribute("href", "#join");
      // Nothing of the block itself: no pass, no price, no offer, no way to a pass.
      for (const word of ["Jokić", "Rax", "rating", "Real Pro", "offer", "Common"]) expect(region.textContent).not.toContain(word);
      expect(within(region).queryByRole("button", { name: /Nikola/ })).toBeNull();
      expect(within(region).queryByRole("link", { name: /See all passes/ })).toBeNull();
    });
  }

  it("reads the level this device chose: what the block would show a member of that level", () => {
    const levels = { new: { passes: 1, best_pct: 10 }, regular: { passes: 4, best_pct: 25 }, pro: { passes: 6, best_pct: 50 } };
    for (const [level, words, title] of [
      ["new", "1 pass", "It costs at least 10% less than usual"],
      ["regular", "4 passes", "The best one costs at least 25% less than usual"],
      ["pro", "6 passes", "The best one costs at least 50% less than usual"],
    ] as const) {
      freshDevice();
      prefs(level);
      const view = renderApp({ viewport: "phone", snap: freeSnap({ passes: 1, best_pct: 10, levels }), hash: "deals", me: ANON, gateFetch: noGate() });
      const region = block()!;
      expect(region.textContent).toContain(`Cards on sale now build ${words} for less than usual.`);
      expect(within(region).getByRole("heading", { name: title })).toBeInTheDocument();
      view.unmount();
    }
  });

  it(`under ${PASS_DEALS_PCT_MIN}% off, says no percent: the count is the hook`, () => {
    // Tonight's live figures: 13 passes, the best of the first 3 at least 5% off.
    for (const [pct, passes, title, line] of [
      [5, 13, "13 passes worth building today", "Discord members see the best 3:"],
      [PASS_DEALS_PCT_MIN - 5, 2, "2 passes worth building today", "Discord members see each one:"],
      [0, 1, "1 pass worth building today", "Discord members see it:"],
      [null, 1, "1 pass worth building today", "Discord members see it:"],
    ] as const) {
      const view = renderApp({ viewport: "phone", snap: freeSnap({ passes, best_pct: pct }), hash: "deals", me: ANON, gateFetch: noGate() });
      const region = block()!;
      expect(region.textContent).toContain(passes === 1 ? "It uses cards on sale right now and pays back its cost."
        : "Each uses cards on sale right now and pays back its cost.");
      expect(region.textContent).not.toContain("less than usual");
      expect(region.textContent!.match(/build/g)).toHaveLength(1); // said once, in the title
      expect(within(region).getByRole("heading", { name: title })).toBeInTheDocument();
      expect(region.textContent).toContain(line);
      expect(region.textContent).not.toContain("%");
      view.unmount();
    }
  });

  it(`from ${PASS_DEALS_PCT_MIN}% off, says the percent`, () => {
    renderApp({ viewport: "phone", snap: freeSnap({ passes: 13, best_pct: PASS_DEALS_PCT_MIN }), hash: "deals", me: ANON, gateFetch: noGate() });
    const region = block()!;
    expect(region.textContent).toContain("Cards on sale now build 13 passes for less than usual.");
    expect(within(region).getByRole("heading", { name: `The best one costs at least ${PASS_DEALS_PCT_MIN}% less than usual` })).toBeInTheDocument();
  });

  it("up to 3 passes, a member sees each one", () => {
    renderApp({ viewport: "phone", snap: freeSnap({ passes: 3, best_pct: 20 }), hash: "deals", me: ANON, gateFetch: noGate() });
    expect(block()!.textContent).toContain("Discord members see each one: the pass, what its cards cost and what it pays.");
  });

  it("signed in but not in the server: join it, or check again", () => {
    renderApp({ viewport: "phone", snap: freeSnap({ passes: 4, best_pct: 12 }), hash: "deals", me: OUT, gateFetch: noGate() });
    const region = block()!;
    expect(within(region).getByRole("link", { name: /Join the server/ })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "I've joined: check again" })).toBeInTheDocument();
  });

  it("is not there with no pass deal to tease, nor for an older snapshot that does not count them", () => {
    const a = renderApp({ viewport: "phone", snap: freeSnap({ passes: 0, best_pct: null }), hash: "deals", me: ANON, gateFetch: noGate() });
    expect(block()).toBeNull();
    a.unmount();
    renderApp({ viewport: "phone", snap: freeSnap(undefined), hash: "deals", me: ANON, gateFetch: noGate() });
    expect(block()).toBeNull();
    expect(screen.queryByText(/Nikola Jokić 2024-25/)).toBeNull();
  });

  it("is not there for an account Discord refused: no way in to offer", () => {
    renderApp({ viewport: "phone", snap: freeSnap({ passes: 7, best_pct: 31 }), hash: "deals", me: BANNED, gateFetch: noGate() });
    expect(block()).toBeNull();
  });
});

// Switched off (advisor/rules.py PASS_DEALS_ON): the passes' usual rate rests on one arbitrary rating bucket and the
// shelf holds auctions' opening prices, so "for less than usual" could not be trusted. Nobody sees the block, member or not.
describe("Pass deals switched off", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("is off on the site", () => {
    expect(PASS_DEALS_ON).toBe(false);
    expect(passDealsSwitch.on).toBe(false);
  });

  it("shows no Pass deals block to a member, even with cards on sale under the usual rate", () => {
    const snap = snapWith({ deals: [other] });
    const markets = snap.otd.markets.map((m) => (m.key === JOKIC.key ? served({ ...toBasis(m), shelf: [[6, 48], [5, 45]], shelf_count: 2 }) : m));
    renderApp({ viewport: "phone", snap: { ...snap, otd: { ...snap.otd, markets } }, hash: "deals" });
    expect(screen.queryByRole("region", { name: "Pass deals" })).toBeNull();
  });
});
