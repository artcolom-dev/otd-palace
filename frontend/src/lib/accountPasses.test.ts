import { describe, expect, it, vi } from "vitest";
import { fetchPasses, importWords } from "./accountPasses";
import { onDiscordRequired } from "./gate";

const reply = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("fetchPasses", () => {
  it("asks the site's own server for the username, never caching", async () => {
    const f = reply(200, { status: "ok", username: "Shaedon", passes: [{ key: "nba:2026:player:1", rating: 5 }], truncated: false });
    const got = await fetchPasses("shae don", f);
    expect(f).toHaveBeenCalledWith("/api/passes/import?u=shae%20don", { cache: "no-store" });
    expect(got).toEqual({
      status: "ok", username: "Shaedon", passes: [{ key: "nba:2026:player:1", rating: 5 }], truncated: false,
      markets: [], waiting: 0, seasons_waiting: 0,
    });
  });

  it("takes the account's valued passes and how many still wait, and nothing it cannot use", async () => {
    const market = { key: "nba:2024:player:7", rungs: [] };
    const got = await fetchPasses("big", reply(200, {
      status: "ok", username: "Big", passes: [], truncated: false, waiting: 12, seasons_waiting: 3,
      markets: [market, { key: 5 }, null, { key: "x" }],
    }));
    expect(got.markets).toEqual([market]);
    expect([got.waiting, got.seasons_waiting]).toEqual([12, 3]);
    const odd = await fetchPasses("big", reply(200, { status: "ok", username: "Big", passes: [], waiting: -1, seasons_waiting: "2" }));
    expect([odd.waiting, odd.seasons_waiting, odd.markets]).toEqual([0, 0, []]);
  });

  it("tells the gate when the server wants a member of our Discord", async () => {
    const heard = vi.fn();
    const stop = onDiscordRequired(heard);
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: "discord_required" }), { status: 401 }));
    expect((await fetchPasses("someone", f)).status).toBe("signin"); // not "too many lookups": a sign-in is missing
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reads every failure as a status the visitor can understand", async () => {
    expect((await fetchPasses("x1", reply(404, { status: "not_found" }))).status).toBe("not_found");
    expect((await fetchPasses("x1", reply(422, { status: "private" }))).status).toBe("private");
    expect((await fetchPasses("x1", reply(429, {}))).status).toBe("busy");
    expect((await fetchPasses("x1", reply(503, { status: "busy" }))).status).toBe("busy");
    expect((await fetchPasses("x1", vi.fn<typeof fetch>(async () => { throw new Error("offline"); }))).status).toBe("offline");
    expect((await fetchPasses("x1", reply(500, {}))).status).toBe("busy");
  });
});

describe("importWords", () => {
  const ok = (n: number, truncated = false) => ({
    status: "ok" as const, username: "Shaedon", truncated, markets: [], waiting: 0, seasons_waiting: 0,
    passes: Array.from({ length: n }, (_, i) => ({ key: `nba:2026:player:${i}`, rating: 1 })),
  });
  it("says how many were added and how many the site does not cover yet", () => {
    expect(importWords(ok(23), "shaedon", 20)).toBe("Added 23 passes from Shaedon. 3 are not on this site yet.");
    expect(importWords(ok(1), "shaedon", 1)).toBe("Added 1 pass from Shaedon.");
    expect(importWords(ok(200), "shaedon", 200)).toBe("Added 200 passes from Shaedon.");
    expect(importWords(ok(2149), "shaedon", 2149)).toBe("Added 2,149 passes from Shaedon."); // a big account fits whole
    expect(importWords(ok(5200), "shaedon", 5000)).toBe("Added 5,200 passes from Shaedon. Only the first 5,000 fit on a device.");
  });
  it("names the account it could not use", () => {
    const none = { username: null, passes: [], truncated: false, markets: [], waiting: 0, seasons_waiting: 0 };
    expect(importWords({ ...none, status: "not_found" }, "@nobody", 0)).toBe("No Real account is named nobody.");
    expect(importWords({ ...none, status: "private" }, "closed", 0)).toBe("closed has no passes anyone can see.");
    expect(importWords({ ...none, status: "busy" }, "x", 0)).toBe("Too many lookups right now. Try again in a few minutes.");
    expect(importWords({ ...none, status: "signin" }, "x", 0)).toBe("Looking up a Real account is for members of the OTD Palace Discord. It's free.");
    expect(importWords({ ...none, status: "offline" }, "x", 0)).toBe("Couldn't reach OTD Palace. Check your connection and try again.");
  });
});

describe("accountFromHash / accountHash", () => {
  it("reads a Real username from #account/<name>, and nothing else", async () => {
    const { accountFromHash, accountHash } = await import("./accountPasses");
    expect(accountFromHash("#account/shaedon")).toBe("shaedon");
    expect(accountFromHash("#account/Some.User_1")).toBe("Some.User_1");
    expect(accountFromHash("#account/%40shaedon")).toBe("shaedon");
    for (const bad of ["", "#account", "#account/", "#account/a", "#account/two words", "#deals", "#account/" + "x".repeat(40), "#%"]) {
      expect(accountFromHash(bad), bad).toBeNull();
    }
    expect(accountHash("shaedon")).toBe("#account/shaedon");
  });
});
