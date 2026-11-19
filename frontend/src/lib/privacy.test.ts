import { afterEach, describe, expect, it, vi } from "vitest";
import { onDiscordRequired } from "./gate";
import { memberLinkStore } from "./link";
import { deleteMyData } from "./privacy";
import { VISIT_KEY, deviceId } from "./visit";

const answer = (status: number) => vi.fn<typeof fetch>(async () => new Response(null, { status }));

describe("deleteMyData", () => {
  afterEach(() => memberLinkStore.set(null));

  it("asks the server with a same-origin DELETE and forgets what the page knew of the link", async () => {
    memberLinkStore.set({
      link: null,
      perks: { linked: false, roles: [], lounge: false, big_accounts: false, pings: true, dm_closed: false },
      unlinked_at: null,
    });
    const fetchImpl = answer(204);
    expect(await deleteMyData(fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/me", expect.objectContaining({ method: "DELETE", credentials: "same-origin" }));
    expect(memberLinkStore.get()).toBeNull();
  });

  it("names this browser's visit id so the server drops its visits too, then forgets it", async () => {
    localStorage.clear();
    const id = deviceId();
    const fetchImpl = answer(204);
    expect(await deleteMyData(fetchImpl)).toBe(true);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ device: id });
    expect(localStorage.getItem(VISIT_KEY)).toBeNull(); // the next visit starts a new id
  });

  it("makes no visit id just to send it", async () => {
    localStorage.clear();
    const fetchImpl = answer(204);
    expect(await deleteMyData(fetchImpl)).toBe(true);
    expect(fetchImpl.mock.calls[0]![1]!.body).toBeUndefined();
    expect(localStorage.getItem(VISIT_KEY)).toBeNull();
  });

  it.each([403, 429, 500, 404])("says no when the server answered %i, and keeps the visit id", async (status) => {
    localStorage.clear();
    const id = deviceId();
    expect(await deleteMyData(answer(status))).toBe(false);
    expect(localStorage.getItem(VISIT_KEY)).toBe(id);
  });

  it("says no when the server did not answer at all", async () => {
    expect(await deleteMyData(vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("offline"))))).toBe(false);
  });

  it("tells the page to show the gate when the session is gone (401)", async () => {
    const heard = vi.fn();
    const stop = onDiscordRequired(heard);
    expect(await deleteMyData(answer(401))).toBe(false);
    stop();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
