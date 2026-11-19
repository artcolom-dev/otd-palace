import { describe, expect, it } from "vitest";
import { JOKIC, OLIVEIRA, THUNDER, CHASE } from "../test/passScene";
import { BUILD_TO_BEST, THIN_LINE, about, buildToMeta, mateLines, outLead, outWhy, metaText, monthWord, monthsText, multText, paysLaterText, spanText, spentWords, noRoomWords, tierName, titleText } from "./passWords";

describe("pass words", () => {
  it("says a pass that has earned its limit has reached it, and that a lift reopens it", () => {
    expect(noRoomWords(5000)).toBe("limit reached: a lift reopens it");
    expect(noRoomWords(0)).toBe("maxed On This Day");
    expect(noRoomWords(null)).toBe("maxed On This Day");
  });

  it("calls a spent General what it is, not maxed: in the fleet every spent pass was a General (cap 0)", () => {
    expect(spentWords("general")).toEqual({ tag: "", pay: "pays nothing On This Day" });
    expect(spentWords("epic")).toEqual({ tag: " · maxed", pay: "pays nothing" });
  });

  it("rounds to what a person says: units, tens, hundreds", () => {
    expect([about(7.4), about(86.5), about(864), about(12_480), about(1_234_567)]).toEqual(["7", "87", "860", "12,500", "1,234,600"]);
  });

  it("names the payback month, with its year once it is a year or more away", () => {
    expect(monthWord("2027-01", "2026-11-12")).toBe("January");
    expect(monthWord("2027-10", "2026-11-12")).toBe("October");
    expect(monthWord("2027-11", "2026-11-12")).toBe("November 2027");
  });

  it("says when a pass whose pay is months away starts paying, and when to buy it", () => {
    expect(paysLaterText({ from: 3, buy: 2 })).toBe("Pays from March — better bought in February");
    expect(paysLaterText({ from: 1, buy: 12 })).toBe("Pays from January — better bought in December");
  });

  it("says months, and years past two of them", () => {
    expect([monthsText(0.4), monthsText(2.4), monthsText(2.6)]).toEqual(["<1", "2", "3"]);
    expect([spanText(0.3), spanText(1), spanText(11.2), spanText(25.3)]).toEqual(["1 month", "1 month", "11 months", "2.1 years"]);
  });

  it("describes a pass in a line", () => {
    expect(titleText(JOKIC)).toBe("Nikola Jokić 2024-25");
    expect(metaText(JOKIC)).toBe("NBA 2024-25 · past season");
    expect(metaText(CHASE)).toBe("NFL 2026 · this season");
    expect(metaText(THUNDER)).toBe("NBA 2024-25 · past season · team");
    expect(metaText(OLIVEIRA)).toBe("UFC 2025 · fighter");
    expect([tierName("legendary"), multText(25), multText(1.2)]).toEqual(["Legendary", "25×", "1.2×"]);
  });
});

describe("mateLines: what one sport says about teammates on the same days", () => {
  it("names the biggest groups first, at most three lines of four names, and counts the rest", () => {
    const groups = [["A", "B"], ["C", "D", "E", "F", "G", "H"], ["I", "J", "K"], ["L", "M"], ["N", "O"]];
    const { lines, more } = mateLines(groups);
    expect(lines).toEqual([
      "C, D, E and 3 more play on the same days",
      "I, J and K play on the same days",
      "A and B play on the same days",
    ]);
    expect(more).toBe(2);
    expect(mateLines([["A", "B"]])).toEqual({ lines: ["A and B play on the same days"], more: 0 });
    expect(mateLines([])).toEqual({ lines: [], more: 0 });
  });
});

describe("Build to words", () => {
  it("says each reason a pass is set apart in a short plain line", () => {
    expect(outWhy("over", 5000, 5)).toBe("Over your 5,000 budget");
    expect(outWhy("never", null, 5)).toBe("Doesn't pay back within 5 years");
    expect(outWhy("even", null, 5)).toBe("Its limit is no more than its cost");
    expect(outWhy("unpriced", null, 5)).toBe("No price yet");
    expect(outWhy("none", null, 5)).toBe("Can't be built: no cards trade");
  });

  it("counts the set-apart passes and says the list's order", () => {
    expect(outLead(1, "legendary")).toBe("1 pass doesn't pay back at Legendary, or can't be built to it");
    expect(outLead(1200, "common")).toBe("1,200 passes don't pay back at Common, or can't be built to it");
    expect(buildToMeta(10, "epic")).toBe("the 10 best per sport built to Epic, most Rax a year per Rax first");
    expect(BUILD_TO_BEST).toBe("Best for each");
    expect(THIN_LINE).toContain("less certain");
  });
});
