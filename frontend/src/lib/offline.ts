// The worker that keeps the last home page for when the network fails (public/sw.js, which also shows the alerts) is
// registered for every visitor, a few seconds after the page has loaded, so the first screen has the link to itself.

export const SW_URL = "/sw.js";
export const KEEP_AFTER_MS = 4000;
const ENABLED = import.meta.env.PROD || import.meta.env.MODE === "test";

interface OfflineEnv {
  nav: Pick<Navigator, "serviceWorker"> | undefined;
  win: Pick<Window, "addEventListener">;
  doc: Pick<Document, "readyState">;
}

const defaultEnv = (): OfflineEnv => ({
  nav: typeof navigator === "undefined" ? undefined : navigator,
  win: window,
  doc: document,
});

/** Registers the worker KEEP_AFTER_MS after the page's load event (at once counted from now if it has passed). */
export function keepForOffline(env: OfflineEnv = defaultEnv()): void {
  if (!ENABLED) return;
  const workers = env.nav?.serviceWorker;
  if (!workers) return; // an old browser, or a private window that refuses workers
  const register = () =>
    setTimeout(() => {
      workers.register(SW_URL, { scope: "/" }).catch(() => undefined);
    }, KEEP_AFTER_MS);
  if (env.doc.readyState === "complete") register();
  else env.win.addEventListener("load", register, { once: true });
}
