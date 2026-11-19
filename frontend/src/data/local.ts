// What this device remembers between visits, and nothing about who uses it: the players followed, the deals
// opened (a few facts about the card, so a later visit can ask "got one?"), whether the welcome was dismissed, the
// daily-pay passes its visitor says they hold, when it last left the site and how many visits it made, the Rax its
// visitor saved on deals they marked as got (never sent anywhere), the balance and daily Rax they typed, the daily
// checklist they ticked, and its alert settings (the server only ever gets the rules made from them, see lib/push.ts).
import { useSyncExternalStore } from "react";
import { noteUnlink } from "../lib/link";
import { type Holding, type PassBasis, toStored } from "../lib/passes";
import { EMPTY_ROUTINE, type Routine, type RoutineId, readRoutine, setTick } from "../lib/routine";
import { dealKey } from "./deals";
import type { Deal, PassMarket } from "./types";

export interface OpenedDeal {
  key: string; // listing and kind, as `dealKey`
  listing_id: number;
  kind: Deal["kind"];
  sport: string;
  player_id: number;
  player_name: string;
  price: number;
  reference: number;
  rarity: number;
  season?: number; // with the rating, what a similar deal is found by when this one ends (older records lack them)
  rating?: number;
  at: number; // when it was opened, ms since the epoch
}

/** The alerts this device asked for. All off until its visitor turns them on; the quiet hours are on by default. */
export interface AlertSettings {
  on: boolean; // subscribed on this device ("Turn on alerts")
  deals: boolean; // a new deal on a followed player
  lastCall: boolean; // a deal opened from here ends within 3 minutes
  moves: boolean; // a followed player's prices moved 20% or more today
  digest: boolean; // today's best deals, once a day
  routine: boolean; // a reminder of the daily checklist, once a day at the digest hour
  digestHour: number; // 0-23, this device's clock
  quiet: [number, number] | null; // no alert from the first hour to the second; null: none
  renew: boolean; // switched off because the server's key changed: the sheet asks to turn alerts on again
}

export const DEFAULT_ALERTS: AlertSettings = {
  on: false, deals: false, lastCall: false, moves: false, digest: false, routine: false, digestHour: 9, quiet: [23, 7],
  renew: false,
};

/** A pass just removed, as `local.removePass` says: enough to put it back as it was. */
export interface RemovedPass {
  holding: Holding;
  index: number; // its place in the list
  valued: PassBasis | null; // its valuation, when an analysed account brought one
}

/** The Real account linked on this device: its passes are the visitor's own for all advice. */
export interface LinkedAccount {
  username: string;
  at: number; // when its passes were last read, ms since the epoch
  count: number; // passes the account showed (a device keeps DEVICE_PASSES of them at most)
}

export interface LocalState {
  follows: string[]; // "sport:player_id"
  opened: OpenedDeal[]; // newest first
  welcomeDismissed: boolean;
  passes: Holding[]; // "sport:season:kind:id" with a rarity or an exact rating; `spent` when the app says it is maxed
  // An analysed account's valuation of the passes this device took from it that this site does not list (its season's
  // earnings ranking), so they count here too; one per held pass at most, as of when they were added. Kept without
  // their rungs (hooks/useHeldMarkets walks them again from the day they are read) and in a storage key of their own,
  // written only when they change: a 2,000-pass account's valuations would otherwise be rewritten at every click.
  heldMarkets: PassBasis[];
  lastVisitAt: number | null; // when the page was last hidden or closed, ms since the epoch
  visits: number; // visits so far; coming back within VISIT_GAP_MS of leaving is the same visit
  saved: number; // Rax saved on the deals marked "Got it": usual price minus price, never below 0
  got: number[]; // the listings counted into `saved`, newest first: none is counted twice
  openedDismissedAt: number; // "Not this time": deals opened up to then are not asked about again
  installDismissed: boolean; // the add-to-home-screen card was put away
  balance: number | null; // the last balance typed into "What can I do with…", in Rax; null when none
  dailyRax: number | null; // the Rax the visitor says they make on a typical day (their own estimate); null when not given
  routine: Routine; // "Your day": the checklist ticked today, the days that counted, whether the card shows
  alerts: AlertSettings;
  link: LinkedAccount | null; // the Real account linked here; null when none (its passes carry `from: "real"`)
}

