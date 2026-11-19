import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchMe,
  fetchTeaser,
  loginHref,
  noteDiscordRequired,
  onDiscordRequired,
  readInlinedMe,
  recheck,
  signOut,
  teaserAge,
  teaserLine,
} from "./gate";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mark(text: string | null) {
  document.getElementById("me")?.remove();
  if (text === null) return;
  const el = document.createElement("script");
  el.id = "me";
  el.type = "application/json";
  el.textContent = text;
  document.body.append(el);
}

describe("the gate's mark in the page", () => {
  afterEach(() => mark(null));

  it("is read when the server put one, with the visitor's state", () => {
    mark('{"gate":true,"member":false,"state":"anon"}');
    expect(readInlinedMe()).toEqual({ gate: true, member: false, state: "anon", name: null });
    mark('{"gate":true,"member":true,"state":"in"}');
    expect(readInlinedMe()).toEqual({ gate: true, member: true, state: "in", name: null });
    mark('{"gate":true,"member":false,"state":"out"}');
    expect(readInlinedMe()?.state).toBe("out");
    mark('{"gate":true,"member":false,"state":"banned"}');
    expect(readInlinedMe()?.state).toBe("banned");
  });

  it("never takes a state for more than the server's member says, and reads an older mark without one", () => {
    mark('{"gate":true,"member":false,"state":"in"}');
    expect(readInlinedMe()?.state).toBe("anon");
    mark('{"gate":true,"member":false,"state":"admin"}');
    expect(readInlinedMe()?.state).toBe("anon");
    mark('{"gate":true,"member":true}');
    expect(readInlinedMe()?.state).toBe("in");
  });

  it("is none without one, or with one that cannot be read", () => {
    expect(readInlinedMe()).toBeNull();
    for (const text of ["", "nope", "[]", '{"gate":"yes"}', '{"member":true}']) {
      mark(text);
      expect(readInlinedMe()).toBeNull();
    }
  });
});

describe("the way in", () => {
  it("comes back to the page the visitor is on, hash and all", () => {
    expect(loginHref({ pathname: "/", search: "", hash: "#deals" })).toBe("/auth/discord?next=%2F%23deals");
    expect(loginHref({ pathname: "/", search: "?open=104", hash: "" })).toBe("/auth/discord?next=%2F%3Fopen%3D104");
    expect(loginHref({ pathname: "/", search: "", hash: "" })).toBe("/auth/discord?next=%2F");
  });
});

describe("the teaser", () => {
  it("says the counts in one line", () => {
    expect(teaserLine({ deals: 143, sports: 8, best_pct: 38, generated_at: null })).toBe(
      "143 live deals right now across 8 sports · best 38% under",
    );
    expect(teaserLine({ deals: 1, sports: 1, best_pct: null, generated_at: null })).toBe(
      "1 live deal right now in 1 sport",
    );
    expect(teaserLine({ deals: 2_431, sports: 3, best_pct: 41, generated_at: null })).toBe(
      "2,431 live deals right now across 3 sports · best 41% under",
    );
  });

  it("says nothing with no deal to count", () => {
    expect(teaserLine({ deals: 0, sports: 0, best_pct: null, generated_at: null })).toBeNull();
  });

  it("says how fresh the data is", () => {
    const now = Date.parse("2026-11-16T12:00:30Z");
    expect(teaserAge("2026-11-16T12:00:18Z", now)).toBe("Checked 12 s ago");
    expect(teaserAge("2026-11-16T11:57:30Z", now)).toBe("Checked 3 min ago");
    expect(teaserAge("2026-11-16T12:00:40Z", now)).toBe("Checked just now"); // a clock a little ahead
    expect(teaserAge(null, now)).toBeNull();
    expect(teaserAge("garbage", now)).toBeNull();
    expect(teaserAge("2026-11-15T12:00:00Z", now)).toBeNull(); // too old to brag about
  });

  it("is read defensively", async () => {
    const good = vi.fn<typeof fetch>(async () => json({ deals: 5, sports: 2, best_pct: 30, generated_at: "x" }));
    expect(await fetchTeaser(good)).toEqual({ deals: 5, sports: 2, best_pct: 30, generated_at: "x" });
    expect(good).toHaveBeenCalledWith("/api/teaser", expect.anything());
    const odd = vi.fn<typeof fetch>(async () => json({ deals: "lots", sports: -1, best_pct: 900 }));
    expect(await fetchTeaser(odd)).toBeNull();
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError("offline");
    });
    expect(await fetchTeaser(down)).toBeNull();
    expect(await fetchTeaser(vi.fn<typeof fetch>(async () => json({}, 503)))).toBeNull();
  });
});

describe("who is asking", () => {
  it("reads /api/me, never from a cache", async () => {
    const f = vi.fn<typeof fetch>(async () => json({ gate: true, member: true, state: "in", name: "Deal Hunter" }));
    expect(await fetchMe(f)).toEqual({ gate: true, member: true, state: "in", name: "Deal Hunter" });
    expect(f.mock.calls[0]![0]).toBe("/api/me");
    expect(f.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
  });

  it("keeps a name to 32 characters and drops one that is not text", async () => {
    const long = vi.fn<typeof fetch>(async () => json({ gate: true, member: true, name: "N".repeat(50) }));
    expect((await fetchMe(long))?.name).toBe("N".repeat(32));
    const odd = vi.fn<typeof fetch>(async () => json({ gate: true, member: true, name: 5 }));
    expect((await fetchMe(odd))?.name).toBeNull();
  });

  it("is unknown when the server cannot say", async () => {
    expect(await fetchMe(vi.fn<typeof fetch>(async () => json({}, 500)))).toBeNull();
    expect(
      await fetchMe(
        vi.fn<typeof fetch>(async () => {
          throw new TypeError("offline");
        }),
      ),
    ).toBeNull();
  });

  it("signs out with a POST", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    expect(await signOut(f)).toBe(true);
    expect(f).toHaveBeenCalledWith("/auth/logout", expect.objectContaining({ method: "POST" }));
  });
});

describe("a member who left the server", () => {
  it("is told to every listener, which can stop listening", () => {
    const a = vi.fn();
    const b = vi.fn();
    const stopA = onDiscordRequired(a);
    const stopB = onDiscordRequired(b);
    noteDiscordRequired();
    stopA();
    noteDiscordRequired();
    stopB();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});

describe("check again", () => {
  it("posts to /auth/recheck and reads the state it answers", async () => {
    const f = vi.fn<typeof fetch>(async () => json({ member: true, state: "in" }));
    expect(await recheck(f)).toBe("in");
    expect(f.mock.calls[0]![0]).toBe("/auth/recheck");
    expect(f.mock.calls[0]![1]).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
  });

  it("is null when the server did not answer, or with an answer it cannot read", async () => {
    expect(await recheck(vi.fn<typeof fetch>(async () => new Response("", { status: 429 })))).toBeNull();
    expect(await recheck(vi.fn<typeof fetch>(async () => json({ state: "admin" })))).toBeNull();
    expect(await recheck(vi.fn<typeof fetch>(async () => Promise.reject(new Error("down"))))).toBeNull();
  });
});
