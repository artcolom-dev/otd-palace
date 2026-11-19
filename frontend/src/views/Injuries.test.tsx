import { render, screen, within } from "@testing-library/react";
import { InjuryTag } from "../components/InjuryTag";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Prefs, savePrefs } from "../data/prefs";
import { seedDevice } from "../test/app";
import type { Injury } from "../data/types";
import { freshDevice, renderApp } from "../test/app";
import { sceneDeals, sceneSnapshot } from "../test/scene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const prefs = (over: Partial<Prefs> = {}) =>
  savePrefs({ level: "regular", budget: 1000, sport: "all", sort: "best", tab: "deals", passBudget: 5000, ...over });
const OUT: Injury = { status: "out", part: "Knee", back: "2026-11-18" };
const DAY: Injury = { status: "day", part: "Foot", back: "2026-11-16" };
const OUT_LINE = "Out · knee · back about Nov 18";
const DAY_LINE = "Day-to-day · foot · back about Nov 16";

/** The scene's deals, with ESPN's note on two of them: Chase (NFL, 160) is out, Edwards (NBA, 70) day-to-day. */
function hurtScene(injurySports: string[] | null = ["nba", "nfl"]) {
  const deals = sceneDeals().map((d) =>
    d.player_name === "Ja'Marr Chase" ? { ...d, injury: OUT } : d.player_name === "Anthony Edwards" ? { ...d, injury: DAY } : d,
  );
  const snap = sceneSnapshot({ deals });
  if (injurySports) snap.rules = { ...snap.rules, injury_sports: injurySports };
  return snap;
}
const table = () => screen.getByRole("table", { name: "All deals" });
const row = (name: string) =>
  within(table()).getAllByRole("row").slice(1).find((r) => within(r).getByTestId("player").textContent === name)!;

describe("Hurt players on the deals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("tags a deal whose player ESPN lists as hurt, in plain words with what hurts and when they may be back", () => {
    prefs();
    renderApp({ snap: hurtScene(), viewport: "desktop" });
    expect(within(row("Ja'Marr Chase")).getByRole("button", { name: OUT_LINE })).toHaveTextContent("Out");
    expect(within(row("Anthony Edwards")).getByRole("button", { name: DAY_LINE })).toHaveTextContent("Day-to-day");
    expect(within(row("Connor McDavid")).queryByRole("button", { name: /Out|Day-to-day/ })).toBeNull(); // no note, no tag
  });

  it("tags a deal in the phone list too, as a word and not a button too small to tap", () => {
    prefs();
    renderApp({ snap: hurtScene(), viewport: "phone" });
    const item = within(screen.getByRole("list", { name: "All deals" })).getAllByRole("listitem").find((li) => li.textContent?.includes("Chase"))!;
    expect(within(item).getByText("Out").closest(".inj")).toHaveTextContent(OUT_LINE);
    expect(within(item).queryByRole("button", { name: OUT_LINE })).toBeNull();
  });

  it("hides from New a player who most likely misses the next game, keeps one who may play, and says what it hid", () => {
    prefs({ level: "new", budget: 200 });
    renderApp({ snap: hurtScene(), viewport: "desktop" });
    expect(screen.queryByText("Ja'Marr Chase")).not.toBeInTheDocument();
    expect(within(row("Anthony Edwards")).getByRole("button", { name: DAY_LINE })).toBeInTheDocument();
    expect(screen.getByTestId("hurt-note")).toHaveTextContent("1 deal is hidden because its player is hurt. Regular shows it with a tag.");
  });

  it("says nothing about hidden deals to a level that hides none, nor when nothing was hidden", () => {
    prefs();
    renderApp({ snap: hurtScene(), viewport: "desktop" });
    expect(screen.queryByTestId("hurt-note")).toBeNull();
  });

  it("says which sports the notes cover, so a deal with no tag is not taken for a healthy one", () => {
    prefs();
    renderApp({ snap: hurtScene(["nba", "nfl", "wnba"]), viewport: "desktop" });
    expect(screen.getByTestId("injury-coverage")).toHaveTextContent("Injury notes come from ESPN and cover NBA, NFL and WNBA only. No tag does not mean healthy.");
  });

  it("says nothing of injuries when the server sent no list (the sample data, or ESPN out of reach)", () => {
    prefs();
    renderApp({ snap: hurtScene(null), viewport: "desktop" });
    expect(screen.queryByTestId("injury-coverage")).toBeNull();
    renderApp({ snap: hurtScene([]), viewport: "desktop" });
    expect(screen.queryByTestId("injury-coverage")).toBeNull();
  });
});

describe("Hurt players where a deal is looked for in another way", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("says what New hid on the My players tab too: a followed hurt player is not silently missing", () => {
    prefs({ level: "new", budget: 200, sport: "mine" });
    seedDevice({ follows: ["nfl:11"], welcomeDismissed: true }); // Chase, who is out
    renderApp({ snap: hurtScene(), viewport: "desktop", hash: "deals" });
    expect(screen.getByTestId("hurt-note")).toHaveTextContent("1 deal is hidden because its player is hurt.");
  });

  it("tells a visitor who taps an alert for a deal whose player has since got hurt why it is not on their list", async () => {
    prefs({ level: "new", budget: 200 });
    const { advance } = renderApp({ snap: hurtScene(), viewport: "desktop", hash: "deals", search: "?open=101" });
    await advance(50);
    const notice = screen.getByRole("status", { name: "From your alert" });
    expect(notice).toHaveTextContent("This player is hurt now.");
    expect(notice).toHaveTextContent("Out · knee · back about Nov 18");
    expect(notice).not.toHaveTextContent("outside your level or budget");
    expect(within(notice).getByRole("link", { name: /Open in Real/ })).toBeInTheDocument();
  });

  it("keeps the old words for a deal that is outside the level for any other reason", async () => {
    prefs({ level: "new", budget: 200 });
    const { advance } = renderApp({ snap: hurtScene(), viewport: "desktop", hash: "deals", search: "?open=105" });
    await advance(50);
    expect(screen.getByRole("status", { name: "From your alert" })).toHaveTextContent("This deal is outside your level or budget.");
  });
});

describe("The tag", () => {
  it("shows nothing for a note it does not understand rather than crash the page", () => {
    const { container } = render(<InjuryTag injury={{ status: "probable" } as never} inert />);
    expect(container).toBeEmptyDOMElement();
  });
});
