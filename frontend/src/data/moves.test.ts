import { describe, expect, it } from "vitest";
import { sceneSnapshot } from "../test/scene";
import { bandText, changeText, moveCounts, moveKey, visibleMoves } from "./moves";

describe("moves: the players whose cards sold for much more or less today", () => {
  const snap = sceneSnapshot();

  it("keeps the server's order, risers biggest first and fallers biggest fall first", () => {
    expect(visibleMoves(snap, "risers", "all", new Set()).map((m) => m.player_name)).toEqual([
      "Ja'Marr Chase", "Anthony Edwards", "Mohamed Salah", "Macklin Celebrini", "Josh Allen",
    ]);
    expect(visibleMoves(snap, "fallers", "all", new Set()).map((m) => m.player_name)).toEqual([
      "Connor McDavid", "Nikola Jokić",
    ]);
  });

  it("follows the sport filter: one sport, or only the players followed", () => {
    expect(visibleMoves(snap, "risers", "nfl", new Set()).map((m) => m.player_name)).toEqual(["Ja'Marr Chase", "Josh Allen"]);
    expect(visibleMoves(snap, "fallers", "mine", new Set(["nba:22"])).map((m) => m.player_name)).toEqual(["Nikola Jokić"]);
    expect(visibleMoves(snap, "risers", "mine", new Set(["nba:22"]))).toEqual([]);
  });

  it("counts the moves per sport tab", () => {
    expect(moveCounts(snap, "risers", new Set(["nfl:11"]))).toEqual({
      all: 5, mine: 1, bySport: { nfl: 2, nba: 1, soccer: 1, nhl: 1 },
    });
  });

  it("says the change with its sign, a real minus for a fall", () => {
    expect(changeText(0.405)).toBe("+41%");
    expect(changeText(0.312)).toBe("+31%");
    expect(changeText(-0.222)).toBe("−22%");
    expect(changeText(0)).toBe("0%");
  });

  it("names the value band a move was measured in", () => {
    expect(bandText("0-1.5")).toBe("rating under 1.5");
    expect(bandText("3-5")).toBe("3–5 rating");
    expect(bandText("9+")).toBe("9+ rating");
  });

  it("keys a move by its market: sport, season, player and band", () => {
    expect(moveKey(snap.moves.risers[0]!)).toBe("nfl:2026:11:7-9");
  });
});
