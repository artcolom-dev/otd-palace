// Open with perks: everyone gets the site. The page's mark says who is asking (a member, not signed in, signed in but
// not in our server, refused by it); anyone but a member is served the free site's snapshot, whose locked areas each
// offer the way in. A 401 from a member route mid-visit asks the server again who this is, and the snapshot at once.
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "./data/types";
import { noteDiscordRequired } from "./lib/gate";
import { freshDevice, renderApp } from "./test/app";
import { sceneSnapshot } from "./test/scene";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));

const ANON = '{"gate":true,"member":false,"state":"anon"}';
const OUT = '{"gate":true,"member":false,"state":"out"}';
const BANNED = '{"gate":true,"member":false,"state":"banned"}';
const MEMBER = '{"gate":true,"member":true,"state":"in"}';

/** The free site's snapshot, as the server trims it (advisor/public.py): a few deals and the counts of the rest. */
function freeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  const whole = sceneSnapshot();
  return {
    ...whole,
    deals: whole.deals.slice(0, 3),
    gone: [],
    links: { community: "https://discord.gg/palace", push: null, accounts: false },
    locked: { deals: 42, risers: 7, fallers: 6, passes: 59, alerts: true, accounts: true },
    ...over,
  };
}

/** The gate's own server: /api/me, /api/teaser, /auth/*, each as given. */
function gateServer(answers: Record<string, () => Response>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const answer = answers[url];
    return answer ? answer() : new Response(null, { status: 404 });
  });
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

