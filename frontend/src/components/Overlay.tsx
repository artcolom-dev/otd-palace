import {
  type FocusEvent,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { track } from "../lib/activity";
import { DUR, EASE_IN, EASE_OUT, play } from "../lib/motion";
import { Icon } from "./Icon";
import { useSheetDrag } from "./useSheetDrag";

// One overlay at a time: an anchored popover on desktop, a <dialog> bottom sheet on a phone. Explanations, the sort
// menu, the budget choice, the QR code, "How it works" and the player search all open through it. Under it there can
// be one panel: a drawer from the right on desktop, a tall sheet on a phone (a pass's card); an overlay opened from
// inside the panel sits above it, and Escape closes the top one first.

export interface OverlayContentProps {
  titleId: string;
  close: () => void;
  phone: boolean;
}

export interface OverlaySpec {
  title: string;
  body: (ctx: OverlayContentProps) => ReactNode;
  anchor: HTMLElement | null;
  size?: "narrow" | "normal" | "wide";
  /** "panel": the drawer (desktop) or tall sheet (phone) under any other overlay. Its body draws its own header
   * (with an element whose id is `titleId`, which names the dialog), its scrolling part (.dwbody) and its footer
   * (.dwft); the close button sits in the top corner. */
  layer?: "panel";
  /** Steps of one flow ("add a pass": player, season, rarity) share this name: opening the next step replaces the
   * one open, in place (the same sheet on a phone), instead of toggling it closed. */
  flow?: string;
}

interface OverlayApi {
  /** Opens `spec` and says true; the same anchor a second time closes it instead, and says false. A panel replaces
   * the panel open, and closes any overlay above it. */
  open: (spec: OverlaySpec) => boolean;
  /** Closes the top overlay: the popover or sheet, else the panel. */
  close: () => void;
  /** Closes the overlay and the panel under it. */
  closeAll: () => void;
  isOpen: boolean;
}

const OverlayContext = createContext<OverlayApi>({
  open: () => false,
  close: () => undefined,
  closeAll: () => undefined,
  isOpen: false,
});

export const useOverlay = () => useContext(OverlayContext);

export function OverlayProvider({ phone, children }: { phone: boolean; children: ReactNode }) {
  const [spec, setSpec] = useState<OverlaySpec | null>(null);
  const [panel, setPanel] = useState<OverlaySpec | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;

  const closeTop = useCallback(() => setSpec(null), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const close = useCallback(() => (specRef.current ? setSpec(null) : setPanel(null)), []);
  const closeAll = useCallback(() => {
    setSpec(null);
    setPanel(null);
  }, []);
  const open = useCallback((next: OverlaySpec) => {
    track("sheet", next.title); // which sheet or menu, by its title, for the admin panel's feature use
    if (next.layer === "panel") {
      setSpec(null);
      setPanel(next);
      return true;
    }
    const current = specRef.current;
    if (current && next.flow && current.flow === next.flow) {
      setSpec(next);
      return true;
    }
    if (current && next.anchor && current.anchor === next.anchor) {
      setSpec(null);
      return false;
    }
    setSpec(next);
    return true;
  }, []);
  const api = useMemo(
    () => ({ open, close, closeAll, isOpen: spec !== null || panel !== null }),
    [open, close, closeAll, spec, panel],
  );

  return (
    <OverlayContext.Provider value={api}>
      {children}
      {panel &&
        (phone ? (
          <Sheet key={`panel:${panel.title}`} spec={panel} onClose={closePanel} />
        ) : (
          <Drawer spec={panel} onClose={closePanel} covered={spec !== null} />
        ))}
      {spec &&
        (phone ? (
          <Sheet key={spec.flow ?? spec.title} spec={spec} onClose={closeTop} />
        ) : (
          <Popover spec={spec} onClose={closeTop} />
        ))}
    </OverlayContext.Provider>
  );
}

function returnFocus(anchor: HTMLElement | null) {
  if (anchor?.isConnected) anchor.focus({ preventScroll: true });
}

const GAP = 8;

function Popover({ spec, onClose }: { spec: OverlaySpec; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { anchor } = spec;

  const dismiss = useCallback(
    (refocus: boolean) => {
      onClose();
      if (refocus) returnFocus(anchor);
    },
    [anchor, onClose],
  );

  // Place it under its anchor (above when there is no room), inside the window, through the CSSOM.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor?.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r ? r.left + r.width / 2 - w / 2 : (window.innerWidth - w) / 2;
    left = Math.min(Math.max(GAP, left), window.innerWidth - w - GAP);
    let top = r ? r.bottom + GAP : 80;
    if (r && top + h > window.innerHeight - GAP) top = Math.max(GAP, r.top - h - GAP);
    el.style.setProperty("left", `${Math.round(left)}px`);
    el.style.setProperty("top", `${Math.round(top)}px`);
    play(el, [{ opacity: 0, transform: "translateY(-4px) scale(0.98)" }, { opacity: 1, transform: "none" }], {
      duration: DUR.base,
      easing: EASE_OUT,
    });
    // The chosen item when there is one (a menu opens on its current choice), else the close button.
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>("[data-close]");
    first?.focus({ preventScroll: true });
  }, [anchor, spec]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      tabbing.current = false;
      const t = e.target as Node | null;
      if (t && !ref.current?.contains(t) && !anchor?.contains(t)) dismiss(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss(true);
    };
    const onScroll = () => dismiss(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
    };
  }, [anchor, dismiss]);

  // Focus that leaves the popover closes it: by Tab or Shift+Tab, or into nowhere (past its last button, since it
  // is drawn after the page), focus goes back to the anchor, so the next Tab carries on from there; anywhere else
  // (the search shortcut, a click) stays where it was sent. A Tab counts only while its key is down and until the
  // next pointer press. The window losing focus (another app, another tab) leaves the popover as it is.
  const tabbing = useRef(false);
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && ref.current?.contains(next)) return;
    if (next === null && !tabbing.current && !document.hasFocus()) return;
    dismiss(next === null || tabbing.current);
  };

  const close = () => dismiss(true);
  return (
    <div
      ref={ref}
      className={`pop ${spec.size ?? "normal"}`}
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        tabbing.current = e.key === "Tab";
      }}
      onKeyUp={() => {
        tabbing.current = false;
      }}
      onBlur={onBlur}
    >
      <div className="pophd">
        <b id={titleId}>{spec.title}</b>
        <button type="button" className="x" data-close aria-label="Close" onClick={close}>
          <Icon name="x" />
        </button>
      </div>
      {spec.body({ titleId, close, phone: false })}
    </div>
  );
}

