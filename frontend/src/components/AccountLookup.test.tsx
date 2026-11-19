import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppState } from "../AppContext";
import { local } from "../data/local";
import { pendingForTests, resetActivityForTests } from "../lib/activity";
import { memberLinkStore } from "../lib/link";
import { sceneSnapshot } from "../test/scene";
import { AccountButton, AccountCard, LINK_SYNC_RETRY_MS, LinkSync } from "./AccountLookup";
import { type Member, MemberContext } from "./MemberLine";
import { OverlayProvider } from "./Overlay";

const COVERAGE = { sports: ["nba"], listings_complete: false, sales_window_h: 168, otd_as_of: null };
const state = ({ coverage, accounts }: { coverage?: unknown; accounts?: boolean }) => {
  const snap = sceneSnapshot();
  return {
    snap: { ...snap, rules: { ...snap.rules, coverage }, links: { ...snap.links, accounts } },
    layout: { phone: false },
    now: Date.now(),
  } as unknown as AppState;
};
const show = (value: AppState, member: Member | null = null) =>
  render(
    <AppContext.Provider value={value}>
      <MemberContext.Provider value={member}>
        <OverlayProvider phone={false}>
          <AccountCard />
          <AccountButton variant="bar" />
        </OverlayProvider>
      </MemberContext.Provider>
    </AppContext.Provider>,
  );

describe("Link your Real account: the entry points", () => {
  beforeEach(() => {
    localStorage.clear();
    local.reload();
    memberLinkStore.set(null);
  });

  it("show on the live feed: one action to link, and a small way to look up someone else", () => {
    show(state({ coverage: COVERAGE }));
    expect(screen.getByRole("heading", { name: "Link your Real account" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Your Real username")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link your Real account" })).toBeInTheDocument();
    expect(screen.queryByText(/Analyze/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Look up someone else" }));
    expect(screen.getByPlaceholderText("Their Real username")).toBeInTheDocument();
  });

  it("tell the admin panel which account was looked up or linked (lib/activity.ts)", () => {
    resetActivityForTests();
    const prefs = { level: "regular", budget: null, sport: "all", sort: "best", tab: "today", passBudget: null };
    show({ ...state({ coverage: COVERAGE }), prefs, follows: new Set() } as unknown as AppState);
    fireEvent.click(screen.getByRole("button", { name: "Look up someone else" }));
    fireEvent.change(screen.getByPlaceholderText("Their Real username"), { target: { value: "@KingCards" } });
    fireEvent.submit(screen.getByPlaceholderText("Their Real username").closest("form")!);
    expect(pendingForTests()).toContainEqual(["lookup", "KingCards"]);
    resetActivityForTests();
  });

  it("show on the sample data too, which links sample accounts; nothing when the site cannot read an account", () => {
    show(state({ accounts: true }));
    expect(screen.getByRole("heading", { name: "Link your Real account" })).toBeInTheDocument();
    document.body.innerHTML = "";
    const { container } = show(state({}));
    expect(container).toBeEmptyDOMElement();
  });

  it("once linked: the chip with the name, the passes, the age, Refresh and Unlink", () => {
    local.link("Shaedon", [{ key: "nba:2025:player:1001", rating: 12 }, { key: "nba:2025:player:1002", rating: 12 }], [], new Set(), Date.now() - 3 * 60_000);
    show(state({ coverage: COVERAGE }));
    expect(screen.getByRole("heading", { name: "Your Real account" })).toBeInTheDocument();
    expect(screen.getByTestId("link-chip")).toHaveTextContent("Linked: @Shaedon · 2 passes · updated 3 min ago");
    expect(screen.getByRole("button", { name: "@Shaedon" })).toBeInTheDocument(); // the top bar says it too
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(local.get().link).toBeNull();
    expect(local.get().passes).toEqual([]);
    expect(screen.getByRole("heading", { name: "Link your Real account" })).toBeInTheDocument();
  });

  it("a member sees their Discord perks, and turns the pings off", async () => {
    let pings = true;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "PATCH") pings = JSON.parse(String(init.body)).pings;
      const perks = { linked: true, roles: ["Linked", "NBA", "Steady"], lounge: true, big_accounts: false, pings, dm_closed: false };
      return new Response(JSON.stringify({ link: { username: "Shaedon", linked_at: 1, refreshed_at: 1, passes: 40, year: 900, pings, dm_closed: false }, perks }), { status: 200 });
    });
    local.link("Shaedon", [{ key: "nba:2025:player:1001", rating: 12 }], [], new Set());
    show(state({ coverage: COVERAGE }), { name: "Deal Hunter", fetchImpl });
    await waitFor(() => expect(screen.getByText("Linked, NBA, Steady")).toBeInTheDocument());
    expect(screen.getByText("Open to you in the server.")).toBeInTheDocument();
    expect(screen.getByText("Opens at 500,000 Rax a year.")).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: "Ping me on Discord for deals on my players" });
    expect(box).toBeChecked();
    await act(async () => void fireEvent.click(box));
    await waitFor(() => expect(box).not.toBeChecked());
    const patch = fetchImpl.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1]!.body))).toMatchObject({ pings: false });
  });

  it("folds the perks into one line while all of them are on, and opens them out when one is not", async () => {
    const answer = (pings: boolean) =>
      new Response(JSON.stringify({ link: { username: "Shaedon", linked_at: 1, refreshed_at: 1, passes: 40, year: 900, pings, dm_closed: false },
        perks: { linked: true, roles: ["Linked"], lounge: true, big_accounts: false, pings, dm_closed: false } }), { status: 200 });
    local.link("Shaedon", [{ key: "nba:2025:player:1001", rating: 12 }], [], new Set());
    show(state({ coverage: COVERAGE }), { name: "Deal Hunter", fetchImpl: vi.fn<typeof fetch>(async () => answer(true)) });
    const summary = await screen.findByText("All on");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    document.body.innerHTML = "";
    memberLinkStore.set(null);
    show(state({ coverage: COVERAGE }), { name: "Deal Hunter", fetchImpl: vi.fn<typeof fetch>(async () => answer(false)) });
    await screen.findByText("Discord perks");
    expect(screen.queryByText("All on")).toBeNull();
    expect(screen.getByText("Discord perks").closest("details")).toHaveAttribute("open");
  });

  it("says when the member's DMs are closed, and nobody else sees the perks", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ link: { username: "x1", linked_at: 1, passes: 3, pings: true, dm_closed: true },
        perks: { linked: true, roles: ["Linked", "Rookie"], lounge: true, big_accounts: false, pings: true, dm_closed: true } }), { status: 200 }));
    show(state({ coverage: COVERAGE }), { name: "Deal Hunter", fetchImpl });
    await waitFor(() => expect(screen.getByText(/DMs are closed to our bot/)).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: /Ping me/ })).not.toBeChecked();
    document.body.innerHTML = "";
    show(state({ coverage: COVERAGE }));
    expect(screen.queryByText("Discord perks")).toBeNull();
  });
});

