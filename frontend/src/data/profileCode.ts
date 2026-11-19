// A profile code: what a visitor keeps on this device (the players followed, the passes held and the valuations an
// analysed account gave the ones this site does not list, the Rax saved, a few typed numbers), as one piece of text to
// paste on another device. Nothing is stored on a server and the code has no name in it; alerts are left out because a
// subscription belongs to the device that made it.
//
// Two forms, told apart by their prefix, both always read:
//   MP1.<base64url of the JSON>                      the first codes (no valuations then), and where a browser cannot compress
//   MP2.<base64url of the JSON, deflate-raw packed>  a big account's code is then a few times shorter
import { DEVICE_PASSES, type LocalState, local, parseLocal } from "./local";

const PLAIN = "MP1.";
const PACKED = "MP2.";
// Room for a device's whole DEVICE_PASSES and their valuations, even as a plain code (~4 M characters measured).
const MAX_CODE_CHARS = 8_000_000;
// What a packed code may unpack to at most: a code cannot make the page swallow more than this.
const MAX_JSON_BYTES = 16_000_000;

/** What a code carries of a state. */
const carried = (state: LocalState) => ({
  v: 2,
  follows: state.follows,
  passes: state.passes,
  heldMarkets: state.heldMarkets,
  opened: state.opened,
  got: state.got,
  saved: state.saved,
  balance: state.balance,
  dailyRax: state.dailyRax,
  link: state.link,
});

/** Nothing in this state is worth a code: no player followed, no pass, nothing saved or typed. */
export function isEmptyProfile(state: LocalState): boolean {
  return (
    state.follows.length === 0 && state.passes.length === 0 && state.opened.length === 0 && state.got.length === 0 &&
    state.saved === 0 && state.balance === null && state.dailyRax === null
  );
}

function toB64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The bytes through a compression or decompression stream, refused past `limit` bytes out. */
async function through(bytes: Uint8Array<ArrayBuffer>, stream: ReadableWritablePair<Uint8Array, BufferSource>, limit: number): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  const reader = source.pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("too big");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The code of this state: packed when the browser can compress, else plain. */
export async function encodeProfile(state: LocalState, { compress = true } = {}): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(carried(state)));
  if (compress && typeof CompressionStream === "function") {
    try {
      return PACKED + toB64url(await through(json, new CompressionStream("deflate-raw"), Number.POSITIVE_INFINITY));
    } catch {
      // the plain code below
    }
  }
  return PLAIN + toB64url(json);
}

/** The state a code carries, each field checked as the page checks its own storage; null when it is not a code. */
export async function decodeProfile(text: string): Promise<LocalState | null> {
  const code = text.trim();
  if (code.length > MAX_CODE_CHARS) return null;
  try {
    let json: Uint8Array;
    if (code.startsWith(PLAIN)) json = fromB64url(code.slice(PLAIN.length));
    else if (code.startsWith(PACKED) && typeof DecompressionStream === "function")
      json = await through(fromB64url(code.slice(PACKED.length)), new DecompressionStream("deflate-raw"), MAX_JSON_BYTES);
    else return null;
    const data: unknown = JSON.parse(new TextDecoder().decode(json));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    return parseLocal(data);
  } catch {
    return null;
  }
}

/**
 * The imported profile merged into this device's state: unions, the imported pass (and valuation) wins, alerts and the
 * rest stay. Every incoming pass is kept; when the device would then hold more than DEVICE_PASSES, its own oldest go.
 */
export function mergeProfile(current: LocalState, incoming: LocalState): LocalState {
  const coming = new Set(incoming.passes.map((q) => q.key));
  const own = current.passes.filter((p) => !coming.has(p.key));
  const room = Math.max(0, DEVICE_PASSES - incoming.passes.length);
  const passes = [...own.slice(Math.max(0, own.length - room)), ...incoming.passes].slice(0, DEVICE_PASSES);
  const kept = new Set(passes.map((p) => p.key));
  const valued = new Set(incoming.heldMarkets.map((m) => m.key));
  const heldMarkets = [...current.heldMarkets.filter((m) => !valued.has(m.key)), ...incoming.heldMarkets].filter((m) => kept.has(m.key));
  const opened = [...incoming.opened, ...current.opened.filter((o) => !incoming.opened.some((i) => i.key === o.key))]
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);
  return {
    ...current,
    follows: [...new Set([...current.follows, ...incoming.follows])],
    passes,
    heldMarkets,
    opened,
    got: [...new Set([...current.got, ...incoming.got])].slice(0, 500),
    saved: Math.max(current.saved, incoming.saved),
    balance: current.balance ?? incoming.balance,
    dailyRax: current.dailyRax ?? incoming.dailyRax,
    // The linked account comes along with its passes (the newer link when both devices have one).
    link: incoming.link && (!current.link || incoming.link.at >= current.link.at) ? incoming.link : current.link,
  };
}

/** What a restore did: the players and passes the code carried, and how many of this device's own passes made room. */
export type ApplyResult =
  | { ok: true; follows: number; passes: number; dropped: number }
  | { ok: false; reason: "invalid" | "unsupported" };

/** A packed code this browser cannot unpack (no DecompressionStream, e.g. Safari before 16.4). */
const unreadable = (text: string) => text.trim().startsWith(PACKED) && typeof DecompressionStream !== "function";

/** Reads a pasted code and keeps it on this device (on top of what another tab may have saved meanwhile). */
export async function applyProfile(text: string): Promise<ApplyResult> {
  if (unreadable(text)) return { ok: false, reason: "unsupported" };
  const incoming = await decodeProfile(text);
  if (!incoming) return { ok: false, reason: "invalid" };
  let dropped = 0;
  local.update((current) => {
    const merged = mergeProfile(current, incoming);
    const coming = new Set(incoming.passes.map((p) => p.key));
    dropped = current.passes.filter((p) => !coming.has(p.key)).length + incoming.passes.length - merged.passes.length;
    return merged;
  });
  return { ok: true, follows: incoming.follows.length, passes: incoming.passes.length, dropped };
}