describe("open with perks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.getElementById("me")?.remove();
  });

  it("gives a visitor the free site at once, with Continue with Discord and the way to every deal", async () => {
    const gate = gateServer({});
    const { advance } = renderApp({ snap: freeSnapshot(), me: ANON, gateFetch: gate });
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    const go = screen.getByRole("link", { name: "Continue with Discord" });
    expect(go).toHaveAttribute("href", expect.stringMatching(/^\/auth\/discord\?next=/));
    expect(screen.getByRole("heading", { name: /more deals are hidden/ })).toBeInTheDocument();
    const unlock = screen.getAllByRole("link", { name: /Unlock it all free/ });
    expect(unlock.length).toBeGreaterThan(0);
    for (const link of unlock) expect(link).toHaveAttribute("href", expect.stringMatching(/^\/auth\/discord\?next=/));
    expect(screen.getAllByRole("link", { name: "What you get" })[0]).toHaveAttribute("href", "#join");
    // No filters, no follow stars, no alerts bell: those come with Discord.
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Alerts" })).not.toBeInTheDocument();
    await advance(5_000);
    expect(gate).not.toHaveBeenCalledWith("/api/me", expect.anything()); // nobody to name
  });

  it("says once, on the join page, that the site is free and what Discord adds", async () => {
    const gate = gateServer({ "/api/teaser": json({ deals: 42, sports: 4, best_pct: 38, generated_at: null }) });
    const { advance } = renderApp({ snap: freeSnapshot(), me: ANON, gateFetch: gate, hash: "join" });
    expect(screen.getByRole("heading", { level: 1, name: "Free. Join the Discord and it's basically a cheat code. Also free." })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "With Discord" })).toHaveTextContent(/Every live deal/);
    expect(screen.getByRole("list", { name: "Free for everyone" })).toHaveTextContent(/Today's best deals/);
    expect(screen.getByRole("link", { name: "Continue with Discord" })).toHaveAttribute("href", "/auth/discord?next=%2F");
    await advance(0);
    expect(screen.getByText("42 live deals right now across 4 sports · best 38% under")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Keep browsing/ })).toHaveAttribute("href", "#today");
  });

  it("offers someone signed in but out of the server the join again and Check again", async () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);
    let state = "out";
    const gate = gateServer({
      "/api/me": () => new Response(JSON.stringify({ gate: true, member: false, state: "out", name: "Deal Hunter" })),
      "/auth/recheck": () => new Response(JSON.stringify({ member: state === "in", state })),
    });
    const { advance } = renderApp({ snap: freeSnapshot(), me: OUT, gateFetch: gate });
    await advance(0);
    expect(screen.getAllByRole("link", { name: "Join the server" })[0]).toHaveAttribute(
      "href", expect.stringMatching(/^\/auth\/discord\?next=/));
    expect(screen.getByTitle("Signed in with Discord as Deal Hunter")).toBeInTheDocument();
    const deals = screen.getByRole("heading", { name: /more deals are hidden/ }).closest("section")!;
    fireEvent.click(within(deals).getByRole("button", { name: "I've joined: check again" }));
    await advance(0);
    expect(within(deals).getByText("Not in the server yet.")).toHaveAttribute("role", "status");
    expect(reload).not.toHaveBeenCalled();
    state = "in"; // they joined by the invite
    fireEvent.click(within(deals).getByRole("button", { name: "I've joined: check again" }));
    await advance(0);
    expect(reload).toHaveBeenCalled(); // a member's page, from the start
  });

  it("never sends an account the server refused round the join again", async () => {
    const gate = gateServer({
      "/api/me": json({ gate: true, member: false, state: "banned", name: "Deal Hunter" }),
    });
    const { advance } = renderApp({ snap: freeSnapshot(), me: BANNED, gateFetch: gate });
    await advance(0);
    expect(screen.getByText(/Discord won't let this account join the OTD Palace server/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Discord|Join the server/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check again/ })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument(); // the free site stays
  });

  it("asks who this is and the market again when a member route turns the visitor down", async () => {
    let me = { gate: true, member: true, state: "in", name: "Deal Hunter" };
    const gate = gateServer({ "/api/me": () => new Response(JSON.stringify(me)) });
    const { fetchImpl, advance } = renderApp({ me: MEMBER, gateFetch: gate });
    await advance(0);
    expect(screen.queryByRole("link", { name: "Continue with Discord" })).not.toBeInTheDocument();
    const asked = gate.mock.calls.length;
    const polled = fetchImpl.mock.calls.length;
    me = { gate: true, member: false, state: "out", name: "Deal Hunter" };
    act(() => noteDiscordRequired());
    await advance(0);
    expect(gate.mock.calls.length).toBeGreaterThan(asked);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(polled);
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument(); // never a wall
    expect(screen.getByRole("link", { name: "Join the server" })).toBeInTheDocument();
  });

  it("shows a member their Discord name and lets them sign out", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);
    const gate = gateServer({
      "/api/me": json({ gate: true, member: true, state: "in", name: "Deal Hunter" }),
      "/auth/logout": () => new Response(null, { status: 204 }),
    });
    const { advance } = renderApp({ me: MEMBER, gateFetch: gate });
    await advance(0);
    expect(screen.getByTitle("Signed in with Discord as Deal Hunter")).toHaveTextContent("Signed in with Discord as Deal Hunter");
    expect(screen.queryByRole("link", { name: /Unlock it all free/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await advance(0);
    expect(gate).toHaveBeenCalledWith("/auth/logout", expect.objectContaining({ method: "POST" }));
    expect(assign).toHaveBeenCalledWith("/");
  });

  it("stays signed in and says so when signing out did not work", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);
    const gate = gateServer({
      "/api/me": json({ gate: true, member: true, state: "in", name: "Deal Hunter" }),
      "/auth/logout": () => new Response(null, { status: 429 }),
    });
    const { advance } = renderApp({ me: MEMBER, gateFetch: gate });
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await advance(0);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn't sign out. Try again.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it("leaves the site as it always was without a mark", async () => {
    const gate = gateServer({});
    const { advance } = renderApp({ gateFetch: gate });
    await advance(5_000);
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Discord/ })).not.toBeInTheDocument();
    expect(gate).not.toHaveBeenCalled();
  });
});