const STORAGE_KEY = "advisor.local.v1";
const HELD_KEY = "advisor.held.v1";
const MAX_OPENED = 30;
/** The passes one device keeps: every pass of the biggest accounts (the server reads up to as many). */
export const DEVICE_PASSES = 5000;
const MAX_PASSES = DEVICE_PASSES;
const MAX_GOT = 500;
/** Coming back within this long of leaving is the same visit. */
export const VISIT_GAP_MS = 30 * 60_000;
const EMPTY: LocalState = {
  follows: [], opened: [], welcomeDismissed: false, passes: [], heldMarkets: [], lastVisitAt: null, visits: 0, saved: 0, got: [],
  openedDismissedAt: 0, installDismissed: false, balance: null, dailyRax: null, routine: EMPTY_ROUTINE,
  alerts: DEFAULT_ALERTS, link: null,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readOpened(value: unknown): OpenedDeal[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (o): o is OpenedDeal =>
        isRecord(o) && typeof o.key === "string" && isNum(o.listing_id) && (o.kind === "target" || o.kind === "bid") &&
        typeof o.sport === "string" && isNum(o.player_id) && typeof o.player_name === "string" && isNum(o.price) &&
        isNum(o.reference) && isNum(o.rarity) && isNum(o.at),
    )
    .map((o) => ({ ...o, season: isNum(o.season) ? o.season : undefined, rating: isNum(o.rating) ? o.rating : undefined }))
    .slice(0, MAX_OPENED);
}

/** The tiers every pass ladder climbs (advisor/rules.py OTD_LADDERS), General to Iconic. */
const LADDER_TIERS: ReadonlySet<string> = new Set([
  "general", "common", "uncommon", "rare", "epic", "legendary", "mystic", "iconic",
]);

/**
 * A held pass as stored, or null when it cannot be read: a key and either a rarity of the ladder or a rating of 0
 * or more. A rarity the ladder does not have is dropped: it would be read as a General pass.
 */
function readHolding(value: unknown): Holding | null {
  if (!isRecord(value) || typeof value.key !== "string" || value.key === "") return null;
  const out: Holding = { key: value.key };
  if (typeof value.tier === "string" && LADDER_TIERS.has(value.tier)) out.tier = value.tier;
  if (isNum(value.rating) && value.rating >= 0) out.rating = value.rating;
  // What Real itself says, from a linked account: each kept only when it fits.
  if (typeof value.rarity === "string" && LADDER_TIERS.has(value.rarity)) out.rarity = value.rarity;
  if (isNum(value.mult) && value.mult > 0 && value.mult < 1000) out.mult = value.mult;
  if (isNum(value.cap) && value.cap >= 0) out.cap = value.cap;
  if (isNum(value.earned) && value.earned >= 0) out.earned = value.earned;
  if (Number.isInteger(value.level) && (value.level as number) >= 0) out.level = value.level as number;
  if (typeof value.label === "string" && value.label.trim() && value.label.length <= 24) out.label = value.label.trim();
  if (out.tier === undefined && out.rating === undefined && out.rarity === undefined) return null;
  if (value.spent === true) out.spent = true;
  if (value.from === "real") out.from = "real";
  return out;
}

/** The linked account as stored, or null. */
function readLink(value: unknown): LinkedAccount | null {
  if (!isRecord(value) || typeof value.username !== "string" || !/^[A-Za-z0-9_.]{2,30}$/.test(value.username)) return null;
  if (!isNum(value.at) || value.at <= 0) return null;
  return { username: value.username, at: value.at, count: atLeast0(value.count) };
}

function readPasses(value: unknown): Holding[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map(readHolding)
    .filter((h): h is Holding => h !== null && !seen.has(h.key) && Boolean(seen.add(h.key)))
    .slice(0, MAX_PASSES);
}

/**
 * The stored valuations of held passes this site does not list, each the shape the planner reads (numbers it can
 * trust, 12 month shares), only for a pass still held, once each, without the figures derived from them (an older
 * device stored its rungs too: they are dropped here).
 */
