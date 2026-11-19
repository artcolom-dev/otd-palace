// OTD Palace's worker. It does three things: it shows a notification when one is pushed, a tap on it opens the site
// on the page the alert is about, and it keeps the last home page (with the snapshot in it) and the built files it
// needs, for when the network fails: a phone with no signal then opens on the last market it saw, which the page
// itself shows as paused, instead of the browser's error page. While there is a network the page is always the one
// the server sends, so a deploy is never held back. The data, the photos, other pages and everything but GET go to
// the network untouched. Only line comments in this file: a glob inside a block comment would end it early.
"use strict";

const SITE = self.location.origin;
const HOME = SITE + "/";
const ICON = "/icon-192.png";
// The cache's name. Change the number only to throw away what every phone kept (activate drops the others).
const SHELL = "otd-shell-v1";
const ASSETS = "/assets/";
// The site's pages: the home page and each view at its own address (src/lib/tabHint.ts), all the same page with the
// view's own head, so the last one kept opens any of them offline (the page reads its view from the address).
const PAGES = new Set(["/", "/deals", "/prices", "/passes", "/plan"]);
const ANY = { ignoreVary: true, ignoreSearch: true };

function savingData() {
  try {
    return Boolean(self.navigator && self.navigator.connection && self.navigator.connection.saveData);
  } catch (error) {
    return false;
  }
}

// The built files a page names: its entry script, its style sheet and the chunks it preloads.
function filesOf(page) {
  const found = new Set();
  const named = /(?:src|href)="(\/assets\/[A-Za-z0-9._-]+)"/g;
  let match;
  while ((match = named.exec(page)) !== null) found.add(match[1]);
  return [...found];
}

// Keeps `response` (a home page the server sent) and the files it names. A page of a new build drops the files of
// the older one first: the names carry a fingerprint, so a name the new page does not have belongs to an old build
// (the new build's lazy chunks come back the first time they are asked for).
async function keepPage(response) {
  const page = await response.clone().text();
  const cache = await caches.open(SHELL);
  const files = filesOf(page);
  const entry = files.find((file) => /\/index-[^/]+\.js$/.test(file));
  const newBuild = entry !== undefined && !(await cache.match(SITE + entry, ANY));
  if (newBuild) {
    for (const request of await cache.keys()) {
      const path = new URL(request.url).pathname;
      if (path.startsWith(ASSETS) && !files.includes(path)) await cache.delete(request);
    }
  }
  await cache.put(HOME, response);
  for (const file of files) {
    if (await cache.match(SITE + file, ANY)) continue;
    try {
      await cache.add(SITE + file);
    } catch (error) {
      // not kept this time: the next page tries again
    }
  }
}

const isPage = (response) =>
  response.status === 200 && (response.headers.get("Content-Type") || "").startsWith("text/html");

// The home page (or a view at its own address): the network's, kept for later; the last one kept when the network
// fails or the server errs.
async function homePage(event) {
  let response;
  try {
    response = await fetch(event.request);
  } catch (error) {
    const kept = await caches.open(SHELL).then((cache) => cache.match(HOME, ANY));
    if (kept) return kept;
    throw error;
  }
  if (isPage(response)) {
    event.waitUntil(keepPage(response.clone()).catch(() => undefined));
  } else if (response.status >= 500) {
    const kept = await caches.open(SHELL).then((cache) => cache.match(HOME, ANY));
    if (kept) return kept;
  }
  return response;
}

// A built file: its name carries a fingerprint, so a kept copy is always the right one; else the network's, kept.
async function builtFile(event) {
  const cache = await caches.open(SHELL);
  const kept = await cache.match(event.request, ANY);
  if (kept) return kept;
  const response = await fetch(event.request);
  if (response.status === 200) event.waitUntil(cache.put(event.request, response.clone()).catch(() => undefined));
  return response;
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // The home page as it is now, so a phone that goes offline before its next visit still has it; not while it saves
  // data (its next visit is kept instead).
  if (!savingData()) {
    event.waitUntil(
      fetch(HOME, { credentials: "same-origin" })
        .then((response) => (isPage(response) ? keepPage(response) : undefined))
        .catch(() => undefined),
    );
  }
  // Where the browser can route requests itself, the data and the photos never wake this worker. (The patterns are
  // written in two pieces so no slash and star ever stand side by side in this file.)
  try {
    if (typeof event.addRoutes === "function" && typeof URLPattern === "function") {
      event.waitUntil(
        event
          .addRoutes([
            { condition: { urlPattern: new URLPattern({ pathname: "/api/" + "*" }) }, source: "network" },
            { condition: { urlPattern: new URLPattern({ pathname: "/img/" + "*" }) }, source: "network" },
          ])
          .catch(() => undefined),
      );
    }
  } catch (error) {
    // routes are only a shortcut
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith("otd-") && name !== SHELL).map((name) => caches.delete(name)));
      await self.clients.claim();
    })().catch(() => undefined),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  if (url.origin !== SITE) return;
  if (request.mode === "navigate" && PAGES.has(url.pathname)) event.respondWith(homePage(event));
  else if (url.pathname.startsWith(ASSETS) && request.mode !== "navigate") event.respondWith(builtFile(event));
});

// The page an alert opens, on this site only; anything else, or nothing readable, opens the home page.
function onSite(url) {
  try {
    const target = new URL(typeof url === "string" ? url : "/", SITE);
    return target.origin === SITE ? target.href : HOME;
  } catch (error) {
    return HOME;
  }
}

function payload(event) {
  try {
    const data = event.data ? event.data.json() : null;
    return data && typeof data === "object" ? data : {};
  } catch (error) {
    return {};
  }
}

self.addEventListener("push", (event) => {
  const data = payload(event);
  const title = typeof data.title === "string" && data.title ? data.title : "OTD Palace";
  const options = { body: typeof data.body === "string" ? data.body : "", icon: ICON, data: { url: onSite(data.url) } };
  if (typeof data.tag === "string" && data.tag) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

// A tab of the site already open is moved to the alert's page and brought forward; without one, or when the open
// tab cannot be moved (this worker does not control it yet), a new tab opens there.
async function openAlert(url) {
  const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const tab = tabs.find((client) => typeof client.url === "string" && client.url.startsWith(HOME));
  if (tab) {
    try {
      const moved = await tab.navigate(url);
      if (moved) {
        await moved.focus();
        return;
      }
    } catch (error) {
      // not controlled by this worker: open a new tab instead
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openAlert(onSite(data.url)));
});
