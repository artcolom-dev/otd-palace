import { useApp } from "../AppContext";
import { local, useLocal } from "../data/local";
import { HowItWorks } from "./HowItWorks";
import { useOpenHow } from "./HowSheet";
import { WHAT_IS_REAL } from "../content/intro";
import { Icon } from "./Icon";
import { useOverlay } from "./Overlay";

/**
 * A first visit's one line: how to use the site, "How it works" for the rest, and "New to Real?" for someone who never
 * played (a phone drops the opening sentence, so the first deals stay in view). Dismissed once, gone on this device. A labelled region: on a
 * phone it sits above the page's main landmark.
 */
export function WelcomeStrip() {
  const { welcomeDismissed } = useLocal();
  const { layout } = useApp();
  const overlay = useOverlay();
  const openHow = useOpenHow();
  if (welcomeDismissed) return null;

  // Gone at once, and for good on this device; focus moves on to the page rather than into nothing.
  const dismiss = () => {
    local.dismissWelcome();
    document.getElementById("main")?.focus({ preventScroll: true });
  };

  return (
    <section className="welcome" aria-label="Welcome">
      <div className="welcome-body">
        <p>
          {!layout.phone && "We check every Real auction against recent sales. "}
          <b>Tap a deal to open it in Real.</b> {WHAT_IS_REAL}
        </p>
        <div className="welcome-acts">
          <button
            type="button"
            className="tlink"
            onClick={(e) =>
              overlay.open({ title: "How it works", anchor: e.currentTarget, size: "wide", body: () => <HowItWorks /> })
            }
          >
            How it works
            <Icon name="arrow" />
          </button>
          {/* Someone who never played: what Real is, and where to get it. */}
          <button type="button" className="tlink" aria-haspopup="dialog" onClick={(e) => openHow("new", e.currentTarget)}>
            New to Real?
          </button>
        </div>
      </div>
      <button type="button" className="icb x" aria-label="Dismiss the welcome" onClick={dismiss}>
        <Icon name="x" />
      </button>
    </section>
  );
}
