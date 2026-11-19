import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { savePrefs } from "../data/prefs";
import motion from "../styles/motion.css?raw";
import { freshDevice, renderApp, seedDevice, setVisibility } from "../test/app";
import { JOKIC, MURRAY, passSnapshot } from "../test/passScene";
import { NOW, sceneSnapshot } from "../test/scene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

// A face wherever a player is named: the photo through our own server, the initials while it loads or when there
// is none. One test per surface that a PlayerAvatar (or, on a drawn card, a CardFace) is there.

const PHOTO = /^\/img\/players\/[a-z]+\/\d+$/;
const faces = (root: Element) => [...root.querySelectorAll<HTMLElement>('[data-testid="avatar"]')];
const photoOf = (face: Element) => face.querySelector("img")?.getAttribute("src");
const press = (name: string | RegExp, root: HTMLElement = document.body) => fireEvent.click(within(root).getByRole("button", { name }));
const min = (n: number) => n * 60_000;
const regular = () => savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "today", passBudget: 5000 });

const passes = passSnapshot();
const openPasses = (o: Parameters<typeof renderApp>[0] = {}) => renderApp({ snap: passes, hash: "passes", ...o });

describe("a face wherever a player is named", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("Today", () => {
    it("Pass worth getting leads with the pass's player, in the pass's rarity", () => {
      regular();
      renderApp({ viewport: "desktop", snap: sceneSnapshot({ otd: passes.otd }) });
      const panel = screen.getByRole("region", { name: "Pass worth getting" });
      const [face] = faces(panel);
      expect(face).toBeDefined();
      expect(face).toHaveClass("pav", "s40");
      expect(face!.className).toMatch(/rar-\d/);
      expect(photoOf(face!)).toMatch(PHOTO);
      expect(face!.querySelector("img")).toHaveAttribute("alt", ""); // the name is written beside it
      expect(faces(panel)).toHaveLength(1);
    });

    it("the Moving today rail keeps its faces", () => {
      renderApp({ viewport: "desktop" });
      const moving = screen.getByRole("region", { name: "Moving today" });
      expect(faces(moving).length).toBe(within(moving).getAllByRole("listitem").length);
    });

    it("the 'You opened' strip shows the face of the deal opened", async () => {
      const { advance } = renderApp({ viewport: "desktop" });
      await advance(5000);
      const best = screen.getByRole("region", { name: "Best deals for you right now" });
      fireEvent.click(within(best).getByRole("link", { name: /Open in Real/ }));
      await advance(5000);
      setVisibility("hidden");
      await advance(min(1));
      setVisibility("visible");
      const strip = screen.getByRole("region", { name: /^You opened/ });
      const [face] = faces(strip);
      expect(face).toHaveClass("pav", "s28");
      expect(face!.className).toMatch(/rar-\d/);
      expect(photoOf(face!)).toMatch(PHOTO);
    });

    it("'Since your last visit' shows the face of the player who moved", () => {
      regular();
      seedDevice({ lastVisitAt: NOW - min(12), follows: ["nba:22", "nba:44"], visits: 1 });
      renderApp({ viewport: "desktop" });
      const note = screen.getByRole("note", { name: "Since your last visit" });
      expect(note).toHaveTextContent("Edwards +31% today");
      const [face] = faces(note);
      expect(face).toHaveClass("pav", "s28");
      expect(photoOf(face!)).toMatch(PHOTO);
    });
  });

  describe("an alert's notice", () => {
    it("names a live deal's player with the face", async () => {
      const { advance } = renderApp({ hash: "deals", search: "?open=105" }); // a deal outside the visitor's level
      await advance(50);
      const notice = screen.getByRole("status", { name: "From your alert" });
      expect(faces(notice)).toHaveLength(1);
      expect(photoOf(faces(notice)[0]!)).toMatch(PHOTO);
    });

    it("shows the deals offered instead with their faces", async () => {
      const { advance } = renderApp({ hash: "deals", search: "?open=999" }); // an id never seen
      await advance(50);
      const notice = screen.getByRole("status", { name: "From your alert" });
      expect(notice).toHaveTextContent("Deals for you instead");
      expect(notice).toHaveTextContent("Ja'Marr Chase");
      expect(faces(notice)).toHaveLength(2);
      expect(photoOf(faces(notice)[0]!)).toMatch(PHOTO);
    });
  });

  describe("player search", () => {
    it("leads every result with the player's face", () => {
      renderApp({ viewport: "phone" });
      fireEvent.click(screen.getByRole("button", { name: "Search a player" }));
      const sheet = screen.getByRole("dialog");
      fireEvent.change(within(sheet).getByRole("searchbox", { name: "Player name" }), { target: { value: "a" } });
      const results = [...sheet.querySelectorAll<HTMLElement>("button.res")];
      expect(results.length).toBeGreaterThan(1);
      for (const result of results) expect(photoOf(faces(result)[0]!)).toMatch(PHOTO);
    });
  });

  describe("Passes", () => {
    it("the top pick's drawn cards carry the photo", () => {
      openPasses({ viewport: "desktop" });
      const hero = screen.getByRole("region", { name: /top pick/i });
      const cards = [...hero.querySelectorAll<HTMLImageElement>(".card .jn.face img")];
      expect(cards.length).toBeGreaterThan(0);
      for (const img of cards) expect(img.getAttribute("src")).toMatch(PHOTO);
    });

    it("every row of the ranked list has a face on a desktop table", () => {
      openPasses({ viewport: "desktop" });
      const rows = screen.getByRole("table", { name: "Best passes" }).querySelectorAll('[role="row"][data-key]');
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) expect(faces(row)).toHaveLength(1);
    });

    it("every row of the ranked list has a face on a phone", () => {
      openPasses({ viewport: "phone" });
      const rows = document.querySelectorAll(".prow.pass");
      expect(rows.length).toBeGreaterThan(1);
      rows.forEach((row) => expect(faces(row)).toHaveLength(1));
    });

    it("the pass sheet draws the card with the photo", () => {
      openPasses({ viewport: "desktop" });
      press(/Open the Nathan MacKinnon/, screen.getByRole("table", { name: "Best passes" }));
      const sheet = screen.getByRole("dialog", { name: /pass$/ });
      expect(sheet.querySelector(".card.p .jn.face img")?.getAttribute("src")).toMatch(PHOTO);
    });

    it("My passes leads with the face", () => {
      local.addPass({ key: JOKIC.key, tier: "common" });
      local.addPass({ key: MURRAY.key, tier: "common" });
      openPasses({ viewport: "desktop" });
      fireEvent.click(screen.getAllByRole("radio", { name: "Regular" })[0]!);
      const mine = screen.getByRole("region", { name: "My passes" });
      press(/Show my 2 passes/, mine);
      expect(faces(mine).length).toBeGreaterThanOrEqual(2);
    });

    it("Cheapest way to start (a phone's Best passes) leads with the face", () => {
      local.addPass({ key: JOKIC.key, tier: "common" });
      openPasses({ viewport: "phone" });
      const panel = screen.getByRole("region", { name: "Cheapest way to start" });
      const picks = panel.querySelectorAll("button.nx");
      expect(picks.length).toBeGreaterThan(0);
      picks.forEach((pick) => expect(faces(pick)).toHaveLength(1));
    });

    it("the add-a-pass picks lead with the face", () => {
      openPasses({ viewport: "desktop" });
      press("Add a pass you own", screen.getByRole("region", { name: "My passes" }));
      const pop = screen.getByRole("dialog", { name: "Add a pass you own" });
      fireEvent.change(within(pop).getByRole("searchbox", { name: "Player or team" }), { target: { value: "jok" } });
      expect(faces(pop)).toHaveLength(1);
      expect(photoOf(faces(pop)[0]!)).toMatch(PHOTO);
    });
  });

  it.each([{ hash: "today" }, { hash: "deals" }, { hash: "prices" }])(
    "every face on $hash is lazy and reserves its box, on a phone and a desktop",
    ({ hash }) => {
      for (const viewport of ["phone", "desktop"] as const) {
        const { unmount } = renderApp({ viewport, hash });
        const imgs = document.querySelectorAll<HTMLImageElement>(".pav img");
        expect(imgs.length, `${hash} ${viewport}`).toBeGreaterThan(0);
        imgs.forEach((img) => {
          expect(img).toHaveAttribute("loading", "lazy");
          const size = [...img.parentElement!.classList].find((c) => /^s\d+$/.test(c))!.slice(1);
          expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual([size, size]);
        });
        unmount();
      }
    },
  );

  it("a photo only ever fades in, and that stops under reduced motion", () => {
    const css = motion.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.pav img[^{]*\{([^{}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/animation:\s*fade-in var\(--dur-base\)/); // --dur-base is 0ms under reduced motion
    expect(/@keyframes fade-in\s*\{[^@]*?\}\s*\}/.exec(css)?.[0]).not.toMatch(/transform/);
  });
});
