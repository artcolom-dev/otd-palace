import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { about } from "../../content/passWords";
import { local } from "../../data/local";
import { AppContext, type AppState } from "../../AppContext";
import { passSnapshot } from "../../test/passScene";
import { type Member, MemberContext } from "../MemberLine";
import { AccessContext } from "../Access";
import { ASK_AGAIN_MS, AccountAnalysis } from "./AccountAnalysis";

// A plan's figures as a big account's are: not round (the fixture's are).
const odd = vi.hoisted(() => ({ on: false }));
vi.mock("../../lib/passes", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/passes")>();
  return {
    ...real,
    planHoldings: (...args: Parameters<typeof real.planHoldings>) => {
      const plan = real.planHoldings(...args);
      if (!odd.on) return plan;
      return { ...plan, total: 4_517_888.4, held: plan.held.map((h, i) => ({ ...h, year: h.year + 37.3 + i })) };
    },
  };
});

const ctx = { titleId: "t", close: () => undefined, phone: false };
const show = (username: string, link = false, member: Member | null = null) =>
  render(
    <AppContext.Provider
      value={{ snap: passSnapshot(), prefs: { level: "regular", budget: null, passBudget: null, sport: "all" }, now: Date.now() } as unknown as AppState}
    >
      <MemberContext.Provider value={member}>
        <AccountAnalysis username={username} ctx={ctx} link={link} />
      </MemberContext.Provider>
    </AppContext.Provider>,
  );

