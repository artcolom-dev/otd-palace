// The thin bar at the top of the screen, in the accent, for the waits of the whole page: a tab whose code is still on
// its way, the first market, a page the browser is leaving for (the Discord sign-in, signing out, the page after
// deleting one's data). Timing in lib/progress; the look in styles/loading.css. It sits over the top edge of the
// page, under the status bar, and takes no room: nothing moves when it shows. A wait of the page that lasts says so
// once, politely ("Still loading…"); a short one says nothing.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SnapshotStatus } from "../data/useSnapshot";
import { type Progress, progress } from "../lib/progress";

/** Holds the top bar while `active`. */
export function useProgress(active: boolean, bar: Progress = progress): void {
  useEffect(() => (active ? bar.start() : undefined), [active, bar]);
}

/** How long a page we are leaving for may hold the bar before it lets go on its own. */
const LEAVING_MAX_MS = 20_000;

/**
 * The browser is about to load another page (a sign-in, the front door after signing out): the bar runs until this
 * page goes. It lets go if this page is hidden instead (another app opened the link) or after a while.
 */
export function startNavigation(bar: Progress = progress): void {
  const release = bar.start();
  const timer = setTimeout(done, LEAVING_MAX_MS);
  function done() {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onHidden);
    release();
  }
  function onHidden() {
    if (document.visibilityState === "hidden") done();
  }
  document.addEventListener("visibilitychange", onHidden);
}

/** Whether a click on this link leaves this page for another page of the site, in this tab. */
function leavesForPage(e: MouseEvent): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!(a instanceof HTMLAnchorElement) || a.hasAttribute("download")) return false;
  if (a.target && a.target !== "_self") return false;
  let to: URL;
  try {
    to = new URL(a.href, location.href);
  } catch {
    return false;
  }
  if (to.origin !== location.origin) return false;
  return to.pathname !== location.pathname || to.search !== location.search; // a hash alone stays on this page
}

/** How long after the network came back the bar waits for the market to read live again. */
const RECONNECT_MAX_MS = 12_000;

/** True from the moment the network comes back while the data reads as paused, until it reads live (or a while). */
export function useReconnecting(status: SnapshotStatus): boolean {
  const [since, setSince] = useState<number | null>(null);
  const stale = status === "stale";
  useEffect(() => {
    if (!stale) {
      setSince(null);
      return;
    }
    const onOnline = () => setSince(Date.now());
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [stale]);
  useEffect(() => {
    if (since === null) return;
    const timer = setTimeout(() => setSince(null), RECONNECT_MAX_MS);
    return () => clearTimeout(timer);
  }, [since]);
  return stale && since !== null;
}

export function TopProgress({ bar = progress }: { bar?: Progress }) {
  const view = useSyncExternalStore(bar.subscribe, bar.get, bar.get);
  const line = useRef<HTMLElement>(null);
  const was = useRef(view.phase);
  // The value goes in as a transform set from script (the CSP allows no inline style): the compositor draws it. A bar
  // that just showed starts where it is at once, with no glide from nothing: WebKit holds transitions still on a page
  // it is leaving (the sign-in), and the bar would stay invisible there.
  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    const fresh = was.current !== "running" && view.phase === "running";
    was.current = view.phase;
    if (fresh) el.style.transition = "none";
    el.style.transform = `scaleX(${view.value.toFixed(3)})`;
    if (fresh) {
      void el.offsetWidth; // the start lands before the transitions come back
      el.style.transition = "";
    }
  }, [view.value, view.phase]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (leavesForPage(e)) startNavigation(bar);
    };
    // Back to a page the browser kept (bfcache): whatever was leaving is over.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) bar.reset();
    };
    document.addEventListener("click", onClick);
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("pageshow", onShow);
    };
  }, [bar]);
  const long = view.long && view.phase === "running";
  return (
    <>
      <div className="tprog" data-phase={view.phase} aria-hidden="true">
        <i ref={line} />
      </div>
      <p className="tprog-long" data-on={long ? "" : undefined} role="status">
        {long ? "Still loading… the connection seems slow." : ""}
      </p>
    </>
  );
}
