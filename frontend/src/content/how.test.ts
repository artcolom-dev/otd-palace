import { describe, expect, it } from "vitest";
import { GLOSSARY } from "./glossary";
import { HOW, HOW_IDS, MAX_HOW_WORDS, TERM_HOW, howFromHash, howHash, howSearch, isHowId, wordCount } from "./how";

describe("How Real works: the content", () => {
  it("has fifteen items with their own ids, what Real is first", () => {
    expect(HOW).toHaveLength(15);
    expect(new Set(HOW_IDS).size).toBe(15);
    expect(HOW_IDS).toEqual([
      "new", "fees", "countdown", "winning", "offers", "minted", "usual", "falling", "passes", "rarity", "first", "boosters",
      "more", "polls", "estimates",
    ]);
  });

  it("says offers are the cheap way to build a pass: most refused, so send many; no figure, no mention of who was read", () => {
    const item = HOW.find((h) => h.id === "offers")!;
    expect(item.title).toBe("Offers: the cheap way to build a pass");
    expect(item.text).toBe(
      "Offer under the usual price on many cards of the player and season your pass needs. Most offers are refused, so send many: the ones accepted are the cheapest rating you will get. Offers need Real Pro.",
    );
    expect(item.text).not.toMatch(/\d|%|tool|scan|account|bot|fleet|we read/i);
    expect(howSearch("offers").map((h) => h.id)).toEqual(["offers"]);
    expect(howFromHash("#how/offers")).toEqual({ id: "offers" });
  });

  it("says a pass's rarity is the cards held, so selling one lowers the pass (504 passes fell a rarity in 9.5 hours on 66 accounts read)", () => {
    const text = HOW.find((h) => h.id === "rarity")!.text;
    expect(text).toMatch(/sum of the ratings of the cards you hold/);
    expect(text).toMatch(/[Ss]ell one and it falls back/);
  });

  it("tells someone who never played what Real is, and where to get it: Real's own site", () => {
    const item = HOW.find((h) => h.id === "new")!;
    expect(item.title).toBe("New to Real?");
    expect(item.text).toMatch(/sports app/);
    expect(item.text).toMatch(/Rax/);
    expect(item.link).toEqual({ label: "Get Real at realapp.com", href: "https://www.realapp.com/" });
    expect(howFromHash("#how/new")).toEqual({ id: "new" });
  });

  it("says who wins a deal, as measured: one bid at the opening price, half the deals to the first bidder", () => {
    const text = HOW.find((h) => h.id === "winning")!.text;
    expect(text).toMatch(/one bid, at the opening price/);
    expect(text).toMatch(/about half go to the first bidder/);
    expect(text).toMatch(/still ends under the usual price/);
    expect(howSearch("first bidder").map((h) => h.id)).toEqual(["winning"]);
  });

  it("keeps each item to 40 words", () => {
    for (const item of HOW) expect(wordCount(item.text), item.id).toBeLessThanOrEqual(MAX_HOW_WORDS);
    expect(wordCount("a b  c\n d")).toBe(4);
  });

  it("says what the app shows: the fee, the listing fee, the countdown and the soft close, the 2 claims, the poll lock", () => {
    const text = (id: string) => HOW.find((h) => h.id === id)!.text;
    expect(text("fees")).toMatch(/10%/);
    expect(text("fees")).toMatch(/10 Rax/);
    expect(text("countdown")).toMatch(/10-minute countdown/);
    expect(text("countdown")).toMatch(/last minute adds a minute/);
    expect(text("passes")).toMatch(/2 claims per sport per day/);
    expect(text("fees")).toMatch(/Quick List has no listing fee/);
    // A deal is under its usual price, not always a profit: under 50 Rax, most lose after fees.
    expect(text("fees")).toMatch(/a deal can still lose when resold; on cards usually under 50 Rax, most do/);
    expect(text("polls")).toBe(
      "A pass applied to a poll cannot be claimed until the poll ends. Before you use a pass on a poll, check it is not one you still want to claim with.",
    );
  });

  it("claims nothing about what an account earns; karma only where Real states its Rax rate", () => {
    for (const item of HOW) {
      expect(item.text, item.id).not.toMatch(/free account|\d Rax (a|per) day|you will earn|guarantee/i);
      if (item.id !== "more") expect(item.text, item.id).not.toMatch(/karma/i);
    }
  });

  it("explains live pay apart from On This Day, and the Rax Real states beyond passes", () => {
    const text = (id: string) => HOW.find((h) => h.id === id)!.text;
    expect(text("passes")).toMatch(/every game its player plays, on its own; playoff games pay double/);
    expect(text("first")).toMatch(/first player pass in each sport is free/);
    expect(text("first")).toMatch(/one extra claim a day across all sports, through the bonus poll/);
    expect(text("boosters")).toMatch(/Rare \+10, Epic \+15, Legendary \+25/);
    expect(text("more")).toMatch(/5 per 1,000/);
    expect(text("more")).toMatch(/plus 10 per exact pick/);
  });

  it("every ⓘ that points here points at an item that exists, on a term that exists", () => {
    for (const [term, id] of Object.entries(TERM_HOW)) {
      expect(term in GLOSSARY, term).toBe(true);
      expect(isHowId(id), `${term} -> ${id}`).toBe(true);
    }
  });
});

describe("the address", () => {
  it("reads #how and #how/<id>", () => {
    expect(howFromHash("#how")).toEqual({ id: null });
    expect(howFromHash("#how/fees")).toEqual({ id: "fees" });
    expect(howFromHash("#HOW/Countdown")).toEqual({ id: "countdown" });
    expect(howFromHash("#how/nope")).toEqual({ id: null }); // opens at the top
  });

  it("is not about anything else", () => {
    for (const h of ["", "#", "#deals", "#howto", "#how/fees/x", "#%", "#how/"]) expect(howFromHash(h), h).toBeNull();
  });

  it("writes the address it reads", () => {
    for (const id of HOW_IDS) expect(howFromHash(howHash(id))).toEqual({ id });
    expect(howHash(null)).toBe("#how");
  });
});

describe("search", () => {
  it("finds by title or text, ignoring case and accents, every word having to match", () => {
    expect(howSearch("FEES").map((h) => h.id)).toContain("fees");
    expect(howSearch("countdown").map((h) => h.id)).toEqual(expect.arrayContaining(["countdown"]));
    expect(howSearch("soft close").map((h) => h.id)).toEqual(["countdown"]);
    expect(howSearch("poll lock").map((h) => h.id)).toEqual(["polls"]);
    expect(howSearch("real pay").map((h) => h.id)).toEqual(expect.arrayContaining(["passes"]));
    expect(howSearch("fees countdown")).toEqual([]);
  });

  it("an empty or blank search gives them all, and a search that matches nothing gives none", () => {
    expect(howSearch("")).toHaveLength(HOW.length);
    expect(howSearch("   ")).toHaveLength(HOW.length);
    expect(howSearch("zzzz")).toEqual([]);
  });
});