function readHeldMarkets(value: unknown, passes: readonly Holding[]): PassBasis[] {
  if (!Array.isArray(value)) return [];
  const held = new Set(passes.map((p) => p.key));
  const seen = new Set<string>();
  return value
    .filter(
      (m): m is PassBasis =>
        isRecord(m) && typeof m.key === "string" && held.has(m.key) && !seen.has(m.key) && Boolean(seen.add(m.key)) &&
        typeof m.sport === "string" && typeof m.kind === "string" && typeof m.player_name === "string" &&
        typeof m.season_label === "string" && (m.season_state === "past" || m.season_state === "current") &&
        isNum(m.season) && isNum(m.player_id) && isNum(m.base_1x) && m.base_1x >= 0 &&
        isNum(m.season_progress) && m.season_progress > 0 && m.season_progress <= 1 &&
        (m.game_days === null || (isNum(m.game_days) && m.game_days > 0)) &&
        Array.isArray(m.month_share) && m.month_share.length === 12 && m.month_share.every(isNum) &&
        (m.rate_traded === null || (isNum(m.rate_traded) && m.rate_traded >= 0)) && isNum(m.rate_sales) &&
        Array.isArray(m.shelf) && isNum(m.shelf_count) && (m.mint_cost === null || isNum(m.mint_cost)) &&
        typeof m.mintable === "boolean",
    )
    .slice(0, MAX_PASSES)
    .map(toStored);
}

const atLeast0 = (v: unknown): number => (isNum(v) && v >= 0 ? Math.round(v) : 0);
const isHour = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23;

/** Alert settings as stored, each field that cannot be trusted taken from the defaults. */
function readAlerts(value: unknown): AlertSettings {
  if (!isRecord(value)) return DEFAULT_ALERTS;
  const flag = (key: keyof AlertSettings) => (typeof value[key] === "boolean" ? (value[key] as boolean) : DEFAULT_ALERTS[key]);
  const q = value.quiet;
  return {
    on: flag("on") as boolean,
    deals: flag("deals") as boolean,
    lastCall: flag("lastCall") as boolean,
    moves: flag("moves") as boolean,
    digest: flag("digest") as boolean,
    routine: flag("routine") as boolean,
    digestHour: isHour(value.digestHour) ? value.digestHour : DEFAULT_ALERTS.digestHour,
    quiet: q === null ? null : Array.isArray(q) && q.length === 2 && isHour(q[0]) && isHour(q[1]) ? [q[0], q[1]] : DEFAULT_ALERTS.quiet,
    renew: flag("renew") as boolean,
  };
}

/** A balance as stored: a positive whole number of Rax, else none. */
const readBalance = (value: unknown): number | null => (isNum(value) && value >= 0.5 ? Math.round(value) : null);

/** A state from anything stored or pasted: each field read as the page reads it, what does not fit left out. */
export function parseLocal(stored: unknown): LocalState {
  {
    if (!isRecord(stored)) return EMPTY;
    return {
      follows: Array.isArray(stored.follows)
        ? [...new Set(stored.follows.filter((f): f is string => typeof f === "string" && f.includes(":")))]
        : [],
      opened: readOpened(stored.opened),
      welcomeDismissed: stored.welcomeDismissed === true,
      passes: readPasses(stored.passes),
      heldMarkets: readHeldMarkets(stored.heldMarkets, readPasses(stored.passes)),
      lastVisitAt: isNum(stored.lastVisitAt) && stored.lastVisitAt > 0 ? stored.lastVisitAt : null,
      visits: atLeast0(stored.visits),
      saved: atLeast0(stored.saved),
      got: Array.isArray(stored.got) ? [...new Set(stored.got.filter(isNum))].slice(0, MAX_GOT) : [],
      openedDismissedAt: atLeast0(stored.openedDismissedAt),
      installDismissed: stored.installDismissed === true,
      balance: readBalance(stored.balance),
      dailyRax: readBalance(stored.dailyRax),
      routine: readRoutine(stored.routine),
      alerts: readAlerts(stored.alerts),
      link: readLink(stored.link),
    };
  }
}

