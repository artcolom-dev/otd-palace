import { beforeEach, describe, expect, it, vi } from "vitest";

// Two tabs of the site: two copies of the module over the same storage, as two pages of one origin are.
type Local = typeof import("./local");
async function tab(): Promise<Local> {
  vi.resetModules();
  return import("./local");
}

/** What the browser tells every other tab after a write. */
function tellOthers(key: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
}

describe("local: two tabs of the site at once", () => {
  beforeEach(() => localStorage.clear());

  it("a write in one tab never erases what the other tab saved (an imported account is not lost)", async () => {
    const a = await tab();
    const b = await tab();
    a.local.get(); // both tabs loaded with an empty device
    b.local.get();
    // Tab B imports an account: 3 passes and their valuations.
    b.local.addPasses([
      { key: "nba:2026:player:1", tier: "epic" },
      { key: "nba:2026:player:2", tier: "rare" },
      { key: "nba:2026:player:3", tier: "rare" },
    ]);
    // Tab A, never told (no event yet), follows a player.
    a.local.toggleFollow("nba:9");
    // Neither change is lost: storage and both tabs have both.
    const fresh = await tab();
    expect(fresh.local.get().passes.map((p) => p.key)).toEqual(["nba:2026:player:1", "nba:2026:player:2", "nba:2026:player:3"]);
    expect(fresh.local.get().follows).toEqual(["nba:9"]);
    expect(a.local.get().passes).toHaveLength(3);
  });

  it("a tab picks up the other tab's changes when the browser says storage changed, and re-renders", async () => {
    const a = await tab();
    const b = await tab();
    a.local.get();
    const seen = vi.fn();
    a.local.subscribe(seen);
    b.local.addPass({ key: "nfl:2025:player:7", tier: "legendary" });
    tellOthers("advisor.local.v1");
    expect(a.local.get().passes.map((p) => p.key)).toEqual(["nfl:2025:player:7"]);
    expect(seen).toHaveBeenCalled();
  });

  it("listens to the valuations' own key too, and to a cleared storage, and ignores other keys", async () => {
    const a = await tab();
    a.local.addPass({ key: "nba:2026:player:1", tier: "epic" });
    const seen = vi.fn();
    a.local.subscribe(seen);
    tellOthers("someone.else");
    expect(seen).not.toHaveBeenCalled();
    tellOthers("advisor.held.v1");
    expect(seen).toHaveBeenCalledTimes(1);
    localStorage.clear();
    tellOthers(null);
    expect(a.local.get().passes).toEqual([]);
  });
});
