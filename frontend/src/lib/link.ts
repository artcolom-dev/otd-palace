// "Link your Real account": one action that reads an account's passes and makes them the visitor's own for all advice.
// Anyone links on their own device; a member signed in through our Discord also keeps the link on the server
// (/api/me/link), so it follows them to any device and unlocks their Discord perks. Pure helpers and the requests;
// the panel that runs them is components/passes/AccountAnalysis.
import { useSyncExternalStore } from "react";
import type { Snapshot } from "../data/types";
import { type Answer, fetchPasses } from "./accountPasses";
import { track } from "./activity";
import { noteDiscordRequired } from "./gate";

/** Whether this site can read a Real account: the live feed, or the sample data's sample accounts. */
export const canLink = (snap: Pick<Snapshot, "links" | "rules">): boolean =>
  snap.links?.accounts === true || Boolean(snap.rules.coverage);

/** "updated 3 min ago" for a link read at `at`. */
export function updatedWords(at: number, now: number): string {
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 1) return "updated just now";
  if (min < 60) return `updated ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `updated ${h} h ago`;
  const d = Math.floor(h / 24);
  return `updated ${d} day${d === 1 ? "" : "s"} ago`;
}

/** What linking unlocks for a member, as the server says (see advisor/discord_perks.perks_state). */
export interface Perks {
  linked: boolean;
  roles: string[];
  lounge: boolean;
  big_accounts: boolean;
  pings: boolean;
  dm_closed: boolean;
}

/** A member's link as the server keeps it. */
export interface ServerLink {
  username: string;
  linked_at: number; // seconds since the epoch
  refreshed_at: number;
  passes: number;
  year: number | null;
  pings: boolean;
  dm_closed: boolean;
}

export interface MemberLink {
  link: ServerLink | null;
  perks: Perks;
  unlinked_at: number | null; // when the member last unlinked (seconds since the epoch), while nothing is linked
  skew_ms?: number; // the server's clock minus this device's, when the server said what time it is
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readPerks(v: unknown): Perks | null {
  if (!isRecord(v) || typeof v.linked !== "boolean" || !Array.isArray(v.roles)) return null;
  return {
    linked: v.linked,
    roles: v.roles.filter((r): r is string => typeof r === "string").slice(0, 20),
    lounge: v.lounge === true,
    big_accounts: v.big_accounts === true,
    pings: v.pings === true,
    dm_closed: v.dm_closed === true,
  };
}

/** A /api/me/link answer read field by field, or null. */
export function readMemberLink(v: unknown): MemberLink | null {
  if (!isRecord(v)) return null;
  const perks = readPerks(v.perks);
  if (!perks) return null;
  const l = v.link;
  const unlinked_at = num(v.unlinked_at) ? v.unlinked_at : null;
  const skew_ms = num(v.now) ? v.now * 1000 - Date.now() : undefined;
  if (l === null || l === undefined) return { link: null, perks, unlinked_at, ...(skew_ms !== undefined && { skew_ms }) };
  if (!isRecord(l) || typeof l.username !== "string" || !num(l.linked_at)) return null;
  return {
    link: {
      username: l.username,
      linked_at: l.linked_at,
      refreshed_at: num(l.refreshed_at) ? l.refreshed_at : l.linked_at,
      passes: num(l.passes) ? l.passes : 0,
      year: num(l.year) ? l.year : null,
      pings: l.pings === true,
      dm_closed: l.dm_closed === true,
    },
    perks,
    unlinked_at: null,
  };
}

// The member's link and perks, as last heard from the server, for every component that shows them.
let mine: MemberLink | null = null;
const listeners = new Set<() => void>();
function keep(next: MemberLink | null) {
  mine = next;
  for (const l of listeners) l();
}
export const memberLinkStore = {
  get: () => mine,
  set: keep,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** The member's link and perks as last heard from the server; null before the first answer (or with no gate). */
export function useMemberLink(): MemberLink | null {
  return useSyncExternalStore(memberLinkStore.subscribe, memberLinkStore.get, memberLinkStore.get);
}

// How many times this page has begun an unlink. A read of the account that started before an unlink must not link the
// device (or the server) back when its answer comes in late: it compares this count before and after.
let unlinks = 0;
export const unlinkCount = () => unlinks;
export const noteUnlink = () => {
  unlinks += 1;
};

const JSON_HEADERS = { "Content-Type": "application/json" };

/** GET /api/me/link: the member's link and perks; null when the server cannot say. */
export async function fetchMemberLink(fetchImpl: typeof fetch): Promise<MemberLink | null> {
  try {
    const r = await fetchImpl("/api/me/link", { cache: "no-store", credentials: "same-origin" });
    if (r.status === 401) noteDiscordRequired();
    if (!r.ok) return null;
    const found = readMemberLink(await r.json());
    if (found) keep(found);
    return found;
  } catch {
    return null;
  }
}

/** An import answer; `note` when the server would not keep a member's link (another member linked that name, or
 * no room): the account is then linked on this device alone, and the note says why. */
export type LinkAnswer = Answer & { note?: string };

/**
 * Reads an account to link it: through /api/me/link for a member (the server keeps the link), else through the
 * plain import route. Any failure reads as "busy", as a lookup does.
 */
export async function fetchForLink(username: string, member: { fetchImpl: typeof fetch } | null, fetchImpl: typeof fetch = fetch): Promise<LinkAnswer> {
  if (!member) return fetchPasses(username, fetchImpl);
  const began = unlinks;
  try {
    const r = await member.fetchImpl("/api/me/link", {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ username }),
    });
    if (r.status === 401) noteDiscordRequired();
    const text = await r.text();
    if (unlinks !== began) {
      // The member unlinked while this was being read: the server just kept the link again, so forget it again.
      void unlinkRequest(member.fetchImpl);
      return { ...EMPTY, status: "busy" };
    }
    let refused: string | null = null; // the server keeps no link: another member has that name, or no room
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (r.status === 409 || (r.status === 503 && body.error === "full")) {
        refused = typeof body.message === "string" ? body.message.slice(0, 200) : "Your Discord could not keep this link.";
      }
    } catch {
      // not JSON: an import answer's status speaks
    }
    if (refused !== null) {
      // Linked on this device all the same: anyone can type any name, so a squatted name must not block its owner.
      const own = await fetchPasses(username, fetchImpl);
      return { ...own, note: `${refused} It is linked on this device only.` };
    }
    // The answer is an import answer: read it as the import route's, with the same checks.
    const answer = await fetchPasses(username, async () => new Response(text, { status: r.status }));
    try {
      const found = readMemberLink(JSON.parse(text));
      if (found) keep(found);
    } catch {
      // the import answer alone
    }
    return answer;
  } catch {
    return { ...EMPTY, status: "offline" }; // no answer at all: no network, or the site is down
  }
}

const EMPTY = { username: null, passes: [], truncated: false, markets: [], waiting: 0, seasons_waiting: 0 };

/** PATCH /api/me/link: a member's settings; the new state, or null when it did not go through. */
export async function saveLinkSettings(
  member: { fetchImpl: typeof fetch },
  patch: { pings?: boolean; follows?: string[]; year?: number },
): Promise<MemberLink | null> {
  if (patch.pings !== undefined) track("pings", patch.pings ? "on" : "off");
  try {
    const r = await member.fetchImpl("/api/me/link", {
      method: "PATCH",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ ...patch, follows: patch.follows?.slice(0, 200) }),
    });
    if (!r.ok) return null;
    const found = readMemberLink(await r.json());
    if (found) keep(found);
    return found;
  } catch {
    return null;
  }
}

const UNLINK_TIMEOUT_MS = 15_000;

/** What came of an unlink request: "ok", the HTTP status that refused it, or "offline" (no answer in time). */
export type UnlinkOutcome = "ok" | "offline" | number;

async function unlinkRequest(fetchImpl: typeof fetch): Promise<UnlinkOutcome> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), UNLINK_TIMEOUT_MS);
  try {
    const r = await fetchImpl("/api/me/link", { method: "DELETE", credentials: "same-origin", signal: stop.signal });
    return r.ok ? "ok" : r.status;
  } catch {
    return "offline";
  } finally {
    clearTimeout(timer);
  }
}

/** DELETE /api/me/link: forgets a member's link on the server, and says what came of it. */
export async function tryUnlinkOnServer(member: { fetchImpl: typeof fetch }): Promise<UnlinkOutcome> {
  track("unlink");
  noteUnlink();
  const outcome = await unlinkRequest(member.fetchImpl);
  if (outcome === "ok") {
    keep({
      link: null,
      perks: { linked: false, roles: [], lounge: false, big_accounts: false, pings: false, dm_closed: false },
      unlinked_at: Date.now() / 1000,
    });
  }
  return outcome;
}

/** The words for an unlink the server did not take, by what it answered. */
export function unlinkFailure(outcome: Exclude<UnlinkOutcome, "ok">): string {
  if (outcome === 401) return "Not unlinked: your Discord sign-in ran out. Sign in again, then press Unlink.";
  if (outcome === 403) return "Not unlinked: your browser blocked the request. Reload the page and press Unlink again.";
  if (outcome === 429) return "Not unlinked: too many tries. Wait a minute, then press Unlink again.";
  if (outcome === "offline") return "Not unlinked: no answer from the server. Check your connection, then press Unlink again.";
  return "Not unlinked: the server had a problem. Press Unlink again in a moment.";
}

/** DELETE /api/me/link: whether the server forgot the member's link. */
export async function unlinkOnServer(member: { fetchImpl: typeof fetch }): Promise<boolean> {
  return (await tryUnlinkOnServer(member)) === "ok";
}
