import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { local } from "../data/local";
import { savePrefs } from "../data/prefs";
import { animate, freshDevice, renderApp } from "../test/app";
import { sceneSnapshot } from "../test/scene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

const page = () => screen.getByRole("region", { name: "Prices moving today" });
const tabs = () => within(page()).getByRole("tablist", { name: "Risers or fallers" });
const rows = () => within(page()).getAllByRole("listitem");
const names = () => rows().map((r) => within(r).getByTestId("move-player").textContent);
const row = (name: string) => rows().find((r) => within(r).queryByText(name)) as HTMLElement;
const calls = () => animate.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions | undefined][];
const regular = (sport = "all") =>
  savePrefs({ level: "regular", budget: 1000, sport, sort: "best", tab: "prices", passBudget: 5000 });

describe("Prices: the moves of today", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("opens on the risers, biggest first, each with its sport, typical sale today ← last 7 days, change and sales", () => {
    renderApp({ hash: "prices", viewport: "desktop" });
    expect(screen.getByRole("heading", { name: "Prices moving today", level: 1 })).toBeInTheDocument();
    expect(within(tabs()).getByRole("tab", { name: "Risers" })).toHaveAttribute("aria-selected", "true");
    expect(names()).toEqual(["Ja'Marr Chase", "Anthony Edwards", "Mohamed Salah", "Macklin Celebrini", "Josh Allen"]);
    const chase = row("Ja'Marr Chase");
    expect(chase).toHaveTextContent("NFL");
    expect(within(chase).getByTestId("move-prices")).toHaveTextContent("236 ← 168");
    expect(within(chase).getByTestId("move-change")).toHaveTextContent("+41%");
    expect(within(chase).getByTestId("move-change")).toHaveClass("up");
    expect(chase).toHaveTextContent("52 sales today");
    expect(row("Josh Allen")).toHaveTextContent("1 sale today");
    expect(within(chase).getByRole("button", { name: "Follow Ja'Marr Chase" })).toBeInTheDocument();
    expect(page()).toHaveTextContent("Typical sale in Rax: today ← last 7 days");
  });

  it("shows the fallers, in red with a real minus", () => {
    renderApp({ hash: "prices" });
    fireEvent.click(within(tabs()).getByRole("tab", { name: "Fallers" }));
    expect(within(tabs()).getByRole("tab", { name: "Fallers" })).toHaveAttribute("aria-selected", "true");
    expect(names()).toEqual(["Connor McDavid", "Nikola Jokić"]);
    const jokic = row("Nikola Jokić");
    expect(within(jokic).getByTestId("move-prices")).toHaveTextContent("49 ← 63");
    expect(within(jokic).getByTestId("move-change")).toHaveTextContent("−22%");
    expect(within(jokic).getByTestId("move-change")).toHaveClass("down");
  });

  it("moves between Risers and Fallers with the arrow keys", () => {
    renderApp({ hash: "prices", viewport: "desktop" });
    const risers = within(tabs()).getByRole("tab", { name: "Risers" });
    expect(risers).toHaveAttribute("tabindex", "0");
    expect(within(tabs()).getByRole("tab", { name: "Fallers" })).toHaveAttribute("tabindex", "-1");
    risers.focus();
    fireEvent.keyDown(risers, { key: "ArrowRight" });
    const fallers = within(tabs()).getByRole("tab", { name: "Fallers" });
    expect(fallers).toHaveAttribute("aria-selected", "true");
    expect(fallers).toHaveFocus();
  });

  it("links a row to that player's deals: their sport, and the search set to them", () => {
    regular();
    renderApp({ hash: "prices", viewport: "desktop" });
    fireEvent.click(within(tabs()).getByRole("tab", { name: "Fallers" }));
    fireEvent.click(within(row("Nikola Jokić")).getByRole("link", { name: /^See deals for Nikola Jokić/ }));
    expect(`${location.pathname}${location.hash}`).toBe("/deals");
    expect(screen.getByRole("heading", { name: "All deals", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Showing", { exact: false })).toHaveTextContent("Showing Nikola Jokić");
    expect(screen.getByRole("tab", { name: /NBA/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByTestId("player").map((p) => p.textContent)).toEqual(["Nikola Jokić"]);
  });

  it("follows a player from its star", () => {
    renderApp({ hash: "prices" });
    fireEvent.click(within(row("Anthony Edwards")).getByRole("button", { name: "Follow Anthony Edwards" }));
    expect(local.get().follows).toEqual(["nba:44"]);
    expect(within(row("Anthony Edwards")).getByRole("button", { name: "Unfollow Anthony Edwards" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("respects the sport filter, with a tab per sport counting its moves", () => {
    regular("nfl");
    renderApp({ hash: "prices", viewport: "desktop" });
    expect(names()).toEqual(["Ja'Marr Chase", "Josh Allen"]);
    const sports = within(page()).getByRole("tablist", { name: "Filter by player or sport" });
    expect(within(sports).getByRole("tab", { name: /NFL/ })).toHaveTextContent("NFL2");
    fireEvent.click(within(sports).getByRole("tab", { name: /NHL/ }));
    expect(names()).toEqual(["Macklin Celebrini"]);
  });

  it("says so when there are not enough sales yet", () => {
    regular("soccer");
    renderApp({ hash: "prices" });
    fireEvent.click(within(tabs()).getByRole("tab", { name: "Fallers" }));
    expect(page()).toHaveTextContent("Not enough sales yet today.");
    expect(within(page()).queryAllByRole("listitem")).toEqual([]);
  });

  it("says so with no moves at all", () => {
    renderApp({ hash: "prices", snap: sceneSnapshot({ moves: { risers: [], fallers: [] } }) });
    expect(page()).toHaveTextContent("Not enough sales yet today.");
  });

  it("draws its arrows in when it appears", () => {
    renderApp({ hash: "prices", viewport: "desktop" });
    const drawn = calls().filter(([frames]) => JSON.stringify(frames).includes("strokeDashoffset"));
    expect(drawn).toHaveLength(5);
  });

  it("only fades them in for a visitor who asks for less motion", () => {
    renderApp({ hash: "prices", viewport: "desktop", reducedMotion: true });
    expect(calls().filter(([, options]) => options?.delay !== undefined).length).toBeGreaterThan(0);
    for (const [frames] of calls()) expect(JSON.stringify(frames)).not.toContain("strokeDashoffset");
  });
});
