import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { writeBrotli } from "./src/build/brotli.ts";

// The site's code (the App chunk) is fetched by everyone: members get the whole market, anyone else the free site, and
// both run the same app. The page names it as a modulepreload, so it downloads beside the entry file.
const preloadApp: Plugin = {
  name: "preload-app-chunk",
  transformIndexHtml: {
    order: "post",
    handler(_html, ctx) {
      const bundle = ctx.bundle ?? {};
      const app = Object.values(bundle).find((c) => c.type === "chunk" && c.name === "App");
      if (!app || app.type !== "chunk") return [];
      // The Plan view is a lazy chunk of under 1 KB (its code is the site's): naming it here starts it with the rest,
      // so a #plan visit does not wait for the entry to ask for it. The Passes view is bigger: the entry file starts it
      // only for a visit that opens on it (`main.tsx`), so the other visits do not pay for it.
      const views = Object.values(bundle).filter(
        (c): c is typeof app => c.type === "chunk" && c.name === "PlanView",
      );
      // The chunk and what it imports at once (not the entry, which the page loads anyway), so they come in parallel.
      const entry = Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry);
      const early = new Set(entry?.type === "chunk" ? [entry.fileName, ...entry.imports] : []);
      const files = [
        ...new Set([app, ...views].flatMap((c) => [c.fileName, ...c.imports]).filter((f) => !early.has(f))),
      ];
      return files.map((file) => ({
        tag: "link",
        attrs: { rel: "modulepreload", crossorigin: true, href: `/${file}` },
        injectTo: "head" as const,
      }));
    },
  },
};

// Each fingerprinted script, style sheet and svg also gets a brotli copy (`<file>.br`), which the server sends to a
// browser that names br (`advisor/web.py`, `built_file`).
const brotliAssets: Plugin = {
  name: "brotli-assets",
  apply: "build",
  async writeBundle(options, bundle) {
    if (options.dir) await writeBrotli(options.dir, Object.keys(bundle));
  },
};

export default defineConfig({
  plugins: [react(), preloadApp, brotliAssets],
  build: {
    // The Python server serves what lands here.
    outDir: "../advisor/static",
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` talks to the server started with `uv run python server.py`, for the data and the photos.
    proxy: { "/api": "http://localhost:8795", "/img": "http://localhost:8795" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Style sheets stay out of the tests, except as plain text where a test reads their rules (`?raw`).
    css: { include: [/\.css\?raw$/] },
  },
});
