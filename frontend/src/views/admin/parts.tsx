// Pieces the admin panel's tabs share (views/AdminView.tsx and views/admin/*): numbers, days, sections, columns and
// bars, all in the panel's own look (styles/admin.css). Days are UTC days.
import type { ReactNode } from "react";

const NUMBER = new Intl.NumberFormat("en-US");

/** A share as a whole percent: `pct(0.12)` or `pct(part, whole)`; a dash when there is nothing to divide. */
export function pct(value: number | null, whole?: number): string {
  if (value === null) return "–";
  if (whole !== undefined) {
    if (whole <= 0) return "–";
    value = value / whole;
  }
  return `${Math.round(value * 100)}%`;
}

export const n = (value: number) => NUMBER.format(value);

/** "Nov 18" from "2026-11-18", read as a UTC day. */
export function short(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function Section({ title, note, wide, children }: { title: string; note?: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={wide ? "adm-section adm-wide" : "adm-section"} aria-label={title}>
      <h2 className="adm-h2">{title}</h2>
      {note && <p className="adm-note">{note}</p>}
      {children}
    </section>
  );
}

/** Columns over days or weeks: one value, or two stacked (new under returning). Each column says its numbers on
 * hover and to a screen reader; the table under it holds them all. */
export function Columns({ rows, label }: { rows: { key: string; tick: string; parts: number[]; say: string }[]; label: string }) {
  const top = Math.max(1, ...rows.map((r) => r.parts.reduce((a, b) => a + b, 0)));
  return (
    <div className="adm-cols" role="img" aria-label={label}>
      {rows.map((r, i) => (
        <div key={r.key} className="adm-col" title={r.say}>
          <div className="adm-stack">
            {r.parts.map((part, j) => (
              <span key={j} className={`adm-seg adm-seg-${j}`} style={{ height: `${(part / top) * 100}%` }} />
            ))}
          </div>
          {/* A tick each 7 columns, counted back from the last one (today, or this week), which ends flush right. */}
          <span className={i === rows.length - 1 ? "adm-tick adm-tick-end" : "adm-tick"} aria-hidden="true">
            {(rows.length - 1 - i) % 7 === 0 ? <span>{r.tick}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Bars({ rows, label }: { rows: { name: string; value: number; extra?: string }[]; label: string }) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="adm-bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.name} className="adm-bar">
          <span className="adm-bar-name">{r.name}</span>
          <span className="adm-bar-value">
            {n(r.value)}
            {r.extra && <span className="adm-bar-extra"> {r.extra}</span>}
          </span>
          <span className="adm-bar-track" aria-hidden="true">
            <span className="adm-bar-fill" style={{ width: `${(r.value / top) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}


/** "Nov 18, 14:05 UTC" from seconds since the epoch. */
export function when(ts: number): string {
  const d = new Date(ts * 1000);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day}, ${d.toISOString().slice(11, 16)} UTC`;
}

/** "3 min ago", "5 h ago", "12 days ago" from seconds since the epoch, as of `now`. */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, now - ts);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "1 h 05 min", "3 min 20 s", "40 s" from seconds. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${String(s % 60).padStart(2, "0")} s` : ""}`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

/** Headline figures: a label, a figure, a line under it. */
export function Tiles({ tiles, label }: { tiles: [string, string, string?][]; label: string }) {
  return (
    <ul className="adm-tiles" aria-label={label}>
      {tiles.map(([name, value, sub]) => (
        <li key={name} className="adm-tile">
          <span className="adm-label">{name}</span>
          <span className="adm-figure">{value}</span>
          {sub && <span className="adm-sub">{sub}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A member's face: their Discord avatar (from Discord's image host, which only the admin page may load), else
 * their initials. */
export function Face({ name, avatar, size = 32 }: { name: string; avatar: string | null; size?: number }) {
  if (avatar && avatar.startsWith("https://cdn.discordapp.com/avatars/")) {
    return <img className="adm-face" src={avatar} width={size} height={size} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
  }
  const letters = name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="adm-face adm-face-none" style={{ width: size, height: size }} aria-hidden="true">
      {letters || "?"}
    </span>
  );
}

/** Our Discord server's member count over days, one point a day. */
export function DiscordLine({ points }: { points: { day: string; members: number }[] }) {
  if (points.length < 2) return <p className="adm-note">{points.length ? `${n(points[0]!.members)} members.` : "No count yet."}</p>;
  const values = points.map((p) => p.members);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(1, hi - lo);
  const w = 300;
  const h = 80;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 6 - ((p.members - lo) / span) * (h - 12)] as const);
  return (
    <figure className="adm-line">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Discord members, ${n(lo)} to ${n(hi)}`}>
        <polyline points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} />
        {xy.map(([x, y], i) => (
          <circle key={points[i]!.day} cx={x} cy={y} r={points.length > 40 ? 0 : 3}>
            <title>{`${short(points[i]!.day)}: ${n(points[i]!.members)}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="adm-note">
        {short(points[0]!.day)}: {n(points[0]!.members)} · {short(points.at(-1)!.day)}: {n(points.at(-1)!.members)}
      </figcaption>
    </figure>
  );
}