// The held valuations are not safely under their own key (an older device kept them in the main key, or the last
// write of their key failed): until they are, the main key keeps them too, and each write tries their key again.
let heldUnsaved = false;
// What storage held under each key when this tab last read it or wrote it. Another tab of the site writes the same
// keys: when storage no longer holds this, the other tab wrote since, and this tab reads it again before it writes
// (else its whole-state write would erase what the other tab saved, an imported account among it).
let seenMain: string | null = null;
let seenHeld: string | null = null;

function read(): LocalState {
  let main: LocalState;
  try {
    seenMain = localStorage.getItem(STORAGE_KEY);
    main = parseLocal(JSON.parse(seenMain ?? "null"));
  } catch {
    return EMPTY;
  }
  // Read on their own: a valuations key that cannot be read costs the valuations, never the passes.
  let held: unknown = null;
  try {
    seenHeld = localStorage.getItem(HELD_KEY);
    held = JSON.parse(seenHeld ?? "null");
  } catch {
    held = null;
  }
  if (Array.isArray(held)) return { ...main, heldMarkets: readHeldMarkets(held, main.passes) };
  // No key of their own: an older device kept them in the main one, or their last write failed (parseLocal read
  // them from there). The next write moves them.
  heldUnsaved = main.heldMarkets.length > 0;
  return main;
}

let state: LocalState = read();
const listeners = new Set<() => void>();

/** Before a write: what another tab saved since this one last looked, read in, so the write builds on it. */
function sync(): void {
  let main: string | null;
  let held: string | null;
  try {
    main = localStorage.getItem(STORAGE_KEY);
    held = localStorage.getItem(HELD_KEY);
  } catch {
    return; // blocked storage: this tab's memory is all there is
  }
  if (main === seenMain && held === seenHeld) return;
  heldUnsaved = false;
  state = read();
}

/** Writes one key, and remembers what storage now holds under it (only once the write went through). */
function put(key: string, value: string): void {
  localStorage.setItem(key, value);
  if (key === STORAGE_KEY) seenMain = value;
  else seenHeld = value;
}

function commit(next: LocalState) {
  const heldChanged = next.heldMarkets !== state.heldMarkets || heldUnsaved;
  state = next;
  const { heldMarkets, ...rest } = next;
  // The passes first, always: the main key is written before the valuations, so a storage the valuations fill can
  // never keep the passes, the follows or anything else from being saved. Blocked or full storage: this visit still
  // remembers, the next one will not.
  const carry = heldUnsaved;
  try {
    put(STORAGE_KEY, JSON.stringify(carry ? next : rest));
  } catch {
    if (carry) {
      try {
        put(STORAGE_KEY, JSON.stringify(rest)); // too big with them: the passes alone
      } catch {
        // as above
      }
    }
  }
  if (heldChanged) {
    try {
      put(HELD_KEY, JSON.stringify(heldMarkets));
      heldUnsaved = false;
      if (carry) put(STORAGE_KEY, JSON.stringify(rest)); // now safe under their own key
    } catch {
      heldUnsaved = true;
      try {
        localStorage.removeItem(HELD_KEY); // no older copy left to be read instead of the main key's
        seenHeld = null;
      } catch {
        // as above
      }
    }
  }
  for (const listener of listeners) listener();
}

