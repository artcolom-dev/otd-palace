import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppState } from "../AppContext";
import { local } from "../data/local";
import { memberLinkStore } from "../lib/link";
import { JOKIC, MURRAY, SGA, passSnapshot } from "../test/passScene";
import { type Member, MemberContext } from "./MemberLine";
import { YearReporter } from "./YearReporter";

const PERKS = { linked: true, roles: ["Linked"], lounge: true, big_accounts: false, pings: true, dm_closed: false };
const held = (year: number | null) => ({
  link: { username: "Shaedon", linked_at: 1, refreshed_at: 1, passes: 2, year, pings: true, dm_closed: false },
  perks: PERKS,
  unlinked_at: null,
});

describe("YearReporter", () => {
  let sent: unknown[];
  let member: Member;
  const show = () => {
    const snap = passSnapshot();
    return render(
      <AppContext.Provider value={{ snap, layout: { phone: false }, now: Date.now() } as unknown as AppState}>
        <MemberContext.Provider value={member}>
          <YearReporter />
        </MemberContext.Provider>
      </AppContext.Provider>,
    );
  };
  const link = () => local.link("Shaedon", [{ key: JOKIC.key, tier: "common" }, { key: MURRAY.key, tier: "common" }], [], new Set(), Date.now());
  const byHand = { key: SGA.key, tier: "common" };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    local.reload();
    memberLinkStore.set(null);
    sent = [];
    member = {
      name: "Shaedon",
      fetchImpl: vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { year: number };
        sent.push(body);
        return new Response(JSON.stringify(held(body.year)), { status: 200 });
      }) as unknown as typeof fetch,
    };
  });
  afterEach(() => vi.useRealTimers());

  it("sends the planner's yearly figure once, after a pause, when the server holds none yet", async () => {
    link();
    memberLinkStore.set(held(null));
    show();
    expect(sent).toEqual([]); // not at once: the figure settles first
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(sent).toHaveLength(1);
    const body = sent[0] as { year: number };
    expect(Number.isInteger(body.year) && body.year > 0).toBe(true);
    expect(Object.keys(body)).toEqual(["year"]); // the figure alone: nothing else of the visitor goes with it
  });

  it("stays quiet when the server holds a figure within 5 % of it", async () => {
    link();
    memberLinkStore.set(held(null));
    const { unmount } = show();
    await act(async () => void vi.advanceTimersByTime(3000));
    const year = (sent[0] as { year: number }).year;
    unmount();
    sent = [];
    memberLinkStore.set(held(Math.round(year * 1.03)));
    show();
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(sent).toEqual([]);
    act(() => memberLinkStore.set(held(Math.round(year * 1.2))));
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(sent).toHaveLength(1);
  });

  it("says nothing for a visitor who is not a member, has linked nothing, or whose link the server does not keep", async () => {
    link();
    memberLinkStore.set(held(null));
    const { unmount } = render(
      <AppContext.Provider value={{ snap: passSnapshot(), layout: { phone: false }, now: 1 } as unknown as AppState}>
        <MemberContext.Provider value={null}>
          <YearReporter />
        </MemberContext.Provider>
      </AppContext.Provider>,
    );
    await act(async () => void vi.advanceTimersByTime(5000));
    unmount();
    memberLinkStore.set({ link: null, perks: { ...PERKS, linked: false }, unlinked_at: null });
    show();
    await act(async () => void vi.advanceTimersByTime(5000));
    local.unlink();
    memberLinkStore.set(held(null));
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(sent).toEqual([]);
  });

  it("counts the linked account's passes only: one added by hand on this device does not move the figure", async () => {
    link();
    memberLinkStore.set(held(null));
    const { unmount } = show();
    await act(async () => void vi.advanceTimersByTime(3000));
    const year = (sent[0] as { year: number }).year;
    unmount();
    sent = [];
    local.addPass(byHand);
    memberLinkStore.set(held(year));
    show();
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(sent).toEqual([]);
  });
});
