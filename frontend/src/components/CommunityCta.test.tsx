import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AppContext, type AppState } from "../AppContext";
import { memberLinkStore } from "../lib/link";
import { sceneSnapshot } from "../test/scene";
import { CommunityCta } from "./CommunityCta";
import { MemberContext } from "./MemberLine";

const state = () => {
  const snap = sceneSnapshot();
  return { snap: { ...snap, links: { ...snap.links, community: "https://discord.gg/x" } }, prefs: { level: "new", sport: "all" } } as unknown as AppState;
};
const member = { name: "Ana", fetchImpl: (() => Promise.reject(new Error("no"))) as unknown as typeof fetch };
const perks = (pings: boolean) => ({
  link: null,
  unlinked_at: null,
  perks: { linked: false, roles: [], lounge: false, big_accounts: false, pings, dm_closed: false },
});
const linked = (pings: boolean) => ({
  link: { username: "ana", year: 1000, passes: 3, linked_at: 1, refreshed_at: 1, pings, dm_closed: false },
  unlinked_at: null,
  perks: { linked: true, roles: ["Linked"], lounge: true, big_accounts: false, pings, dm_closed: false },
});
const show = (m: typeof member | null, where?: "invite" | "member") =>
  render(
    <AppContext.Provider value={state()}>
      <MemberContext.Provider value={m}>
        <CommunityCta show={where} />
      </MemberContext.Provider>
    </AppContext.Provider>,
  );

describe("the Discord call to join", () => {
  beforeEach(() => memberLinkStore.set(null));

  it("asks a visitor with no Discord session to get deals pinged there", () => {
    show(null);
    expect(screen.getByRole("link", { name: /Every deal, your own plan, deals pinged/ })).toHaveAttribute("href", "https://discord.gg/x");
  });

  it("names the way in plainly: Join our Discord", () => {
    show(null);
    expect(screen.getByRole("link", { name: /Join the Discord/ })).toBeInTheDocument();
  });

  it("the early invite (after the top deals) is for visitors only; the foot keeps the member's switch", () => {
    memberLinkStore.set(linked(true));
    const early = show(member, "invite");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    early.unmount();
    show(null, "member");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("does not ask a member who is already in the server: a switch says whether their pings are on", () => {
    memberLinkStore.set(linked(true));
    show(member);
    expect(screen.queryByText(/Every deal, your own plan/)).toBeNull();
    expect(screen.getByRole("switch", { name: "Deal pings" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Deal pings: on")).toBeInTheDocument();
  });

  it("says off when they are off, and nothing at all before the server has answered", () => {
    memberLinkStore.set(linked(false));
    const { unmount } = show(member);
    expect(screen.getByRole("switch", { name: "Deal pings" })).toHaveAttribute("aria-checked", "false");
    unmount();
    memberLinkStore.set(null);
    const { container } = show(member);
    expect(container).toBeEmptyDOMElement();
  });

  it("turns the pings off with one tap, and shows off", async () => {
    memberLinkStore.set(linked(true));
    const calls: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls.push(String(init.body));
      return new Response(JSON.stringify({ ...linked(false), perks: { ...linked(false).perks } }), { status: 200 });
    }) as unknown as typeof fetch;
    show({ name: "Ana", fetchImpl });
    fireEvent.click(screen.getByRole("switch", { name: "Deal pings" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0]!).pings).toBe(false);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Deal pings" })).toHaveAttribute("aria-checked", "false"));
  });

  it("sends a member who has not linked yet to the Passes page, with the switch not offered", () => {
    memberLinkStore.set(perks(false));
    show(member);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("link", { name: /Deal pings: off/ })).toHaveAttribute("href", "#passes");
  });
});
