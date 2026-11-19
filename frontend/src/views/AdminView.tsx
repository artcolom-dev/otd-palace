// The private admin panel at /admin (advisor/web.py serves the page to the Discord ids in ADVISOR_ADMIN_DISCORD_IDS
// only). The overview reads /api/admin/stats (advisor/admin_stats.py: anonymous totals); the other tabs read the
// deep routes (advisor/activity_report.py; views/admin/*): Members (each signed-in member, by their Discord account,
// and their timeline), Accounts, Discord, Features and Sources. Its own chunk and its own sheet: nothing of it reaches
// the site's pages. Days are UTC days.
import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import "../styles/admin.css";
import { AccountsTab } from "./admin/AccountsTab";
import { DiscordTab } from "./admin/DiscordTab";
import { FeaturesTab } from "./admin/FeaturesTab";
import { MembersTab } from "./admin/MembersTab";
import { SourcesTab } from "./admin/SourcesTab";
import { Bars, Columns, DiscordLine, Section, n, pct, short } from "./admin/parts";

export { pct };

interface Actives {
  dau: number;
  wau: number;
  mau: number;
  kept: number;
  over?: number; // devices: new ones not followed in 30 days because the table was full
}

interface Cohort {
  week: string;
  size: number;
  d1: number | null;
  d7: number | null;
  d14: number | null;
  d30: number | null;
}

export interface AdminStats {
  today: string;
  window_days: number;
  active: Actives;
  members: Actives;
  daily: {
    day: string;
    active: number;
    new: number;
    returning: number;
    members: number;
    loads: number;
    clicks: number;
    signin: number;
    discord: number | null;
    over: number;
  }[];
  weekly: { week: string; active: number }[];
  cohorts: Cohort[];
  member_cohorts: Cohort[];
  funnel: { key: string; count: number }[];
  logins: { signin: number; started: number; finished: number };
  totals: { linked: number; pings: number; push: number };
  tabs: { tab: string; views: number }[];
  devices: { phone: number; tablet: number; desktop: number; app: number; total: number };
  sources: {
    ref: { key: string; loads: number }[];
    tag: { key: string; loads: number }[];
    new: { key: string; new: number; d1: number | null; d7: number | null }[];
  };
  clicks: { total: number; by_panel: { panel: string; count: number }[] };
  discord: { day: string; members: number }[];
}

type Load =
  | { kind: "loading" }
  | { kind: "ok"; stats: AdminStats }
  | { kind: "signin" }
  | { kind: "forbidden" }
  | { kind: "failed" };

const FUNNEL_NAMES: Record<string, string> = {
  visit: "Visited",
  signin: "Pressed Continue with Discord",
  signed_in: "Signed in",
  in_server: "In our Discord server",
  linked: "Linked a Real account",
  alerts: "Deal pings or alerts on",
};
const TAB_NAMES: Record<string, string> = { today: "Today", deals: "Deals", prices: "Prices", passes: "Passes", plan: "Your plan" };
const COHORT_DAYS = ["d1", "d7", "d14", "d30"] as const;
function Headline({ stats }: { stats: AdminStats }) {
  const discord = stats.discord.at(-1)?.members;
  const today = stats.daily.at(-1);
  const tiles: [string, string, string?][] = [
    ["Today", n(stats.active.dau), today ? `${n(today.new)} new` : undefined],
    ["Last 7 days", n(stats.active.wau)],
    ["Last 30 days", n(stats.active.mau)],
    ["Members today", n(stats.members.dau), `${n(stats.members.mau)} in 30 days`],
    ["Discord members", discord === undefined ? "–" : n(discord)],
    ["Clicks to Real", n(stats.clicks.total), "30 days"],
  ];
  return (
    <ul className="adm-tiles" aria-label="Headline figures">
      {tiles.map(([label, value, sub]) => (
        <li key={label} className="adm-tile">
          <span className="adm-label">{label}</span>
          <span className="adm-figure">{value}</span>
          {sub && <span className="adm-sub">{sub}</span>}
        </li>
      ))}
    </ul>
  );
}

