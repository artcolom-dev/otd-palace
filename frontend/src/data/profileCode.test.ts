import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { passSnapshot } from "../test/passScene";
import { DEVICE_PASSES, local } from "./local";
import { applyProfile, decodeProfile, encodeProfile, isEmptyProfile, mergeProfile } from "./profileCode";

const fresh = () => {
  localStorage.clear();
  local.reload();
};

/** A valuation from an analysed account for a pass this site does not list. */
const theirs = (key: string, over: Record<string, unknown> = {}) => ({
  ...passSnapshot().otd.markets[0]!, key, season: 2019, player_id: Number(key.split(":")[3]), player_name: "Lone Wolf", ...over,
});

/** The bytes after the prefix of an uncompressed (MP1) code, as text. */
const mp1Text = (code: string) => {
  const b64 = code.slice(4).replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
};

// Codes made by the site before the valuations were carried and before codes were compressed: they must always restore.
const OLD_MP1 =
  "MP1.eyJ2IjoxLCJmb2xsb3dzIjpbIm5iYTo1IiwibmZsOjkiXSwicGFzc2VzIjpbeyJrZXkiOiJuYmE6MjAyNjpwbGF5ZXI6NSIsInRpZXIiOiJyYXJlIn0seyJrZXkiOiJ1ZmM6MjAyMzpmaWdodGVyOjQyIiwicmF0aW5nIjo2MS41LCJzcGVudCI6dHJ1ZX1dLCJvcGVuZWQiOltdLCJnb3QiOls3XSwic2F2ZWQiOjEyMCwiYmFsYW5jZSI6NTAwMCwiZGFpbHlSYXgiOm51bGx9";

