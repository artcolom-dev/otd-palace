// The way in with Discord, as a link. In the phone's own browser (and on a desktop) it is a plain link to the login.
// In an app's built-in browser (Instagram, Facebook, TikTok, a chat app...) a tap asks first to sign in from the
// phone's browser, where the session will be there next time: a button that opens the sign-in itself there (so the
// login starts there and its state cookie is set there), the steps by hand for when nothing opens, the link to copy,
// and a way to sign in right here anyway. See lib/inapp for what can be told apart and what cannot.
//
// On a phone's home screen (lib/handoff), a tap starts the login from the app itself: the app opens Discord, which
// iOS shows in a Safari window over it, and takes the session once the login is done there, so the visitor only closes
// that window.
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { handsOff, nav, nextOf, startHandoff, waitForHandoff } from "../lib/handoff";
import { type InApp, escapeTo, inAppHere, manualStep, signInUrl } from "../lib/inapp";
import { Icon } from "./Icon";

type Handoff = { phase: "starting" } | { phase: "waiting"; url: string } | { phase: "gone" };

export function SignInLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  const [inApp] = useState(inAppHere);
  const [homeScreen] = useState(() => handsOff());
  const [open, setOpen] = useState(false);
  const [handoff, setHandoff] = useState<Handoff | null>(null);

  const begin = async () => {
    if (handoff?.phase === "starting") return;
    setHandoff({ phase: "starting" });
    const url = await startHandoff(nextOf(href));
    if (!url) {
      setHandoff(null);
      nav.assign(href); // the plain login: no worse than before
      return;
    }
    setHandoff({ phase: "waiting", url });
    nav.assign(url);
  };

  return (
    <>
      <a
        className={className}
        href={href}
        aria-busy={handoff?.phase === "starting" || undefined}
        onClick={
          homeScreen
            ? (e) => {
                e.preventDefault();
                void begin();
              }
            : inApp
              ? (e) => {
                  e.preventDefault();
                  setOpen(true);
                }
              : undefined
        }
      >
        {children}
      </a>
      {open && inApp && <OpenInBrowser inApp={inApp} href={href} onClose={() => setOpen(false)} />}
      {handoff && handoff.phase !== "starting" && (
        <FinishInDiscord
          handoff={handoff}
          next={nextOf(href)}
          onGone={() => setHandoff({ phase: "gone" })}
          onRetry={() => void begin()}
          onClose={() => setHandoff(null)}
        />
      )}
    </>
  );
}

/** The app's wait while the login is open in the window over it; then the page the login was for, signed in. */
function FinishInDiscord({
  handoff,
  next,
  onGone,
  onRetry,
  onClose,
}: {
  handoff: Handoff;
  next: string;
  onGone: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const waiting = handoff.phase === "waiting";
  const gone = useRef(onGone);
  gone.current = onGone;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    dialog.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    if (!waiting) return;
    return waitForHandoff(
      () => {
        // Signed in: the page the login was for, read again with the new session.
        if (`${location.pathname}${location.search}${location.hash}` === next) nav.reload();
        else nav.assign(next);
      },
      () => gone.current(),
    );
  }, [waiting, next]);

  return (
    <dialog
      ref={ref}
      className="sheet inapp handoff"
      aria-labelledby={`${id}t`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="sheet-in">
        <div className="grab" aria-hidden="true" />
        <div className="shd">
          <h3 id={`${id}t`} tabIndex={-1}>
            {waiting ? "Finish signing in with Discord" : "That sign-in ran out"}
          </h3>
          <button type="button" className="icb" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {handoff.phase === "waiting" ? (
          <>
            <p className="poptx">
              Say yes on Discord in the window that opened. When it says you're signed in, close it: this app signs in on
              its own.
            </p>
            <span className="wbar" data-kind="busy" role="progressbar" aria-label="Waiting for Discord">
              <i />
            </span>
            <p className="inapp-said" role="status">
              Waiting for Discord…
            </p>
            <a className="lnk inapp-here" href={handoff.url}>
              Open Discord again
            </a>
          </>
        ) : (
          <>
            <p className="poptx">The sign-in took too long or was finished somewhere else. Start it again: it takes a tap.</p>
            <button type="button" className="btn fill inapp-go" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}

function OpenInBrowser({ inApp, href, onClose }: { inApp: InApp; href: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [said, setSaid] = useState<string | null>(null);
  const whole = signInUrl(href);
  const out = escapeTo(whole, inApp);
  const browser = inApp.os === "ios" ? "Safari" : "your browser";
  const app = inApp.name ? `${inApp.name}'s` : "this app's";

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    // The title takes the focus (read out first), not the close button, which showModal would ring.
    dialog.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
    };
  }, []);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(whole);
      setSaid(`Copied. Paste it in ${browser}.`);
    } catch {
      // Many web views give no clipboard: the link is selected, for the phone's own copy.
      input.current?.focus();
      input.current?.select();
      setSaid("Press and hold the link to copy it.");
    }
  };

  return (
    <dialog
      ref={ref}
      className="sheet inapp"
      aria-labelledby={`${id}t`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // a tap on the backdrop
      }}
    >
      <div className="sheet-in">
        <div className="grab" aria-hidden="true" />
        <div className="shd">
          <h3 id={`${id}t`} tabIndex={-1}>
            Sign in from your browser
          </h3>
          <button type="button" className="icb" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <p className="poptx">
          You're in {app} built-in browser. Sign in from {browser} instead: you stay signed in there next time.
        </p>
        {out && (
          <a
            className="btn fill inapp-go"
            href={out.href}
            {...(out.newTab ? { target: "_blank", rel: "noopener" } : {})}
          >
            {out.label}
            <Icon name="ext" />
          </a>
        )}
        <p className="inapp-or">{out ? "If nothing opens:" : `To open it in ${browser}:`}</p>
        <ol className="steps">
          <li>
            <em>1</em>
            <span>{manualStep(inApp)}</span>
          </li>
          <li>
            <em>2</em>
            <span>
              Sign in there with <b>Discord</b>.
            </span>
          </li>
        </ol>
        <div className="inapp-copy">
          <label className="sr" htmlFor={`${id}l`}>
            Sign-in link
          </label>
          <input id={`${id}l`} ref={input} type="text" readOnly value={whole} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="lnk box inapp-copy-go" onClick={() => void copy()}>
            Copy link
          </button>
        </div>
        <p className="inapp-said" role="status">
          {said}
        </p>
        {inApp.app === "discord" && (
          <p className="poptx">In Discord, Settings, then Web Browser, then External Browser opens every link in {browser}.</p>
        )}
        <a className="lnk inapp-here" href={href}>
          Sign in here instead
        </a>
      </div>
    </dialog>
  );
}
