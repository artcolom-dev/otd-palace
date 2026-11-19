import { describe, expect, it } from "vitest";
import tokens from "../styles/tokens.css?raw";
import { RARITIES, rarityClass, rarityIndex, rarityLabel, rarityName, seasonLabel, sportLabel, sportName } from "./real";



describe("Real's rarities", () => {
  it("are Real's eight, in Real's order", () => {
    expect(RARITIES.map((r) => r.name)).toEqual(["General", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mystic", "Iconic"]);
    expect(RARITIES.map((r) => r.key)).toEqual(RARITIES.map((r) => r.name.toLowerCase()));
  });

  it("carry the emoji Real's docs give them", () => {
    expect(RARITIES.map((r) => r.emoji).join("")).toBe("⚪🔵🟢🟠🔴🟣🟡💎");
  });

  it("are the colours the stylesheet's --rarity-N tokens draw, on the dark theme", () => {
    const dark = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf(":root[data-theme"));
    const site = [...dark.matchAll(/--rarity-(\d): (#[0-9a-f]{6});/g)].map((m) => [Number(m[1]), m[2]]);
    expect(site).toEqual(RARITIES.map((r, i) => [i, r.color]));
  });

  it("name an index, a tier and a class", () => {
    expect([0, 5, 7].map(rarityName)).toEqual(["General", "Legendary", "Iconic"]);
    expect(rarityName(8)).toBe("");
    expect(rarityIndex("Legendary")).toBe(5);
    expect(rarityIndex("gold")).toBe(-1);
    expect(rarityClass(6)).toBe("rar-6");
    expect(rarityClass(12)).toBe("rar-0");
  });

  it("write a sub-level the way Real's label does, and trust no other label", () => {
    expect(rarityLabel("legendary", "Legendary 3")).toBe("Legendary 3");
    expect(rarityLabel(6, "Mystic 10")).toBe("Mystic 10");
    expect(rarityLabel("legendary", "Legendary")).toBe("Legendary");
    expect(rarityLabel("legendary", "Legendary 1")).toBe("Legendary");
    expect(rarityLabel("legendary", "Mystic 2")).toBe("Legendary");
    expect(rarityLabel("legendary", "<b>x</b>")).toBe("Legendary");
    expect(rarityLabel(4)).toBe("Epic");
  });
});

describe("seasons and sports, as Real writes them", () => {
  it("writes a season that straddles New Year as two years, the rest as one", () => {
    expect(seasonLabel("nba", 2026)).toBe("2025-26");
    expect(seasonLabel("nhl", 2025)).toBe("2024-25");
    expect(seasonLabel("cbb", 2000)).toBe("1999-00");
    expect(seasonLabel("nfl", 2026)).toBe("2026");
    expect(seasonLabel("mlb", 2025)).toBe("2025");
  });

  it("names sports short on a tab and in full in a sentence", () => {
    expect(sportLabel("nba")).toBe("NBA");
    expect(sportLabel("soccer")).toBe("Soccer");
    expect(sportName("cfb")).toBe("NCAA Football");
    expect(sportName("nba")).toBe("NBA");
  });
});
