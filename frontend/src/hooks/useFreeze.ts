import { type PointerEvent, useEffect, useRef, useState } from "react";

const AFTER_SCROLL_MS = 1500;

/**
 * Whether the visitor is busy with the list: a mouse over it, a finger on it, or a scroll in the last 1.5 s. Spread
 * `bind` on the list element.
 */
export function useFreeze() {
  const [hover, setHover] = useState(false);
  const [touch, setTouch] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const scrollingRef = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (!scrollingRef.current) {
        scrollingRef.current = true;
        setScrolling(true);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        scrollingRef.current = false;
        setScrolling(false);
      }, AFTER_SCROLL_MS);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      clearTimeout(timer);
    };
  }, []);

  const bind = {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== "touch") setHover(true);
    },
    onPointerLeave: () => setHover(false),
    onTouchStart: () => setTouch(true),
    onTouchEnd: () => setTouch(false),
    onTouchCancel: () => setTouch(false),
  };

  return { frozen: hover || touch || scrolling, bind };
}
