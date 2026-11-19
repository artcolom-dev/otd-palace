import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePrefs } from "../data/prefs";
import base from "../styles/base.css?raw";
import layout from "../styles/layout.css?raw";
import passes from "../styles/passes.css?raw";
import today from "../styles/today.css?raw";
import { freshDevice, renderApp } from "../test/app";
import { sceneSnapshot } from "../test/scene";
import { CardFace, PHOTO_RETRY_MS, PHOTO_START_MS, PlayerAvatar, photoUrl, resetPhotoStart, resetPhotos, tintClass } from "./PlayerAvatar";

const avatar = () => screen.getByTestId("avatar");

describe("PlayerAvatar", () => {
  beforeEach(() => resetPhotos());

  it("asks our own server for the photo, by sport and player id", () => {
    expect(photoUrl("nba", 3112335)).toBe("/img/players/nba/3112335");
    expect(photoUrl("a/b", 1)).toBe("/img/players/a%2Fb/1");
    render(<PlayerAvatar sport="mlb" playerId={660271} name="Shohei Ohtani" rarity="rar-5" />);
    const img = avatar().querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/img/players/mlb/660271");
    expect(img.getAttribute("src")).not.toMatch(/^(data:|https?:)/);
  });

  it("loads lazily, at a fixed size, so nothing shifts when it arrives", () => {
    render(<PlayerAvatar sport="mlb" playerId={1} name="A B" />);
    const img = avatar().querySelector("img")!;
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["32", "32"]);
    expect(avatar()).toHaveClass("pav", "s32");
  });

  it("says nothing when the name is next to it, and carries the name when it is not", () => {
    const { unmount } = render(<PlayerAvatar sport="nba" playerId={2} name="Nikola Jokić" />);
    expect(avatar().querySelector("img")).toHaveAttribute("alt", "");
    unmount();
    render(<PlayerAvatar sport="nba" playerId={2} name="Nikola Jokić" labelled={false} />);
    expect(screen.getByRole("img", { name: "Nikola Jokić" })).toBe(avatar().querySelector("img"));
  });

  it("shows the initials on the tint when the photo fails, and does not ask for it again", () => {
    const { unmount } = render(<PlayerAvatar sport="nhl" playerId={33} name="Connor McDavid" rarity="rar-3" />);
    fireEvent.error(avatar().querySelector("img")!);
    expect(avatar().querySelector("img")).toBeNull();
    expect(avatar()).toHaveTextContent("CM");
    expect(avatar()).toHaveClass("ini", "rar-3", tintClass(33));
    expect(avatar()).toHaveAttribute("aria-hidden", "true");
    unmount();
    render(<PlayerAvatar sport="nhl" playerId={33} name="Connor McDavid" />);
    expect(avatar().querySelector("img")).toBeNull(); // the same player drawn again: straight to initials
    expect(avatar()).toHaveTextContent("CM");
  });

  it("asks once more for a missing photo after a while (a fresh server may not know its names yet), never in a loop", () => {
    vi.useFakeTimers();
    try {
      render(<PlayerAvatar sport="nba" playerId={12} name="Nikola Jokić" />);
      fireEvent.error(avatar().querySelector("img")!);
      expect(avatar().querySelector("img")).toBeNull();
      act(() => void vi.advanceTimersByTime(PHOTO_RETRY_MS - 1));
      expect(avatar().querySelector("img")).toBeNull(); // not before the wait is over
      act(() => void vi.advanceTimersByTime(1));
      expect(avatar().querySelector("img")).toHaveAttribute("src", "/img/players/nba/12"); // asked again
      fireEvent.error(avatar().querySelector("img")!);
      expect(avatar()).toHaveTextContent("NJ");
      act(() => void vi.advanceTimersByTime(PHOTO_RETRY_MS * 10));
      expect(avatar().querySelector("img")).toBeNull(); // it stays on the initials
    } finally {
      vi.useRealTimers();
    }
  });

  it("the second ask works for the face on a card too, and a face that loads schedules nothing", () => {
    vi.useFakeTimers();
    try {
      const { container, unmount } = render(<CardFace sport="nba" playerId={13} name="Nikola Jokić" />);
      fireEvent.error(container.querySelector("img")!);
      expect(container.querySelector("img")).toBeNull();
      act(() => void vi.advanceTimersByTime(PHOTO_RETRY_MS));
      expect(container.querySelector("img")).not.toBeNull();
      unmount();
      render(<PlayerAvatar sport="nba" playerId={14} name="Ok Face" />);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the player with the initials alone when the name is not next to it", () => {
    render(<PlayerAvatar sport="golf" playerId={9} name="Scottie Scheffler" photo={false} labelled={false} />);
    expect(screen.getByRole("img", { name: "Scottie Scheffler" })).toHaveTextContent("SS");
  });

  it("asks nothing for a team (its id is no player's)", () => {
    render(<PlayerAvatar sport="nba" playerId={7} name="Denver Nuggets" photo={false} />);
    expect(avatar().querySelector("img")).toBeNull();
    expect(avatar()).toHaveTextContent("DN");
  });

  it("rings the face in the rarity's colour, else a plain line, and tints it by team, else by player", () => {
    render(<PlayerAvatar sport="nba" playerId={10} name="A B" teamId={3} />);
    expect(avatar()).toHaveClass("ring", "tint-3");
    expect(tintClass(-13)).toBe("tint-5");
    expect(tintClass(Number.NaN)).toBe("tint-0");
  });

  it("has no style attribute, photo or initials", () => {
    const { container, rerender } = render(<PlayerAvatar sport="nba" playerId={1} name="A B" rarity="rar-2" size={40} />);
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.innerHTML).not.toMatch(/style=/);
    fireEvent.error(avatar().querySelector("img")!);
    rerender(<PlayerAvatar sport="nba" playerId={1} name="A B" rarity="rar-2" size={40} />);
    expect(container.querySelector("[style]")).toBeNull();
  });
});

