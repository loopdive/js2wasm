#!/usr/bin/env node
//
// Render docs/adr/*.md → dist/pages/docs/adr/*.html.
//
// Reason this script exists: GitHub Pages does not render .md files. The
// landing page links to ADRs from the "Architecture" subsection, and those
// links must resolve on the same origin (loopdive.github.io/js2wasm). So at
// build time we render each ADR through `marked` and wrap it in a minimal
// HTML shell whose look matches the rest of the site (dark background, system
// font stack, soft text colour, tasteful link hover, anchored headings).
//
// Inputs:  docs/adr/*.md     (and docs/adr/README.md for the index)
// Output:  dist/pages/docs/adr/*.html
//
// The output template is intentionally self-contained — no external CSS, no
// JS — so that pages stay fast and survive without the rest of the site
// being deployed.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";

const ROOT = resolve(import.meta.dirname, "..");
const ADR_SOURCE_DIR = join(ROOT, "docs", "adr");
const PAGES_DIST = join(ROOT, "dist", "pages");
const ADR_OUTPUT_DIR = join(PAGES_DIST, "docs", "adr");

// Configure marked for safe-ish defaults. We trust the ADR sources (they live
// in this repo) but still set `mangle: false` and `headerIds: true` so anchor
// links work out of the box.
marked.use({
  gfm: true,
  breaks: false,
  pedantic: false,
});

function htmlShell({ title, body, backHref }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — js2wasm</title>
  <link rel="icon" href="/js2wasm/favicon.svg" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #060a14;
      --fg: #ffffff;
      --fg-soft: rgba(255, 255, 255, 0.78);
      --fg-faint: rgba(255, 255, 255, 0.55);
      --line: rgba(255, 255, 255, 0.14);
      --surface: rgba(255, 255, 255, 0.04);
      --link: #8ab4ff;
      --link-hover: #b8cdff;
      --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--fg-soft);
      font-family: var(--font);
      font-size: 16px;
      line-height: 1.65;
    }
    body {
      max-width: 760px;
      margin: 0 auto;
      padding: 56px 28px 96px;
    }
    a { color: var(--link); text-decoration: none; border-bottom: 1px solid transparent; transition: color .15s ease, border-color .15s ease; }
    a:hover { color: var(--link-hover); border-bottom-color: currentColor; }
    .top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 36px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
      letter-spacing: 0.04em;
      color: var(--fg-faint);
    }
    .top-nav a { color: var(--fg-faint); }
    .top-nav a:hover { color: var(--fg); }
    .top-nav .brand {
      font-family: var(--mono);
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    h1, h2, h3, h4 {
      color: var(--fg);
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 28px; }
    h2 { font-size: 1.25rem; margin: 36px 0 12px; padding-top: 8px; }
    h3 { font-size: 1.05rem; margin: 28px 0 10px; }
    p, li { color: var(--fg-soft); }
    p { margin: 0 0 16px; }
    ul, ol { padding-left: 1.4em; margin: 0 0 16px; }
    li { margin: 4px 0; }
    strong { color: var(--fg); font-weight: 600; }
    code {
      font-family: var(--mono);
      font-size: 0.92em;
      background: var(--surface);
      padding: 1px 6px;
      border-radius: 4px;
      color: var(--fg);
    }
    pre {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px 18px;
      overflow-x: auto;
      font-family: var(--mono);
      font-size: 0.88em;
      line-height: 1.55;
    }
    pre code { background: none; padding: 0; border-radius: 0; color: var(--fg-soft); }
    blockquote {
      margin: 16px 0;
      padding: 4px 18px;
      border-left: 3px solid var(--line);
      color: var(--fg-faint);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 0.95em;
    }
    th, td {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
    }
    th { color: var(--fg); font-weight: 600; }
    hr { border: 0; border-top: 1px solid var(--line); margin: 32px 0; }
    .footer {
      margin-top: 64px;
      padding-top: 24px;
      border-top: 1px solid var(--line);
      font-size: 12px;
      color: var(--fg-faint);
      letter-spacing: 0.04em;
    }
    .footer a { color: var(--fg-faint); }
    .footer a:hover { color: var(--fg); }
  </style>
</head>
<body>
  <nav class="top-nav">
    <a class="brand" href="/js2wasm/#approach">JS² · Approach</a>
    <a href="${escapeHtml(backHref)}">← back to ADR index</a>
  </nav>
  <main>
    ${body}
  </main>
  <div class="footer">
    Source: <a href="https://github.com/loopdive/js2wasm/tree/main/docs/adr">docs/adr/</a> on GitHub.
  </div>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Rewrite intra-ADR links so the rendered HTML pages link to each other
// instead of the source markdown.
//   ./0007-closure-conversion.md     → ./0007-closure-conversion.html
//   0007-closure-conversion.md       → 0007-closure-conversion.html
export function rewriteAdrLinks(htmlBody) {
  return htmlBody.replace(
    /(href="(?:\.\/)?)([0-9A-Za-z._-]+)\.md(#[^"]*)?"/g,
    (_match, prefix, name, hash) => `${prefix}${name}.html${hash ?? ""}"`,
  );
}

export function titleFromMarkdown(source) {
  const heading = source.match(/^#\s+(.+?)\s*$/m);
  return heading ? heading[1].trim() : "Architecture decision record";
}

// Render a single ADR markdown source to a complete HTML document.
//
// `filename` is the source filename (e.g. "0007-closure-conversion.md" or
// "README.md") — used to decide whether the document is the ADR index (which
// gets a different back-href) and to compute the default `<title>` when the
// markdown lacks a top-level heading.
//
// Used by both the static build (build-pages → dist/pages/docs/adr/*.html)
// and the Vite dev middleware (playground/vite-plugin-adr.ts) so that
// localhost and the deployed site render the same way.
export function renderAdrPage(filename, source) {
  const title = titleFromMarkdown(source);
  const body = rewriteAdrLinks(marked.parse(source));
  const isIndex = filename === "README.md";
  const backHref = isIndex ? "/js2wasm/#approach" : "./";
  return htmlShell({ title, body, backHref });
}

export { htmlShell, escapeHtml };

export function buildAdrPages() {
  if (!existsSync(ADR_SOURCE_DIR)) {
    console.log(`[build-adr-html] no docs/adr directory found at ${ADR_SOURCE_DIR} — skipping`);
    return;
  }

  const entries = readdirSync(ADR_SOURCE_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();

  if (entries.length === 0) {
    console.log("[build-adr-html] no ADR markdown files found — skipping");
    return;
  }

  mkdirSync(ADR_OUTPUT_DIR, { recursive: true });

  let writtenCount = 0;
  for (const entry of entries) {
    const sourcePath = join(ADR_SOURCE_DIR, entry);
    const source = readFileSync(sourcePath, "utf-8");
    const isIndex = entry === "README.md";
    const outputName = isIndex ? "index.html" : entry.replace(/\.md$/, ".html");
    const outputPath = join(ADR_OUTPUT_DIR, outputName);
    const html = renderAdrPage(entry, source);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, html);
    writtenCount += 1;
  }

  console.log(`[build-adr-html] rendered ${writtenCount} ADR page(s) to ${ADR_OUTPUT_DIR}`);
}

// Only run the build when this file is the entry point. When the dev plugin
// imports it (for the helpers above) we don't want a stray build-step run.
const isMainModule = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMainModule) {
  buildAdrPages();
}
