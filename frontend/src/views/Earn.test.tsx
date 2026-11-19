import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePrefs } from "../data/prefs";
import { freshDevice, renderApp, seedDevice } from "../test/app";

// The scene's clock is 12 November 2026: CBB has just started, MLB and WNBA are off.
const level = (l: "new" | "regular" | "pro", tab: "today" | "prices" = "today") =>
  savePrefs({ level: l, budget: 1000, sport: "all", sort: "best", tab, passBudget: 5000 });
const flush = () => act(async () => void (await Promise.resolve()));
const sheet = () => screen.getByRole("dialog", { name: "Earn more Rax" });
const card = () => screen.getByRole("region", { name: "This month in Real" });
const plan = () => within(sheet()).getByRole("tabpanel");

describe("Earn more Rax", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => vi.useRealTimers());

  it.each(["phone", "desktop"] as const)("Today shows this month's move and opens the guide from it (%s)", async (viewport) => {
    const { advance } = renderApp({ viewport });
    expect(card()).toHaveTextContent("CBB");
    expect(card()).toHaveTextContent("Sell this season's new cards");
    fireEvent.click(within(card()).getByRole("button", { name: /Earn more Rax/ }));
    expect(sheet()).toBeInTheDocument();
    expect(location.hash).toBe("#earn");
    fireEvent.click(within(sheet()).getByRole("button", { name: "Close" }));
    await flush();
    await advance(1000);
    expect(screen.queryByRole("dialog", { name: "Earn more Rax" })).toBeNull();
    expect(`${location.pathname}${location.hash}`).toBe("/");
  });

  it("lists every sport's season this month, honest about what it doesn't know", () => {
    renderApp({ viewport: "desktop", hash: "earn" });
    const clock = within(sheet()).getByRole("list", { name: "Season clock" });
    const rows = within(clock).getAllByRole("listitem");
    expect(rows).toHaveLength(10);
    expect(rows[0]).toHaveTextContent(/CBB.*Just started/);
    const mlb = rows.find((r) => r.textContent?.startsWith("MLB"))!;
    expect(mlb).toHaveTextContent("Off-season");
    expect(mlb).toHaveTextContent("Don't sell now");
    expect(sheet()).toHaveTextContent(/months, not exact days/i);
  });

  it("opens at the plan of the visitor's level, and the tabs switch with a tap or the arrows", () => {
    level("pro");
    renderApp({ viewport: "desktop", hash: "earn" });
    const tabs = within(sheet()).getByRole("tablist", { name: "Your plan" });
    expect(within(tabs).getByRole("tab", { selected: true })).toHaveTextContent("Growing");
    expect(plan()).toHaveTextContent("Skip Rare");
    expect(plan()).toHaveTextContent("Worked out from Real's rules");
    fireEvent.click(within(tabs).getByRole("tab", { name: "New" }));
    expect(plan()).toHaveTextContent("free player pass");
    expect(plan()).toHaveTextContent("A rough guess");
    fireEvent.keyDown(within(tabs).getByRole("tab", { name: "New" }), { key: "End" });
    expect(within(tabs).getByRole("tab", { selected: true })).toHaveTextContent("Big");
    expect(within(tabs).getByRole("tab", { name: "Big" })).toHaveFocus();
    expect(plan()).toHaveTextContent("Breadth before depth");
    expect(plan()).toHaveTextContent("Measured on real accounts");
  });

  it("a typed balance picks the plan over the level", () => {
    level("new");
    seedDevice({ balance: 150_000 });
    renderApp({ viewport: "desktop", hash: "earn" });
    expect(within(sheet()).getByRole("tab", { selected: true })).toHaveTextContent("Big");
  });

  it("names the costly mistakes, a General bought to claim with among them, now confirmed", () => {
    renderApp({ viewport: "desktop", hash: "earn" });
    const list = within(sheet()).getByRole("list", { name: "Mistakes that cost Rax" });
    expect(list).toHaveTextContent("Levelling to Rare and stopping");
    const general = within(list).getAllByRole("listitem").find((li) => li.textContent?.includes("General"))!;
    expect(general).toHaveTextContent("General pays nothing On This Day");
    expect(general).not.toHaveTextContent("Not confirmed");
  });

  it("works out a sale after fees, normal listing against Quick List", () => {
    renderApp({ viewport: "desktop", hash: "earn" });
    const calc = within(sheet()).getByRole("group", { name: "What a sale leaves you" });
    fireEvent.change(within(calc).getByRole("textbox", { name: "Sale price" }), { target: { value: "100" } });
    expect(within(calc).getByText("Normal listing").parentElement).toHaveTextContent("80 Rax");
    expect(within(calc).getByText("Quick List").parentElement).toHaveTextContent("90 Rax");
    fireEvent.change(within(calc).getByRole("textbox", { name: "Sale price" }), { target: { value: "abc" } });
    expect(calc).toHaveTextContent("Type a price");
  });

  it("says when to cash the daily streak, from the visitor's hit rate", () => {
    renderApp({ viewport: "desktop", hash: "earn" });
    const calc = within(sheet()).getByRole("group", { name: "Daily streak" });
    const field = within(calc).getByRole("spinbutton", { name: /right/ });
    fireEvent.change(field, { target: { value: "60" } });
    expect(calc).toHaveTextContent("Ride to 8 in a row");
    expect(calc).toHaveTextContent("about 2.2 Rax a day per sport");
    fireEvent.change(field, { target: { value: "45" } });
    expect(calc).toHaveTextContent("Cash out at 2 in a row");
  });

  it("is in the footer of every tab", () => {
    level("new", "prices");
    renderApp({ viewport: "desktop", hash: "prices" });
    fireEvent.click(screen.getByRole("button", { name: "Earn more Rax" }));
    expect(sheet()).toBeInTheDocument();
  });

  it("opens when the address changes to it", () => {
    renderApp({ viewport: "phone" });
    act(() => {
      history.replaceState(null, "", "#earn");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(sheet()).toBeInTheDocument();
  });
});
