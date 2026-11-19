import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppContext, type AppState, type CardFilter } from "./AppContext";
import { AccountFromAddress, LinkSync } from "./components/AccountLookup";
import { YearReporter } from "./components/YearReporter";
import { EarnFromAddress } from "./components/EarnSheet";
import { HowFromAddress } from "./components/HowSheet";
import { SupportFromAddress } from "./components/SupportSheet";
import { type Member, MemberContext } from "./components/MemberLine";
import { OverlayProvider, useOverlay } from "./components/Overlay";
import type { UndoOffer } from "./components/UndoBar";
import { sortsFor } from "./data/deals";
import { filterDeals } from "./data/filters";
import { local, useLocal } from "./data/local";
import type { MoveDir } from "./data/moves";
import { type LevelKey, type Prefs, type TabKey, loadPrefs, savePrefs } from "./data/prefs";
import type { Deal, Snapshot } from "./data/types";
import { type SnapshotStatus, type UseSnapshotOptions, useSnapshot } from "./data/useSnapshot";
import { useAlertRules, useAlertSync } from "./hooks/useAlerts";
import { type Layout, useLayout } from "./hooks/useMedia";
import { useNow } from "./hooks/useNow";
import { type Me, fetchMe, onDiscordRequired, readInlinedMe } from "./lib/gate";
import { haptic } from "./lib/haptics";
import { type Access, type AccessState, AccessContext, JOIN_HASH } from "./components/Access";
import { listenForInstall } from "./lib/install";
import { prefersReducedMotion } from "./lib/motion";
import { tabFromAddress, tabFromHash, tabFromPath, tabPath } from "./lib/tabHint";
import { trackOut } from "./lib/track";
import { track } from "./lib/activity";
import { noteTab } from "./lib/visit";
import { DealsView } from "./views/DealsView";
import { Join } from "./views/Gate";
import { CrashCard, CrashShell, ErrorBoundary } from "./views/Crash";
import { PassesView, PlanView, PricesView, preloadViews, resetFailedViews } from "./views/lazy";
import { LoadingShell, Shell, ViewLoading } from "./views/Shell";
import { TodayView } from "./views/TodayView";

/** Each tab's name in the window title: "Deals · OTD Palace". */
const TAB_TITLES: Record<TabKey, string> = { today: "Today", deals: "Deals", prices: "Prices", passes: "Passes", plan: "Your plan" };

/** The crash card's Try again: a split view whose code failed to load fetches it anew, then the page draws again. */
function tryAgain(retry: () => void) {
  resetFailedViews();
  retry();
}

/** A first load that failed this many polls in a row says so, instead of a skeleton that never ends. */
const FAILED_LOAD_POLLS = 3;

/** The wait before the other views' code is fetched: the first screen has its own bytes to itself until then. */
const PRELOAD_AFTER_MS = 2500;

/** Fetches the split views' code once the page has painted, has had its bytes to itself, and the browser is idle. */
function preloadWhenIdle(): () => void {
  let cancelIdle: () => void = () => undefined;
  const timer = setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(() => void preloadViews(), { timeout: 4000 });
      cancelIdle = () => window.cancelIdleCallback(id);
    } else {
      void preloadViews();
    }
  }, PRELOAD_AFTER_MS);
  return () => {
    clearTimeout(timer);
    cancelIdle();
  };
}

/** How long a deal row stays lit up after an alert (or "Show it") points at it. */
const FLASH_MS = 6000;

/** Notes a change of filter, sort or sport for the admin panel's feature use (lib/activity.ts). */
function notePrefs(patch: Partial<Prefs>): void {
  if (patch.sport !== undefined) track("sport", patch.sport);
  if (patch.sort !== undefined) track("sort", patch.sort);
  if (patch.budget !== undefined) track("filter", "budget");
  if (patch.passBudget !== undefined) track("filter", "pass-budget");
  if (patch.level !== undefined) track("filter", `level-${patch.level}`);
  // The rarity strip notes its own taps (components/RarityStrip), with the rarity's name.
}

