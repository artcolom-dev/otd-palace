import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import alerts from "./alerts.css?raw";
import base from "./base.css?raw";
import gate from "./gate.css?raw";
import helpers from "./helpers.css?raw";
import injury from "./injury.css?raw";
import layout from "./layout.css?raw";
import loading from "./loading.css?raw";
import meter from "./meter.css?raw";
import motion from "./motion.css?raw";
import passes from "./passes.css?raw";
import paused from "./paused.css?raw";
import phone from "./phone.css?raw";
import plan from "./plan.css?raw";
import privacy from "./privacy.css?raw";
import routine from "./routine.css?raw";
import today from "./today.css?raw";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(loading);
const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
const outside = css.slice(0, css.indexOf("@media (prefers-reduced-motion: reduce)"));

describe("the loading sheet", () => {
  it("moves by transform and opacity only, so a bar showing never shifts the page", () => {
    for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
      const props = m[1]!.split(",").map((part) => part.trim().split(/\s+/)[0]);
      for (const prop of props) expect(["opacity", "transform", "none"]).toContain(prop);
    }
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*{([\s\S]*?)\n}/g)) {
      const props = [...m[2]!.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
      for (const prop of props) expect([m[1], prop]).toEqual([m[1], expect.stringMatching(/^(opacity|transform)$/)]);
    }
  });

  it("the top bar is fixed, under the status bar, above the page and never in a finger's way", () => {
    const rule = /\.tprog\s*{([^}]*)}/.exec(css)![1]!;
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/top:\s*env\(safe-area-inset-top/);
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/z-index:\s*\d+/);
  });

  it("stops every loop for less motion and in a hidden tab", () => {
    const looping = [...outside.matchAll(/([^{}]+){[^}]*animation:[^;]*infinite[^}]*}/g)].map((m) => m[1]!.trim());
    expect(looping.length).toBeGreaterThan(0);
    for (const selector of looping) {
      const inner = selector.replace(/\s+/g, " ");
      expect(reduced.replace(/\s+/g, " ")).toContain(inner);
    }
    expect(css).toMatch(/:root\[data-tab-hidden\][^{]*{\s*animation:\s*none/);
    expect(reduced).toMatch(/\.tprog > i,\s*\.tprog\[data-phase="boot"\] > i\s*{[^}]*animation:\s*none/);
  });

  it("styles no class another sheet styles (but the QR frame it fills)", () => {
    const classesOf = (sheet: string) => new Set([...strip(sheet).matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!));
    const mine = [...classesOf(loading)].filter((name) => name !== "qrwrap");
    const others = { alerts, base, gate, helpers, injury, layout, meter, motion, passes, paused, phone, plan, privacy, routine, today };
    for (const [sheet, other] of Object.entries(others)) {
      const theirs = classesOf(other);
      expect([sheet, mine.filter((name) => theirs.has(name))]).toEqual([sheet, []]);
    }
  });

  it("speaks in tokens, but for the QR code's light frame, which is light in both themes", () => {
    const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(new Set(literals)).toEqual(new Set(["#3a3a3a", "#f2f1ee", "#e3e1db"]));
  });
});

describe("index.html's own bar", () => {
  it("sits inside the root, so the site replaces it when it draws, and is hidden from screen readers", () => {
    expect(indexHtml).toMatch(/<div id="root"><div class="tprog" data-phase="boot" aria-hidden="true"><i><\/i><\/div><\/div>/);
  });

  it("shows only after the same delay as the site's bar, by the sheet alone (no script, no inline style)", () => {
    expect(css).toMatch(/\.tprog\[data-phase="boot"\]\s*{[^}]*animation:\s*tprog-show 1ms linear 180ms forwards/);
    expect(indexHtml).not.toMatch(/style=/);
  });
});