export const local = {
  get: (): LocalState => state,

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Keeps this state (an imported profile merged into the current one). */
  replace(next: LocalState): void {
    commit(next);
  },

  /** Keeps the state `change` makes of the current one, read again first if another tab wrote since. */
  update(change: (current: LocalState) => LocalState): void {
    sync();
    commit(change(state));
  },

  /** Reads the storage again (another tab, or a test that cleared it). */
  reload(): void {
    heldUnsaved = false;
    seenMain = seenHeld = null;
    state = read();
    for (const listener of listeners) listener();
  },

  /** Follows the player, or stops following them; says whether they are followed now. */
  toggleFollow(player: string): boolean {
    sync();
    const on = !state.follows.includes(player);
    commit({ ...state, follows: on ? [...state.follows, player] : state.follows.filter((f) => f !== player) });
    return on;
  },

  /** Remembers that this deal was opened in Real, newest first, once per deal. */
  markOpened(deal: Deal, at = Date.now()): void {
    sync();
    const key = dealKey(deal);
    const record: OpenedDeal = {
      key, listing_id: deal.listing_id, kind: deal.kind, sport: deal.sport, player_id: deal.player_id,
      player_name: deal.player_name, price: deal.price, reference: deal.reference, rarity: deal.rarity,
      season: deal.season, rating: deal.rating, at,
    };
    commit({ ...state, opened: [record, ...state.opened.filter((o) => o.key !== key)].slice(0, MAX_OPENED) });
  },

  isOpened: (listingId: number): boolean => state.opened.some((o) => o.listing_id === listingId),

  dismissWelcome(): void {
    sync();
    commit({ ...state, welcomeDismissed: true });
  },

  /** Keeps a pass this device holds; the same pass again replaces it in place. Says whether it was an update. */
  addPass(holding: Holding): boolean {
    sync();
    const clean = readHolding(holding);
    if (!clean) return false;
    const i = state.passes.findIndex((h) => h.key === clean.key);
    const passes = i >= 0 ? state.passes.map((h, j) => (j === i ? clean : h)) : [...state.passes, clean];
    commit({ ...state, passes: passes.slice(0, MAX_PASSES) });
    return i >= 0;
  },

  /** Keeps many passes in one write (an analysed account's thousands): each as `addPass` would. Says how many were
   * new. */
  addPasses(holdings: readonly Holding[]): number {
    sync();
    const passes = [...state.passes];
    const at = new Map(passes.map((h, i) => [h.key, i]));
    let added = 0;
    for (const holding of holdings) {
      const clean = readHolding(holding);
      if (!clean) continue;
      const i = at.get(clean.key);
      if (i !== undefined) passes[i] = clean;
      else {
        at.set(clean.key, passes.length);
        passes.push(clean);
        added++;
      }
    }
    commit({ ...state, passes: passes.slice(0, MAX_PASSES) });
    return added;
  },

  /** Forgets a held pass and its valuation. Says what went and from where, for `restorePass`; null when not held. */
  removePass(key: string): RemovedPass | null {
    sync();
    const index = state.passes.findIndex((h) => h.key === key);
    const holding = state.passes[index];
    const valued = state.heldMarkets.find((m) => m.key === key) ?? null;
    const heldMarkets = valued ? state.heldMarkets.filter((m) => m.key !== key) : state.heldMarkets;
    commit({ ...state, passes: state.passes.filter((h) => h.key !== key), heldMarkets });
    return holding ? { holding, index, valued } : null;
  },

  /** Undo of a removal: the pass back at its place in the list, with its valuation. Nothing when it is held again. */
  restorePass(removed: RemovedPass): void {
    sync();
    if (state.passes.some((h) => h.key === removed.holding.key)) return;
    const passes = [...state.passes];
    passes.splice(Math.min(removed.index, passes.length), 0, removed.holding);
    const heldMarkets = removed.valued ? [...state.heldMarkets, removed.valued] : state.heldMarkets;
    commit({ ...state, passes: passes.slice(0, MAX_PASSES), heldMarkets });
  },

  /** Keeps an analysed account's valuations for passes this device holds (the same pass again: the newer one). */
  keepMarkets(markets: readonly (PassMarket | PassBasis)[]): void {
    sync();
    const incoming = new Map(markets.map((m) => [m.key, m]));
    const merged = [...state.heldMarkets.filter((m) => !incoming.has(m.key)), ...incoming.values()];
    commit({ ...state, heldMarkets: readHeldMarkets(merged, state.passes) });
  },

  /**
   * Links a Real account: its passes (best rated first, up to DEVICE_PASSES) become this device's, marked as the
   * link's, in one write. Linking again (a refresh, or another account) replaces the link's passes; a pass added by
   * hand stays unless the account holds it too. The account's valuations of its passes this site does not list come
   * along (`siteKeys`: the passes the site lists), so they count here too.
   */
  link(username: string, holdings: readonly Holding[], markets: readonly (PassMarket | PassBasis)[], siteKeys: ReadonlySet<string>, at = Date.now()): void {
    sync();
    const linked: Holding[] = [];
    const keys = new Set<string>();
    let count = 0; // the account's readable passes, kept or not (a device keeps MAX_PASSES)
    for (const h of holdings) {
      const clean = readHolding({ ...h, from: "real" });
      if (!clean || keys.has(clean.key)) continue;
      keys.add(clean.key);
      count++;
      if (linked.length < MAX_PASSES) linked.push(clean);
    }
    const byHand = state.passes.filter((h) => h.from !== "real" && !keys.has(h.key));
    const passes = [...linked, ...byHand].slice(0, MAX_PASSES);
    const valued = markets.filter((m) => keys.has(m.key) && !siteKeys.has(m.key));
    const kept = state.heldMarkets.filter((m) => !keys.has(m.key));
    commit({
      ...state,
      passes,
      heldMarkets: readHeldMarkets([...kept, ...valued], passes),
      link: { username, at, count },
    });
  },

  /** Unlinks the account: its passes leave this device; the ones added by hand stay. */
  unlink(): void {
    noteUnlink();
    sync();
    const passes = state.passes.filter((h) => h.from !== "real");
    commit({ ...state, passes, heldMarkets: readHeldMarkets(state.heldMarkets, passes), link: null });
  },

  /**
   * A page load, or the page back after a while: a new visit unless it left less than VISIT_GAP_MS ago. Says whether
   * it counted a new one.
   */
  startVisit(at = Date.now()): boolean {
    sync();
    const last = state.lastVisitAt;
    if (last !== null && at - last <= VISIT_GAP_MS && state.visits > 0) return false;
    commit({ ...state, visits: state.visits + 1 });
    return true;
  },

  /** The page was hidden or closed: the time a later visit counts "since your last visit" from. */
  leave(at = Date.now()): void {
    sync();
    commit({ ...state, lastVisitAt: at });
  },

  /**
   * "Got it" on an opened deal: adds what it saved (usual price minus price, never below 0) to the tally. Says how
   * much it added, or null when that listing was already counted.
   */
  markGot(deal: OpenedDeal): number | null {
    sync();
    if (state.got.includes(deal.listing_id)) return null;
    const amount = Math.max(0, Math.round(deal.reference - deal.price));
    commit({ ...state, saved: state.saved + amount, got: [deal.listing_id, ...state.got].slice(0, MAX_GOT) });
    return amount;
  },

  /** "Not this time": the deals opened until now are not asked about again. */
  dismissOpened(at = Date.now()): void {
    sync();
    commit({ ...state, openedDismissedAt: at });
  },

  /** Remembers the balance typed into "What can I do with…" (a positive whole number of Rax); anything else forgets it. */
  setBalance(rax: number | null): void {
    sync();
    commit({ ...state, balance: rax === null ? null : readBalance(rax) });
  },

  /** Remembers the Rax the visitor says they make on a typical day (a positive whole number); anything else forgets it. */
  setDailyRax(rax: number | null): void {
    sync();
    commit({ ...state, dailyRax: rax === null ? null : readBalance(rax) });
  },

  /** Ticks or unticks one item of the daily checklist for the local day `today` ("YYYY-MM-DD"). */
  tickRoutine(id: RoutineId, on: boolean, today: string): void {
    sync();
    commit({ ...state, routine: setTick(state.routine, id, on, today) });
  },

  /** Shows or hides the checklist card (null: as the level decides). */
  showRoutine(show: boolean | null): void {
    sync();
    commit({ ...state, routine: { ...state.routine, show } });
  },

  dismissInstall(): void {
    sync();
    commit({ ...state, installDismissed: true });
  },

  /** Changes some alert settings; the rest stay. */
  setAlerts(patch: Partial<AlertSettings>): void {
    sync();
    commit({ ...state, alerts: readAlerts({ ...state.alerts, ...patch }) });
  },

  /** "Turn off and delete my alert settings": back to the defaults, alerts off. */
  resetAlerts(): void {
    sync();
    commit({ ...state, alerts: DEFAULT_ALERTS });
  },
};

// Another tab of the site wrote one of the keys (or cleared the storage): this tab reads it again and re-renders.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== STORAGE_KEY && e.key !== HELD_KEY) return;
    try {
      if (e.storageArea && e.storageArea !== localStorage) return;
    } catch {
      return;
    }
    local.reload();
  });
}

/** The device's state, re-rendering on every change. */
export function useLocal(): LocalState {
  return useSyncExternalStore(local.subscribe, local.get, local.get);
}
