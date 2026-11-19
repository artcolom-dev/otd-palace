import { describe, expect, it, vi } from "vitest";
import type { HeldPass, Plan } from "./passes";
import { cardFileName, profileCardModel, shareProfileCard } from "./profileCard";

const held = (name: string, sport: string, year: number, tier = "rare", id = 1, spent = false): HeldPass =>
  ({
    holding: { key: `${sport}:2026:player:${id}`, tier },
    market: { player_name: name, sport, player_id: id, season_label: "2025-26", kind: "player" },
    tier, mult: 10, rating: 100, limit: null, year, spent,
  }) as unknown as HeldPass;

const plan = (held: HeldPass[], sports: Plan["sports"] = {}): Plan => ({ held, sports, total: held.reduce((n, h) => n + h.year, 0) });

describe("profileCardModel", () => {
  it("names the total, the count, the best three passes and the sports that pay most, and nothing that identifies the visitor", () => {
    const p = plan(
      [held("A", "nba", 900, "epic", 1), held("B", "nfl", 5000, "mystic", 2), held("C", "nba", 300, "rare", 3), held("D", "mlb", 1200, "legendary", 4)],
      { nba: { total: 1200 } as never, nfl: { total: 5000 } as never, mlb: { total: 1200 } as never },
    );
    const m = profileCardModel(p);
    expect(m.total).toBe(7400);
    expect(m.passes).toBe(4);
    expect(m.top.map((t) => t.name)).toEqual(["B", "D", "A"]);
    expect(m.top[0]).toMatchObject({ sport: "nfl", playerId: 2, year: 5000, tier: "Mystic" });
    expect(m.sports.map((s) => s.sport)).toEqual(["nfl", "nba", "mlb"]);
    expect(JSON.stringify(m)).not.toMatch(/username|userId|@/);
  });

  it("skips passes that are maxed out in the top, and says nothing for an empty plan", () => {
    const p = plan([held("Maxed", "nba", 8000, "iconic", 1, true), held("Pays", "nba", 100, "rare", 2)]);
    expect(profileCardModel(p).top.map((t) => t.name)).toEqual(["Pays"]);
    expect(profileCardModel(plan([])).top).toEqual([]);
  });
});

describe("shareProfileCard", () => {
  const model = profileCardModel(plan([held("A", "nba", 900)]));
  const blob = new Blob(["png"], { type: "image/png" });

  it("shares the picture as a file through the share sheet when the browser can", async () => {
    const share = vi.fn(async () => {});
    const nav = { canShare: () => true, share } as unknown as Navigator;
    expect(await shareProfileCard(model, blob, nav)).toBe("shared");
    const arg = (share.mock.calls[0] as unknown as [ShareData])[0];
    expect(arg.files?.[0]?.name).toBe(cardFileName());
    expect(arg.text).toMatch(/900/);
  });

  it("closing the sheet is no error, and a browser that cannot share files gets a download", async () => {
    const abort = vi.fn(async () => {
      throw new DOMException("x", "AbortError");
    });
    expect(await shareProfileCard(model, blob, { canShare: () => true, share: abort } as unknown as Navigator)).toBe("cancelled");
    const click = vi.fn();
    const link = { click, set href(_: string) {}, set download(_: string) {} } as unknown as HTMLAnchorElement;
    const create = vi.spyOn(document, "createElement").mockReturnValue(link);
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    expect(await shareProfileCard(model, blob, {} as Navigator)).toBe("downloaded");
    expect(click).toHaveBeenCalled();
    create.mockRestore();
  });
});

describe("bestPlayersToFollow", () => {
  it("takes the players of the passes that pay most, once each, players only (a team or a fighter has no player page)", async () => {
    const { bestPlayersToFollow } = await import("./profileCard");
    const p = plan(
      [
        held("A", "nba", 900, "epic", 1),
        held("B", "nfl", 5000, "mystic", 2),
        { ...held("A again", "nba", 800, "rare", 1), market: { player_name: "A", sport: "nba", player_id: 1, season_label: "2024-25", kind: "player" } } as unknown as HeldPass,
        { ...held("Team", "nba", 7000, "epic", 77), market: { player_name: "T", sport: "nba", player_id: 77, season_label: "2025-26", kind: "team" } } as unknown as HeldPass,
        held("C", "mlb", 100, "rare", 3, true), // maxed: pays nothing more, but it is still a player the visitor owns
      ],
      {},
    );
    expect(bestPlayersToFollow(p, 3)).toEqual(["nfl:2", "nba:1", "mlb:3"]);
    expect(bestPlayersToFollow(p, 1)).toEqual(["nfl:2"]);
    expect(bestPlayersToFollow(plan([]), 20)).toEqual([]);
  });
});
