import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdminStats, AdminView, pct } from "./AdminView";

function day(i: number) {
  const d = new Date(Date.UTC(2026, 9, 20 + i));
  return d.toISOString().slice(0, 10);
}

export const STATS: AdminStats = {
  today: "2026-11-18",
  window_days: 30,
  active: { dau: 12, wau: 40, mau: 95, kept: 120, over: 0 },
  members: { dau: 3, wau: 9, mau: 20, kept: 22 },
  daily: Array.from({ length: 30 }, (_, i) => ({
    day: day(i), active: 5 + i, new: 2, returning: 3 + i, members: 1, loads: 9, clicks: 4, signin: 1,
    discord: i === 29 ? 415 : null, over: 0,
  })),
  weekly: Array.from({ length: 12 }, (_, i) => ({ week: day(i * 7 - 70), active: 10 + i })),
  cohorts: Array.from({ length: 12 }, (_, i) => ({
    week: day(i * 7 - 70), size: i === 11 ? 0 : 10, d1: i < 11 ? 0.5 : null, d7: i < 10 ? 0.3 : null,
    d14: i < 9 ? 0.2 : null, d30: i < 7 ? 0.1 : null,
  })),
  member_cohorts: Array.from({ length: 12 }, (_, i) => ({ week: day(i * 7 - 70), size: 0, d1: null, d7: null, d14: null, d30: null })),
  funnel: [
    { key: "visit", count: 95 }, { key: "signin", count: 30 }, { key: "signed_in", count: 25 },
    { key: "in_server", count: 22 }, { key: "linked", count: 10 }, { key: "alerts", count: 4 },
  ],
  logins: { signin: 31, started: 33, finished: 26 },
  totals: { linked: 14, pings: 6, push: 3 },
  tabs: [{ tab: "deals", views: 300 }, { tab: "today", views: 120 }],
  devices: { phone: 70, tablet: 5, desktop: 20, app: 18, total: 95 },
  sources: {
    ref: [{ key: "direct", loads: 200 }, { key: "google.com", loads: 30 }],
    tag: [{ key: "launch", loads: 12 }],
    new: [{ key: "direct", new: 50, d1: 0.2, d7: 0.1 }, { key: "?launch", new: 8, d1: 0.5, d7: null }],
  },
  clicks: { total: 120, by_panel: [{ panel: "deals", count: 80 }, { panel: "otd", count: 40 }] },
  discord: [{ day: "2026-11-17", members: 410 }, { day: "2026-11-18", members: 415 }],
};

const answering = (status: number, body: unknown = STATS) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("the admin panel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks for the figures with the session, not from a cache", async () => {
    const fetchImpl = answering(200);
    render(<AdminView fetchImpl={fetchImpl} />);
    await screen.findByText("Active devices");
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/stats", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("shows the headline figures, the funnel with its shares and the cohorts", async () => {
    render(<AdminView fetchImpl={answering(200)} />);
    const tiles = await screen.findByRole("list", { name: "Headline figures" });
    expect(within(tiles).getByText("Today").closest("li")).toHaveTextContent("12");
    expect(within(tiles).getByText("Last 30 days").closest("li")).toHaveTextContent("95");
    expect(within(tiles).getByText("Discord members").closest("li")).toHaveTextContent("415");
    const funnel = screen.getByRole("list", { name: "Funnel" });
    expect(within(funnel).getByText("Linked a Real account").closest("li")).toHaveTextContent("10");
    expect(within(funnel).getByText("Linked a Real account").closest("li")).toHaveTextContent("11%");
    const cohorts = screen.getByRole("table", { name: "Device retention by week of first visit" });
    expect(within(cohorts).getAllByRole("row")).toHaveLength(13);
    expect(within(cohorts).getAllByText("50%").length).toBeGreaterThan(0);
    expect(screen.getByText("google.com")).toBeInTheDocument();
    expect(screen.getAllByText("?launch")).toHaveLength(2); // the tag, and the source of new devices
  });

  it("says plainly when the account may not see it, or the server failed", async () => {
    const { unmount } = render(<AdminView fetchImpl={answering(403, { error: "forbidden" })} />);
    expect(await screen.findByText(/not for this account/i)).toBeInTheDocument();
    unmount();
    render(<AdminView fetchImpl={vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("offline")))} />);
    await waitFor(() => expect(screen.getByText(/could not load/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("asks to sign in when there is no session", async () => {
    render(<AdminView fetchImpl={answering(401, { error: "discord_required" })} />);
    expect(await screen.findByRole("link", { name: "Continue with Discord" })).toHaveAttribute("href", "/auth/discord?next=%2Fadmin");
  });

  it("warns when the device table is full, and only then", async () => {
    const { unmount } = render(<AdminView fetchImpl={answering(200)} />);
    await screen.findByText("Active devices");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();
    render(<AdminView fetchImpl={answering(200, { ...STATS, active: { ...STATS.active, over: 7 } })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("7 new devices");
  });

  it("rounds shares, and shows a dash for none", () => {
    expect(pct(0.1234)).toBe("12%");
    expect(pct(null)).toBe("–");
    expect(pct(10, 95)).toBe("11%");
    expect(pct(3, 0)).toBe("–");
  });
});