function Sheet({ spec, onClose }: { spec: OverlaySpec; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closing = useRef(false);
  const { anchor } = spec;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    play(dialog, [{ transform: "translateY(100%)" }, { transform: "none" }], { duration: DUR.slow, easing: EASE_OUT });
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
    };
  }, []);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const done = () => {
      onClose();
      returnFocus(anchor);
    };
    // From where it stands: open, or where a finger let it go (useSheetDrag).
    const from = ref.current?.style.transform || "none";
    const out = play(ref.current, [{ transform: from }, { transform: "translateY(100%)" }], {
      duration: DUR.base,
      easing: EASE_IN,
      fill: "forwards",
    }, [{ opacity: 1 }, { opacity: 0 }]);
    if (out) out.finished.then(done, done);
    else done();
  }, [anchor, onClose]);

  const ctx = { titleId, close, phone: true };
  const panel = spec.layer === "panel";
  useSheetDrag(ref, { tall: panel, close });
  return (
    <dialog
      ref={ref}
      className={panel ? "sheet tall" : "sheet"}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close(); // a tap on the backdrop
      }}
    >
      <div className="sheet-in">
        <div className="grab" aria-hidden="true" />
        {panel ? (
          <button type="button" className="icb pclose" data-close aria-label="Close" onClick={close}>
            <Icon name="x" />
          </button>
        ) : (
          <div className="shd">
            <h3 id={titleId}>{spec.title}</h3>
            <button type="button" className="icb" data-close aria-label="Close" onClick={close}>
              <Icon name="x" />
            </button>
          </div>
        )}
        {spec.body(ctx)}
      </div>
    </dialog>
  );
}

/**
 * The desktop panel: a drawer from the right edge over a dimmed page. The page behind it is inert while it is open;
 * Escape closes it (unless a popover above it takes the key first), as do the scrim and its close button. It slides
 * in over 380 ms on a decelerating ease and out faster; with reduced motion it fades.
 */
function Drawer({ spec, onClose, covered }: { spec: OverlaySpec; onClose: () => void; covered: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closing = useRef(false);
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const { anchor } = spec;

  useLayoutEffect(() => {
    const page = document.querySelector<HTMLElement>(".app");
    if (page) page.inert = true;
    play(ref.current, [{ transform: "translateX(100%)" }, { transform: "none" }], { duration: DUR.glide, easing: EASE_OUT });
    play(scrim.current, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.slow }, [{ opacity: 0 }, { opacity: 1 }]);
    ref.current?.querySelector<HTMLElement>("[data-close]")?.focus({ preventScroll: true });
    return () => {
      if (page) page.inert = false;
    };
  }, []);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const page = document.querySelector<HTMLElement>(".app");
    if (page) page.inert = false;
    const done = () => {
      onClose();
      returnFocus(anchor);
    };
    play(scrim.current, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.base, fill: "forwards" }, [{ opacity: 1 }, { opacity: 0 }]);
    const out = play(ref.current, [{ transform: "none" }, { transform: "translateX(100%)" }], {
      duration: DUR.base,
      easing: EASE_IN,
      fill: "forwards",
    }, [{ opacity: 1 }, { opacity: 0 }]);
    if (out) out.finished.then(done, done);
    else done();
  }, [anchor, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !coveredRef.current) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  // A new pass in the open drawer starts at its top.
  useLayoutEffect(() => {
    const body = ref.current?.querySelector<HTMLElement>(".dwbody");
    if (body) body.scrollTop = 0;
  }, [spec]);

  const ctx = { titleId, close, phone: false };
  return (
    <>
      <div ref={scrim} className="scrim" aria-hidden="true" onClick={close} />
      <div ref={ref} className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button type="button" className="x pclose" data-close aria-label="Close" onClick={close}>
          <Icon name="x" />
        </button>
        {spec.body(ctx)}
      </div>
    </>
  );
}
