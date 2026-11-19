// The admin panel's Members tab: one row per Discord member who signed in on the site, sortable and filterable, with a
// CSV export; a row opens that member's timeline (what their devices did, before signing in too, the accounts they
// looked up, their link changes, their days of messages and their changes in our Discord).
import { useMemo, useState } from "react";
import { type MemberRow, type MembersReport, type Timeline, type TimelineItem, useAdmin } from "./api";
import { Face, Section, Tiles, ago, duration, n, when } from "./parts";

type SortKey = "last" | "first" | "days" | "sessions" | "time_s" | "lookups" | "messages" | "passes" | "year" | "name";
const SORTS: [SortKey, string][] = [
  ["last", "Last seen"],
  ["first", "First seen"],
  ["days", "Days active"],
  ["sessions", "Sessions"],
  ["time_s", "Time on site"],
  ["lookups", "Lookups"],
  ["messages", "Discord messages"],
  ["passes", "Passes"],
  ["year", "Yearly figure"],
  ["name", "Name"],
];
const SHOWN = 150;

export interface MemberFilter {
  text: string;
  week: boolean;
  linked: boolean;
  server: boolean;
  type: string;
  source: string;
}

export const NO_FILTER: MemberFilter = { text: "", week: false, linked: false, server: false, type: "", source: "" };

/** The members the filter keeps, in the order asked (the largest first, names from A). */
export function pickMembers(rows: readonly MemberRow[], filter: MemberFilter, sort: SortKey): MemberRow[] {
  const text = filter.text.trim().toLowerCase();
  const kept = rows.filter(
    (r) =>
      (!text || r.name.toLowerCase().includes(text) || (r.linked ?? "").toLowerCase().includes(text) || r.uid === text) &&
      (!filter.week || r.active_7d) &&
      (!filter.linked || r.linked !== null) &&
      (!filter.server || r.in_server === true) &&
      (!filter.type || r.type === filter.type) &&
      (!filter.source || r.source === filter.source),
  );
  const value = (r: MemberRow) => (sort === "name" ? 0 : (r[sort] ?? -1));
  return kept.sort((a, b) =>
    sort === "name" ? a.name.localeCompare(b.name) : value(b) - value(a) || a.name.localeCompare(b.name),
  );
}

function Badge({ on, children }: { on?: boolean; children: string }) {
  return <span className={on === false ? "adm-badge adm-badge-off" : "adm-badge"}>{children}</span>;
}

function MemberLineRow({ r, now, open }: { r: MemberRow; now: number; open: (uid: string) => void }) {
  return (
    <li>
      <button type="button" className="adm-mem" onClick={() => open(r.uid)} aria-label={`${r.name}: open the timeline`}>
        <Face name={r.name} avatar={r.avatar} />
        <span className="adm-mem-who">
          <span className="adm-mem-name">{r.name}</span>
          <span className="adm-mem-sub">
            {r.linked ? `@${r.linked}` : "not linked"}
            {r.type ? ` · ${r.type}` : ""}
            {r.year !== null ? ` · ${n(r.year)} a year` : ""}
          </span>
        </span>
        <span className="adm-mem-figs">
          <span title="Last seen">{ago(r.last, now)}</span>
          <span title="Days active · sessions · time on site">
            {n(r.days)} d · {n(r.sessions)} s · {duration(r.time_s)}
          </span>
        </span>
        <span className="adm-mem-tags">
          {r.in_server === false && <Badge on={false}>Left server</Badge>}
          {r.pings && <Badge>Pings</Badge>}
          {r.push && <Badge>Alerts</Badge>}
          <Badge>{r.source}</Badge>
          {r.devices > 1 && <Badge>{`${r.devices} devices`}</Badge>}
        </span>
      </button>
    </li>
  );
}