/** The listing a notification opened the page on: `?open=<listing_id>`, or null when there is none worth reading. */
function openFromAddress(): number | null {
  try {
    const raw = new URLSearchParams(location.search).get("open");
    return raw !== null && /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

function scrollToTop() {
  const root = document.scrollingElement;
  if (root) root.scrollTop = 0;
}

/** The open tab tapped again: back to its top, gliding there as a native tab bar does (at once under reduced motion). */
function glideToTop() {
  const root = document.scrollingElement;
  if (!root) return;
  if (prefersReducedMotion() || typeof root.scrollTo !== "function") root.scrollTop = 0;
  else root.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * Back to where a tab was left. A page drawn a frame late (a list that settles after its first frame) may not be tall
 * enough yet: the scroll is tried again for a few frames while it rests where the page stopped it, and gives up quietly
 * (it then stays as far down as it goes). A finger that moves the page in the meantime ends the tries at once.
 */
function scrollBackTo(y: number) {
  const root = document.scrollingElement;
  if (!root) return;
  root.scrollTop = y;
  let landed = root.scrollTop;
  let tries = 10;
  const again = () => {
    if (Math.abs(root.scrollTop - landed) > 1) return; // moved by the visitor: theirs now
    root.scrollTop = y;
    landed = root.scrollTop;
    if (Math.abs(landed - y) > 1 && --tries > 0) requestAnimationFrame(again);
  };
  if (Math.abs(landed - y) > 1 && typeof requestAnimationFrame === "function") requestAnimationFrame(again);
}

/** The sport filter as it can apply now: "mine" needs someone followed, a sport needs to be served. */
function resolveSport(sport: string, follows: ReadonlySet<string>, sports: string[]): string {
  if (sport === "mine") return follows.size > 0 ? "mine" : "all";
  return sport === "all" || sports.includes(sport) ? sport : "all";
}

function Site({ snap, status, updatedAgoS, refresh, layout }: {
  snap: Snapshot;
  status: SnapshotStatus;
  updatedAgoS: number | null;
  refresh: () => Promise<boolean>;
  layout: Layout;
}) {
  const now = useNow();
  const device = useLocal();
  const [chosen, setChosen] = useState<Prefs>(() => loadPrefs(snap.levels));
  // A bare address means the tab this visit opened on: the remembered one, else Today.
  const [landing] = useState<TabKey>(() => chosen.tab);
  const [tab, setTab] = useState<TabKey>(() => tabFromAddress() ?? landing);
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<CardFilter | null>(null);
  // The last visit as it stood when this visit started: "since your last visit" counts from it all visit long. A page
  // left open and come back to after a while is a new visit, counted from the one that just ended.
  const [previousVisit, setPreviousVisit] = useState(() => local.get().lastVisitAt);
  const [returnedAt, setReturnedAt] = useState(() => Date.now());
  const [sinceDismissed, setSinceDismissed] = useState(false);
  const [movesDir, setMovesDir] = useState<MoveDir>("risers");
  const [alertListing, setAlertListing] = useState<number | null>(openFromAddress);
  const [flash, setFlash] = useState<{ listing: number; seq: number } | null>(() =>
    alertListing === null ? null : { listing: alertListing, seq: 0 },
  );
  const [notice, setNotice] = useState<UndoOffer | null>(null);
  const notify = useCallback(
    (offer: Omit<UndoOffer, "seq"> | null) => setNotice((n) => (offer ? { ...offer, seq: (n?.seq ?? 0) + 1 } : null)),
    [],
  );
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useEffect(() => savePrefs(chosen), [chosen]);

  // The view the visit opened on keeps the title the server wrote for its address (advisor/web.py VIEWS: the words a
  // search engine lists the page under, read after the page has run); a tab moved to afterwards is named short.
  const servedTitle = useRef({ tab, title: document.title, moved: false });
  useEffect(() => {
    const served = servedTitle.current;
    if (tab !== served.tab) served.moved = true;
    document.title = !served.moved && served.title ? served.title : `${TAB_TITLES[tab]} · OTD Palace`;
  }, [tab]);

  // The anonymous visit count (lib/visit.ts): the load with this tab, then each tab moved to.
  useEffect(() => noteTab(tab), [tab]);

  useEffect(() => preloadWhenIdle(), []);

  // An address from a notification (?open=) is read once: the address is cleaned, and the deal is looked for among
  // every sport, not only the one the tabs were left on.
  useEffect(() => {
    if (location.search.includes("open=")) {
      history.replaceState(history.state, "", `${location.pathname}${location.hash}`);
    }
    if (alertListing !== null) setChosen((p) => (p.sport === "all" ? p : { ...p, sport: "all" }));
  }, []);

  // A lit-up row fades back after a few seconds.
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);
  const lightUp = useCallback((listing: number) => setFlash((f) => ({ listing, seq: (f?.seq ?? 0) + 1 })), []);
  const dismissAlert = useCallback(() => setAlertListing(null), []);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    notePrefs(patch); // what was chosen, for the admin panel's feature use (lib/activity.ts); the tab is counted apart
    setChosen((p) => ({ ...p, ...patch }));
  }, []);
  const levels = snap.levels;
  const setLevel = useCallback(
    (level: LevelKey) => {
      track("filter", `level-${level}`);
      setChosen((p) => ({
        ...p,
        level,
        budget: levels[level]?.default_budget ?? null,
        passBudget: levels[level]?.otd_default_budget ?? null,
        sort: sortsFor(level).includes(p.sort) ? p.sort : "best",
      }));
    },
    [levels],
  );

  // The address and the tab agree: each tab has its own (lib/tabHint), the remembered tab's is written over a bare
  // address, an old #tab link (or the older #market and #otd) moves to its tab's, and the back button is followed.
  useEffect(() => {
    if (location.pathname !== tabPath(tab) || location.hash) {
      history.replaceState(null, "", `${tabPath(tab)}${location.search}`);
    }
    const onHash = () => {
      const old = tabFromHash();
      if (old) history.replaceState(history.state, "", `${tabPath(old)}${location.search}`);
      // A sheet's own address (#how, #account/...) changes no tab: the path still names it, the bare one Today.
      const next = old ?? tabFromPath() ?? (location.pathname === "/" ? "today" : null);
      if (!next) return;
      // Back and forward land on a page as it was left, like a tap on its tab.
      if (next !== tabRef.current) {
        leftAt.current[tabRef.current] = window.scrollY;
        scrollOnDraw.current = "restore";
      }
      setTab(next);
      setPrefs({ tab: next });
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
    // Only on mount: later changes come from navigate() or from these events.
  }, []);

  // A tab the visitor moves to fades in; the first paint of a visit never does (it must be there at once).
  const firstTab = useRef(tab);
  useEffect(() => {
    if (tab !== firstTab.current) document.documentElement.setAttribute("data-navigated", "");
  }, [tab]);

  // Where the page is set once the tab moved to is drawn (the page it replaces does not jump first: the menu draws
  // the new page as a transition, see views/Shell). From the menu, or back and forward, a tab opens where it was left
  // this visit, as a native tab bar keeps each tab's place (its top the first time); a link inside a page ("See all
  // deals", a player's cards) opens its page at the top, since it changed what that page shows.
  const scrollOnDraw = useRef<"top" | "restore" | null>(null);
  const leftAt = useRef<Partial<Record<TabKey, number>>>({});
  useLayoutEffect(() => {
    const how = scrollOnDraw.current;
    if (!how) return;
    scrollOnDraw.current = null;
    const y = how === "restore" ? (leftAt.current[tab] ?? 0) : 0;
    if (y > 0) scrollBackTo(y);
    else scrollToTop();
  }, [tab]);

  const navigate = useCallback(
    (next: TabKey, how?: { restore?: boolean }) => {
      // The tab already open: back to its top, and no history entry for a page that did not change.
      if (next === tabRef.current) {
        glideToTop();
        return;
      }
      if (location.pathname !== tabPath(next)) history.pushState(null, "", `${tabPath(next)}${location.search}`);
      haptic("tap");
      leftAt.current[tabRef.current] = window.scrollY;
      scrollOnDraw.current = how?.restore ? "restore" : "top";
      setTab(next);
      setPrefs({ tab: next });
    },
    [setPrefs],
  );
  const showCards = useCallback(
    (filter: CardFilter) => {
      setCards(filter);
      navigate("deals");
    },
    [navigate],
  );
  const clearCards = useCallback(() => setCards(null), []);
  // The card filter belongs to the visit to Deals it was made for.
  useEffect(() => {
    if (tab !== "deals") setCards(null);
  }, [tab]);

  // The live dot breathes only while the tab is visible.
  useEffect(() => {
    const sync = () => {
      document.documentElement.toggleAttribute("data-tab-hidden", document.visibilityState === "hidden");
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // Visits, on this device only: one starts on load (or on coming back after a while); leaving (the page hidden or
  // closed) is the time the next visit counts "since" from; coming back is when opened deals can be asked about.
  const visitStarted = useRef(false);
  useEffect(() => {
    listenForInstall();
    if (!visitStarted.current) {
      visitStarted.current = true;
      local.startVisit(Date.now());
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        local.leave(Date.now());
      } else {
        const left = local.get().lastVisitAt;
        if (local.startVisit(Date.now())) {
          setPreviousVisit(left);
          setSinceDismissed(false); // put away for the visit that ended, not for this one
        }
        setReturnedAt(Date.now());
      }
    };
    const onPageHide = () => local.leave(Date.now());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  // The free site's snapshot (`locked`) holds the best few deals the New level shows: they are shown as they are, with
  // no level, budget, sport, rarity or follows to filter them (those are for members), whatever this device chose before.
  const free = snap.locked !== undefined;
  const follows = useMemo(() => new Set(free ? [] : device.follows), [device.follows, free]);
  const opened = useMemo(() => new Set(device.opened.map((o) => o.listing_id)), [device.opened]);
  const prefs = useMemo<Prefs>(() => {
    if (free) return { ...chosen, level: "new", budget: null, passBudget: null, sport: "all", rarity: null, sort: "best" };
    const sport = resolveSport(chosen.sport, follows, snap.sports);
    const sort = sortsFor(chosen.level).includes(chosen.sort) ? chosen.sort : "best";
    return sport === chosen.sport && sort === chosen.sort ? chosen : { ...chosen, sport, sort };
  }, [chosen, follows, snap.sports, free]);

  const openCount = useMemo(
    () => filterDeals(snap.deals, { ...prefs, sport: "all" }, snap.levels, now).length,
    [snap, prefs, now],
  );

  const openDeal = useCallback(
    (deal: Deal, panel: "hero" | "deals", pos: number) => {
      // The deal a notification pointed at counts as opened from the alert.
      const from = deal.listing_id === alertListing ? "alert" : panel;
      trackOut({ panel: from, target: "listing", level: prefs.level, sport: prefs.sport, pos });
      track("deal", deal.listing_id);
      haptic("tap");
      local.markOpened(deal);
    },
    [prefs.level, prefs.sport, alertListing],
  );

  // A star under the finger answers with a tick, as a switch does.
  const toggleFollow = useCallback((player: string) => {
    haptic("select");
    return local.toggleFollow(player);
  }, []);

  // Every switch of the site (the one shared switch, role="switch") and every tick box (the daily checklist) ticks
  // when flipped, wherever it is drawn. Not the haptic's own hidden switch (lib/haptics), which this click may be.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[role="switch"], input[type="checkbox"]') : null;
      if (el && !el.closest(".haptic") && !el.matches(":disabled, [aria-disabled='true']")) haptic("select");
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const alertRules = useAlertRules(device.alerts, prefs.level, prefs.budget, device.follows, device.opened);
  useAlertSync(Boolean(snap.links.push), device.alerts.on, alertRules, snap.links.push?.public_key ?? null);

  const app: AppState = {
    snap,
    status,
    updatedAgoS,
    refresh,
    now,
    prefs,
    setPrefs,
    setLevel,
    follows,
    toggleFollow,
    opened,
    openDeal,
    openCount,
    layout,
    query,
    setQuery,
    navigate,
    notice,
    notify,
    tab,
    cards,
    showCards,
    clearCards,
    previousVisit,
    returnedAt,
    sinceDismissed,
    dismissSince: () => setSinceDismissed(true),
    movesDir,
    setMovesDir,
    alertRules,
    alertListing,
    dismissAlert,
    flash,
    lightUp,
  };

  return (
    <AppContext.Provider value={app}>
      <OverlayProvider phone={layout.phone}>
        <HowFromAddress />
        <EarnFromAddress />
        <SupportFromAddress />
        <AccountFromAddress />
        <LinkSync />
        <CloseOnTab tab={tab} />
        <YearReporter />
        <Shell tab={tab}>
          {/* A tab that breaks says so inside the shell; another tab, or a newer snapshot, tries afresh. */}
          <ErrorBoundary key={tab} resetKey={snap.version} fallback={(retry) => <CrashCard onRetry={() => tryAgain(retry)} />}>
            <Suspense fallback={<ViewLoading tab={tab} />}>
              {tab === "today" && <TodayView />}
              {tab === "deals" && <DealsView />}
              {tab === "prices" && <PricesView />}
              {tab === "passes" && <PassesView />}
              {tab === "plan" && <PlanView />}
            </Suspense>
          </ErrorBoundary>
        </Shell>
      </OverlayProvider>
    </AppContext.Provider>
  );
}

/** A sheet or panel belongs to the page it was opened on: moving to another tab puts it away. */
function CloseOnTab({ tab }: { tab: TabKey }) {
  const { closeAll } = useOverlay();
  const was = useRef(tab);
  useEffect(() => {
    if (was.current !== tab) closeAll();
    was.current = tab;
  }, [tab, closeAll]);
  return null;
}

export interface GateOptions {
  /** How the gate's own requests go out (/api/me, /api/teaser, /auth/*); the browser's fetch by default. */
  fetchImpl?: typeof fetch;
}

const defaultGateFetch: typeof fetch = (input, init) => fetch(input, init);

const ME_RETRIES = 4; // times /api/me is asked again after an answer that cannot be read

/** The access state the page's mark says: "open" without one (the gate is off). */
function stateOf(mark: Me | null): AccessState {
  if (mark === null || !mark.gate) return "open";
  return mark.state;
}

/** Whether the address asks for the page that explains what Discord unlocks. */
const onJoin = () => location.hash === JOIN_HASH;

/**
 * OTD Palace, free for everyone, with the extras for members of our Discord server. The page's mark (see `lib/gate`)
 * says at once who is asking: a member, someone not signed in, someone signed in but not in the server, or an account
 * the server refused. Everyone gets the site; the server already sent anyone but a member the free site's snapshot,
 * and each locked area offers the way in (components/Access). A signed-in visitor's Discord name comes from /api/me.
 * A 401 {"error": "discord_required"} from a member route (a member who left the server) asks /api/me again and the
 * snapshot at once: the next one is the free site's. `#join` shows the page that says what Discord unlocks.
 */
export function App({ snapshotOptions, gateOptions }: { snapshotOptions?: UseSnapshotOptions; gateOptions?: GateOptions } = {}) {
  const [{ mark, gateFetch }] = useState(() => ({
    mark: readInlinedMe(),
    gateFetch: gateOptions?.fetchImpl ?? defaultGateFetch,
  }));
  const [me, setMe] = useState<Me | null>(null);
  const [asked, setAsked] = useState(0); // bumped to ask /api/me again
  const [join, setJoin] = useState(onJoin);
  const state: AccessState = me ? stateOf(me) : stateOf(mark);

  useEffect(() => {
    const sync = () => setJoin(onJoin());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => onDiscordRequired(() => setAsked((n) => n + 1)), []);

  // A signed-in visitor's name is not in the page (the same page serves everyone in a state): ask for it, and ask
  // again whenever the server turned a member route down.
  useEffect(() => {
    if (!mark?.gate || (mark.state === "anon" && asked === 0)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One failed answer must not leave a member nameless for the whole visit (their link could not be read or undone).
    const ask = (left: number) =>
      void fetchMe(gateFetch).then((found) => {
        if (!live) return;
        if (found === null) {
          if (left > 0) timer = setTimeout(() => ask(left - 1), 2000 * (ME_RETRIES - left + 1));
          return;
        }
        setMe(found);
      });
    ask(ME_RETRIES);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mark, gateFetch, asked]);

  const name = me?.name ?? null;
  const member = useMemo<Member | null>(
    () => (state === "in" && name ? { name, fetchImpl: gateFetch } : null),
    [state, name, gateFetch],
  );
  const access = useMemo<Access>(
    () => ({ state, name, fetchImpl: gateFetch, refresh: () => setAsked((n) => n + 1) }),
    [state, name, gateFetch],
  );

  return (
    <AccessContext.Provider value={access}>
      <MemberContext.Provider value={member}>
        <Market snapshotOptions={snapshotOptions} join={join} fetchImpl={gateFetch} />
      </MemberContext.Provider>
    </AccessContext.Provider>
  );
}

/** The site itself: the snapshot, kept fresh, shown for this visitor; with `join`, the join page over it (the site
 * stays mounted under it, so coming back is instant and the market stays fresh). */
function Market({ snapshotOptions, join = false, fetchImpl }: {
  snapshotOptions?: UseSnapshotOptions;
  join?: boolean;
  fetchImpl: typeof fetch;
}) {
  const { snap, status, updatedAgoS, failures, retry, refresh } = useSnapshot(snapshotOptions);
  const layout = useLayout();
  // A member route turned this visitor down: their next snapshot is the free site's, asked for now.
  useEffect(() => onDiscordRequired(retry), [retry]);
  return (
    <>
      {join && <Join fetchImpl={fetchImpl} invite={snap?.links.community ?? null} />}
      <div className="market-frame" hidden={join}>
        <ErrorBoundary resetKey={snap?.version} fallback={(retry) => <CrashShell onRetry={() => tryAgain(retry)} />}>
          {snap ? (
            <Site snap={snap} status={status} updatedAgoS={updatedAgoS} refresh={refresh} layout={layout} />
          ) : (
            <LoadingShell failed={failures >= FAILED_LOAD_POLLS} onRetry={retry} />
          )}
        </ErrorBoundary>
      </div>
    </>
  );
}
