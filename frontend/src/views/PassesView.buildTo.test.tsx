// "Build to" a rarity on the Passes tab, with its switch turned on for these tests (lib/buildToSwitch.ts): the strip,
// every pass priced at the rarity picked and ranked by Rax a year per Rax, the passes set apart with why, "less
// certain" on a thin rate, the choice kept on the device, and the same working strip on a visitor's free passes.
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_TO_TIERS, passList } from "../data/passList";
import type { Snapshot } from "../data/types";
import { buildToSwitch } from "../lib/buildToSwitch";
import { toBasis } from "../lib/passes";
import { freshDevice, renderApp } from "../test/app";
import { JOKIC, MACKINNON, MCDAVID, OLIVEIRA, PASS_MARKETS, otdOf, passSnapshot, served } from "../test/passScene";

const BUILT = served({ ...toBasis(JOKIC), rate_build: 8, rate_build_from: { bucket: "5-7", rarity: "common", sales: 11 }, rate_bucket: "5-7" });
const THIN = served({ ...toBasis(MCDAVID), rate_build: null, rate_bucket: "7+" });
const MARKETS = PASS_MARKETS.map((m) => (m.key === JOKIC.key ? BUILT : m.key === MCDAVID.key ? THIN : m));
const member = passSnapshot({ otd: otdOf(MARKETS) });

function free(): Snapshot {
  const otd = member.otd;
  const picks = Object.fromEntries(Object.entries(otd.picks).map(([s, keys]) => [s, keys.slice(0, 5)]));
  const named = new Set([...Object.values(picks).flat(), ...Object.values(otd.starters)]);
  return {
    ...member,
    deals: member.deals.slice(0, 3),
    gone: [],
    links: { community: "https://discord.gg/palace", push: null, accounts: false },
    otd: { as_of: otd.as_of, sports: otd.sports, markets: otd.markets.filter((m) => named.has(m.key)), picks, starters: otd.starters },
    locked: {
      deals: 42, risers: 7, fallers: 6, passes: 59, alerts: true, accounts: true,
      by_rarity: { "0": 9, "1": 12, "2": 8, "3": 6, "4": 3, "5": 4, "6": 0, "7": 1 },
    },
  };
}
const ANON = '{"gate":true,"member":false,"state":"anon"}';
const gateFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));

function keep(level: "new" | "regular" | "pro", buildTo: number | null = null) {
  const budget = { new: 1000, regular: 5000, pro: null }[level];
  localStorage.setItem(
    "advisor.prefs.v1",
    JSON.stringify({ sport: "all", budget: 200, level, sort: "best", tab: "passes", passBudget: budget, rarity: null, rarer: false, buildTo }),
  );
}
const saved = () => JSON.parse(localStorage.getItem("advisor.prefs.v1")!) as { buildTo: number | null };
const strip = () => screen.getByRole("radiogroup", { name: "Build to" });
const chip = (name: string) => within(strip()).getByRole("radio", { name });
const table = () => screen.getByRole("table", { name: "Best passes" });
const bestKeys = () =>
  Array.from(table().querySelector("[role=rowgroup]")!.querySelectorAll<HTMLElement>("[data-key]")).map((el) => el.dataset.key);
const hero = () => screen.getByRole("region", { name: /top pick/i });
const filters = (_snap: Snapshot, level: "new" | "regular" | "pro", buildTo: string | null) => ({
  level, budget: { new: 1000, regular: 5000, pro: null }[level], sport: "all", season: level === "new" ? ("past" as const) : ("all" as const),
  soon: false, showAll: false, sort: "soon" as const, query: "", held: new Set<string>(), owned: new Map(), buildTo,
});