describe("profile code", () => {
  beforeEach(fresh);
  afterEach(() => vi.unstubAllGlobals());

  it("an old code (MP1, no valuations) still restores, field for field", async () => {
    const back = await decodeProfile(OLD_MP1);
    expect(back?.follows).toEqual(["nba:5", "nfl:9"]);
    expect(back?.passes).toEqual([
      { key: "nba:2026:player:5", tier: "rare" },
      { key: "ufc:2023:fighter:42", rating: 61.5, spent: true },
    ]);
    expect(back?.got).toEqual([7]);
    expect(back?.saved).toBe(120);
    expect(back?.balance).toBe(5000);
    expect(back?.heldMarkets).toEqual([]);
    expect(await applyProfile(OLD_MP1)).toEqual({ ok: true, follows: 2, passes: 2, dropped: 0 });
  });

  it("carries a big account's every pass and its valuations, compressed far below the old code", async () => {
    const keys = Array.from({ length: 2149 }, (_, i) => `nba:2019:player:${10_000 + i}`);
    local.addPasses(keys.map((key) => ({ key, rating: 120 })));
    local.keepMarkets(keys.map((key) => theirs(key)));
    const before = local.get();
    const code = await encodeProfile(before);
    expect(code.startsWith("MP2.")).toBe(true);
    const uncompressed = (await encodeProfile(before, { compress: false })).length;
    expect(code.length).toBeLessThan(uncompressed / 4);
    fresh();
    expect(await applyProfile(code)).toEqual({ ok: true, follows: 0, passes: 2149, dropped: 0 });
    expect(local.get().passes).toHaveLength(2149);
    expect(local.get().heldMarkets).toHaveLength(2149); // the valuations came too: the total is the same over there
    expect(local.get().heldMarkets).toEqual(before.heldMarkets);
  });

  it("without compression in the browser, falls back to a plain code that still carries the valuations", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    local.addPass({ key: "nba:2019:player:777", tier: "rare" });
    local.keepMarkets([theirs("nba:2019:player:777")]);
    const code = await encodeProfile(local.get());
    expect(code.startsWith("MP1.")).toBe(true);
    expect((await decodeProfile(code))?.heldMarkets.map((m) => m.key)).toEqual(["nba:2019:player:777"]);
  });

  it("a plain code of a full device (5,000 passes, every valuation) is still short enough to read back", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const keys = Array.from({ length: DEVICE_PASSES }, (_, i) => `nba:2019:player:${10_000 + i}`);
    local.addPasses(keys.map((key) => ({ key, rating: 120 })));
    local.keepMarkets(keys.map((key) => theirs(key)));
    const code = await encodeProfile(local.get());
    expect(code.startsWith("MP1.")).toBe(true);
    expect((await decodeProfile(code))?.heldMarkets).toHaveLength(DEVICE_PASSES);
  });

  it("a packed code on a browser that cannot unpack says so, instead of 'not a code'", async () => {
    local.addPass({ key: "nba:2026:player:5", tier: "rare" });
    const code = await encodeProfile(local.get());
    expect(code.startsWith("MP2.")).toBe(true);
    vi.stubGlobal("DecompressionStream", undefined);
    expect(await applyProfile(code)).toEqual({ ok: false, reason: "unsupported" });
    expect(await applyProfile("hello")).toEqual({ ok: false, reason: "invalid" });
  });

  it("round-trips what is worth carrying to another device, and leaves out what belongs to this one", async () => {
    local.toggleFollow("nba:1627");
    local.addPass({ key: "nba:2026:player:1627", tier: "epic" });
    local.addPass({ key: "ufc:2023:fighter:42", rating: 61.5, spent: true });
    local.setAlerts({ on: true, deals: true });
    local.dismissInstall();
    const plain = await encodeProfile(local.get(), { compress: false });
    expect(mp1Text(plain)).not.toMatch(/alerts|subscription|endpoint|routine|installDismissed/); // none of this device's own
    for (const code of [plain, await encodeProfile(local.get())]) {
      const back = await decodeProfile(code);
      expect(back?.follows).toEqual(["nba:1627"]);
      expect(back?.passes.map((p) => p.key)).toEqual(["nba:2026:player:1627", "ufc:2023:fighter:42"]);
      expect(back?.alerts.on).toBe(false);
      expect(await decodeProfile(`  ${code}\n`)).not.toBeNull(); // pasted with spaces and a newline
    }
  });

  it("refuses anything that is not a profile code, and never throws", async () => {
    const bad = ["", "hello", "MP1.", "MP1.%%%", "MP2.", "MP2.e30", "MP2.%%%", "MP9.e30", `MP1.${btoa("not json")}`, "MP1." + btoa('{"v":1,"passes":"x"}')];
    for (const text of bad) {
      const got = await decodeProfile(text);
      expect(got === null || (Array.isArray(got.passes) && got.passes.length === 0), text).toBe(true);
    }
    expect(await decodeProfile("MP1." + "A".repeat(2_000_000))).toBeNull(); // too long to be one
    expect(await decodeProfile("MP2." + "A".repeat(2_000_000))).toBeNull();
  });

  it("merges into what this device already has: unions, the imported pass wins, nothing is lost", async () => {
    local.toggleFollow("nba:1");
    local.addPass({ key: "nba:2026:player:1", tier: "rare" });
    const incoming = (await decodeProfile(
      await encodeProfile({ ...local.get(), follows: ["nfl:9"], passes: [{ key: "nba:2026:player:1", tier: "epic" }, { key: "nfl:2025:player:9", tier: "rare" }] }),
    ))!;
    const merged = mergeProfile(local.get(), incoming);
    expect(merged.follows.sort()).toEqual(["nba:1", "nfl:9"]);
    expect(merged.passes.find((p) => p.key === "nba:2026:player:1")?.tier).toBe("epic");
    expect(merged.passes).toHaveLength(2);
    expect(merged.alerts).toEqual(local.get().alerts); // this device's alerts stay as they are
  });

  it("merges the valuations: the imported one wins, this device's own stay, none for a pass not kept", () => {
    local.addPasses([{ key: "nba:2019:player:1", tier: "rare" }, { key: "nba:2019:player:2", tier: "rare" }]);
    local.keepMarkets([theirs("nba:2019:player:1", { base_1x: 1 }), theirs("nba:2019:player:2", { base_1x: 2 })]);
    const here = local.get();
    const incoming = { ...here, passes: [{ key: "nba:2019:player:2", tier: "epic" }], heldMarkets: [{ ...here.heldMarkets[1]!, base_1x: 22 }] };
    const merged = mergeProfile(here, incoming);
    expect(merged.heldMarkets.map((m) => [m.key, m.base_1x])).toEqual([["nba:2019:player:1", 1], ["nba:2019:player:2", 22]]);
  });

  it("a full device keeps every incoming pass, drops its own oldest, and says how many", async () => {
    local.addPasses(Array.from({ length: DEVICE_PASSES }, (_, i) => ({ key: `nba:2019:player:${i}`, tier: "rare" })));
    const code = await encodeProfile({
      ...local.get(),
      passes: Array.from({ length: 30 }, (_, i) => ({ key: `nfl:2025:player:${i}`, tier: "epic" })),
      heldMarkets: [],
    });
    expect(await applyProfile(code)).toEqual({ ok: true, follows: 0, passes: 30, dropped: 30 });
    const passes = local.get().passes;
    expect(passes).toHaveLength(DEVICE_PASSES);
    expect(passes.filter((p) => p.key.startsWith("nfl:"))).toHaveLength(30); // every incoming pass is there
    expect(passes.some((p) => p.key === "nba:2019:player:0")).toBe(false); // the oldest of this device's went
    expect(passes.some((p) => p.key === `nba:2019:player:${DEVICE_PASSES - 1}`)).toBe(true);
  });

  it("applying it saves it on this device, and says what came in", async () => {
    const code = await encodeProfile({ ...local.get(), follows: ["nba:5"], passes: [{ key: "nba:2026:player:5", tier: "rare" }] });
    fresh();
    expect(await applyProfile(code)).toEqual({ ok: true, follows: 1, passes: 1, dropped: 0 });
    expect(local.get().follows).toEqual(["nba:5"]);
    expect(local.get().passes).toHaveLength(1);
    expect(await applyProfile("nope")).toEqual({ ok: false, reason: "invalid" });
  });

  it("applying builds on what another tab saved meanwhile", async () => {
    const code = await encodeProfile({ ...local.get(), follows: ["nba:5"] });
    // Another tab adds a pass straight into storage; this tab has not been told.
    localStorage.setItem("advisor.local.v1", JSON.stringify({ passes: [{ key: "nba:2026:player:8", tier: "rare" }] }));
    await applyProfile(code);
    expect(local.get().passes.map((p) => p.key)).toEqual(["nba:2026:player:8"]);
    expect(local.get().follows).toEqual(["nba:5"]);
  });

  it("knows an empty profile: nothing in it worth a code", () => {
    expect(isEmptyProfile(local.get())).toBe(true);
    local.setAlerts({ on: true }); // this device's own: not carried
    expect(isEmptyProfile(local.get())).toBe(true);
    local.toggleFollow("nba:1");
    expect(isEmptyProfile(local.get())).toBe(false);
  });
});
