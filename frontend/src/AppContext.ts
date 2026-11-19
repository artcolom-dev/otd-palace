import { createContext, useContext } from "react";
import type { UndoOffer } from "./components/UndoBar";
import type { MoveDir } from "./data/moves";
import type { LevelKey, Prefs, TabKey } from "./data/prefs";
import type { Deal, Snapshot } from "./data/types";
import type { SnapshotStatus } from "./data/useSnapshot";
import type { Layout } from "./hooks/useMedia";
import type { AlertRules } from "./lib/push";

/** One player-season's cards, for "See these cards" on a pass: Deals shows only them, at any price, until cleared. */
export interface CardFilter {
  sport: string;
  player_id: number;
  season: number;
  label: string; // "Nathan MacKinnon 2025-26"
}

/** Everything a screen needs once there is a snapshot: the data, the visitor's choices, and the actions on them. */
export interface AppState {
  snap: Snapshot;
  status: SnapshotStatus;
  updatedAgoS: number | null;
  /** Asks the server for the market now (a pull to refresh); resolves once it answered (true) or failed. */
  refresh: () => Promise<boolean>;
  now: number; // the shared one-second clock
  prefs: Prefs; // with the sport resolved: "mine" only while someone is followed, a sport only while it is served
  setPrefs: (patch: Partial<Prefs>) => void;
  /** Changes the level and resets the budget to that level's own; a sort the level lacks goes back to best. */
  setLevel: (level: LevelKey) => void;
  follows: ReadonlySet<string>;
  toggleFollow: (player: string) => boolean;
  opened: ReadonlySet<number>; // listing ids opened in Real from this device
  /** Counts the click and remembers the deal as opened; the link itself does the opening. */
  openDeal: (deal: Deal, panel: "hero" | "deals", pos: number) => void;
  openCount: number; // deals open at this level and budget, every sport
  layout: Layout;
  query: string;
  setQuery: (query: string) => void;
  /** The bar after an action that moved or removed something ("Removed X · Undo"), or null. */
  notice: UndoOffer | null;
  /** Shows that bar (one at a time, the newest wins), or puts it away with null. */
  notify: (offer: Omit<UndoOffer, "seq"> | null) => void;
  /** Opens a tab at its top; `restore` (the menu, back and forward) opens it where it was left this visit. */
  navigate: (tab: TabKey, how?: { restore?: boolean }) => void;
  tab: TabKey; // the tab on screen
  cards: CardFilter | null;
  /** Opens Deals on one player-season's cards. */
  showCards: (filter: CardFilter) => void;
  clearCards: () => void;
  previousVisit: number | null; // when this device last left the site, as it was when this visit started
  returnedAt: number; // when the page loaded or last came back into view: opens before it can be asked about
  sinceDismissed: boolean; // "Since your last visit" put away for this visit
  dismissSince: () => void;
  movesDir: MoveDir; // the side of today's moves shown, shared by the Today panel and Prices
  setMovesDir: (dir: MoveDir) => void;
  alertRules: AlertRules; // what the server matches for this device's alerts, as things stand
  alertListing: number | null; // the listing a notification opened the page on (?open=), until put away
  dismissAlert: () => void;
  flash: { listing: number; seq: number } | null; // the deal row lit up right now
  /** Lights up a deal's row (scrolling to it) for a few seconds. */
  lightUp: (listing: number) => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp outside AppContext");
  return app;
}