describe("Passes, Build to (switch on)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    buildToSwitch.on = true;
  });
  afterEach(() => {
    vi.useRealTimers();
    buildToSwitch.on = false;
    document.getElementById("me")?.remove();
  });

  it("offers Best for each, then Common to Iconic in Real's colours, Best for each picked first", () => {
    keep("pro");
    renderApp({ snap: member, viewport: "desktop", hash: "passes" });
    const chips = within(strip()).getAllByRole("radio");
    expect(chips.map((c) => c.textContent)).toEqual(["Best for each", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mystic", "Iconic"]);
    expect(chip("Best for each")).toHaveAttribute("aria-checked", "true");
    expect(chip("Legendary")).toHaveClass("rchip", "rar-5");
    expect(chip("Best for each")).not.toHaveClass("rar-0");
    // One tab stop: the picked chip.
    expect(chips.filter((c) => c.tabIndex === 0)).toEqual([chip("Best for each")]);
    // Best for each is the list of before: the same passes in the same order.
    expect(bestKeys()).toEqual(passList(member, filters(member, "pro", null)).rows.map((r) => r.market.key));
  });

  it("Legendary prices every pass at Legendary and ranks them by Rax a year per Rax, the sort put aside", () => {
    keep("pro");
    renderApp({ snap: member, viewport: "desktop", hash: "passes" });
    expect(screen.getByRole("button", { name: /^Sort/ })).toBeInTheDocument();
    fireEvent.click(chip("Legendary"));
    expect(chip("Legendary")).toHaveAttribute("aria-checked", "true");
    const want = passList(member, filters(member, "pro", "legendary"));
    expect(bestKeys()).toEqual(want.rows.map((r) => r.market.key));
    const ypr = want.rows.map((r) => r.rung.year_per_rax!);
    expect([...ypr].sort((a, b) => b - a)).toEqual(ypr);
    // MacKinnon's row shows his Legendary rung's cost and year.
    const mac = table().querySelector<HTMLElement>(`[data-key="${MACKINNON.key}"]`)!;
    expect(within(mac).getByText("Legendary")).toBeInTheDocument();
    expect(within(mac).getByText("2,300")).toBeInTheDocument(); // about 2,290
    expect(screen.queryByRole("button", { name: /^Sort/ })).not.toBeInTheDocument();
    expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toContain("Rarity");
    expect(within(table()).queryAllByRole("columnheader").some((h) => h.querySelector("button"))).toBe(false);
    // The top pick is the list's first, said as such.
    expect(within(hero()).getByText("Legendary pass")).toBeInTheDocument();
    expect(within(hero()).getByText(/built to Legendary/)).toBeInTheDocument();
    expect(within(hero()).getByText(/most Rax a year for each Rax it costs/)).toBeInTheDocument();
    expect(saved().buildTo).toBe(5);
  });

  it("sets apart the passes that do not pay back there, behind one Show more, each with its reason", () => {
    keep("pro");
    renderApp({ snap: member, viewport: "desktop", hash: "passes" });
    fireEvent.click(chip("Legendary"));
    expect(table().querySelector(`[data-key="${OLIVEIRA.key}"]`)).toBeNull();
    const n = passList(member, filters(member, "pro", "legendary")).out!.length;
    expect(n).toBeGreaterThan(0);
    const more = screen.getByRole("button", { name: `Show ${n} more` });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(new RegExp(`${n} (pass|passes) (don't|doesn't) pay back at Legendary`))).toBeInTheDocument();
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Hide them" })).toHaveAttribute("aria-expanded", "true");
    const oliveira = table().querySelector<HTMLElement>(`[data-key="${OLIVEIRA.key}"]`)!;
    expect(within(oliveira).getByText("Doesn't pay back within 5 years")).toBeInTheDocument();
    // Show all, the never-paying passes of Best for each, has nothing to do here.
    expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
  });

  it("a pass over the budget at that rarity says so", () => {
    keep("regular");
    renderApp({ snap: member, viewport: "desktop", hash: "passes" });
    fireEvent.click(chip("Iconic"));
    fireEvent.click(screen.getByRole("button", { name: /^Show \d+ more$/ }));
    expect(screen.getAllByText("Over your 5,000 budget").length).toBeGreaterThan(0);
  });

  it("a thin pass reads less certain, in both modes; a measured one does not", () => {
    keep("pro");
    renderApp({ snap: member, viewport: "desktop", hash: "passes" });
    const line = (key: string) => table().querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    expect(within(line(THIN.key)).getByText("Price less certain: too few of any one rarity")).toBeInTheDocument();
    expect(within(line(BUILT.key)).queryByText(/less certain/)).toBeNull();
    fireEvent.click(chip("Rare"));
    expect(within(line(THIN.key)).getByText("Price less certain: too few of any one rarity")).toBeInTheDocument();
    expect(within(line(MACKINNON.key)).queryByText(/less certain/)).toBeNull();
  });

  it("is kept on the device: the next visit opens at Legendary; a choice saved while off is read", () => {
    keep("pro", 5);
    const first = renderApp({ snap: member, viewport: "desktop", hash: "passes" });
    expect(chip("Legendary")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(chip("Best for each"));
    expect(saved().buildTo).toBeNull();
    first.unmount();
    renderApp({ snap: member, viewport: "desktop", hash: "passes" });
    expect(chip("Best for each")).toHaveAttribute("aria-checked", "true");
  });

  it("moves with the arrows, Home and End, choosing as it goes", () => {
    keep("pro");
    renderApp({ snap: member, viewport: "desktop", hash: "passes" });
    fireEvent.keyDown(chip("Best for each"), { key: "ArrowRight" });
    expect(chip("Common")).toHaveAttribute("aria-checked", "true");
    expect(chip("Common")).toHaveFocus();
    fireEvent.keyDown(chip("Common"), { key: "End" });
    expect(chip("Iconic")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(chip("Iconic"), { key: "Home" });
    expect(chip("Best for each")).toHaveAttribute("aria-checked", "true");
  });

  it("on a phone: the strip under the sport tabs, the list's line says the rarity, Show more below", () => {
    keep("regular");
    renderApp({ snap: member, viewport: "phone", hash: "passes" });
    expect(strip()).toBeInTheDocument();
    fireEvent.click(chip("Epic"));
    expect(screen.getByText(/best per sport built to Epic, most Rax a year per Rax first/)).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Best passes" })).getAllByRole("listitem");
    const want = passList(member, filters(member, "regular", "epic")).rows;
    expect(rows.map((r) => r.dataset.key)).toEqual(want.slice(0, 20).map((r) => r.market.key));
    for (const r of rows) expect(r).toHaveTextContent(/Epic · /);
    expect(screen.queryByRole("button", { name: /^Sort/ })).not.toBeInTheDocument();
  });

  it("a visitor gets the working strip on the free passes, from the free snapshot alone, and no join prompt", () => {
    keep("regular");
    const snap = free();
    renderApp({ snap, viewport: "desktop", hash: "passes", me: ANON, gateFetch });
    expect(screen.queryByText(/free with Discord/)).toBeNull();
    fireEvent.click(chip("Legendary"));
    // The free site reads at New, any budget (App.tsx), whatever the device saved.
    const want = passList(snap, { ...filters(snap, "new", "legendary"), budget: null });
    expect(bestKeys()).toEqual(want.rows.map((r) => r.market.key));
    expect(bestKeys().length).toBeGreaterThan(0);
    // Only passes the free snapshot carries.
    const carried = new Set(snap.otd.markets.map((m) => m.key));
    expect(bestKeys().every((k) => carried.has(k!))).toBe(true);
  });

  it("says so when no pass here pays back at the rarity, and offers Best for each", () => {
    keep("pro");
    renderApp({ snap: passSnapshot({ otd: otdOf([OLIVEIRA]) }), viewport: "desktop", hash: "passes" });
    fireEvent.click(chip("Legendary"));
    expect(screen.getByText("No pass here pays back at Legendary.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Best for each" }));
    expect(chip("Best for each")).toHaveAttribute("aria-checked", "true");
  });

  it("each rarity of the strip is one the lists know", () => {
    expect(BUILD_TO_TIERS.length).toBe(7);
  });
});
