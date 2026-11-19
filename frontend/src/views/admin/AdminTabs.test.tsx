import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATS } from "../AdminView.test";
import { AdminView, tabFromHash } from "../AdminView";
import type { AccountsReport, DiscordReport, FeaturesReport, MemberRow, MembersReport, SourcesReport, Timeline } from "./api";
import { sortAccounts } from "./AccountsTab";
import { statusWords } from "./DiscordTab";
import { localHours } from "./FeaturesTab";
import { NO_FILTER, describe as say, pickMembers } from "./MembersTab";
import { ago, duration } from "./parts";

const NOW = 1_795_000_000;
const member = (over: Partial<MemberRow>): MemberRow => ({
  uid: "111122223333444455", name: "Deal Hunter", avatar: null, first: NOW - 10 * 86400, last: NOW - 600, days: 4,
  sessions: 9, time_s: 1800, devices: 2, source: "?tiktok", in_server: true, state: "in", linked: "kingcards",
  type: "Strong", year: 12000, passes: 340, sports: ["nba"], pings: true, push: false, roles: ["Linked", "NBA"],
  messages: 12, lookups: 3, active_7d: true, ...over,
});
const MEMBERS: MembersReport = {
  now: NOW,
  members: [
    member({}),
    member({ uid: "999988887777666655", name: "Quiet One", linked: null, type: null, year: null, passes: null,
             last: NOW - 20 * 86400, active_7d: false, source: "direct", in_server: false, sessions: 1, lookups: 0 }),
  ],
};
const TIMELINE: Timeline = {
  member: MEMBERS.members[0]!,
  devices: 2,
  items: [
    { ts: NOW - 60, from: "site", kind: "sheet", arg: "how-it-works", n: null, state: "in", cls: "phone", device: 1 },
    { ts: NOW - 120, from: "lookup", kind: "ok", arg: "bigwhale", n: 2400 },
    { ts: NOW - 86400, from: "discord", kind: "role+", arg: "NBA", n: null },
    { ts: NOW - 86400 - 60, from: "messages", kind: "messages", arg: "market-talk", n: 5 },
  ],
};
const days = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 20 + i)).toISOString().slice(0, 10));
const ACCOUNTS: AccountsReport = {
  now: NOW,
  accounts: [
    { username: "kingcards", lookups: 5, members: 2, anon: 1, devices: 3, first: NOW - 9000, last: NOW - 100, passes: 340, year: 12000, type: "Strong", status: "ok", linked_by: "Deal Hunter" },
    { username: "bigwhale", lookups: 2, members: 1, anon: 0, devices: 1, first: NOW - 9000, last: NOW - 50, passes: 2400, year: 90000, type: "Giant", status: "ok", linked_by: null },
  ],
  power: [{ uid: "111122223333444455", name: "Deal Hunter", lookups: 7, accounts: 2 }],
  totals: { lookups: 7, by_members: 6, accounts: 2 },
  daily: days.map((day) => ({ day, lookups: 1 })),
};
const FEATURES: FeaturesReport = {
  now: NOW, window_days: 30, days,
  features: [{ kind: "sport", events: 10, users: 4, daily: days.map(() => 0), by_state: { anon: 5, out: 1, in: 4 },
               by_cls: { phone: 8, desktop: 2 }, top: [{ arg: "nba", n: 7 }] }],
  sessions: { daily: days.map(() => 2), time_daily: days.map(() => 300), count: 60, time_s: 9000, avg_s: 150,
              by_state: { anon: 30, out: 5, in: 25 } },
  hours: Array.from({ length: 24 }, (_, h) => (h === 20 ? 9 : 1)),
  dropped: 0,
};
const SOURCES: SourcesReport = {
  now: NOW, window_days: 90,
  sources: [{ key: "?tiktok", devices: 10, signed_in: 4, linked: 2, d7_ready: 8, d7: 2, members: 4 }],
};
const DISCORD: DiscordReport = {
  now: NOW, window_days: 30, days, count: [{ day: "2026-11-18", members: 5 }],
  moves: days.map((day) => ({ day, joins: 1, leaves: 0 })),
  channels: [{ channel: "market-talk", total: 40, daily: days.map(() => 1) }],
  people: [{ uid: "111122223333444455", name: "Deal Hunter", avatar: null, messages: 12, site: true, linked: true }],
  posts: [{ channel: "live-deals", ts: NOW - 3600, title: "LeBron · 40% under", reactions: 6, top: "🔥 4 · 👍 2" }],
  post_channels: [{ channel: "live-deals", posts: 1, reactions: 6, avg: 6 }],
  roles: [{ ts: NOW - 100, name: "Deal Hunter", kind: "role+", role: "NBA" }],
  known: { people: 3, present: 2 },
  status: { at: NOW - 300, members_list: "refused", channels: 14, messages: 98, checked: 2, posts: 62, error: null },
};

