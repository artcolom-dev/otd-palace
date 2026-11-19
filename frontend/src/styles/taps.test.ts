import { describe, expect, it } from "vitest";
import base from "./base.css?raw";

describe("one shared 44 px tap area", () => {
  const block = base.slice(base.indexOf("One 44 px tap area"));
  it("covers the small controls, drawn around them and never in the layout", () => {
    for (const sel of [".ib", ".star", ".icb", ".tlink", ".plink", ".foot a", ".seg button", ".lvl button", ".chips button"]) {
      expect(block, sel).toContain(sel + ",");
    }
    expect(block).toMatch(/width: max\(100%, 44px\)/);
    expect(block).toMatch(/height: max\(100%, 44px\)/);
    expect(block).toMatch(/position: absolute/);
  });
});

import layout from "./layout.css?raw";

describe("drawn card words", () => {
  it("keep the full text colour on every rarity: the rarity is the border and the wash", () => {
    const rule = layout.slice(layout.indexOf("\n.ct {"), layout.indexOf("\n.ct b"));
    expect(rule).toContain("color: var(--color-text)");
    expect(rule).not.toContain("color-mix");
  });
});

describe("the placeholder while a tab's code loads", () => {
  it("is short for the short page (Your plan), so the footer does not jump", () => {
    expect(layout).toMatch(/\.skeleton\[data-view="plan"\]\s*\{\s*min-block-size: 440px/);
  });
});
