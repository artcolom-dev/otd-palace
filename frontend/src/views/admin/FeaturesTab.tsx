// The admin panel's Features tab: what the site is used for over 30 days, for everyone (anonymous devices too): each
// feature by day, by state (not signed in, signed in but not in our server, member) and by phone or computer; the
// sessions, the time on screen, and the hours visits start (in the admin's own time).
import { Fragment, useState } from "react";
import { type FeatureRow, type FeaturesReport, useAdmin } from "./api";
import { LoadNote } from "./MembersTab";
import { Columns, Section, Tiles, duration, n, pct, short } from "./parts";

export const FEATURE_NAMES: Record<string, string> = {
  load: "Site opened",
  tab: "Tab opened",
  signin: "Continue with Discord",
  lookup: "Account looked up",
  link: "Link pressed",
  unlink: "Unlink pressed",
  share: "Shared",
  filter: "Filter changed",
  sort: "Sort picked",
  sport: "Sport picked",
  deal: "Deal opened",
  out: "Click out (Real, Discord)",
  push: "Phone alerts switched",
  pings: "Deal pings switched",
  install: "Home-screen offer",
  refresh: "Pull to refresh",
  sheet: "Sheet or menu opened",
};

/** The 24 UTC hours moved to the viewer's own clock: index h is the viewer's hour h. */
export function localHours(utc: readonly number[], offsetMinutes: number = -new Date().getTimezoneOffset()): number[] {
  const shift = Math.round(offsetMinutes / 60);
  return Array.from({ length: 24 }, (_, h) => utc[(((h - shift) % 24) + 24) % 24] ?? 0);
}

function Split({ row }: { row: FeatureRow }) {
  const s = row.by_state;
  const c = row.by_cls;
  return (
    <>
      <td>{pct(s.anon, row.events)}</td>
      <td>{pct(s.out, row.events)}</td>
      <td>{pct(s.in, row.events)}</td>
      <td>{pct(c.phone ?? 0, row.events)}</td>
      <td>{pct(c.desktop ?? 0, row.events)}</td>
    </>
  );
}

export function FeaturesTab({ fetchImpl, refreshKey }: { fetchImpl: typeof fetch; refreshKey: number }) {
  const [load] = useAdmin<FeaturesReport>(`/api/admin/features?r=${refreshKey}`, fetchImpl);
  const [open, setOpen] = useState<string | null>(null);
  if (load.kind !== "ok") return <LoadNote load={load} />;
  const { sessions, days, features, hours, dropped, window_days: windowDays } = load.data;
  const local = localHours(hours);
  return (
    <>
      <Tiles
        label="Sessions"
        tiles={[
          ["Sessions", n(sessions.count), `${windowDays} days`],
          ["Time on site", duration(sessions.time_s)],
          ["Per session", sessions.avg_s === null ? "–" : duration(sessions.avg_s)],
          ["Not signed in", pct(sessions.by_state.anon, sessions.count), "of sessions"],
          ["Members", pct(sessions.by_state.in, sessions.count), "of sessions"],
          ["Dropped by the limits", n(dropped)],
        ]}
      />
      <Section title="Sessions a day" note="A session: the site opened, or back after 30 minutes away. UTC days.">
        <Columns
          label="Sessions a day"
          rows={days.map((d, i) => ({ key: d, tick: short(d), parts: [sessions.daily[i] ?? 0], say: `${short(d)}: ${sessions.daily[i] ?? 0} sessions, ${duration(sessions.time_daily[i] ?? 0)}` }))}
        />
      </Section>
      <Section title="When visits start" note="Sessions by hour of the day, in your own time.">
        <Columns
          label="Sessions by hour"
          rows={local.map((v, h) => ({ key: String(h), tick: `${h}h`, parts: [v], say: `${h}:00: ${v} sessions` }))}
        />
      </Section>
      <Section wide title="Features" note="Events in 30 days and the devices (or members) behind them; the share by state and by phone or computer. Tap a row for its days.">
        <div className="adm-scroll">
          <table className="adm-table" aria-label="Features">
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">Uses</th>
                <th scope="col">Users</th>
                <th scope="col">Anon</th>
                <th scope="col">Out</th>
                <th scope="col">Member</th>
                <th scope="col">Phone</th>
                <th scope="col">Computer</th>
                <th scope="col">Most</th>
              </tr>
            </thead>
            <tbody>
              {features.map((f) => (
                <Fragment key={f.kind}>
                  <tr className="adm-click" onClick={() => setOpen(open === f.kind ? null : f.kind)}>
                    <th scope="row">
                      <button type="button" className="adm-link" aria-expanded={open === f.kind}>
                        {FEATURE_NAMES[f.kind] ?? f.kind}
                      </button>
                    </th>
                    <td>{n(f.events)}</td>
                    <td>{n(f.users)}</td>
                    <Split row={f} />
                    <td className="adm-top-args">{f.top.slice(0, 3).map((t) => `${t.arg} ${n(t.n)}`).join(" · ") || "–"}</td>
                  </tr>
                  {open === f.kind && (
                    <tr>
                      <td colSpan={9} className="adm-open">
                        <Columns
                          label={`${FEATURE_NAMES[f.kind] ?? f.kind} a day`}
                          rows={days.map((d, i) => ({ key: d, tick: short(d), parts: [f.daily[i] ?? 0], say: `${short(d)}: ${f.daily[i] ?? 0}` }))}
                        />
                        {f.top.length > 0 && (
                          <p className="adm-note">Most: {f.top.map((t) => `${t.arg} (${n(t.n)})`).join(", ")}</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
