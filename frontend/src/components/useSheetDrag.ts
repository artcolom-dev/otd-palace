// A phone's sheet follows the thumb: dragged down by its grip or its title (or by its content when that is scrolled to
// the top), it springs back, rests at its middle stop (a tall sheet) or goes, by where and how fast it was let go
// (lib/gestures settleSheet). Snapping to another stop or going ticks (lib/haptics). Touch listeners are passive: the
// page's scrolling never waits for this code. Transform only; under reduced motion the finger still moves the sheet,
// but a let-go jumps to its stop instead of gliding there.
import { type RefObject, useEffect } from "react";
import { DRAG_SLOP, type Sample, lockAxis, rubberBand, settleSheet, velocityOf } from "../lib/gestures";
import { haptic } from "../lib/haptics";
import { DUR, EASE_SPRING, prefersReducedMotion } from "../lib/motion";

/** A tall sheet's middle stop leaves this much of the screen's height showing. */
const MIDDLE_SHOWS = 0.5;
/** How far (px) a sheet gives when pulled above fully open. */
const OVER_TOP = 48;

type Mode = "idle" | "pending" | "drag" | "ignore";

export const translateY = (px: number): string => (px === 0 ? "" : `translate3d(0, ${Math.round(px * 10) / 10}px, 0)`);

/**
 * Makes the sheet `ref` draggable. `close(fromPx)` puts it away from where the finger left it; `tall` gives it a
 * middle stop (half the screen) between open and gone.
 */
export function useSheetDrag(ref: RefObject<HTMLDialogElement | null>, { tall, close }: { tall: boolean; close: () => void }) {
  useEffect(() => {
    const sheet = ref.current;
    if (!sheet) return;
    let mode: Mode = "idle";
    let x0 = 0;
    let y0 = 0;
    let fromHandle = false;
    let rest = 0; // the stop it rests at: 0 is fully open
    let offset = 0;
    let height = 0;
    let samples: Sample[] = [];
    let frame = 0;
    let dragged = false; // a drag just ended: the click it would make is not a tap
    let settling: Animation | null = null;

    const paint = () => {
      frame = 0;
      sheet.style.transform = translateY(offset);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const stopsFor = (h: number): number[] => {
      const screen = window.innerHeight || h;
      const middle = Math.round(h - screen * MIDDLE_SHOWS);
      return tall && middle > h * 0.2 ? [0, middle] : [0];
    };
    const setRest = (to: number) => {
      rest = to;
      sheet.toggleAttribute("data-middle", to > 0);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !sheet.open) {
        mode = "ignore";
        return;
      }
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]")) {
        mode = "ignore";
        return;
      }
      settling?.cancel();
      settling = null;
      const t = e.touches[0];
      if (!t) return;
      x0 = t.clientX;
      y0 = t.clientY;
      fromHandle = Boolean(target?.closest(".grab, .shd"));
      mode = "pending";
      samples = [{ t: e.timeStamp, y: t.clientY }];
    };

    const onMove = (e: TouchEvent) => {
      if (mode === "idle" || mode === "ignore") return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - y0;
      if (mode === "pending") {
        const axis = lockAxis(t.clientX - x0, dy, DRAG_SLOP);
        if (axis === null) return;
        const scroller = sheet.querySelector<HTMLElement>(".sheet-in");
        const atTop = !scroller || scroller.scrollTop <= 0;
        if (axis !== "y" || !(fromHandle || rest > 0 || (atTop && dy > 0))) {
          mode = "ignore";
          return;
        }
        mode = "drag";
        dragged = true;
        height = sheet.getBoundingClientRect().height; // a translate moves the box, never resizes it
        y0 = t.clientY; // follow from here: no jump by the slop
        sheet.setAttribute("data-drag", "");
      }
      samples.push({ t: e.timeStamp, y: t.clientY });
      if (samples.length > 12) samples.shift();
      const raw = rest + (t.clientY - y0);
      // Above open: a grip pull gives a little; a content pull hands the move back to the content's own scroll.
      offset = raw >= 0 ? raw : fromHandle ? -rubberBand(-raw, OVER_TOP) : 0;
      schedule();
    };

    const onEnd = () => {
      if (mode !== "drag") {
        mode = "idle";
        return;
      }
      mode = "idle";
      cancelAnimationFrame(frame);
      frame = 0;
      sheet.removeAttribute("data-drag");
      const { to, dismiss } = settleSheet(offset, velocityOf(samples), stopsFor(height), height);
      if (dismiss) {
        haptic("tap");
        sheet.style.transform = translateY(offset);
        close();
        return;
      }
      if (to !== rest) haptic("tap");
      setRest(to);
      const from = offset;
      offset = to;
      if (prefersReducedMotion() || typeof sheet.animate !== "function" || Math.abs(from - to) < 1) {
        sheet.style.transform = translateY(to);
        return;
      }
      sheet.style.transform = translateY(to);
      try {
        settling = sheet.animate([{ transform: translateY(from) || "none" }, { transform: translateY(to) || "none" }], {
          duration: Math.min(DUR.glide, Math.max(DUR.base, Math.abs(from - to) * 0.9)),
          easing: EASE_SPRING,
        });
        settling.finished.then(
          () => (settling = null),
          () => undefined,
        );
      } catch {
        settling = null;
      }
    };

    // The click a drag leaves behind (on the close button, a link in the title row) is not a tap.
    const onClick = (e: MouseEvent) => {
      if (!dragged || (e.target instanceof Element && e.target.closest(".haptic"))) return; // the haptic's own switch
      dragged = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const onDown = () => {
      dragged = false;
    };

    sheet.addEventListener("touchstart", onStart, { passive: true });
    sheet.addEventListener("touchmove", onMove, { passive: true });
    sheet.addEventListener("touchend", onEnd, { passive: true });
    sheet.addEventListener("touchcancel", onEnd, { passive: true });
    sheet.addEventListener("click", onClick, true);
    sheet.addEventListener("pointerdown", onDown, true);
    return () => {
      cancelAnimationFrame(frame);
      settling?.cancel();
      sheet.removeEventListener("touchstart", onStart);
      sheet.removeEventListener("touchmove", onMove);
      sheet.removeEventListener("touchend", onEnd);
      sheet.removeEventListener("touchcancel", onEnd);
      sheet.removeEventListener("click", onClick, true);
      sheet.removeEventListener("pointerdown", onDown, true);
    };
  }, [ref, tall, close]);
}