describe("CardFace", () => {
  beforeEach(() => resetPhotos());

  it("puts the photo inside the card, and falls back to the monogram", () => {
    const { container } = render(<CardFace sport="nba" playerId={22} name="Nikola Jokić" />);
    const img = container.querySelector(".jn.face img")!;
    expect(img).toHaveAttribute("src", "/img/players/nba/22");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("loading", "lazy");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".jn")).toHaveTextContent("NJ");
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("keeps a team's monogram", () => {
    const { container } = render(<CardFace sport="nba" playerId={5} name="Denver Nuggets" photo={false} mono="DEN" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".jn.sm")).toHaveTextContent("DEN");
  });
});

describe("in the rows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000 });
  });
  afterEach(() => vi.useRealTimers());

  it("leads every deal row on a desktop with the player's face", () => {
    renderApp({ viewport: "desktop", hash: "deals" });
    const rows = within(screen.getByRole("table", { name: "All deals" })).getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const face = within(row).getByTestId("avatar");
      expect(face.querySelector("img")?.getAttribute("src")).toMatch(/^\/img\/players\/[a-z]+\/\d+$/);
      expect(face.querySelector("img")).toHaveAttribute("alt", ""); // the name is right beside it
    }
  });

  it("leads every deal row on a phone with the face, which falls back to initials in place", () => {
    renderApp({ viewport: "phone", hash: "deals" });
    const list = screen.getByRole("list", { name: "All deals" });
    const first = within(list).getAllByRole("listitem")[0]!;
    const face = within(first).getByTestId("avatar");
    expect(face.parentElement).toBe(first); // a cell of the row's grid, where the thumbnail was
    const size = [...face.classList].filter((c) => /^(pav|s\d+|rar-\d)$/.test(c));
    fireEvent.error(face.querySelector("img")!);
    const again = within(first).getByTestId("avatar");
    expect(again.parentElement).toBe(first);
    expect(again.querySelector("img")).toBeNull();
    expect(again.textContent).toMatch(/^[A-Z]{1,2}$/);
    expect(again).toHaveClass(...size, "ini"); // the same frame, the same size: only the photo gave way
  });

  it("puts each top tile's photo in its rarity ring, big on the best one", () => {
    renderApp({ viewport: "desktop", hash: "today" });
    const tops = within(screen.getByRole("region", { name: "Best deals for you right now" })).getAllByRole("listitem");
    const faces = tops.map((t) => within(t).getByTestId("avatar"));
    for (const face of faces) {
      expect(face.className).toMatch(/rar-\d/);
      expect(face.querySelector("img")?.getAttribute("src")).toMatch(/^\/img\/players\//);
    }
    expect(faces[0]).toHaveClass("s76");
    expect(faces[1]).toHaveClass("s56");
  });

  it("leads the price moves with the face", () => {
    renderApp({ viewport: "desktop", hash: "prices" });
    const rows = document.querySelectorAll(".mv.full");
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => expect(row.querySelector(".pav img")).not.toBeNull());
  });

  it("asks for no photo in a sport the server says has none: initials straight away", () => {
    const snap = sceneSnapshot();
    renderApp({ viewport: "desktop", hash: "deals", snap: { ...snap, rules: { ...snap.rules, photo_sports: ["nba"] } } });
    const rows = within(screen.getByRole("table", { name: "All deals" })).getAllByRole("row").slice(1);
    const face = (name: string) =>
      within(rows.find((r) => within(r).getByTestId("player").textContent === name)!).getByTestId("avatar");
    expect(face("Anthony Edwards").querySelector("img")?.getAttribute("src")).toMatch(/^\/img\/players\/nba\//);
    expect(face("Mohamed Salah").querySelector("img")).toBeNull();
    expect(face("Mohamed Salah")).toHaveClass("ini");
    expect(face("Ja'Marr Chase").querySelector("img")).toBeNull();
  });

  it("draws no style attribute in any face or card face of the page", () => {
    const { container } = renderApp({ viewport: "desktop", hash: "deals" });
    for (const el of container.querySelectorAll(".pav, .pav *, .jn, .jn *")) expect(el.hasAttribute("style")).toBe(false);
    for (const img of container.querySelectorAll("img")) expect(img.getAttribute("src")).not.toMatch(/^data:/);
  });
});

