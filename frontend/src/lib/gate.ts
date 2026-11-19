// The Discord gate, as the page sees it: OTD Palace is free for everyone, and free members of our Discord server get
// the extras (every deal, the filters, the full moves, their own plan, pings and alerts).
//
// The server says in the page whether the gate is on and who is asking (`<script id="me">`: a member "in", "anon" with
// no session, "out" signed in but not in the server, "banned" refused by it), so the first paint is already the right
// one, with no request to wait for. Anyone but a member gets the free site's snapshot from the server (it says
// `locked`), so the page shows what it holds and offers to unlock the rest. A page without that mark is one the gate
// does not concern (it is off). A 401 {"error": "discord_required"} from a member route (a member who left the server)
// is told to every listener here: the page asks the server again who this is, and its next snapshot is the free one.
import { formatRax } from "./format";

/** Who is asking, as the server says: "in" a member of our server, "anon" not signed in, "out" signed in with Discord
 * but not in the server (left, removed, or the join failed), "banned" refused by the server. */
export type GateState = "anon" | "in" | "out" | "banned";

export interface Me {
  gate: boolean;
  member: boolean;
  state: GateState;
  /** The Discord name to show; the page's mark never carries one (one page serves everyone): /api/me does. */
  name: string | null;
}

export interface Teaser {
  deals: number;
  sports: number;
  best_pct: number | null;
  generated_at: string | null;
}

const NAME_MAX_CHARS = 32;
/** Data older than this is not worth a "checked … ago" on the gate screen. */
const TEASER_AGE_MAX_S = 3600;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

const STATES: readonly GateState[] = ["anon", "in", "out", "banned"];

function parseMe(value: unknown): Me | null {
  if (!isRecord(value) || typeof value.gate !== "boolean" || typeof value.member !== "boolean") return null;
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, NAME_MAX_CHARS) : null;
  // A server from before the states says only member or not.
  const given = STATES.find((s) => s === value.state);
  const state: GateState = value.member ? "in" : given && given !== "in" ? given : "anon";
  return { gate: value.gate, member: value.member, state, name };
}

/** The gate's mark the server put in the page, if there is one and it can be read. */
export function readInlinedMe(): Me | null {
  try {
    const text = document.getElementById("me")?.textContent;
    return text ? parseMe(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** Whether the gate is on and this visitor a member, from the server; null when it cannot say. */
export async function fetchMe(fetchImpl: typeof fetch = fetch): Promise<Me | null> {
  try {
    const r = await fetchImpl("/api/me", { cache: "no-store", credentials: "same-origin" });
    return r.ok ? parseMe(await r.json()) : null;
  } catch {
    return null;
  }
}

/** The gate screen's counts; null when there are none to show (no answer, or one that cannot be read). */
export async function fetchTeaser(fetchImpl: typeof fetch = fetch): Promise<Teaser | null> {
  try {
    const r = await fetchImpl("/api/teaser", { credentials: "omit" });
    if (!r.ok) return null;
    const body: unknown = await r.json();
    if (!isRecord(body) || !isCount(body.deals) || !isCount(body.sports)) return null;
    const best = body.best_pct;
    if (!(best === null || (isCount(best) && best < 100))) return null;
    return {
      deals: body.deals,
      sports: body.sports,
      best_pct: best,
      generated_at: typeof body.generated_at === "string" ? body.generated_at : null,
    };
  } catch {
    return null;
  }
}

/** "143 live deals right now across 8 sports · best 38% under"; null with no deal to count. */
export function teaserLine(t: Teaser): string | null {
  if (t.deals <= 0) return null;
  const deals = `${formatRax(t.deals)} live deal${t.deals === 1 ? "" : "s"} right now`;
  const sports = t.sports === 1 ? " in 1 sport" : t.sports > 1 ? ` across ${formatRax(t.sports)} sports` : "";
  const best = t.best_pct !== null && t.best_pct > 0 ? ` · best ${t.best_pct}% under` : "";
  return `${deals}${sports}${best}`;
}

/** "Checked 12 s ago" from the data's time; null without one, or when it is too old to be worth saying. */
export function teaserAge(generatedAt: string | null, nowMs: number): string | null {
  if (!generatedAt) return null;
  const at = Date.parse(generatedAt);
  if (Number.isNaN(at)) return null;
  const ageS = Math.floor((nowMs - at) / 1000);
  if (ageS > TEASER_AGE_MAX_S) return null;
  if (ageS < 5) return "Checked just now";
  return ageS < 120 ? `Checked ${ageS} s ago` : `Checked ${Math.floor(ageS / 60)} min ago`;
}

/** The login link, coming back to where the visitor is (the hash included: it names the tab or the sheet). */
export function loginHref(where: { pathname: string; search: string; hash: string } = location): string {
  return `/auth/discord?next=${encodeURIComponent(`${where.pathname}${where.search}${where.hash}`)}`;
}

/** "I joined, check again": the server asks Discord now whether this visitor is in our server. Their state after it,
 * or null when the server did not answer. */
export async function recheck(fetchImpl: typeof fetch = fetch): Promise<GateState | null> {
  try {
    const r = await fetchImpl("/auth/recheck", { method: "POST", credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return null;
    const body: unknown = await r.json();
    return isRecord(body) ? (STATES.find((s) => s === body.state) ?? null) : null;
  } catch {
    return null;
  }
}

/** Signs out (the server clears the session cookie): whether it answered. */
export async function signOut(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl("/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Calls `listener` whenever the server says the gate wants a member; returns how to stop. */
export function onDiscordRequired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The server answered 401 {"error": "discord_required"}: tells every listener (the page shows the gate screen). */
export function noteDiscordRequired(): void {
  for (const listener of [...listeners]) listener();
}
