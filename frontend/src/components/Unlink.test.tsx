import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppState } from "../AppContext";
import { local } from "../data/local";
import { memberLinkStore } from "../lib/link";
import { sceneSnapshot } from "../test/scene";
import { AccountCard, LinkSync } from "./AccountLookup";
import { type Member, MemberContext } from "./MemberLine";
import { OverlayProvider } from "./Overlay";
import { AccountAnalysis } from "./passes/AccountAnalysis";

const snap = sceneSnapshot();
const st = { snap: { ...snap, links: { ...snap.links, accounts: true } }, layout: { phone: false }, now: Date.now(), prefs: { level: "mid", budget: 1000, passBudget: 1000 } } as unknown as AppState;
const PASS = { key: "nba:2025:player:1001", rating: 12 };
const perks = (linked: boolean) => ({ linked, roles: [], lounge: false, big_accounts: false, pings: true, dm_closed: false });
const LINK = { username: "Shaedon", linked_at: 1, refreshed_at: 1, passes: 1, year: null, pings: true, dm_closed: false };
const answer = (waiting = 0) => ({ status: "ok", username: "Shaedon", passes: [PASS], truncated: false, markets: [], waiting, seasons_waiting: waiting ? 2 : 0, link: LINK, perks: perks(true) });
const tree = (member: Member | null, extra: React.ReactNode = null) => (
  <AppContext.Provider value={st}>
    <MemberContext.Provider value={member}>
      <OverlayProvider phone={false}>
        <LinkSync />
        <AccountCard />
        {extra}
      </OverlayProvider>
    </MemberContext.Provider>
  </AppContext.Provider>
);

beforeEach(() => {
  localStorage.clear();
  document.getElementById("me")?.remove();
  local.reload();
  memberLinkStore.set(null);
});
afterEach(() => vi.useRealTimers());

describe("Unlink: it stays undone", () => {
  it("a Refresh sheet that is still reading seasons does not link the account back at its next poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const methods: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_u, init) => {
      const m = init?.method ?? "GET";
      methods.push(m);
      if (m === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify(answer(5)), { status: 200 });
    });
    render(tree({ name: "M", fetchImpl }, <AccountAnalysis username="Shaedon" ctx={{ titleId: "t" } as never} link />));
    await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    expect(local.get().link?.username).toBe("Shaedon");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Unlink" })));
    await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
    expect(local.get().link).toBeNull();
    const posts = methods.filter((m) => m === "POST").length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(40_000)));
    expect(local.get().link).toBeNull();
    expect(methods.filter((m) => m === "POST").length).toBe(posts);
  });

  it("an unlink in another tab stops a sheet that was linking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(answer(5)), { status: 200 }));
    render(tree({ name: "M", fetchImpl }, <AccountAnalysis username="Shaedon" ctx={{ titleId: "t" } as never} link />));
    await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    expect(local.get().link?.username).toBe("Shaedon");
    localStorage.clear(); // the other tab's unlink reaches this one's storage
    await act(async () => void local.reload());
    expect(local.get().link).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(40_000)));
    expect(local.get().link).toBeNull();
  });

  it("a read of the account that was in flight when Unlink was pressed does not link it back", async () => {
    let release: (r: Response) => void = () => {};
    const methods: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((_u, init) => {
      const m = init?.method ?? "GET";
      methods.push(m);
      if (m === "POST") return new Promise<Response>((res) => (release = res));
      if (m === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response(JSON.stringify({ link: LINK, perks: perks(true), unlinked_at: null }), { status: 200 }));
    });
    render(tree({ name: "M", fetchImpl }));
    await vi.waitFor(() => expect(methods).toContain("POST")); // LinkSync is reading the account from the server's link
    local.unlink();
    await act(async () => void release(new Response(JSON.stringify(answer()), { status: 200 })));
    await vi.waitFor(() => expect(methods.filter((m) => m === "DELETE")).toHaveLength(1)); // the server's copy is forgotten again
    expect(local.get().link).toBeNull();
  });

  it("a member the page could not name (/api/me failed) still has the server forget the link", async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const me = document.createElement("script");
      me.id = "me";
      me.type = "application/json";
      me.textContent = JSON.stringify({ gate: true, member: true });
      document.body.appendChild(me);
      local.link("Shaedon", [PASS], [], new Set());
      render(tree(null));
      await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Unlink" })));
      expect(calls).toEqual(["DELETE"]);
      expect(local.get().link).toBeNull();
    } finally {
      globalThis.fetch = real;
    }
  });

  it("a phone clock ahead of the server's does not keep a link the member unlinked later", async () => {
    const serverNow = Date.now();
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_u, init) => {
      calls.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ link: null, perks: perks(false), unlinked_at: serverNow / 1000, now: (serverNow - 120_000) / 1000 }), { status: 200 });
    });
    // the device's clock is 2 minutes ahead: it linked 1 minute before the unlink by the server's clock
    local.link("Shaedon", [PASS], [], new Set(), serverNow - 60_000 + 120_000);
    render(tree({ name: "M", fetchImpl }));
    await vi.waitFor(() => expect(local.get().link).toBeNull());
    expect(calls.every((m) => m === "GET")).toBe(true);
  });
});

describe("Unlink: what the member sees", () => {
  const press = async (status: number | "timeout") => {
    const fetchImpl = vi.fn<typeof fetch>((_u, init) => {
      if ((init?.method ?? "GET") !== "DELETE") return Promise.resolve(new Response(JSON.stringify({ link: LINK, perks: perks(true), unlinked_at: null }), { status: 200 }));
      if (status === "timeout") return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      return Promise.resolve(new Response(null, { status }));
    });
    local.link("Shaedon", [PASS], [], new Set());
    render(tree({ name: "M", fetchImpl }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Unlink" })));
    if (status === "timeout") await act(async () => void (await vi.advanceTimersByTimeAsync(16_000)));
  };

  it.each([
    [401, /sign-in ran out/],
    [403, /blocked/],
    [429, /too many/i],
    [500, /server had a problem/],
    ["timeout", /no answer/],
  ] as const)("a %s answer says why, in the chip, and the button offers Try again", async (status, words) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await press(status);
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent(words);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(local.get().link?.username).toBe("Shaedon");
  });

  it("a 204 says Unlinked and the link is gone", async () => {
    await press(204);
    expect(screen.getByText(/Unlinked\./)).toBeInTheDocument();
    expect(local.get().link).toBeNull();
  });
});