function CohortTable({ rows, label }: { rows: Cohort[]; label: string }) {
  return (
    <div className="adm-scroll">
      <table className="adm-table adm-cohorts" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">New</th>
            {COHORT_DAYS.map((d) => (
              <th key={d} scope="col">
                {d.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.week}>
              <th scope="row">{short(c.week)}</th>
              <td>{n(c.size)}</td>
              {COHORT_DAYS.map((d) => {
                const v = c[d];
                // One hue, light to strong with the share: the accent's tint, never a second colour.
                const level = v === null ? "none" : String(Math.min(4, Math.ceil(v * 5)));
                return (
                  <td key={d} className="adm-cell" data-level={level}>
                    {pct(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({ stats }: { stats: AdminStats }) {
  const visits = stats.funnel[0]?.count ?? 0;
  const daily = stats.daily;
  const d = stats.devices;
  return (
    <>
      <Headline stats={stats} />
      {(stats.active.over ?? 0) > 0 && (
        <p className="adm-warn" role="alert">
          The device table is full: {n(stats.active.over ?? 0)} new devices in {stats.window_days} days were counted in the
          day totals only, not followed. Raise VISIT_MAX_DEVICES in advisor/rules.py.
        </p>
      )}

      <Section title="Active devices" note={`Each bar is a UTC day: new devices at the bottom, returning above.`}>
        <Columns
          label={`Active devices a day over ${stats.window_days} days`}
          rows={daily.map((r) => ({
            key: r.day,
            tick: short(r.day),
            parts: [r.new, r.returning],
            say: `${short(r.day)}: ${r.active} active (${r.new} new, ${r.returning} returning)`,
          }))}
        />
        <p className="adm-legend">
          <span className="adm-key adm-seg-0" aria-hidden="true" /> New <span className="adm-key adm-seg-1" aria-hidden="true" /> Returning
        </p>
        <details className="adm-details">
          <summary>Show the days as a table</summary>
          <div className="adm-scroll">
            <table className="adm-table" aria-label="Days">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Active</th>
                  <th scope="col">New</th>
                  <th scope="col">Members</th>
                  <th scope="col">Loads</th>
                  <th scope="col">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {[...daily].reverse().map((r) => (
                  <tr key={r.day}>
                    <th scope="row">{short(r.day)}</th>
                    <td>{n(r.active)}</td>
                    <td>{n(r.new)}</td>
                    <td>{n(r.members)}</td>
                    <td>{n(r.loads)}</td>
                    <td>{n(r.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Section>

      <Section title="Weekly active devices" note="Monday to Sunday; this week so far.">
        <Columns
          label="Active devices a week over 12 weeks"
          rows={stats.weekly.map((w) => ({ key: w.week, tick: short(w.week), parts: [w.active], say: `Week of ${short(w.week)}: ${w.active}` }))}
        />
      </Section>

      <Section
        wide
        title="Retention"
        note="By the week they first came. D7: the share that came back 7 days later or after. A dash: too soon to tell."
      >
        <div className="adm-pair">
          <div>
            <h3 className="adm-h3">Devices</h3>
            <CohortTable rows={stats.cohorts} label="Device retention by week of first visit" />
          </div>
          <div>
            <h3 className="adm-h3">Signed-in members</h3>
            <CohortTable rows={stats.member_cohorts} label="Member retention by week of first visit" />
          </div>
        </div>
      </Section>

      <Section title="Funnel" note={`Devices active in the last ${stats.window_days} days; each step counts those that reached it, by any path.`}>
        <Bars
          label="Funnel"
          rows={stats.funnel.map((s) => ({ name: FUNNEL_NAMES[s.key] ?? s.key, value: s.count, extra: pct(s.count, visits) }))}
        />
        <p className="adm-note">
          Logins started {n(stats.logins.started)} · finished {n(stats.logins.finished)} · Discord button presses {n(stats.logins.signin)}.
          Now: {n(stats.totals.linked)} linked accounts, {n(stats.totals.pings)} with deal pings, {n(stats.totals.push)} alert subscriptions.
        </p>
      </Section>

      <Section title="Tabs viewed" note={`Page loads and tab changes, last ${stats.window_days} days.`}>
        <Bars label="Tabs viewed" rows={stats.tabs.map((t) => ({ name: TAB_NAMES[t.tab] ?? t.tab, value: t.views }))} />
      </Section>

      <Section title="Devices" note={`Active in the last ${stats.window_days} days.`}>
        <Bars
          label="Devices"
          rows={[
            { name: "Phone", value: d.phone, extra: pct(d.phone, d.total) },
            { name: "Tablet", value: d.tablet, extra: pct(d.tablet, d.total) },
            { name: "Computer", value: d.desktop, extra: pct(d.desktop, d.total) },
            { name: "Home-screen app", value: d.app, extra: pct(d.app, d.total) },
          ]}
        />
      </Section>

      <Section title="Clicks to Real" note={`Outbound clicks, by where on the page, last ${stats.window_days} days.`}>
        <Bars label="Clicks by panel" rows={stats.clicks.by_panel.map((p) => ({ name: p.panel, value: p.count }))} />
      </Section>

      <Section wide title="Where visits come from" note="Referring site (its name only) and campaign tags (?ref= or utm_source), by page load.">
        <div className="adm-pair">
          <Bars label="Referring sites" rows={stats.sources.ref.map((r) => ({ name: r.key, value: r.loads }))} />
          {stats.sources.tag.length > 0 ? (
            <Bars label="Campaign tags" rows={stats.sources.tag.map((r) => ({ name: `?${r.key}`, value: r.loads }))} />
          ) : (
            <p className="adm-note">No campaign tag yet. Share links as otdpalace.com/?ref=name to see them here.</p>
          )}
        </div>
        <h3 className="adm-h3">New devices by first source</h3>
        <div className="adm-scroll">
          <table className="adm-table" aria-label="New devices by first source">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">New</th>
                <th scope="col">D1</th>
                <th scope="col">D7</th>
              </tr>
            </thead>
            <tbody>
              {stats.sources.new.map((s) => (
                <tr key={s.key}>
                  <th scope="row">{s.key}</th>
                  <td>{n(s.new)}</td>
                  <td>{pct(s.d1)}</td>
                  <td>{pct(s.d7)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Discord members" note="Our server's member count, read hourly, one point a day.">
        <DiscordLine points={stats.discord} />
      </Section>
    </>
  );
}

const TABS = [
  ["overview", "Overview"],
  ["members", "Members"],
  ["accounts", "Accounts"],
  ["discord", "Discord"],
  ["features", "Features"],
  ["sources", "Sources"],
] as const;
export type AdminTab = (typeof TABS)[number][0];

/** The tab the address names (`/admin#members`), else the overview. */
export function tabFromHash(hash: string = location.hash): AdminTab {
  const key = hash.replace(/^#/, "");
  return TABS.find(([k]) => k === key)?.[0] ?? "overview";
}

function TabBar({ tab, choose }: { tab: AdminTab; choose: (t: AdminTab) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex(([k]) => k === tab);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(i + step + TABS.length) % TABS.length]![0];
    choose(next);
    (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="adm-tabs" role="tablist" aria-label="Admin sections" onKeyDown={onKeyDown}>
      {TABS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          data-tab={key}
          aria-selected={tab === key}
          tabIndex={tab === key ? 0 : -1}
          className="adm-tab"
          onClick={() => choose(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function AdminView({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [tab, setTab] = useState<AdminTab>(() => tabFromHash());
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    setLoad((was) => (was.kind === "ok" ? was : { kind: "loading" }));
    try {
      const r = await fetchImpl("/api/admin/stats", { credentials: "same-origin", cache: "no-store" });
      if (r.status === 401) return setLoad({ kind: "signin" });
      if (r.status === 403 || r.status === 404) return setLoad({ kind: "forbidden" });
      if (!r.ok) return setLoad({ kind: "failed" });
      setLoad({ kind: "ok", stats: (await r.json()) as AdminStats });
    } catch {
      setLoad({ kind: "failed" });
    }
  }, [fetchImpl]);

  useEffect(() => {
    document.title = "Admin · OTD Palace";
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const choose = (next: AdminTab) => {
    setTab(next);
    history.replaceState(null, "", next === "overview" ? location.pathname : `#${next}`);
  };
  const again = () => {
    void refresh();
    setRefreshKey((k) => k + 1);
  };
  const props = { fetchImpl, refreshKey };

  return (
    <div className="adm">
      <header className="adm-top">
        <div>
          <h1 className="adm-h1">OTD Palace admin</h1>
          {load.kind === "ok" && (
            <p className="adm-note">As of {short(load.stats.today)} (UTC days). Members are shown by their Discord account.</p>
          )}
        </div>
        {load.kind === "ok" && (
          <button type="button" className="adm-btn" onClick={again}>
            Refresh
          </button>
        )}
      </header>
      {load.kind === "ok" && <TabBar tab={tab} choose={choose} />}
      <main>
        {load.kind === "loading" && <p className="adm-note">Loading…</p>}
        {load.kind === "ok" && tab === "overview" && <Panel stats={load.stats} />}
        {load.kind === "ok" && tab === "members" && <MembersTab {...props} />}
        {load.kind === "ok" && tab === "accounts" && <AccountsTab {...props} />}
        {load.kind === "ok" && tab === "discord" && <DiscordTab {...props} />}
        {load.kind === "ok" && tab === "features" && <FeaturesTab {...props} />}
        {load.kind === "ok" && tab === "sources" && <SourcesTab {...props} />}
        {load.kind === "signin" && (
          <p className="adm-msg">
            Sign in first.{" "}
            <a className="adm-btn" href="/auth/discord?next=%2Fadmin">
              Continue with Discord
            </a>
          </p>
        )}
        {load.kind === "forbidden" && <p className="adm-msg">This page is not for this account.</p>}
        {load.kind === "failed" && (
          <p className="adm-msg">
            The figures could not load.{" "}
            <button type="button" className="adm-btn" onClick={() => void refresh()}>
              Try again
            </button>
          </p>
        )}
      </main>
    </div>
  );
}

export default AdminView;
