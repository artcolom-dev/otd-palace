import { existsSync, readFileSync } from "node:fs";
import { cwd } from "node:process";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// The service worker as the browser gets it, evaluated in a bare context: it must not throw while it loads (a "*/"
// inside a block comment once ended a comment early and broke a worker). It shows alerts, and keeps the last home page
// (and the built files it names) for when the network fails.
const SW_PATH = [`${cwd()}/public/sw.js`, `${cwd()}/frontend/public/sw.js`].find(existsSync)!;
const SOURCE = readFileSync(SW_PATH, "utf-8");
const ORIGIN = "https://marketpalace.example";

type Listener = (event: unknown) => void;
interface FakeWindow {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

/** Cache Storage as the worker sees it, in memory: entries by cache name, then by url. */
class FakeCaches {
  stores = new Map<string, Map<string, Response>>();
  private store(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return this.stores.get(name)!;
  }
  async open(name: string) {
    const store = this.store(name);
    const key = (request: Request | string) => new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
    return {
      match: async (request: Request | string) => store.get(key(request))?.clone(),
      put: async (request: Request | string, response: Response) => void store.set(key(request), response.clone()),
      add: async (request: string) => {
        const response = await (globalThis as unknown as { swFetch: typeof fetch }).swFetch(new Request(key(request)));
        if (!response.ok) throw new TypeError("bad response");
        store.set(key(request), response);
      },
      delete: async (request: Request | string) => store.delete(key(request)),
      keys: async () => [...store.keys()].map((url) => new Request(url)),
    };
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  urls(name: string) {
    return [...(this.stores.get(name)?.keys() ?? [])].map((url) => url.replace(ORIGIN, "")).sort();
  }
}

interface BootOptions {
  fetch?: typeof fetch;
  caches?: FakeCaches;
  saveData?: boolean;
}

function boot(windows: FakeWindow[] = [], options: BootOptions = {}) {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => null);
  const claim = vi.fn(async () => undefined);
  const skipWaiting = vi.fn(async () => undefined);
  const caches = options.caches ?? new FakeCaches();
  const fetchImpl = options.fetch ?? vi.fn<typeof fetch>(async () => new Response("", { status: 404 }));
  (globalThis as unknown as { swFetch: typeof fetch }).swFetch = fetchImpl;
  const self = {
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: { showNotification },
    clients: { matchAll: vi.fn(async () => windows), openWindow, claim },
    skipWaiting,
    navigator: { connection: { saveData: options.saveData === true } },
  };
  runInNewContext(SOURCE, { self, URL, Request, Response, caches, fetch: fetchImpl }, { filename: "sw.js" });
  return { listeners, showNotification, openWindow, claim, skipWaiting, caches, fetchImpl };
}

/** Fires an event at the worker and waits for what it handed to waitUntil. */
async function fire(listener: Listener | undefined, event: Record<string, unknown>) {
  const waits: Promise<unknown>[] = [];
  listener?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
}

const pushEvent = (payload: unknown) => ({
  data: {
    json: () => {
      if (payload instanceof Error) throw payload;
      return payload;
    },
  },
});

describe("the service worker", () => {
  it("evaluates without an error and listens to install, activate, fetch, push and notificationclick only", () => {
    const { listeners } = boot();
    expect([...listeners.keys()].sort()).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
  });

  it("writes no block comment", () => {
    expect(SOURCE).not.toMatch(/\/\*/);
  });

  it("shows the notification a push carries, with the site's icon", async () => {
    const { listeners, showNotification } = boot();
    await fire(listeners.get("push"), pushEvent({
      title: "New deal on a player you follow",
      body: "Test Player · 150 Rax to start, 34% under usual",
      tag: "deal:nba:22",
      url: "/?open=102#deals",
      icon: "/icon-192.png",
    }));
    expect(showNotification).toHaveBeenCalledWith("New deal on a player you follow", {
      body: "Test Player · 150 Rax to start, 34% under usual",
      tag: "deal:nba:22",
      icon: "/icon-192.png",
      data: { url: `${ORIGIN}/?open=102#deals` },
    });
  });

  it("still shows something plain for a push it cannot read", async () => {
    const { listeners, showNotification } = boot();
    await fire(listeners.get("push"), pushEvent(new Error("not JSON")));
    expect(showNotification).toHaveBeenCalledWith("OTD Palace", {
      body: "", icon: "/icon-192.png", data: { url: `${ORIGIN}/` },
    });
  });

  it("never sends a tap to another site", async () => {
    const { listeners, showNotification } = boot();
    await fire(listeners.get("push"), pushEvent({ title: "Hi", url: "https://evil.example/x" }));
    expect(showNotification.mock.calls[0]).toEqual(["Hi", expect.objectContaining({ data: { url: `${ORIGIN}/` } })]);
  });

  it("a tap opens the alert's page in a tab of the site already open, focused", async () => {
    const tab: FakeWindow = { url: `${ORIGIN}/#today`, focus: vi.fn(async () => tab), navigate: vi.fn() };
    tab.navigate.mockImplementation(async () => tab);
    const { listeners, openWindow } = boot([{ url: "https://other.example/", focus: vi.fn(), navigate: vi.fn() }, tab]);
    const close = vi.fn();
    await fire(listeners.get("notificationclick"), {
      notification: { close, data: { url: `${ORIGIN}/?open=102#deals` } },
    });
    expect(close).toHaveBeenCalled();
    expect(tab.navigate).toHaveBeenCalledWith(`${ORIGIN}/?open=102#deals`);
    expect(tab.focus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("a tap opens a new tab when none is open, or when the open one cannot be moved", async () => {
    const first = boot();
    await fire(first.listeners.get("notificationclick"), { notification: { close: vi.fn(), data: { url: `${ORIGIN}/#prices` } } });
    expect(first.openWindow).toHaveBeenCalledWith(`${ORIGIN}/#prices`);

    const stuck: FakeWindow = { url: `${ORIGIN}/`, focus: vi.fn(), navigate: vi.fn(async () => Promise.reject(new TypeError("not controlled"))) };
    const second = boot([stuck]);
    await fire(second.listeners.get("notificationclick"), { notification: { close: vi.fn(), data: {} } });
    expect(second.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});

// ---- the page kept for when the network fails ------------------------------------------------------------------

const SHELL = "otd-shell-v1";
// The views' own addresses (lib/tabHint): the same page as the home page, each with its own head.
const VIEW_PATHS = ["/deals", "/prices", "/passes", "/plan"];
const page = (build: string, extra = "") =>
  `<!doctype html><html><head><link rel="stylesheet" crossorigin href="/assets/index-${build}.css">` +
  `<link rel="modulepreload" crossorigin href="/assets/App-${build}.js">${extra}</head>` +
  `<body><div id="root"></div><script type="module" crossorigin src="/assets/index-${build}.js"></script></body></html>`;
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

/** A server: the home page of `build`, its files, and whatever `down` says is unreachable. */
function server(state: { build: string; down?: boolean; status?: number }) {
  return vi.fn<typeof fetch>(async (input) => {
    if (state.down) throw new TypeError("Failed to fetch");
    const url = new URL(typeof input === "string" ? input : (input as Request).url, ORIGIN);
    if (["/", ...VIEW_PATHS].includes(url.pathname)) return html(page(state.build), state.status ?? 200);
    if (url.pathname.startsWith("/assets/")) return new Response(`file ${url.pathname}`, { status: 200 });
    return new Response("{}", { status: 200 });
  });
}

/** A fetch event; `respondWith` keeps what the worker answered with, and `waitUntil` what it does after. */
function fetchEvent(url: string, mode: RequestMode = "navigate", method = "GET") {
  const request = { url: new URL(url, ORIGIN).href, mode, method } as unknown as Request;
  const waits: Promise<unknown>[] = [];
  let answer: Promise<Response> | undefined;
  return {
    event: { request, respondWith: (p: Promise<Response>) => (answer = p), waitUntil: (p: Promise<unknown>) => waits.push(p) },
    answered: () => answer !== undefined,
    response: async () => {
      const response = await answer!;
      await Promise.all(waits);
      return response;
    },
    done: () => Promise.all(waits),
  };
}

async function install(sw: ReturnType<typeof boot>) {
  await fire(sw.listeners.get("install"), {});
  await fire(sw.listeners.get("activate"), {});
}

describe("the service worker, offline", () => {
  it("on install keeps the home page and the files it names, takes over at once, and drops older caches", async () => {
    const caches = new FakeCaches();
    (await caches.open("otd-shell-v0")).put("/", html("old"));
    const sw = boot([], { fetch: server({ build: "aaa" }), caches });
    await install(sw);
    expect(sw.skipWaiting).toHaveBeenCalled();
    expect(sw.claim).toHaveBeenCalled();
    expect(await caches.keys()).toEqual([SHELL]);
    expect(caches.urls(SHELL)).toEqual(["/", "/assets/App-aaa.js", "/assets/index-aaa.css", "/assets/index-aaa.js"]);
  });

  it("asks nothing on install while the phone saves data: the first page it opens is kept instead", async () => {
    const sw = boot([], { fetch: server({ build: "aaa" }), saveData: true });
    await install(sw);
    expect(sw.fetchImpl).not.toHaveBeenCalled();
    expect(sw.caches.urls(SHELL)).toEqual([]);
  });

  it("serves the home page from the network while there is one, and keeps each new one", async () => {
    const state = { build: "aaa" };
    const sw = boot([], { fetch: server(state) });
    await install(sw);
    state.build = "bbb"; // a deploy
    const visit = fetchEvent("/?open=102");
    sw.listeners.get("fetch")!(visit.event);
    const response = await visit.response();
    expect(await response.text()).toBe(page("bbb"));
    const kept = await (await sw.caches.open(SHELL)).match("/");
    expect(await kept!.text()).toBe(page("bbb"));
    // the new build's files are kept, the older build's are dropped
    expect(sw.caches.urls(SHELL)).toEqual(["/", "/assets/App-bbb.js", "/assets/index-bbb.css", "/assets/index-bbb.js"]);
  });

  it("serves the last page it kept when the network fails or the server errs, and the error when it has none", async () => {
    const state = { build: "aaa", down: false, status: 200 };
    const sw = boot([], { fetch: server(state) });
    await install(sw);
    state.down = true;
    for (const path of ["/", "/?open=7#deals"]) {
      const visit = fetchEvent(path);
      sw.listeners.get("fetch")!(visit.event);
      expect(await (await visit.response()).text()).toBe(page("aaa"));
    }
    state.down = false;
    state.status = 502; // the platform between deploys
    const bad = fetchEvent("/");
    sw.listeners.get("fetch")!(bad.event);
    expect(await (await bad.response()).text()).toBe(page("aaa"));
    expect(await (await (await sw.caches.open(SHELL)).match("/"))!.text()).toBe(page("aaa")); // an error is never kept

    const empty = boot([], { fetch: server({ build: "aaa", down: true }), saveData: true });
    await install(empty);
    const none = fetchEvent("/");
    empty.listeners.get("fetch")!(none.event);
    await expect(none.response()).rejects.toThrow("Failed to fetch");
  });

  it("serves a view's own address like the home page: the network's while there is one, kept, else the last kept", async () => {
    const state = { build: "aaa", down: false };
    const sw = boot([], { fetch: server(state) });
    await install(sw);
    state.build = "bbb";
    for (const path of VIEW_PATHS) {
      const visit = fetchEvent(path);
      sw.listeners.get("fetch")!(visit.event);
      expect(visit.answered(), path).toBe(true);
      expect(await (await visit.response()).text()).toBe(page("bbb"));
    }
    expect(await (await (await sw.caches.open(SHELL)).match("/"))!.text()).toBe(page("bbb"));
    state.down = true;
    for (const path of [...VIEW_PATHS, "/deals?open=7#how"]) {
      const visit = fetchEvent(path);
      sw.listeners.get("fetch")!(visit.event);
      expect(await (await visit.response()).text(), path).toBe(page("bbb"));
    }
  });

  it("serves a built file it kept without asking, and keeps the others the first time they are asked for", async () => {
    const state = { build: "aaa", down: false };
    const sw = boot([], { fetch: server(state) });
    await install(sw);
    const calls = vi.mocked(sw.fetchImpl).mock.calls.length;
    const kept = fetchEvent("/assets/App-aaa.js", "cors");
    sw.listeners.get("fetch")!(kept.event);
    expect(await (await kept.response()).text()).toBe("file /assets/App-aaa.js");
    expect(vi.mocked(sw.fetchImpl).mock.calls.length).toBe(calls);
    const lazy = fetchEvent("/assets/PassesView-aaa.js", "cors");
    sw.listeners.get("fetch")!(lazy.event);
    expect(await (await lazy.response()).text()).toBe("file /assets/PassesView-aaa.js");
    state.down = true;
    const again = fetchEvent("/assets/PassesView-aaa.js", "cors");
    sw.listeners.get("fetch")!(again.event);
    expect(await (await again.response()).text()).toBe("file /assets/PassesView-aaa.js");
  });

  it("leaves everything else to the browser: the data, photos, other pages, other sites, anything but GET", async () => {
    const sw = boot([], { fetch: server({ build: "aaa" }) });
    await install(sw);
    for (const [url, mode, method] of [
      ["/api/snapshot", "cors", "GET"],
      ["/img/players/nhl/1", "no-cors", "GET"],
      ["/privacy", "navigate", "GET"],
      ["/d/123", "navigate", "GET"],
      ["/a/someone", "navigate", "GET"],
      ["/admin", "navigate", "GET"],
      ["/dealz", "navigate", "GET"],
      ["/deals/101", "navigate", "GET"],
      ["/deals", "navigate", "POST"],
      ["/auth/login", "navigate", "GET"],
      ["https://discord.com/oauth2/authorize", "navigate", "GET"],
      ["/api/out", "cors", "POST"],
      ["/", "navigate", "POST"],
    ] as const) {
      const visit = fetchEvent(url, mode, method);
      sw.listeners.get("fetch")!(visit.event);
      expect(visit.answered(), url).toBe(false);
    }
  });
});