export function MembersTab({ fetchImpl, refreshKey }: { fetchImpl: typeof fetch; refreshKey: number }) {
  const [load] = useAdmin<MembersReport>(`/api/admin/members?r=${refreshKey}`, fetchImpl);
  const [filter, setFilter] = useState<MemberFilter>(NO_FILTER);
  const [sort, setSort] = useState<SortKey>("last");
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows = load.kind === "ok" ? load.data.members : [];
  const picked = useMemo(() => pickMembers(rows, filter, sort), [rows, filter, sort]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.type).filter((t): t is string => !!t))].sort(), [rows]);
  const sources = useMemo(() => [...new Set(rows.map((r) => r.source))].sort(), [rows]);
  if (load.kind !== "ok") return <LoadNote load={load} />;
  if (open) return <MemberTimeline uid={open} fetchImpl={fetchImpl} back={() => setOpen(null)} />;
  const now = load.data.now;
  const week = rows.filter((r) => r.active_7d).length;
  const linked = rows.filter((r) => r.linked).length;
  const set = (patch: Partial<MemberFilter>) => setFilter((f) => ({ ...f, ...patch }));
  return (
    <>
      <Tiles
        label="Member figures"
        tiles={[
          ["Signed in, ever kept", n(rows.length)],
          ["Active this week", n(week)],
          ["Linked", n(linked)],
          ["Left the server", n(rows.filter((r) => r.in_server === false).length)],
          ["Pings on", n(rows.filter((r) => r.pings).length)],
          ["Phone alerts", n(rows.filter((r) => r.push).length)],
        ]}
      />
      <Section wide title="Members" note="Everyone who signed in with Discord. Tap one for their timeline.">
        <div className="adm-filters" role="group" aria-label="Filter members">
          <input
            className="adm-input"
            type="search"
            placeholder="Name or Real username"
            aria-label="Search members"
            value={filter.text}
            onChange={(e) => set({ text: e.target.value })}
          />
          <label className="adm-check">
            <input type="checkbox" checked={filter.week} onChange={(e) => set({ week: e.target.checked })} /> This week
          </label>
          <label className="adm-check">
            <input type="checkbox" checked={filter.linked} onChange={(e) => set({ linked: e.target.checked })} /> Linked
          </label>
          <label className="adm-check">
            <input type="checkbox" checked={filter.server} onChange={(e) => set({ server: e.target.checked })} /> In server
          </label>
          <select className="adm-input" aria-label="Account type" value={filter.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">Any type</option>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select className="adm-input" aria-label="First source" value={filter.source} onChange={(e) => set({ source: e.target.value })}>
            <option value="">Any source</option>
            {sources.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select className="adm-input" aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <a className="adm-btn" href="/api/admin/members.csv" download>
            Export CSV
          </a>
        </div>
        <p className="adm-note">
          {n(picked.length)} of {n(rows.length)} members.
        </p>
        <ul className="adm-members" aria-label="Members">
          {(more ? picked : picked.slice(0, SHOWN)).map((r) => (
            <MemberLineRow key={r.uid} r={r} now={now} open={setOpen} />
          ))}
        </ul>
        {!more && picked.length > SHOWN && (
          <button type="button" className="adm-btn adm-more" onClick={() => setMore(true)}>
            Show all {n(picked.length)}
          </button>
        )}
      </Section>
    </>
  );
}

export function LoadNote({ load }: { load: { kind: string } }) {
  if (load.kind === "loading") return <p className="adm-note adm-wide">Loading…</p>;
  if (load.kind === "missing") return <p className="adm-msg adm-wide">This part of the panel is not on for this server.</p>;
  if (load.kind === "forbidden") return <p className="adm-msg adm-wide">This page is not for this account.</p>;
  if (load.kind === "signin") return <p className="adm-msg adm-wide">Sign in again to see this.</p>;
  return <p className="adm-msg adm-wide">The figures could not load. Press Refresh.</p>;
}

const SITE_WORDS: Record<string, string> = {
  load: "Opened the site",
  tab: "Opened a tab",
  signin: "Pressed Continue with Discord",
  auth: "Signed in with Discord",
  session: "Started a visit",
  time: "On screen",
  lookup: "Looked up",
  link: "Pressed Link for",
  linked: "Linked",
  unlink: "Pressed Unlink",
  unlinked: "Unlinked their account",
  share: "Shared",
  filter: "Changed a filter",
  sort: "Sorted by",
  sport: "Picked the sport",
  deal: "Opened deal",
  out: "Clicked out to Real from",
  push: "Phone alerts",
  pings: "Deal pings",
  install: "Home-screen offer",
  refresh: "Pulled to refresh",
  sheet: "Opened",
  year: "Yearly figure of",
};

/** One timeline line, in words. */
export function describe(item: TimelineItem): string {
  if (item.from === "lookup") {
    const size = item.n !== null ? ` (${n(item.n)} passes)` : "";
    return item.kind === "ok" ? `Looked up @${item.arg}${size}` : `Looked up @${item.arg}: ${item.kind.replace("_", " ")}`;
  }
  if (item.from === "messages") return `${n(item.n ?? 0)} message${item.n === 1 ? "" : "s"} in #${item.arg}`;
  if (item.from === "discord") {
    if (item.kind === "join") return "Joined our Discord";
    if (item.kind === "leave") return "Left our Discord";
    return `${item.kind === "role+" ? "Got" : "Lost"} the role ${item.arg}`;
  }
  const words = SITE_WORDS[item.kind] ?? item.kind;
  if (item.kind === "time") return `${words} ${duration(item.n ?? 0)}`;
  if (item.kind === "year") return `${words} @${item.arg}: ${n(item.n ?? 0)}`;
  if (item.kind === "linked") return `${words} @${item.arg}${item.n !== null ? ` (${n(item.n)} passes)` : ""}`;
  if (item.kind === "lookup" || item.kind === "link") return `${words} @${item.arg}`;
  if (item.kind === "load" && item.arg) return `${words} on ${item.arg}`;
  return item.arg ? `${words} ${item.arg}` : words;
}

function MemberTimeline({ uid, fetchImpl, back }: { uid: string; fetchImpl: typeof fetch; back: () => void }) {
  const [load] = useAdmin<Timeline>(`/api/admin/member/${uid}`, fetchImpl);
  const byDay = useMemo(() => {
    if (load.kind !== "ok") return [];
    const days = new Map<string, TimelineItem[]>();
    for (const item of load.data.items) {
      const day = new Date(item.ts * 1000).toISOString().slice(0, 10);
      days.set(day, [...(days.get(day) ?? []), item]);
    }
    return [...days.entries()];
  }, [load]);
  return (
    <Section wide title="Member" note="Times are UTC. Devices are numbered, never shown by id.">
      <button type="button" className="adm-btn" onClick={back}>
        ← All members
      </button>
      {load.kind !== "ok" ? (
        <LoadNote load={load} />
      ) : (
        <>
          <div className="adm-who">
            <Face name={load.data.member.name} avatar={load.data.member.avatar} size={56} />
            <div>
              <h3 className="adm-h3">{load.data.member.name}</h3>
              <p className="adm-note">
                {load.data.member.linked ? `@${load.data.member.linked}` : "Not linked"}
                {load.data.member.type ? ` · ${load.data.member.type}` : ""}
                {load.data.member.passes !== null ? ` · ${n(load.data.member.passes)} passes` : ""}
                {load.data.member.year !== null ? ` · ${n(load.data.member.year)} a year` : ""}
                {load.data.member.sports.length ? ` · ${load.data.member.sports.join(", ").toUpperCase()}` : ""}
              </p>
              <p className="adm-note">
                First seen {when(load.data.member.first)} · came from {load.data.member.source} · {n(load.data.devices)} device
                {load.data.devices === 1 ? "" : "s"}
                {load.data.member.roles.length ? ` · roles: ${load.data.member.roles.join(", ")}` : ""}
              </p>
            </div>
          </div>
          <Tiles
            label="Their figures"
            tiles={[
              ["Days active", n(load.data.member.days)],
              ["Sessions", n(load.data.member.sessions)],
              ["Time on site", duration(load.data.member.time_s)],
              ["Lookups", n(load.data.member.lookups)],
              ["Messages, 30 days", n(load.data.member.messages)],
              ["In our server", load.data.member.in_server === null ? "–" : load.data.member.in_server ? "Yes" : "No"],
            ]}
          />
          {byDay.length === 0 && <p className="adm-note">Nothing recorded yet.</p>}
          {byDay.map(([day, items]) => (
            <section key={day} className="adm-day" aria-label={day}>
              <h4 className="adm-h4">{day}</h4>
              <ol className="adm-timeline">
                {items.map((item, i) => (
                  <li key={`${item.ts}-${i}`} className={`adm-ev adm-ev-${item.from}`}>
                    <time dateTime={new Date(item.ts * 1000).toISOString()}>
                      {item.from === "messages" ? "day" : new Date(item.ts * 1000).toISOString().slice(11, 16)}
                    </time>
                    <span>{describe(item)}</span>
                    {item.device ? <span className="adm-ev-dev">device {item.device}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </>
      )}
    </Section>
  );
}