describe("LinkSync: a member's link follows them", () => {
  beforeEach(() => {
    localStorage.clear();
    local.reload();
    memberLinkStore.set(null);
  });
  const perks = { linked: false, roles: [], lounge: false, big_accounts: false, pings: false, dm_closed: false };
  const sync = (fetchImpl: typeof fetch) =>
    render(
      <AppContext.Provider value={state({ coverage: COVERAGE })}>
        <MemberContext.Provider value={{ name: "Deal Hunter", fetchImpl }}>
          <LinkSync />
        </MemberContext.Provider>
      </AppContext.Provider>,
    );

  it("a device linked before the member unlinked elsewhere unlinks too, and never links them back", async () => {
    local.link("Shaedon", [{ key: "nba:2025:player:1001", rating: 12 }], [], new Set(), 1_000_000);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ link: null, perks, unlinked_at: 2000 }), { status: 200 }));
    sync(fetchImpl);
    await waitFor(() => expect(local.get().link).toBeNull());
    expect(fetchImpl.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("a device linked after the last unlink gives the server its link", async () => {
    local.link("Shaedon", [{ key: "nba:2025:player:1001", rating: 12 }], [], new Set(), 3_000_000);
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ status: "ok", username: "Shaedon", passes: [{ key: "nba:2025:player:1001", rating: 12 }], truncated: false }), { status: 200 })
        : new Response(JSON.stringify({ link: null, perks, unlinked_at: 2000 }), { status: 200 }),
    );
    sync(fetchImpl);
    await waitFor(() => expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(local.get().link?.username).toBe("Shaedon");
  });
  it("a refused read of the server's link (too many asks) is tried again later, so the device ends up linked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const server = { link: { username: "Shaedon", linked_at: 1000, passes: 1 }, perks, unlinked_at: null };
      let posts = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method !== "POST") return new Response(JSON.stringify(server), { status: 200 });
        posts += 1;
        return posts === 1
          ? new Response(JSON.stringify({ error: "rate", message: "Too many" }), { status: 429 })
          : new Response(JSON.stringify({ status: "ok", username: "Shaedon", passes: [{ key: "nba:2025:player:1001", rating: 12 }], truncated: false }), { status: 200 });
      });
      sync(fetchImpl);
      await waitFor(() => expect(posts).toBe(1));
      expect(local.get().link).toBeNull();
      await act(async () => void (await vi.advanceTimersByTimeAsync(LINK_SYNC_RETRY_MS[0]! + 50)));
      await waitFor(() => expect(local.get().link?.username).toBe("Shaedon"));
      expect(posts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
