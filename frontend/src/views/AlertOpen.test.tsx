import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackOut } from "../lib/track";
import { freshDevice, renderApp } from "../test/app";
import { isoAt, makeDeal } from "../test/fixtures";
import { NOW, sceneSnapshot } from "../test/scene";

vi.mock("../lib/track", () => ({ trackOut: vi.fn() }));

// A notification opens /?open=<listing_id>#deals: the app scrolls to that row and lights it up, or says the deal is
// gone and shows the nearest similar one.

const scrolled = vi.fn();
const row = (key: string) => document.querySelector<HTMLElement>(`[data-key="${key}"]`);
const notice = () => screen.getByRole("status", { name: "From your alert" });

describe("opening the site from an alert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freshDevice();
    Element.prototype.scrollIntoView = scrolled as unknown as Element["scrollIntoView"];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("scrolls to the deal and lights it up, then cleans the address", async () => {
    const { advance } = renderApp({ hash: "deals", search: "?open=104", viewport: "desktop" });
    await advance(50);
    expect(row("104:target")).toHaveClass("alerted");
    expect(scrolled.mock.contexts).toContain(row("104:target"));
    expect(screen.queryByRole("status", { name: "From your alert" })).toBeNull(); // nothing to explain
    expect(location.search).toBe("");
    expect(`${location.pathname}${location.hash}`).toBe("/deals");
    await advance(8000);
    expect(row("104:target")).not.toHaveClass("alerted"); // the light fades, the row stays
  });

  it("works on a phone's list too", async () => {
    const { advance } = renderApp({ hash: "deals", search: "?open=101", viewport: "phone" });
    await advance(50);
    expect(row("101:target")).toHaveClass("alerted");
  });

  it("opening the deal the alert was about counts as a click from an alert", async () => {
    const { advance } = renderApp({ hash: "deals", search: "?open=104", viewport: "desktop" });
    await advance(50);
    fireEvent.click(within(row("104:target")!).getByRole("link", { name: /Open/ }));
    expect(trackOut).toHaveBeenCalledWith(expect.objectContaining({ panel: "alert", target: "listing" }));
    fireEvent.click(within(row("101:target")!).getByRole("link", { name: /Open/ }));
    expect(trackOut).toHaveBeenLastCalledWith(expect.objectContaining({ panel: "deals" }));
  });

  const goneRow = (reason: "countdown_started" | "ended") => ({
    ...makeDeal({ now: NOW, listing_id: 120, sport: "nba", player_id: 22, player_name: "Nikola Jokić", price: 90 }),
    reason,
    gone_at: isoAt(NOW - 20_000),
  });

  it("a deal that left the list but may still be open in Real is not called gone", async () => {
    const { advance } = renderApp({ hash: "deals", search: "?open=120", snap: sceneSnapshot({ gone: [goneRow("countdown_started")] }) });
    await advance(50);
    expect(notice()).toHaveTextContent("This is no longer a deal");
    expect(notice()).not.toHaveTextContent("gone");
    expect(notice()).toHaveTextContent("Someone started the countdown.");
    expect(within(notice()).getByRole("link", { name: /Open in Real/ })).toHaveAttribute("href", goneRow("ended").url);
    // a deal that went away is never a dead end: deals like it, each one an auction to open
    const similar = within(notice()).getByRole("list", { name: "Similar deals" });
    expect(within(similar).getAllByRole("link").map((a) => a.getAttribute("aria-label"))).toEqual([
      "Anthony Edwards, NBA 2025-26 · 5.9 rating: 70 to start, 26% cheaper. Opens in Real",
    ]);
  });

  it("says the deal is gone only when its auction ended", async () => {
    const { advance } = renderApp({ hash: "deals", search: "?open=120", snap: sceneSnapshot({ gone: [goneRow("ended")] }) });
    await advance(50);
    expect(notice()).toHaveTextContent("This deal is gone");
    expect(within(notice()).queryByRole("link", { name: /^Open in Real/ })).toBeNull();
    expect(within(notice()).getByRole("list", { name: "Similar deals" })).toHaveTextContent("Anthony Edwards");
  });

  it("an id the page has never seen is not called gone either, and the best deals are offered instead", async () => {
    const { advance } = renderApp({ hash: "deals", search: "?open=999" });
    await advance(50);
    expect(notice()).toHaveTextContent("We no longer list this deal");
    expect(notice()).not.toHaveTextContent("gone");
    const list = within(notice()).getByRole("list", { name: "Deals for you instead" });
    expect(within(list).getAllByRole("link")[0]).toHaveAccessibleName(/^Ja'Marr Chase, .*Opens in Real$/);
  });

  it("a deal outside the visitor's level or budget says so, with a link to it in Real", async () => {
    const { advance } = renderApp({ hash: "deals", search: "?open=105" });
    await advance(50);
    expect(notice()).toHaveTextContent("This deal is outside your level or budget.");
    const link = within(notice()).getByRole("link", { name: /Open in Real/ });
    expect(link).toHaveAttribute("href", sceneSnapshot().deals.find((d) => d.listing_id === 105)!.url);
    expect(link).toHaveAttribute("target", "_blank");
    fireEvent.click(link);
    expect(trackOut).toHaveBeenCalledWith(expect.objectContaining({ panel: "alert", target: "listing" }));
  });

  it("the notice can be put away", async () => {
    const { advance } = renderApp({ hash: "deals", search: "?open=999" });
    await advance(50);
    fireEvent.click(within(notice()).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status", { name: "From your alert" })).toBeNull();
  });

  it("an address that is not a listing id is ignored", async () => {
    const { advance } = renderApp({ hash: "deals", search: "?open=abc" });
    await advance(50);
    expect(screen.queryByRole("status", { name: "From your alert" })).toBeNull();
    expect(location.search).toBe("");
  });
});