describe("AccountAnalysis", () => {
  beforeEach(() => {
    localStorage.clear();
    local.reload();
  });
  afterEach(() => {
    odd.on = false;
    vi.restoreAllMocks();
  });

  it("says what happened for an account that is unknown or private, and touches none of this device's passes", async () => {
    const before = JSON.stringify(local.get().passes);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "not_found" }), { status: 404 }));
    show("nobody");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No Real account is named nobody."));
    expect(JSON.stringify(local.get().passes)).toBe(before);
  });

  it("a visitor not signed in is asked to sign in with Discord, never told there were too many lookups", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "discord_required" }), { status: 401 }));
    show("someone");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("for members of the OTD Palace Discord"));
    expect(screen.queryByText(/Too many lookups/)).toBeNull();
    expect(screen.getByRole("link", { name: /Continue with Discord/ })).toHaveAttribute("href", expect.stringContaining("/auth/discord"));
  });

  it("someone signed in but not in the server is asked to join it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "discord_required" }), { status: 401 }));
    render(
      <AccessContext.Provider value={{ state: "out", name: "x", fetchImpl: fetch, refresh: () => undefined }}>
        <AppContext.Provider
          value={{ snap: passSnapshot(), prefs: { level: "regular", budget: null, passBudget: null, sport: "all" }, now: Date.now() } as unknown as AppState}
        >
          <AccountAnalysis username="someone" ctx={ctx} />
        </AppContext.Provider>
      </AccessContext.Provider>,
    );
    expect(await screen.findByRole("link", { name: /Join the server/ })).toBeInTheDocument();
  });

  it("no network says so", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    show("someone");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Check your connection"));
  });

  it("for a readable account, shows the yearly total and what that account should add next", async () => {
    const market = passSnapshot().otd.markets[0]!;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", username: "Someone", passes: [{ key: market.key, tier: "common" }], truncated: false }), { status: 200 }),
    );
    show("someone");
    await waitFor(() => expect(screen.getByText("Their passes pay about")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "What this account should add next" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How full each sport is" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Passes that hardly ever get a claim" })).toBeNull(); // one pass: it claims
    expect(local.get().passes).toEqual([]); // read only
  });

  it("lists the passes that hardly ever get a claim, with what each gets of what it could pay", async () => {
    const site = passSnapshot().otd.markets[0]!;
    const mate = (id: number, name: string, base: number) =>
      ({ ...site, key: `nba:2019:player:${id}`, season: 2019, player_id: id, player_name: name, team_id: 55, base_1x: base });
    const theirs = [mate(701, "Ace One", 400), mate(702, "Ace Two", 400), mate(703, "Third Wheel", 300)];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        status: "ok", username: "Someone", truncated: false, waiting: 0, seasons_waiting: 0,
        passes: theirs.map((m) => ({ key: m.key, tier: "common" })), markets: theirs,
      }), { status: 200 }),
    );
    const { container } = show("someone");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Passes that hardly ever get a claim" })).toBeInTheDocument());
    const idle = container.querySelector(".acc-idle")!;
    expect(idle.querySelectorAll("li")).toHaveLength(1);
    expect(idle.querySelector("li")).toHaveTextContent("Third Wheel");
    expect(idle.querySelector("li .yr")).toHaveTextContent("0 of 600 a year"); // Common is 2x of 300
    expect(idle).toHaveTextContent("1 pass wins few of the 2 daily claims");
    expect(idle).not.toHaveTextContent("Ace One");
  });

  it("counts a pass this site does not list from the account's own valued markets", async () => {
    const site = passSnapshot().otd.markets[0]!;
    const theirs = { ...site, key: "nba:2019:player:777", season: 2019, player_id: 777, player_name: "Lone Wolf" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        status: "ok", username: "Someone", truncated: false, waiting: 0, seasons_waiting: 0,
        passes: [{ key: theirs.key, tier: "rare" }, { key: site.key, tier: "common" }], markets: [theirs],
      }), { status: 200 }),
    );
    show("someone");
    await waitFor(() => expect(screen.getByText("Their passes pay about")).toBeInTheDocument());
    expect(screen.getByText(/all 2 passes counted/)).toBeInTheDocument();
    expect(screen.getAllByText("Lone Wolf", { exact: false }).length).toBeGreaterThan(0); // in the sports and the top list
    expect(screen.queryByText(/could not be valued/)).toBeNull();
  });

  it("rounds its estimates as My passes does: the same account reads the same figure in both places", async () => {
    const site = passSnapshot().otd.markets[0]!;
    const theirs = { ...site, key: "nba:2019:player:777", season: 2019, player_id: 777, player_name: "Lone Wolf", base_1x: 1337.77 };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        status: "ok", username: "Someone", truncated: false, waiting: 0, seasons_waiting: 0,
        passes: [{ key: theirs.key, tier: "rare" }, { key: site.key, tier: "common" }], markets: [theirs],
      }), { status: 200 }),
    );
    odd.on = true;
    const { container } = show("someone");
    await waitFor(() => expect(screen.getByText("Their passes pay about")).toBeInTheDocument());
    odd.on = false;
    expect(container.querySelector(".acc-total strong")).toHaveTextContent("4,517,900");
    const shown = [container.querySelector(".acc-total strong")!, ...container.querySelectorAll(".dsec .yr b, .dsec li b")]
      .map((el) => el.textContent ?? "")
      .filter((t) => /^[\d,]+$/.test(t));
    expect(shown.length).toBeGreaterThan(0);
    for (const t of shown) expect(t).toBe(about(Number(t.replace(/,/g, ""))));
  });

  it("while seasons are still being read, says so and asks again until every pass is counted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const site = passSnapshot().otd.markets[0]!;
    const theirs = { ...site, key: "nba:2019:player:777", season: 2019, player_id: 777, player_name: "Lone Wolf" };
    const passes = [{ key: theirs.key, tier: "rare" }, { key: site.key, tier: "common" }];
    const answers = [
      { status: "ok", username: "Big", truncated: false, passes, markets: [], waiting: 1, seasons_waiting: 1 },
      { status: "busy" },
      { status: "ok", username: "Big", truncated: false, passes, markets: [theirs], waiting: 0, seasons_waiting: 0 },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(answers.shift()), { status: 200 }));
    try {
      show("big");
      // One statement: the bold line says what is happening, the bar and its words alone count how far (the site's
      // own count of passes it can value, "2 of 2", would read against "1 of 2 read from Real").
      await waitFor(() => expect(screen.getByText("Still reading a season of their passes.")).toBeInTheDocument());
      expect(screen.getByText("Still reading a season of their passes.").closest("p")).not.toHaveTextContent(/counted/);
      expect(screen.getByText("1 of 2 passes read from Real so far")).toBeInTheDocument();
      expect(screen.getByText("So far, their passes pay about")).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(ASK_AGAIN_MS);                 // busy: what was read stays
      expect(screen.getByText("1 of 2 passes read from Real so far")).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(ASK_AGAIN_MS);
      await waitFor(() => expect(screen.getByText(/all 2 passes counted/)).toBeInTheDocument());
      expect(screen.queryByText(/Still reading/)).toBeNull();
      await vi.advanceTimersByTimeAsync(ASK_AGAIN_MS * 3);
      expect(fetchSpy).toHaveBeenCalledTimes(3);                       // every pass counted: it stops asking
    } finally {
      vi.useRealTimers();
    }
  });

  it("a busy first answer is the answer: it does not keep asking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "busy" }), { status: 503 }));
    try {
      show("crowd");
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Too many lookups"));
      await vi.advanceTimersByTimeAsync(ASK_AGAIN_MS * 3);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a lookup that is rate limited never says the account is linked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "busy" }), { status: 503 }));
    show("crowd", true);
    expect(screen.queryByText(/Your Real account, linked/)).toBeNull(); // not while it is still reading either
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Too many lookups"));
    expect(screen.queryByText(/Your Real account, linked/)).toBeNull();
  });

  it("linking makes the account's passes this device's at once: no second click", async () => {
    const market = passSnapshot().otd.markets[0]!;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", username: "Mine", passes: [{ key: market.key, rating: 85, rarity: "rare", cap: 0 }], truncated: false }), { status: 200 }),
    );
    show("mine", true);
    await waitFor(() => expect(local.get().link?.username).toBe("Mine"));
    expect(local.get().passes).toEqual([{ key: market.key, rating: 85, rarity: "rare", cap: 0, from: "real" }]);
    expect(screen.getByText(/Linked: 1 pass is yours/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add to my passes/ })).toBeNull();
  });

  it("a member links through the server; a name another member linked is still linked here, with a note", async () => {
    const market = passSnapshot().otd.markets[0]!;
    const calls: [string, RequestInit | undefined][] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      calls.push([String(url), init]);
      return new Response(JSON.stringify({ error: "taken", message: "shaedon is linked to another Discord member already." }), { status: 409 });
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", username: "shaedon", passes: [{ key: market.key, rating: 12 }], truncated: false }), { status: 200 }),
    );
    show("shaedon", true, { name: "Deal Hunter", fetchImpl });
    await waitFor(() => expect(screen.getByText(/linked to another Discord member already\. It is linked on this device only\./)).toBeInTheDocument());
    expect(calls[0]![0]).toBe("/api/me/link");
    expect(calls[0]![1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ username: "shaedon" });
    expect(local.get().link?.username).toBe("shaedon");
  });

  it("linking a big account keeps every one of its passes on this device", async () => {
    const site = passSnapshot().otd.markets[0]!;
    const passes = Array.from({ length: 2149 }, (_, i) => ({ key: `nba:2019:player:${1000 + i}`, rating: 2149 - i }));
    passes[0] = { key: site.key, rating: 300 };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", username: "Big", truncated: false, passes, markets: [], waiting: 0, seasons_waiting: 0 }), { status: 200 }),
    );
    show("big", true);
    await waitFor(() => expect(screen.getByText("Your passes pay about")).toBeInTheDocument());
    expect(local.get().passes).toHaveLength(2149);
    expect(local.get().heldMarkets).toEqual([]); // no valuation came with these
    expect(local.get().follows.length).toBeGreaterThan(0); // a first link follows their best players
    expect(screen.getByText("Linked: 2,149 passes are yours for all advice here.")).toBeInTheDocument();
  });

  it("linking brings the account's valuations of the passes this site does not list, so they count here too", async () => {
    const site = passSnapshot().otd.markets[0]!;
    const theirs = { ...site, key: "nba:2019:player:777", season: 2019, player_id: 777, player_name: "Lone Wolf" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        status: "ok", username: "Someone", truncated: false, waiting: 0, seasons_waiting: 0,
        passes: [{ key: theirs.key, tier: "rare" }, { key: site.key, tier: "common" }], markets: [theirs, site],
      }), { status: 200 }),
    );
    show("someone", true);
    await waitFor(() => expect(screen.getByText("Your passes pay about")).toBeInTheDocument());
    expect(local.get().heldMarkets.map((m) => m.key)).toEqual([theirs.key]); // the site's own market is not copied
  });

  it("shows the wait while it reads", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => undefined));
    show("slowpoke");
    expect(screen.getByRole("status")).toHaveTextContent("Reading slowpoke's passes");
  });
});
