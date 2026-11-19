import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TopProgress } from "./components/TopProgress";
import { listenForInstall } from "./lib/install";
import { keepForOffline } from "./lib/offline";
import { progress } from "./lib/progress";
import { firstTab } from "./lib/tabHint";
import { startActivity } from "./lib/activity";
import { watchReturn, watchSignIn } from "./lib/visit";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/passes.css";
import "./styles/today.css";
import "./styles/alerts.css";
import "./styles/paused.css";
import "./styles/helpers.css";
import "./styles/routine.css";
import "./styles/meter.css";
import "./styles/plan.css";
import "./styles/injury.css";
import "./styles/gate.css";
import "./styles/privacy.css";
import "./styles/motion.css";
import "./styles/phone.css";
import "./styles/loading.css";

// The install offer can come before the page has drawn: catch it from the start.
listenForInstall();

// The worker that keeps the last page for when the network fails, registered once the page has loaded.
keepForOffline();

// iOS Safari draws :active (the pressed dim) only on a page that listens to touches: an empty, passive listener does it.
document.addEventListener("touchstart", () => undefined, { passive: true });

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const mount = createRoot(root);

// The private admin panel (served by the server at /admin to an admin only): its own view, none of the site's.
const admin = location.pathname === "/admin";
if (!admin) {
  watchSignIn(); // a "Continue with Discord" press counts in the anonymous visit count (lib/visit.ts)
  watchReturn(); // and so does a page left open, shown again on a new day
  startActivity(); // sessions, time on screen and what is used, batched (lib/activity.ts)
}

/** When index.html's own top bar shows (styles/loading.css, `tprog-show`): a page drawn sooner never saw it. */
const BOOT_BAR_AFTER_MS = 180;

// Everyone gets the site: a member the whole market, anyone else the free site the server already put in the page.
// The tab this visit opens on starts its code now, beside the site's (it is the same file the site asks for later).
if (admin) {
  void import("./views/AdminView").then(({ AdminView }) => {
    progress.finish();
    mount.render(
      <StrictMode>
        <AdminView />
      </StrictMode>,
    );
  });
} else {
  const tab = firstTab();
  if (tab === "passes") void import("./views/PassesView").catch(() => undefined);
  else if (tab === "plan") void import("./views/PlanView").catch(() => undefined);
  void import("./App").then(({ App }) => {
    // The page's own bar (index.html) showed while the code came: the site takes it over and finishes it.
    if (performance.now() > BOOT_BAR_AFTER_MS) progress.finish();
    mount.render(
      <StrictMode>
        <TopProgress />
        <App />
      </StrictMode>,
    );
  });
}
