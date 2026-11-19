import { describe, expect, it } from "vitest";
import { ROUTINE_IDS } from "../lib/routine";
import { MAX_HOW_WORDS, wordCount } from "./how";
import { POLL_TRAP, ROUTINE_ITEMS } from "./routine";

describe("the daily checklist's words", () => {
  it("has one item per id of the routine, in its order", () => {
    expect(ROUTINE_ITEMS.map((i) => i.id)).toEqual([...ROUTINE_IDS]);
  });

  it("says what each earns in plain words, and never what an account makes in a day", () => {
    for (const item of ROUTINE_ITEMS) {
      expect(item.earns, item.id).toMatch(/^(Pays Rax|Earns karma|Can save you Rax)/);
      expect(item.earns, item.id).not.toMatch(/karma (is|are) worth|Rax a day|per day a/i);
      expect(wordCount(item.earns), item.id).toBeLessThanOrEqual(MAX_HOW_WORDS);
      expect(item.title.length).toBeLessThan(40);
    }
  });

  it("names a karma figure on the polls line only, and only the ones Real's docs state", () => {
    for (const item of ROUTINE_ITEMS) {
      if (item.id !== "polls") expect(item.earns, item.id).not.toMatch(/\d+ karma|\d+ per poll/i);
    }
    const polls = ROUTINE_ITEMS.find((i) => i.id === "polls")!.earns;
    expect(polls).toBe(
      "Earns karma: 10 per poll win, up to 100 if wagered. 1,000 karma is 5 Rax: a slow start, not a plan. " +
        "The daily streak poll pays Rax: 5 for 2 right in a row, up to 320 for 8.",
    );
    expect(polls.match(/\d[\d,]*/g)).toEqual(["10", "100", "1,000", "5", "5", "2", "320", "8"]);
  });

  it("says the lineup pays Rax (Real Pro) and passes of this season pay after each game", () => {
    const earns = (id: string) => ROUTINE_ITEMS.find((i) => i.id === id)!.earns;
    expect(earns("lineup")).toBe("Pays Rax (Real Pro): 100 down to 10 for the top 10, plus 10 per exact pick.");
    expect(earns("claim")).toMatch(/2 claims per sport a day/);
    expect(earns("claim")).toMatch(/after each game/);
    expect(earns("polls")).toMatch(/daily streak/);
  });

  it("keeps the poll trap word for word", () => {
    expect(POLL_TRAP).toBe("A pass applied to a poll cannot be claimed until the poll ends.");
  });
});
