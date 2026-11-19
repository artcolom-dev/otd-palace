// After a deploy, a page left open keeps running the code it loaded: no fix reaches it, and a later change of the
// snapshot could break it. The server names its build on every snapshot answer (X-Build, its page's entry script);
// when that is not this page's own, the page reloads itself the next time it is hidden (the visitor is not looking,
// and every choice lives on the device, so nothing is lost), once per build so a cache can never make it loop.

const RELOADED_FOR = "mp.reloadedFor";

/** This page's own build: the file name of its entry script under /assets/, or null (the dev server, a test). */
export function pageBuild(doc: Document = document): string | null {
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    const found = /\/assets\/(index-[A-Za-z0-9_-]{1,64}\.js)$/.exec(new URL(script.src, doc.baseURI).pathname);
    if (found) return found[1]!;
  }
  return null;
}

function reloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR);
  } catch {
    return null;
  }
}

let waiting: string | null = null; // the newer build a reload is waiting for, while the page is visible

export interface BuildEnv {
  doc: Document;
  own: string | null;
  reload: () => void;
}

const defaultEnv = (): BuildEnv => ({ doc: document, own: pageBuild(), reload: () => location.reload() });

/** What the server said its build is (null: it did not say). Reloads at once if the page is hidden, else when it is. */
export function noteBuild(server: string | null, env: BuildEnv = defaultEnv()): void {
  const { doc, own, reload } = env;
  if (!server || !own || server === own || reloadedFor() === server || waiting === server) return;
  const go = () => {
    try {
      sessionStorage.setItem(RELOADED_FOR, server);
    } catch {
      // without storage the loop guard is this page's own life: it reloads, and the new page has the new build
    }
    reload();
  };
  if (doc.visibilityState === "hidden") {
    go();
    return;
  }
  waiting = server;
  const onHide = () => {
    if (doc.visibilityState !== "hidden") return;
    doc.removeEventListener("visibilitychange", onHide);
    waiting = null;
    go();
  };
  doc.addEventListener("visibilitychange", onHide);
}

/** Forget what this module remembers (for tests). */
export function resetFreshBuild(): void {
  waiting = null;
  try {
    sessionStorage.removeItem(RELOADED_FOR);
  } catch {
    // nothing to forget
  }
}
