// The free site's tabs: what each shows from the free snapshot, and its one prompt to unlock the rest. A member's
// snapshot (no `locked`) shows none of these prompts.
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "./data/types";
import { freshDevice, renderApp, seedDevice } from "./test/app";
import { sceneSnapshot } from "./test/scene";

vi.mock("./lib/track", () => ({ trackOut: vi.fn() }));

const ANON = '{"gate":true,"member":false,"state":"anon"}';
const MEMBER = '{"gate":true,"member":true,"state":"in"}';
const gate = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));

function freeSnapshot(): Snapshot {
  const whole = sceneSnapshot();
  return {
    ...whole,
    deals: whole.deals.slice(0, 3),
    gone: [],
    links: { community: null, push: null, accounts: false },
    locked: { deals: 42, risers: 7, fallers: 6, passes: 59, alerts: true, accounts: true },
  };
}

describe("the free site's tabs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.getElementById("me")?.remove();
  });

  it("Deals: the free deals whatever this device chose, no sort or sport tabs, then See all 42 deals", () => {
    seedDevice({ follows: ["nba:1"] });
    renderApp({ snap: freeSnapshot(), me: ANON, gateFetch: gate(), hash: "deals", viewport: "desktop" });
    expect(screen.getByRole("heading", { name: /more deals are hidden/ })).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
    // The sort, the sport tabs and the level and budget filters come with Discord.
    expect(document.querySelector(".sortbtn")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Filter by player or sport" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("Prices: the summary of the moves, then See all 13 price moves", () => {
    renderApp({ snap: freeSnapshot(), me: ANON, gateFetch: gate(), hash: "prices" });
    expect(screen.getByRole("heading", { name: "Prices moving today" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "See all 13 price moves" })).toBeInTheDocument();
  });

  it("Your plan: what linking an account gives, and the way in", () => {
    renderApp({ snap: freeSnapshot(), me: ANON, gateFetch: gate(), hash: "plan" });
    expect(screen.getByRole("heading", { name: "Link your Real account for your own plan" })).toBeInTheDocument();
    expect(screen.queryByText("Where are you with Real?")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Unlock it all free/ })).toHaveAttribute(
      "href", expect.stringMatching(/^\/auth\/discord\?next=/));
  });

  it("a member's tabs carry no prompt at all", () => {
    renderApp({ me: MEMBER, gateFetch: gate(), hash: "deals", viewport: "desktop" });
    expect(screen.queryByRole("heading", { name: /^See all/ })).not.toBeInTheDocument();
    expect(document.querySelector(".sortbtn")).not.toBeNull();
    expect(screen.getByRole("tablist", { name: "Filter by player or sport" })).toBeInTheDocument();
    expect(screen.getAllByRole("radiogroup").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /Unlock it all free/ })).not.toBeInTheDocument();
  });
});