// jsdom lays nothing out: the sizes are read from the style sheets (and measured again in Chromium).
function declsOf(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(",").map((s) => s.trim()).includes(selector)) continue;
    for (const part of m[2]!.split(";")) {
      const i = part.indexOf(":");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return out;
}

describe("the face keeps a row's height", () => {
  const sheets = [base, layout, passes, today].join("\n");

  it("is a fixed square that does not grow or shrink", () => {
    const pav = declsOf(base, ".pav");
    expect([pav.width, pav.height, pav.flex, pav.overflow]).toEqual(["32px", "32px", "none", "hidden"]);
    expect([declsOf(base, ".pav.s28").width, declsOf(base, ".pav.s28").height]).toEqual(["28px", "28px"]);
    expect([declsOf(base, ".pav.s40").width, declsOf(base, ".pav.s40").height]).toEqual(["40px", "40px"]);
    expect([declsOf(base, ".pav.s56").width, declsOf(base, ".pav.s56").height]).toEqual(["56px", "56px"]);
    expect([declsOf(base, ".pav.s76").width, declsOf(base, ".pav.s76").height]).toEqual(["76px", "76px"]);
    const img = declsOf(base, ".pav img");
    expect([img.width, img.height, img["object-fit"]]).toEqual(["100%", "100%", "cover"]);
  });

  it("sits in a column as wide as itself, no taller than the thumbnail it replaced (32 px)", () => {
    const firstColumn = (selector: string) => declsOf(sheets, selector)["grid-template-columns"]?.split(" ")[0];
    expect(firstColumn(".prow")).toBe("32px");
    expect(firstColumn(".prow.pass")).toBe("32px");
    expect(firstColumn(".op")).toBe("28px");
    expect(firstColumn(".mp")).toBe("28px");
    expect(firstColumn(".nx")).toBe("28px");
    // No row rule gives the face a size of its own: only its size class does.
    const sized = [...sheets.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /\.pav\b/.test(m[1]!) && !/^\s*\.pav(\.s\d+| img)?\s*$/.test(m[1]!))
      .filter((m) => /(^|;)\s*(width|height|padding|border)\s*:/.test(m[2]!));
    expect(sized.map((m) => m[1]!.trim())).toEqual([]);
  });
});

describe("the first moments of a page", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetPhotoStart(true);
  });

  it("asks for no photo until the page has painted and the code had the line, then asks once", () => {
    vi.useFakeTimers();
    resetPhotoStart(false);
    const { container } = render(<PlayerAvatar sport="mlb" playerId={7} name="Ann Lee" />);
    const img = () => container.querySelector("img");
    expect(img()).not.toBeNull();
    expect(img()?.hasAttribute("src")).toBe(false);
    act(() => void vi.advanceTimersByTime(PHOTO_START_MS));
    expect(img()?.getAttribute("src")).toBe(photoUrl("mlb", 7));
  });
});
