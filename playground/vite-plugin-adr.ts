import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

// Vite dev middleware that renders docs/adr/*.md → HTML on the fly so the
// landing page's "Architecture" subsection works during `pnpm dev`.
//
// Why this is needed:
// - The static deploy renders ADRs at `pnpm build:pages` time via
//   `scripts/build-adr-html.mjs`, writing to `dist/pages/docs/adr/*.html`.
// - The Vite dev server serves files directly from the project root and has
//   `**/dist/pages/**` in its watch-ignore list, so the pre-built HTML never
//   reaches the browser.
// - The source on disk under `docs/adr/` is `.md` only — without this plugin,
//   any link to `./docs/adr/0NNN-*.html` 404s in dev.
//
// This plugin intercepts requests for the rendered ADR URLs and renders them
// from source through the same `renderAdrPage` helper used by the static
// build, so dev and prod produce identical pages.

interface RenderedAdr {
  filename: string; // source filename, e.g. "0007-closure-conversion.md"
  source: string; // raw markdown contents
}

/**
 * Maps an incoming request URL onto an ADR markdown file we know how to
 * render. Returns the source filename (under `docs/adr/`) or `null` if the
 * URL isn't an ADR route.
 *
 *   /docs/adr/                                   → README.md  (the index)
 *   /docs/adr/index.html                         → README.md
 *   /docs/adr/0007-closure-conversion.html       → 0007-closure-conversion.md
 *   /docs/adr/anything-else                      → null
 */
function urlToAdrSourceName(url: string, adrDir: string): string | null {
  const path = url.split("?")[0].split("#")[0];
  if (!path.startsWith("/docs/adr/")) return null;

  const tail = path.slice("/docs/adr/".length);

  // /docs/adr/  →  index
  if (tail === "" || tail === "index.html") {
    if (existsSync(join(adrDir, "README.md"))) return "README.md";
    return null;
  }

  // /docs/adr/0007-foo.html  →  0007-foo.md
  if (tail.endsWith(".html")) {
    const candidate = `${tail.slice(0, -".html".length)}.md`;
    if (existsSync(join(adrDir, candidate))) return candidate;
  }

  return null;
}

export function adrPlugin(): Plugin {
  // Lazily import the build helpers — they live in scripts/ which uses ESM,
  // and we don't want their side effects (the build IIFE) to run on import.
  let renderAdrPage: ((filename: string, source: string) => string) | null = null;
  let renderUnavailableReason: string | null = null;
  const projectRoot = resolve(import.meta.dirname, "..");
  const adrDir = join(projectRoot, "docs", "adr");

  return {
    name: "js2wasm:adr-dev-server",
    apply: "serve", // dev only — production uses scripts/build-adr-html.mjs

    async configureServer(server) {
      // Import once when the dev server starts. Wrap in try/catch so a
      // missing transitive dep (e.g. `marked` not yet installed after a
      // pull that added it) degrades to a useful 503 instead of crashing
      // the whole dev server. The dev server hosts the playground +
      // dashboard too — losing those over a docs feature would be a bad
      // trade.
      try {
        ({ renderAdrPage } = await import(
          // Relative path from playground/ → scripts/.
          new URL("../scripts/build-adr-html.mjs", import.meta.url).href
        ));
      } catch (err) {
        renderUnavailableReason = (err as Error).message ?? String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[adr-dev-server] disabled — failed to load renderer (${renderUnavailableReason}). ` +
            `Run \`pnpm install\` to refresh deps; ADR routes will return 503 until then.`,
        );
      }

      // Reload any open tab when an ADR markdown source changes. Safe to
      // wire up even when rendering is unavailable — the watcher just
      // becomes a no-op for ADR edits.
      server.watcher.add(adrDir);
      server.watcher.on("change", (changedPath) => {
        if (!changedPath.startsWith(adrDir)) return;
        // Naive but effective: tell every connected client to do a full reload.
        server.ws.send({ type: "full-reload", path: "*" });
      });

      server.middlewares.use((req, res, next) => {
        if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) return next();
        const sourceName = urlToAdrSourceName(req.url, adrDir);
        if (!sourceName) return next();

        if (!renderAdrPage) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(
            `[adr-dev-server] ADR renderer is unavailable: ${renderUnavailableReason ?? "unknown reason"}.\n` +
              "Run `pnpm install` and restart the dev server.\n",
          );
          return;
        }

        try {
          const source = readFileSync(join(adrDir, sourceName), "utf-8");
          const html = renderAdrPage(sourceName, source);
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.statusCode = 200;
          res.end(req.method === "HEAD" ? "" : html);
        } catch (err) {
          // Surface the error in the response so the user can see what went
          // wrong instead of getting a silent 500.
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(`[adr-dev-server] failed to render ${sourceName}: ${(err as Error).message}`);
        }
      });
    },

    // Optional sanity-log during dev startup so it's obvious the plugin loaded
    // and how many ADRs it can serve.
    config() {
      if (!existsSync(adrDir)) return;
      const count = readdirSync(adrDir).filter((name) => name.endsWith(".md")).length;
      // eslint-disable-next-line no-console
      console.log(`[adr-dev-server] serving ${count} ADR(s) from ${adrDir}`);
    },
  };
}