const ROUTES: Record<string, unknown> = {
  "/api/admin/stats": STATS,
  "/api/admin/members": MEMBERS,
  [`/api/admin/member/${MEMBERS.members[0]!.uid}`]: TIMELINE,
  "/api/admin/accounts": ACCOUNTS,
  "/api/admin/features": FEATURES,
  "/api/admin/sources": SOURCES,
  "/api/admin/discord": DISCORD,
};

function server(missing: string[] = []) {
  return vi.fn<typeof fetch>(async (input) => {
    const path = String(input).split("?")[0]!;
    if (missing.includes(path) || !(path in ROUTES)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(ROUTES[path]), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

async function openTab(name: string, fetchImpl = server()) {
  render(<AdminView fetchImpl={fetchImpl} />);
  fireEvent.click(await screen.findByRole("tab", { name }));
  return fetchImpl;
}

describe("the admin panel's tabs", () => {
  beforeEach(() => history.replaceState(null, "", "/admin"));
  afterEach(() => vi.restoreAllMocks());

  it("open from the address, and the address follows the tab", async () => {
    expect(tabFromHash("#members")).toBe("members");
    expect(tabFromHash("#nope")).toBe("overview");
    await openTab("Members");
    expect(location.hash).toBe("#members");
    expect(screen.getByRole("tab", { name: "Members" })).toHaveAttribute("aria-selected", "true");
  });

  it("Members: one row per member, filtered and searched, with the CSV to download", async () => {
    const fetchImpl = await openTab("Members");
    const list = await screen.findByRole("list", { name: "Members" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/admin\/members/), expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    fireEvent.click(screen.getByLabelText(/Linked/));
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "nobody" } });
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", "/api/admin/members.csv");
  });

  it("Members: a row opens that member's timeline, in words, and goes back", async () => {
    await openTab("Members");
    fireEvent.click(await screen.findByRole("button", { name: "Deal Hunter: open the timeline" }));
    expect(await screen.findByText("Looked up @bigwhale (2,400 passes)")).toBeInTheDocument();
    expect(screen.getByText("Opened how-it-works")).toBeInTheDocument();
    expect(screen.getByText("Got the role NBA")).toBeInTheDocument();
    expect(screen.getByText("5 messages in #market-talk")).toBeInTheDocument();
    expect(screen.getByText("device 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "← All members" }));
    expect(await screen.findByRole("list", { name: "Members" })).toBeInTheDocument();
  });

  it("Accounts: the accounts looked up with their size, and who looks up most", async () => {
    await openTab("Accounts");
    const table = await screen.findByRole("table", { name: "Accounts looked up" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    fireEvent.click(screen.getByLabelText(/Big and Giant only/));
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("@bigwhale")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Power users" })).toHaveTextContent("Deal Hunter");
  });

  it("Features: each feature with its split, and sessions by hour", async () => {
    await openTab("Features");
    const table = await screen.findByRole("table", { name: "Features" });
    expect(within(table).getByText("Sport picked").closest("tr")).toHaveTextContent("nba 7");
    fireEvent.click(within(table).getByText("Sport picked"));
    expect(screen.getByRole("img", { name: "Sport picked a day" })).toBeInTheDocument();
  });

  it("Sources: first touch to D7", async () => {
    await openTab("Sources");
    const row = within(await screen.findByRole("table", { name: "Sources" })).getByText("?tiktok").closest("tr")!;
    expect(row).toHaveTextContent("40%");
    expect(row).toHaveTextContent("25%");
  });

  it("Discord: what the bot read, and why some of it is missing", async () => {
    await openTab("Discord");
    expect(await screen.findByText(/Server Members intent is off/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Bot posts" })).toHaveTextContent("LeBron · 40% under");
    expect(screen.getByRole("list", { name: "Most active people" })).toHaveTextContent("Deal Hunter");
  });

  it("a tab whose route is off says so", async () => {
    await openTab("Discord", server(["/api/admin/discord"]));
    expect(await screen.findByText("This part of the panel is not on for this server.")).toBeInTheDocument();
  });

  it("Refresh asks the open tab again", async () => {
    const fetchImpl = await openTab("Sources");
    await screen.findByRole("table", { name: "Sources" });
    const before = fetchImpl.mock.calls.filter(([u]) => String(u).startsWith("/api/admin/sources")).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(fetchImpl.mock.calls.filter(([u]) => String(u).startsWith("/api/admin/sources")).length).toBe(before + 1),
    );
  });
});

describe("the tabs' helpers", () => {
  it("sort and filter members", () => {
    expect(pickMembers(MEMBERS.members, NO_FILTER, "sessions").map((m) => m.name)).toEqual(["Deal Hunter", "Quiet One"]);
    expect(pickMembers(MEMBERS.members, { ...NO_FILTER, week: true }, "last")).toHaveLength(1);
    expect(pickMembers(MEMBERS.members, { ...NO_FILTER, source: "direct" }, "name")[0]!.name).toBe("Quiet One");
    expect(pickMembers(MEMBERS.members, { ...NO_FILTER, server: true }, "name")).toHaveLength(1);
  });

  it("sort accounts, the big ones apart", () => {
    expect(sortAccounts(ACCOUNTS.accounts, "year", false)[0]!.username).toBe("bigwhale");
    expect(sortAccounts(ACCOUNTS.accounts, "lookups", true).map((a) => a.username)).toEqual(["bigwhale"]);
  });

  it("move the UTC hours to the viewer's own clock", () => {
    const utc = Array.from({ length: 24 }, (_, h) => h);
    expect(localHours(utc, 60)[13]).toBe(12); // 13:00 in Paris in winter is 12:00 UTC
    expect(localHours(utc, -300)[0]).toBe(5);
    expect(localHours(utc, 0)).toEqual(utc);
  });

  it("say each timeline line in words", () => {
    expect(say({ ts: 0, from: "site", kind: "time", arg: null, n: 95 })).toBe("On screen 1 min 35 s");
    expect(say({ ts: 0, from: "discord", kind: "leave", arg: null, n: null })).toBe("Left our Discord");
    expect(say({ ts: 0, from: "site", kind: "load", arg: "passes", n: null })).toBe("Opened the site on passes");
    expect(say({ ts: 0, from: "lookup", kind: "not_found", arg: "ghost", n: null })).toBe("Looked up @ghost: not found");
  });

  it("say what the Discord reading did", () => {
    expect(statusWords(null, NOW)).toMatch(/has not read the server yet/);
    expect(statusWords({ ...DISCORD.status!, members_list: "ok", error: "limited" }, NOW)).toMatch(/slow down/);
  });

  it("say times and lengths", () => {
    expect(duration(40)).toBe("40 s");
    expect(duration(3900)).toBe("1 h 05 min");
    expect(ago(NOW - 7200, NOW)).toBe("2 h ago");
  });
});
