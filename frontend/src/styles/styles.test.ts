import { describe, expect, it } from "vitest";
import alerts from "./alerts.css?raw";
import base from "./base.css?raw";
import gate from "./gate.css?raw";
import helpers from "./helpers.css?raw";
import layout from "./layout.css?raw";
import motion from "./motion.css?raw";
import { existsSync } from "node:fs";
import { cwd } from "node:process";
import indexHtml from "../../index.html?raw";
import passes from "./passes.css?raw";
import injury from "./injury.css?raw";
import meter from "./meter.css?raw";
import paused from "./paused.css?raw";
import plan from "./plan.css?raw";
import privacy from "./privacy.css?raw";
import routine from "./routine.css?raw";
import today from "./today.css?raw";
import tokens from "./tokens.css?raw";

// jsdom lays nothing out, so these read the style sheets themselves; the sizes are checked again in Chromium.

interface Rule {
  selectors: string[];
  decls: Record<string, string>;
  atRules: string[]; // the @media / @supports blocks it sits in
}

function parse(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  for (const ch of src) {
    if (ch === "{") {
      stack.push(buf.trim());
      buf = "";
    } else if (ch === "}") {
      const prelude = stack.pop() ?? "";
      if (!prelude.startsWith("@")) {
        const decls: Record<string, string> = {};
        for (const part of buf.split(";")) {
          const i = part.indexOf(":");
          if (i > 0) decls[part.slice(0, i).trim()] = part.slice(i + 1).trim();
        }
        rules.push({ selectors: prelude.split(",").map((s) => s.trim()), decls, atRules: stack.filter((p) => p.startsWith("@")) });
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  return rules;
}

const sheets = { base, layout, motion, passes, today, alerts, paused, helpers, routine, meter, plan, injury, gate, privacy };
const rules = Object.values(sheets).flatMap(parse);

/** Every declaration given to exactly this selector outside any @media block, later ones winning. */
function decls(selector: string): Record<string, string> {
  return Object.assign(
    {},
    ...rules.filter((r) => r.atRules.length === 0 && r.selectors.includes(selector)).map((r) => r.decls),
  );
}
const px = (v: string | undefined) => (v === undefined ? Number.NaN : Number.parseFloat(v));

/** Whether an @media block can apply on a phone: it asks for no width of 768 px or more, and no real hover. */
function onPhone(atRule: string): boolean {
  if (!atRule.startsWith("@media")) return true;
  if (/\(hover:\s*hover\)/.test(atRule)) return false;
  const min = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(atRule);
  return !min || Number(min[1]) < 768;
}

/** The declarations @media blocks that can apply on a phone give to exactly this selector. */
function phoneOverrides(selector: string): Record<string, string>[] {
  return rules
    .filter((r) => r.atRules.length > 0 && r.atRules.every(onPhone) && r.selectors.includes(selector))
    .map((r) => r.decls);
}

// Every phone tap target the sheets size, and the properties that size it.
const TAP_TARGETS: [selector: string, props: ("height" | "min-height" | "width")[]][] = [
  [".app.phone .tabs button", ["height", "min-height"]],
  [".app.phone .fchip .icb", ["width", "height"]],
  [".views button", ["height", "min-height"]],
  [".chips button", ["height", "min-height"]],
  [".psec .mini button", ["height", "min-height"]],
  [".psec .tgl", ["height", "min-height"]],
  [".passes-page.phone .rm", ["width", "height", "min-height"]],
  [".passes-page.phone .pl input", ["height"]],
  [".prow.pass", ["min-height"]],
  [".sheet .pclose", ["width", "height"]],
  [".sheet .tiers button", ["min-height"]],
  [".sheet .chk", ["min-height"]],
  [".sheet .addp .back", ["height"]],
  [".sheet .more", ["min-height"]],
  [".app.phone .mvtabs button", ["height", "min-height"]],
  [".app.phone .mv", ["min-height"]],
  [".app.phone .mv .star", ["width", "height"]],
  [".app.phone .plink", ["min-height"]],
  [".app.phone .got", ["height", "min-height"]],
  [".app.phone .opfoot .lnk", ["min-height"]],
  [".app.phone .seeall", ["min-height"]],
  [".app.phone .since .icb", ["width", "height"]],
  [".app.phone .inst .icb", ["width", "height"]],
  [".app.phone .inst .btn", ["height", "min-height"]],
  [".alerts .al-row", ["min-height"]],
  [".alerts select", ["height", "min-height"]],
  [".alerts .btn", ["height", "min-height"]],
  [".alerts .al-del", ["min-height"]],
  [".alert-note .lnk", ["min-height"]],
  [".alert-note .icb", ["width", "height"]],
  [".dl", ["min-height"]],
  [".bbf", ["height"]],
  [".sellform select", ["height"]],
  [".sellrow .lnk", ["min-height"]],
  [".sellbtn", ["min-height"]],
  [".sharerow .btn", ["min-height"]],
  [".sharelink input", ["height"]],
  [".tile .share.iconly", ["width"]],
  [".app.phone .top .bell", ["width", "height"]],
  [".prow .star", ["width", "height"]], // a row's star, gone rows included
  [".app.phone .tile .btn", ["height", "min-height"]], // a top tile's Open
  [".app.phone .tile .star", ["width", "height"]],
  [".loadfail .btn", ["height", "min-height"]], // Retry, when the first load keeps failing
  [".crash .lnk", ["min-height"]], // Try again and Reload, when a page breaks
  [".rtn-row", ["min-height"]], // a checklist item: the whole row ticks it
  [".rtn-go", ["width", "height"]],
  [".rtn-foot .lnk", ["min-height"]],
  [".rtn-back", ["min-height"]],
  [".fg-go", ["min-height"]],
  [".nrx-row", ["min-height"]],
  [".snw-tab summary", ["min-height"]],
  [".how-box", ["height"]],
  [".unlock-go", ["height", "min-height"]], // a locked area's way in
  [".unlock-more", ["min-height"]],
  [".unlock-again", ["min-height"]],
  [".discord-go", ["height", "min-height"]], // the top bar's Continue with Discord
  [".discord-go-phone", ["min-height"]],
  [".gate-back", ["min-height"]],
];

describe("style sheets", () => {
  it("are all read", () => {
    for (const css of Object.values(sheets)) expect(css.length).toBeGreaterThan(100);
  });

  it("show hover styles only where there is a real hover, never as a sticky tap on a touch screen", () => {
    const loose = rules
      .filter((r) => r.selectors.some((s) => s.includes(":hover")))
      .filter((r) => !r.atRules.some((a) => /\(hover:\s*hover\)/.test(a)))
      .map((r) => r.selectors.join(", "));
    expect(loose).toEqual([]);
  });

  describe("phone tap targets are at least 44 px", () => {
    it("sport tabs and My players", () => {
      const tab = decls(".app.phone .tabs button");
      expect(Math.max(px(tab.height), px(tab["min-height"]) || 0)).toBeGreaterThanOrEqual(44);
    });

    it("the clear button on the search chip", () => {
      const clear = decls(".app.phone .fchip .icb");
      expect(px(clear.width)).toBeGreaterThanOrEqual(44);
      expect(px(clear.height)).toBeGreaterThanOrEqual(44);
    });

    it("every ⓘ: 22 px to the eye, 44 px to the finger", () => {
      const ib = decls(".ib");
      expect(px(ib.width)).toBe(22);
      expect(px(ib.height)).toBe(22);
      expect(decls(".app.phone .ib").position).toBe("relative");
      const hit = decls(".app.phone .ib::after");
      expect(hit.content).toBe('""');
      expect(hit.position).toBe("absolute");
      expect(22 - 2 * px(hit.inset)).toBeGreaterThanOrEqual(44);
      // nothing on the phone shrinks it back or hides the hit area
      const phoneIb = rules.filter((r) => r.selectors.some((s) => /^\.(app|hero)\.phone .*\.ib$/.test(s)));
      for (const r of phoneIb) {
        expect(r.decls.width ?? "22px").toBe("22px");
        expect(r.decls.overflow).toBeUndefined();
      }
    });

    it("the Passes tab: views, sport chips, season, the build filter, remove, the planner's fields", () => {
      const tall = (sel: string) => Math.max(px(decls(sel).height), px(decls(sel)["min-height"]) || 0);
      for (const sel of [".views button", ".chips button", ".psec .mini button", ".psec .tgl", ".passes-page.phone .rm"]) {
        expect([sel, tall(sel)]).toEqual([sel, expect.any(Number)]);
        expect(tall(sel)).toBeGreaterThanOrEqual(44);
      }
      expect(px(decls(".passes-page.phone .rm").width)).toBeGreaterThanOrEqual(44);
      expect(px(decls(".passes-page.phone .pl input").height)).toBeGreaterThanOrEqual(44);
      expect(px(decls(".prow.pass")["min-height"])).toBeGreaterThanOrEqual(44);
    });

    it("inside a sheet (a pass, adding one): the close button, every ⓘ, the steps' choices", () => {
      expect(px(decls(".sheet .pclose").width)).toBeGreaterThanOrEqual(44);
      expect(px(decls(".sheet .pclose").height)).toBeGreaterThanOrEqual(44);
      const hit = decls(".sheet .ib::after");
      expect(hit.content).toBe('""');
      expect(22 - 2 * px(hit.inset)).toBeGreaterThanOrEqual(44);
      expect(px(decls(".sheet .tiers button")["min-height"])).toBeGreaterThanOrEqual(44);
      expect(px(decls(".sheet .chk")["min-height"])).toBeGreaterThanOrEqual(44);
      expect(px(decls(".sheet .addp .back").height)).toBeGreaterThanOrEqual(44);
      expect(px(decls(".sheet .more")["min-height"])).toBeGreaterThanOrEqual(44);
    });
  });

  describe("phone tap targets keep 44 px through every @media block", () => {
    it.each(TAP_TARGETS)("%s", (selector, props) => {
      const base = decls(selector);
      const size = Math.max(...props.map((p) => px(base[p]) || 0));
      expect([selector, size >= 44]).toEqual([selector, true]);
      for (const over of phoneOverrides(selector)) {
        for (const prop of props) {
          if (over[prop] === undefined || Number.isNaN(px(over[prop]))) continue;
          expect([selector, prop, px(over[prop]) >= 44]).toEqual([selector, prop, true]);
        }
      }
    });

    it("the ⓘ hit areas", () => {
      for (const selector of [".app.phone .ib::after", ".sheet .ib::after"]) {
        for (const over of phoneOverrides(selector)) {
          if (over.inset !== undefined) expect(22 - 2 * px(over.inset)).toBeGreaterThanOrEqual(44);
        }
      }
    });

    it("reads @media blocks: a block that shrinks a target is caught", () => {
      const shrunk = parse("@media (max-width: 380px) { .app.phone .got { height: 36px; } }");
      expect(shrunk[0]!.atRules).toEqual(["@media (max-width: 380px)"]);
      expect(onPhone(shrunk[0]!.atRules[0]!)).toBe(true);
      expect(onPhone("@media (min-width: 1100px)")).toBe(false);
      expect(onPhone("@media (hover: hover)")).toBe(false);
    });
  });

  it("rarity colours come only from the rarity tokens", () => {
    // The Passes sheet names no colour of its own for a rarity: every one is --c, set by .rar-N from --rarity-N.
    expect(passes).not.toMatch(/--rarity-\d/);
    const rar = rules.filter((r) => r.selectors.some((s) => /^\.rar-\d$/.test(s)));
    expect(rar.map((r) => r.decls["--c"])).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `var(--rarity-${i})`));
  });

  it("the drawn cards and faces name no colour of their own: their rarity tints mix only with tokens", () => {
    const tinted = rules.filter((r) => Object.values(r.decls).some((v) => v.includes("var(--c)")));
    expect(tinted.length).toBeGreaterThan(5);
    for (const r of tinted) {
      for (const [prop, value] of Object.entries(r.decls)) {
        expect([r.selectors.join(", "), prop, /#[0-9a-f]{3,8}\b/i.test(value)]).toEqual([r.selectors.join(", "), prop, false]);
      }
    }
  });

  describe("paused data never fades text", () => {
    const pausedRules = rules.filter((r) => r.selectors.some((s) => s.includes(".stale") || s.includes("[data-stale]")));

    it("fades only photos with opacity; drawn cards lose their colour, icons take a muted token (3:1 and more)", () => {
      expect(pausedRules.length).toBeGreaterThan(3);
      const pictures = /\bimg$/;
      for (const r of pausedRules.filter((rule) => rule.decls.opacity !== undefined)) {
        for (const selector of r.selectors) expect([selector, pictures.test(selector)]).toEqual([selector, true]);
      }
    });

    it("keeps the icons of paused rows on a muted token, the follow star that is on in its accent", () => {
      expect(decls(".stale .i").color).toBe("var(--color-muted)");
      expect(decls(".stale .i").opacity).toBeUndefined();
      expect(decls('.stale .star[aria-pressed="true"] .i').color).toBe("var(--color-accent)");
    });

    it("greys a hero's drawn cards, whose numbers and names are text too", () => {
      const dim = decls("[data-stale] [data-stale-dim]");
      expect(dim.opacity).toBeUndefined();
      expect(dim.filter).toMatch(/^grayscale\(/);
    });

    it("leaves no opacity on the deals table or list as a whole", () => {
      expect(decls(".stale").opacity).toBeUndefined();
      expect(decls(".stale").filter).toBeUndefined();
    });

    it("gives paused text only tokens that read at 4.5:1 or more on every surface", () => {
      // text 13:1, muted 6:1, accent 6.1:1 on every dark surface (the audit's token table)
      const safe = new Set(["var(--color-text)", "var(--color-muted)", "var(--color-accent)"]);
      for (const r of pausedRules.filter((rule) => rule.decls.color !== undefined)) {
        expect([r.selectors.join(", "), safe.has(r.decls.color!)]).toEqual([r.selectors.join(", "), true]);
      }
    });
  });

  it("the live dot stands still under reduced motion", () => {
    const still = rules.filter(
      (r) => r.atRules.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)) && r.selectors.includes(".dot.on::after"),
    );
    expect(still.length).toBeGreaterThan(0);
    for (const r of still) expect(r.decls.animation).toBe("none");
  });

  it("a top tile's name with no break in it wraps anywhere and stops at two lines, never pushing the tile wider", () => {
    const name = decls(".tile h3");
    expect(name["overflow-wrap"]).toBe("anywhere");
    expect(name["min-width"]).toBe("0");
    expect(name["-webkit-line-clamp"]).toBe("2");
    expect(name["line-clamp"]).toBe("2");
    expect(name.overflow).toBe("hidden");
    expect(decls(".tile")["min-width"]).toBe("0");
  });

  it("a top tile's pill gives up its green while paused, and the medals ring with the page, not a glow", () => {
    expect(decls("[data-stale] .tpct").background).toBe("var(--color-raise)");
    expect(decls(".rank").outline).toMatch(/var\(--color-bg\)/);
    expect(decls(".rank")["box-shadow"] ?? "").not.toMatch(/^0 0 /);
  });

  it("a hero name with no break in it wraps anywhere and stops at three lines", () => {
    const name = decls(".hname h2");
    expect(name["overflow-wrap"]).toBe("anywhere");
    expect(name["min-width"]).toBe("0");
    expect(name["-webkit-line-clamp"]).toBe("3");
    expect(name["line-clamp"]).toBe("3");
    expect(name.overflow).toBe("hidden");
    expect(decls(".hname")["min-width"]).toBe("0");
  });

  describe("text on the accent reads at 4.5:1 in both themes (the Best now ribbon, a filled button)", () => {
    const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
    const lum = (h: string) => {
      const [r, g, b] = hex(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const token = (block: string, name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1];
    const dark = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf(":root[data-theme"));
    const light = tokens.slice(tokens.indexOf(":root[data-theme"));

    it.each([["dark", dark], ["light", light]])("%s theme", (_name, block) => {
      const ink = token(block, "--color-on-accent");
      const accent = token(block, "--color-accent");
      expect(ink && accent).toBeTruthy();
      expect(ratio(ink!, accent!)).toBeGreaterThanOrEqual(4.5);
    });

    it("the ribbon and the filled button put that ink on that accent", () => {
      for (const sel of [".ribbon", ".btn.fill"]) {
        expect([sel, decls(sel).background, decls(sel).color]).toEqual([sel, "var(--color-accent)", "var(--color-on-accent)"]);
      }
    });
  });

  it("a taken tile keeps its words on a token: only its face fades", () => {
    const taken = rules.filter((r) => r.selectors.some((s) => s.startsWith(".tile.taken")));
    expect(taken.length).toBeGreaterThan(0);
    for (const r of taken.filter((rule) => rule.decls.opacity !== undefined)) {
      for (const sel of r.selectors) expect([sel, /\.(tface|pav)\b[^ ]*$|\bimg$/.test(sel)]).toEqual([sel, true]);
    }
    for (const sel of [".tile.taken .tid", ".tile.taken .tprice", ".tile.taken .tprice b"]) {
      expect([sel, decls(sel).color]).toEqual([sel, "var(--color-muted)"]);
    }
  });

  describe("fonts are served by the site itself", () => {
    const faces = [...tokens.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]!);

    it("serves one face, for our own name only: Bricolage Grotesque, from woff2 files next to its licence, swapping in", () => {
      const families = faces.map((f) => /font-family:\s*"([^"]+)"/.exec(f)?.[1]);
      expect(new Set(families)).toEqual(new Set(["Bricolage Grotesque"]));
      expect(faces.length).toBe(2); // latin, and latin-ext for the names that need it
      for (const face of faces) {
        expect(face).toMatch(/font-display:\s*swap/);
        const file = /url\("\.\.\/fonts\/([\w-]+\.woff2)"\)\s*format\("woff2"\)/.exec(face)?.[1];
        expect(file).toBeDefined();
        expect(existsSync(`${cwd()}/src/fonts/${file}`)).toBe(true);
      }
      expect(existsSync(`${cwd()}/src/fonts/OFL-BricolageGrotesque.txt`)).toBe(true);
      // Only the brand reads it: every other rule takes the interface or the display face.
      const brandFace = rules.filter((r) => Object.values(r.decls).some((v) => v.includes("var(--font-brand)")));
      expect(brandFace.map((r) => r.selectors)).toEqual([[".brand"]]);
    });

    it("writes everything else in the device's own face, as Real does: nothing is fetched and nothing swaps", () => {
      const ui = /--font-ui:\s*([^;]+);/.exec(tokens)?.[1] ?? "";
      expect(ui.split(",")[0]!.trim()).toBe("system-ui");
      // no web font among them: the only quoted names are faces that ship with a system
      expect([...ui.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(["Segoe UI", "Helvetica Neue"]);
      expect(/--font-display:\s*([^;]+);/.exec(tokens)?.[1]).toBe("var(--font-ui)");
      expect(/--font-brand:\s*([^;]+);/.exec(tokens)?.[1]).toBe('"Bricolage Grotesque", var(--font-ui)');
      // Real sets every figure in tabular numerals; so does the page, from the body down.
      expect(decls("body")["font-variant-numeric"]).toBe("tabular-nums");
    });

    it("asks nothing of Google and preloads no font: the first paint does not wait for them (swap)", () => {
      expect(indexHtml).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(indexHtml).not.toMatch(/rel="preload"/);
    });

    it("describes the site for search results", () => {
      expect(indexHtml).toMatch(/<meta name="description" content="[^"]{50,160}" \/>/);
    });
  });

  it("a tab the visitor moves to fades in, rising a little; with less motion it only fades, and never on the first paint", () => {
    const enter = rules.filter((r) => r.selectors.includes(":root[data-navigated] .main > .page"));
    const plain = enter.find((r) => r.atRules.length === 0);
    const reduced = enter.find((r) => r.atRules.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
    expect(plain?.decls.animation).toMatch(/view-in var\(--dur-slow\) var\(--ease-out\)/);
    expect(reduced?.decls["animation-name"]).toBe("fade-in");
    expect(motion).toMatch(/@keyframes view-in[\s\S]*translateY\(6px\)/);
  });

  it("the Passes, Today and alerts motion have a reduced-motion path", () => {
    expect(passes).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(today).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(alerts).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});


describe("the Real look (the internal research notes)", () => {
  const all = Object.values(sheets).join("\n");
  const dark = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf(":root[data-theme"));
  const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(dark)?.[1];

  it("stands on Real's black ground, with its two greys for text", () => {
    expect(token("--color-bg")).toBe("#000000");
    expect(token("--color-surface")).toBe("#151515");
    expect(token("--color-text")).toBe("#d9d9d9");
    expect(token("--color-muted")).toBe("#8a8e94");
  });

  it("takes every corner from the shape tokens: no radius of its own anywhere", () => {
    const own = [...all.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/border(?:-[a-z]+)*-radius:\s*([^;]+);/g)]
      .map((m) => m[1]!.trim())
      .filter((v) => !/^(var\(--radius-(xs|sm|md|lg|xl|pill)\)|0|50%|inherit|1px)( (var\(--radius-(xs|sm|md|lg|xl|pill)\)|0))*$/.test(v));
    expect(own).toEqual(["10px"]); // our own mark keeps its shape
    expect(decls(".mark")["border-radius"]).toBe("10px");
  });

  it("draws every tab, segment and chip row one way: bold words, the chosen one in the accent on a 2 px line", () => {
    const families = [".tabs", ".chips", ".seg", ".lvl", ".views", ".mini", ".mvtabs"];
    const shared = rules.find((r) => r.atRules.length === 0 && families.every((f) => r.selectors.includes(`${f} button`)));
    expect(shared?.decls["font-weight"]).toBe("var(--weight-strong)");
    const line = rules.find((r) => r.atRules.length === 0 && families.every((f) => r.selectors.includes(`${f} button::after`)));
    expect(line?.decls.height).toBe("2px");
    expect(line?.decls.background).toBe("var(--color-accent)");
    const chosen = rules.find((r) => r.selectors.includes('.tabs button[aria-selected="true"]') && r.decls.color !== undefined);
    expect(chosen?.decls.color).toBe("var(--color-accent)");
    for (const f of families) {
      expect([f, chosen?.selectors.some((s) => s.startsWith(`${f} button[`))]).toEqual([f, true]);
      // no sheet fills, boxes or re-weighs a chosen tab on its own: the row keeps its width whatever is chosen
      const local = rules.filter((r) => r !== chosen && r.selectors.some((s) => new RegExp(`^(\\.app\\.phone )?\\${f} button\\[aria-`).test(s) && !s.includes("::after") && !s.includes(":hover")));
      for (const r of local) {
        expect([f, r.decls.background, r.decls["font-weight"], r.decls.border]).toEqual([f, undefined, undefined, undefined]);
      }
    }
  });

  it("fills one kind of button only, as a pill; the others are an outline or bold accent words", () => {
    expect(decls(".btn.fill")["border-radius"]).toBe("var(--radius-pill)");
    expect(decls(".btn.ghost").border).toBe("1px solid var(--color-accent)");
    expect(decls(".btn.ghost").background).toBe("none");
    expect(decls(".lnk").color).toBe("var(--color-accent)");
  });

  it("lays lists as flat rows on hairlines and sections as outlines, not as filled boxes", () => {
    for (const sel of [".tr", ".prow", ".nrx-row", ".plan-move", ".mv.full"]) {
      expect([sel, decls(sel).background, decls(sel)["border-bottom"]]).toEqual([sel, "none", "1px solid var(--color-line)"]);
    }
    expect(rules.find((r) => r.selectors.includes(".panel") && r.selectors.includes(".pnl") && r.decls.border !== undefined)?.decls.background).toBe("none");
  });

  it("dims what is under the finger, and not at all for a visitor who asks for less motion", () => {
    for (const sel of [".btn:active", ".lnk:active", ".open:active"]) expect([sel, decls(sel).opacity]).toEqual([sel, "var(--press)"]);
    expect(token("--press")).toBe("0.7");
    const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/--press:\s*1;/);
  });

  it("the loading shimmer stands still under reduced motion and in a hidden tab", () => {
    const still = rules.filter((r) => r.atRules.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)) && r.selectors.includes(".sk"));
    expect(still.map((r) => r.decls.animation)).toEqual(["none"]);
    expect(motion).toMatch(/:root\[data-tab-hidden\] :is\(\.sk, \.sk-hero\) \{\s*animation: none;/);
  });
});

describe("the phone's top bar", () => {
  it("makes room for three buttons: with the bell the pill keeps its dot and word, the age clipped for the eye only", () => {
    const ago = decls(".app.phone .top:has(.bell) .live .ago");
    expect(ago.position).toBe("absolute");
    expect(ago["clip-path"]).toBe("inset(50%)");
    expect(ago.display).toBeUndefined(); // never display: none, a screen reader still reads the age
    // the pill gives way (and its words clip) before a button leaves the screen
    expect(decls(".app.phone .top .live")["min-width"]).toBe("0");
    expect(decls(".app.phone .top .live .lw")["text-overflow"]).toBe("ellipsis");
  });

  it("keeps the brand name visible at any width: only a paused bar gives it up", () => {
    const hides = rules.filter((r) => r.selectors.some((s) => /\.brand .*\.bn$/.test(s)) && r.decls["clip-path"] !== undefined);
    expect(hides.map((r) => [r.selectors, r.atRules])).toEqual([[[".app.phone .top.paused .brand .bn"], []]]);
  });
});

describe("the helpers' sheet (share, similar deals, what can I do with…, selling a card)", () => {
  const own = parse(helpers);

  it("speaks in tokens only: no colour of its own", () => {
    expect(helpers.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });

  it("moves only on the motion tokens, which are 0 ms for a visitor who asks for less motion", () => {
    for (const rule of own) {
      const transition = rule.decls.transition;
      if (transition !== undefined) expect([rule.selectors, /var\(--dur-/.test(transition)]).toEqual([rule.selectors, true]);
      expect(rule.decls.animation).toBeUndefined();
    }
  });

  it("puts the sell bar's meter on its own line of the row", () => {
    expect(decls(".sbt")["grid-area"]).toBe("track");
  });

  it("keeps the similar deals' faces in their own rarity inside a dimmed gone row", () => {
    for (let n = 0; n < 8; n++) {
      const rule = own.find((r) => r.selectors.includes(`.gone .twins .pav.rar-${n}`));
      expect(rule?.decls["--c"]).toBe(`var(--rarity-${n})`);
    }
  });

  it("puts a similar-deals block on its own line of a row's grid", () => {
    for (const selector of [".c-tw", ".tw-row"]) expect(decls(selector)["grid-column"]).toBe("1 / -1");
  });
});

describe("the player's path sheet (your day, first pass, next Rax, the plan, how Real works)", () => {
  const own = parse(routine);

  it("speaks in tokens only: no colour of its own", () => {
    expect(routine.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });

  it("moves only on the motion tokens, and has a reduced-motion path for the tick", () => {
    for (const rule of own) {
      const transition = rule.decls.transition;
      if (transition !== undefined) expect([rule.selectors, /var\(--dur-/.test(transition) || transition === "none"]).toEqual([rule.selectors, true]);
      expect(rule.decls.animation).toBeUndefined();
    }
    expect(routine).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const reduced = own.find((r) => r.atRules.some((a) => /prefers-reduced-motion/.test(a)));
    expect(reduced?.selectors).toEqual(expect.arrayContaining([".rtn-box", ".rtn-box path"]));
    expect(reduced?.decls.transition).toBe("none");
  });

  it("keeps the real checkbox in the page (hidden to the eye only) and shows its focus on the drawn box", () => {
    expect(decls(".rtn-row input").opacity).toBe("0");
    expect(decls(".rtn-row input").display).toBeUndefined();
    expect(decls(".rtn-row input:focus-visible + .rtn-box").outline).toMatch(/accent/);
  });

  it("shows hover only where there is a real hover", () => {
    const loose = own.filter((r) => r.selectors.some((s) => s.includes(":hover")) && r.atRules.length === 0);
    expect(loose).toEqual([]);
  });
});

describe("the meter (every bar and the pills of the site)", () => {
  const own = parse(meter);
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("speaks in tokens only: no colour of its own", () => {
    expect(strip(meter)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });

  it("moves only on the motion tokens, which are 0 ms for a visitor who asks for less motion", () => {
    for (const rule of own) {
      for (const value of [rule.decls.transition, rule.decls.animation]) {
        if (value !== undefined) expect([rule.selectors, /var\(--dur-/.test(value)]).toEqual([rule.selectors, true]);
      }
    }
    for (const token of ["--dur-glide", "--dur-enter"]) {
      expect(tokens).toMatch(new RegExp(`${token}: \\d+ms`));
      expect(tokens.slice(tokens.indexOf("prefers-reduced-motion"))).toMatch(new RegExp(`${token}: 0ms`));
    }
  });

  it("registers --fill as a number so it can glide and grow", () => {
    expect(strip(meter)).toMatch(/@property --fill\s*{[^}]*syntax: "<number>"/);
  });

  it("cuts the fill with clip-path from --fill, so its ends stay round and nothing is laid out again", () => {
    const fill = own.find((r) => r.selectors.includes(".meter > i"));
    expect(fill?.decls["clip-path"]).toMatch(/^inset\(.*var\(--fill\).*round 999px\)$/);
    expect(fill?.decls.width).toBeUndefined();
    expect(fill?.decls.transform).toBeUndefined();
  });

  it("keeps two sizes and two tones, on one track", () => {
    expect(decls(".meter")["block-size"]).toBe("8px");
    expect(decls('.meter[data-size="s"]')["block-size"]).toBe("6px");
    expect(decls('.meter[data-tone="quiet"]')["--meter-color"]).toBe("var(--color-muted)");
    expect(decls(".meter")["--meter-color"]).toBe("var(--color-accent)");
  });
});

describe("the injury tag", () => {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("speaks in tokens only: no colour of its own", () => {
    expect(strip(injury)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });

  it("says it without colour: a filled dot for a player who most likely misses the game, a ring for one who may play", () => {
    expect(decls(".inj::before").background).toBe("currentColor");
    expect(decls('.inj[data-tone="maybe"]::before').background).toBe("transparent");
    expect(decls('.inj[data-tone="maybe"]::before')["box-shadow"]).toMatch(/currentColor/);
  });

  it("does not move: a tag is not an event", () => {
    for (const rule of parse(injury)) {
      expect(rule.decls.transition).toBeUndefined();
      expect(rule.decls.animation).toBeUndefined();
    }
  });
});

describe("class names that belong to one sheet", () => {
  // jsdom lays nothing out, so a class name two sheets both style would pass every other test and break the page
  // (the resale tag once took over `.res`, the search-result class, and filled a table cell).
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const classesOf = (css: string) => new Set([...strip(css).matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!));
  const others = { base, layout, motion, passes, today, alerts, paused, helpers, routine };

  it.each([["meter.css", meter], ["injury.css", injury], ["gate.css", gate]])("%s styles no class another sheet styles", (_name, css) => {
    const mine = classesOf(css);
    for (const [sheet, other] of Object.entries(others)) {
      const theirs = classesOf(other);
      const shared = [...mine].filter((name) => theirs.has(name));
      expect([sheet, shared]).toEqual([sheet, []]);
    }
  });
});

describe("the Discord gate's sheet (the gate screen, the member's line)", () => {
  const own = parse(gate);
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("speaks in tokens only: no colour of its own", () => {
    expect(strip(gate)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });

  it("moves only on its first paint (an entrance of opacity and position), and stands still for less motion", () => {
    for (const rule of own) {
      expect([rule.selectors, rule.decls.transition]).toEqual([rule.selectors, undefined]);
      if (rule.decls.animation) expect(rule.decls.animation).toMatch(/gate-in|none/);
    }
    expect(strip(gate)).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("gives the button 44 px and more to the finger, and Sign out a 44 px hit area on its quiet line", () => {
    expect(px(decls(".gate-go").height)).toBeGreaterThanOrEqual(44);
    expect(decls(".member-out::after").inset).toBe("-14px -8px");
  });

  it("shows focus on the button and on Sign out in the accent", () => {
    expect(decls(".gate-go:focus-visible").outline).toMatch(/accent/);
    expect(decls(".member-out:focus-visible").outline).toMatch(/accent/);
  });

  it("gives the sign-in-from-your-browser sheet 44 px targets, and its link field room to shrink", () => {
    expect(px(decls(".inapp-go").height)).toBeGreaterThanOrEqual(44);
    expect(px(decls(".inapp-copy input").height)).toBeGreaterThanOrEqual(44);
    expect(px(decls(".inapp-copy-go")["min-height"])).toBeGreaterThanOrEqual(44);
    expect(px(decls(".inapp-here")["min-height"])).toBeGreaterThanOrEqual(44);
    expect(decls(".inapp-copy input")["min-width"]).toBe("0");
    expect(decls(".inapp-go:focus-visible").outline).toMatch(/accent/);
    expect(decls(".inapp-here:focus-visible").outline).toMatch(/accent/);
  });

  it("lets nothing push the page wider than a phone", () => {
    expect(decls(".gate-title")["overflow-wrap"]).toBe("anywhere");
    expect(decls(".gate-card")["min-width"]).toBe("0");
    expect(decls(".member-name")["text-overflow"]).toBe("ellipsis");
  });
});
