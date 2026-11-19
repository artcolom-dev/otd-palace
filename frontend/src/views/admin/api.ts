// What the admin panel's deep tabs read (advisor/activity_report.py, served by advisor/web.py to an admin only), and
// the one way each tab loads it: with the session, never from a cache.
import { useCallback, useEffect, useState } from "react";

export interface MemberRow {
  uid: string;
  name: string;
  avatar: string | null;
  first: number;
  last: number;
  days: number;
  sessions: number;
  time_s: number;
  devices: number;
  source: string;
  in_server: boolean | null;
  state: string | null;
  linked: string | null;
  type: string | null;
  year: number | null;
  passes: number | null;
  sports: string[];
  pings: boolean | null;
  push: boolean;
  roles: string[];
  messages: number;
  lookups: number;
  active_7d: boolean;
}

export interface MembersReport {
  now: number;
  members: MemberRow[];
}

export interface TimelineItem {
  ts: number;
  from: "site" | "lookup" | "discord" | "messages";
  kind: string;
  arg: string | null;
  n: number | null;
  state?: string;
  cls?: string | null;
  device?: number | null;
}

export interface Timeline {
  member: MemberRow;
  devices: number;
  items: TimelineItem[];
}

export interface AccountRow {
  username: string;
  lookups: number;
  members: number;
  anon: number;
  devices: number;
  first: number;
  last: number;
  passes: number | null;
  year: number | null;
  type: string | null;
  status: string | null;
  linked_by: string | null;
}

export interface AccountsReport {
  now: number;
  accounts: AccountRow[];
  power: { uid: string; name: string; lookups: number; accounts: number }[];
  totals: { lookups: number; by_members: number; accounts: number };
  daily: { day: string; lookups: number }[];
}

export interface FeatureRow {
  kind: string;
  events: number;
  users: number;
  daily: number[];
  by_state: { anon: number; out: number; in: number };
  by_cls: Partial<Record<"phone" | "tablet" | "desktop" | "unknown", number>>;
  top: { arg: string; n: number }[];
}

export interface FeaturesReport {
  now: number;
  window_days: number;
  days: string[];
  features: FeatureRow[];
  sessions: {
    daily: number[];
    time_daily: number[];
    count: number;
    time_s: number;
    avg_s: number | null;
    by_state: { anon: number; out: number; in: number };
  };
  hours: number[];
  dropped: number;
}

export interface SourceRow {
  key: string;
  devices: number;
  signed_in: number;
  linked: number;
  d7_ready: number;
  d7: number;
  members: number;
}

export interface SourcesReport {
  now: number;
  window_days: number;
  sources: SourceRow[];
}

export interface DiscordReport {
  now: number;
  window_days: number;
  days: string[];
  count: { day: string; members: number }[];
  moves: { day: string; joins: number; leaves: number }[];
  channels: { channel: string; total: number; daily: number[] }[];
  people: { uid: string; name: string; avatar: string | null; messages: number; site: boolean; linked: boolean }[];
  posts: { channel: string; ts: number; title: string | null; reactions: number; top: string | null }[];
  post_channels: { channel: string; posts: number; reactions: number; avg: number }[];
  roles: { ts: number; name: string; kind: string; role: string }[];
  known: { people: number; present: number };
  status: {
    at: number;
    members_list: string | null;
    channels: number;
    messages: number;
    checked: number;
    posts: number;
    error: string | null;
  } | null;
}

export type Load<T> =
  | { kind: "loading" }
  | { kind: "ok"; data: T }
  | { kind: "signin" }
  | { kind: "forbidden" }
  | { kind: "missing" }
  | { kind: "failed" };

/** Loads `url` (an admin route) and loads it again on `refresh`; what is shown stays while it reloads. */
export function useAdmin<T>(url: string | null, fetchImpl: typeof fetch): [Load<T>, () => Promise<void>] {
  const [load, setLoad] = useState<Load<T>>({ kind: "loading" });
  const refresh = useCallback(async () => {
    if (!url) return;
    setLoad((was) => (was.kind === "ok" ? was : { kind: "loading" }));
    try {
      const r = await fetchImpl(url, { credentials: "same-origin", cache: "no-store" });
      if (r.status === 401) return setLoad({ kind: "signin" });
      if (r.status === 403) return setLoad({ kind: "forbidden" });
      if (r.status === 404) return setLoad({ kind: "missing" });
      if (!r.ok) return setLoad({ kind: "failed" });
      setLoad({ kind: "ok", data: (await r.json()) as T });
    } catch {
      setLoad({ kind: "failed" });
    }
  }, [url, fetchImpl]);
  useEffect(() => {
    setLoad({ kind: "loading" });
    void refresh();
  }, [refresh]);
  return [load, refresh];
}
