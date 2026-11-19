// Pull to refresh, on a phone's Today and Deals: at the top of the page, a pull down brings a small chip from under
// the bar; past the arming point its arrow turns and it takes the accent, and letting go asks the server for the
// market now (the same poll the page makes every few seconds, sooner). One tick: as it arms on Android, as it is let
// go on an iPhone (the only moment iOS lets a page tick). The browser's own reload pull is off on a phone (phone.css),
// so the two never run together. Passive listeners only: the page's scroll never waits for this.
import { useEffect, useRef } from "react";
import { PULL_ARM, lockAxis, pullTravel } from "../lib/gestures";
import { track } from "../lib/activity";
import { haptic, haptics } from "../lib/haptics";

/** The least time the chip turns, so a fast answer still reads as "refreshed" and not as a flicker. */
const BUSY_MIN_MS = 500;
/** Where the chip waits, hidden under the bar. */
const HIDDEN_Y = -48;

const pageTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;

export function PullToRefresh({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const ref = useRef<HTMLDivElement>(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const chip = ref.current;
    if (!chip) return;
    let mode: "idle" | "pending" | "pull" | "busy" = "idle";
    let x0 = 0;
    let y0 = 0;
    let travel = 0;
    let armed = false;
    let frame = 0;
    let live = true;

    const paint = () => {
      frame = 0;
      const p = Math.min(1, travel / PULL_ARM);
      chip.style.opacity = String(Math.min(1, p * 1.5));
      chip.style.transform = `translateY(${Math.round(HIDDEN_Y + travel)}px) scale(${0.6 + 0.4 * p})`;
      chip.style.setProperty("--ptr-turn", `${Math.round(p * 180)}deg`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const setState = (state: "pull" | "busy" | "settle") => chip.setAttribute("data-state", state);
    const hide = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      armed = false;
      chip.removeAttribute("data-armed");
      setState("settle");
      travel = 0;
      chip.style.opacity = "0";
      chip.style.transform = `translateY(${HIDDEN_Y}px) scale(0.6)`;
      mode = "idle";
    };

    const onStart = (e: TouchEvent) => {
      if (mode === "busy") return;
      mode = "idle";
      const t = e.touches[0];
      const target = e.target instanceof Element ? e.target : null;
      if (e.touches.length !== 1 || !t || !pageTop()) return;
      if (document.querySelector("dialog[open]")) return; // a sheet is up: its own drag
      if (chip.closest("[hidden]")) return; // the site is under another page (joining): nothing to refresh here
      if (target?.closest("input, textarea, select, .tabbar, .top")) return;
      x0 = t.clientX;
      y0 = t.clientY;
      mode = "pending";
    };

    const onMove = (e: TouchEvent) => {
      if (mode !== "pending" && mode !== "pull") return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - y0;
      if (mode === "pending") {
        const axis = lockAxis(t.clientX - x0, dy);
        if (axis === null) return;
        if (axis !== "y" || dy <= 0 || !pageTop()) {
          mode = "idle";
          return;
        }
        mode = "pull";
        setState("pull");
      }
      if (dy <= 0) {
        hide(); // pushed back up: the page scrolls as usual
        return;
      }
      travel = pullTravel(dy);
      const now = travel >= PULL_ARM;
      if (now !== armed) {
        armed = now;
        chip.toggleAttribute("data-armed", armed);
        if (armed && haptics.engine() === "vibrate") haptic("select");
      }
      schedule();
    };

    const onEnd = () => {
      if (mode !== "pull") {
        if (mode === "pending") mode = "idle";
        return;
      }
      if (!armed) {
        hide();
        return;
      }
      mode = "busy";
      if (haptics.engine() !== "vibrate") haptic("select"); // an iPhone ticks only inside the touch's end
      cancelAnimationFrame(frame);
      frame = 0;
      setState("busy");
      travel = PULL_ARM;
      paint();
      const began = performance.now();
      const done = () => {
        const wait = Math.max(0, BUSY_MIN_MS - (performance.now() - began));
        setTimeout(() => live && hide(), wait);
      };
      track("refresh");
      refreshRef.current().then(done, done);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  return (
    <div ref={ref} className="ptr" aria-hidden="true" data-testid="ptr">
      <svg className="ptr-arrow" viewBox="0 0 24 24">
        <path d="M12 5v14M6.5 13.5L12 19l5.5-5.5" />
      </svg>
      <svg className="ptr-spin" viewBox="0 0 24 24">
        <path d="M20 12a8 8 0 1 1-8-8" />
      </svg>
    </div>
  );
}
