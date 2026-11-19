import { describe, expect, it } from "vitest";
import tokens from "../styles/tokens.css?raw";
import { DUR, EASE_IN, EASE_OUT, EASE_SPRING, STAGGER, stagger } from "./motion";

describe("the motion tokens", () => {
  it("are the same durations and easings in script as in the style sheet", () => {
    for (const [name, ms] of Object.entries(DUR)) {
      expect(tokens).toContain(`--dur-${name}: ${ms}ms;`);
    }
    expect(tokens).toContain(`--ease-out: ${EASE_OUT};`);
    expect(tokens).toContain(`--ease-in: ${EASE_IN};`);
    expect(tokens).toContain(`--ease-spring: ${EASE_SPRING};`);
  });

  it("zero every duration for a visitor who asks for less motion", () => {
    const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const name of [...Object.keys(DUR), "hold"]) expect(reduced).toContain(`--dur-${name}: 0ms;`);
  });

  it("deal a long list in a bounded time", () => {
    expect(stagger(0)).toBe(0);
    expect(stagger(2)).toBe(2 * STAGGER.beat);
    expect(stagger(500)).toBe(STAGGER.max);
    expect(stagger(500, 70)).toBe(STAGGER.max);
  });
});
