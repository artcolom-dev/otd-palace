// Reading a Real account's passes through this site's server, and saying the outcome in plain words.
import { DEVICE_PASSES } from "../data/local";
import type { PassMarket } from "../data/types";
import { formatRax } from "./format";
import { noteDiscordRequired } from "./gate";
import { sportLabel } from "./words";
import type { Holding } from "./passes";

// "signin": the server wants a member of our Discord (401); "offline": the server could not be reached at all;
// "busy": the server or Real cannot look now (limits, 429, 503, anything else).
export type Status = "ok" | "not_found" | "private" | "busy" | "signin" | "offline";

export interface Answer {
  status: Status;
  username: string | null;
  passes: Holding[];
  truncated: boolean;
  markets: PassMarket[]; // the account's passes valued from their season's ranking, as the snapshot's markets
  waiting: number; // passes whose season's ranking is still being read: ask again
  seasons_waiting: number;
}

const NONE = { username: null, passes: [], truncated: false, markets: [], waiting: 0, seasons_waiting: 0 };
const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

export const USERNAME = /^@?[A-Za-z0-9_.]{2,30}$/;

/** Asks the server for a username's passes; a failure reads as "signin", "offline" or "busy" (see Status). */
export async function fetchPasses(username: string, fetchImpl: typeof fetch = fetch): Promise<Answer> {
  let r: Response;
  try {
    r = await fetchImpl(`/api/passes/import?u=${encodeURIComponent(username)}`, { cache: "no-store" });
  } catch {
    return { ...NONE, status: "offline" }; // no answer at all: no network, or the site is down
  }
  try {
    if (r.status === 401) {
      noteDiscordRequired(); // the top bar learns this visitor is not (or no longer) a signed-in member
      return { ...NONE, status: "signin" };
    }
    if (r.status === 429 || r.status === 400) {
      return { ...NONE, status: r.status === 400 ? "not_found" : "busy" };
    }
    const body = (await r.json()) as Partial<Answer>;
    const status: Status = body.status === "ok" || body.status === "not_found" || body.status === "private" ? body.status : "busy";
    return {
      status,
      username: typeof body.username === "string" ? body.username : null,
      passes: Array.isArray(body.passes) ? body.passes : [],
      truncated: body.truncated === true,
      markets: Array.isArray(body.markets) ? body.markets.filter((m) => typeof m?.key === "string" && Array.isArray(m.rungs)) : [],
      waiting: count(body.waiting),
      seasons_waiting: count(body.seasons_waiting),
    };
  } catch {
    return { ...NONE, status: "busy" }; // an answer that is not ours (a proxy's error page)
  }
}

/** What the visitor reads after a lookup. */
export function importWords(answer: Answer, asked: string, known: number): string {
  const name = answer.username ?? asked.replace(/^@/, "");
  if (answer.status === "not_found") return `No Real account is named ${name}.`;
  if (answer.status === "private") return `${name} has no passes anyone can see.`;
  if (answer.status === "busy") return "Too many lookups right now. Try again in a few minutes.";
  if (answer.status === "signin") return "Looking up a Real account is for members of the OTD Palace Discord. It's free.";
  if (answer.status === "offline") return "Couldn't reach OTD Palace. Check your connection and try again.";
  const n = answer.passes.length;
  const head = `Added ${formatRax(n)} pass${n === 1 ? "" : "es"} from ${name}.`;
  const unknown = Math.min(n, DEVICE_PASSES) - known;
  const tail = unknown > 0 ? ` ${formatRax(unknown)} ${unknown === 1 ? "is" : "are"} not on this site yet.` : "";
  return `${head}${tail}${n > DEVICE_PASSES ? ` Only the first ${formatRax(DEVICE_PASSES)} fit on a device.` : ""}`;
}


/** The username an address asks to analyze (#account/<name>), or null. */
export function accountFromHash(hash: string): string | null {
  let raw: string;
  try {
    raw = decodeURIComponent(hash);
  } catch {
    return null;
  }
  const m = /^#account\/@?([A-Za-z0-9_.]{2,30})$/.exec(raw);
  return m ? m[1]! : null;
}

/** The address of an account's analysis on this site. */
export const accountHash = (username: string) => `#account/${encodeURIComponent(username)}`;

/** This site's markets, then the account's own for the passes it does not list (a nameless one named by its sport). */
export function withAccountMarkets(site: readonly PassMarket[], account: readonly PassMarket[]): PassMarket[] {
  const keys = new Set(site.map((m) => m.key));
  const extra = account
    .filter((m) => !keys.has(m.key) && Boolean(keys.add(m.key)))
    .map((m) => (m.player_name.trim() ? m : { ...m, player_name: `${sportLabel(m.sport)} ${m.kind === "team" ? "team" : "player"} #${m.player_id}` }));
  return extra.length ? [...site, ...extra] : [...site];
}
