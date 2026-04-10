#!/usr/bin/env node

import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "public");
const PLAYGROUND_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "playground-benchmark-sidebar.json");
const PLAYGROUND_PUBLIC_PATH = resolve(ROOT, "public", "benchmarks", "results", "playground-benchmark-sidebar.json");
const PLAYGROUND_PLAYGROUND_PUBLIC_PATH = resolve(
  ROOT,
  "playground",
  "public",
  "benchmarks",
  "results",
  "playground-benchmark-sidebar.json",
);
const BROWSER_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "browser-runtime-benchmarks.json");
const BROWSER_PUBLIC_PATH = resolve(ROOT, "public", "benchmarks", "results", "browser-runtime-benchmarks.json");

const HOST = "127.0.0.1";
const PORT = 4174;
const PAGE_PATH = "/benchmarks/runtime-benchmark.html";
const RESULT_ID = "result";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function copyFileTo(source, destination) {
  ensureParent(destination);
  copyFileSync(source, destination);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  ensureParent(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function contentType(filePath) {
  return MIME_TYPES[extname(filePath)] || "application/octet-stream";
}

function createStaticServer(rootDir) {
  return createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
      const pathname = decodeURIComponent(url.pathname === "/" ? PAGE_PATH : url.pathname);
      const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
      const filePath = resolve(rootDir, `.${safePath}`);
      if (!filePath.startsWith(rootDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
      res.end(readFileSync(filePath));
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error));
    }
  });
}

function playwrightWrapperPath() {
  const codexHome = process.env.CODEX_HOME || resolve(os.homedir(), ".codex");
  return join(codexHome, "skills", "playwright", "scripts", "playwright_cli.sh");
}

function runPlaywrightCommand(args) {
  const pwcli = playwrightWrapperPath();
  return execFileSync(pwcli, args, {
    cwd: ROOT,
    env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME || resolve(os.homedir(), ".codex") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function extractJson(text) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // Ignore.
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {
      // Ignore.
    }
  }
  throw new Error(`Unable to parse Playwright result JSON from output:\n${text}`);
}

function mergeRuntimeSnapshots(nodeRows, browserRows) {
  const browserPaths = new Set(browserRows.map((row) => row.path));
  return [...nodeRows.filter((row) => !browserPaths.has(row.path)), ...browserRows];
}

async function main() {
  if (!existsSync(PLAYGROUND_RESULTS_PATH)) {
    throw new Error(`Missing compute runtime snapshot: ${PLAYGROUND_RESULTS_PATH}`);
  }

  // Skip browser benchmarks if Playwright is not available (e.g. CI runners)
  const pwcli = playwrightWrapperPath();
  if (!existsSync(pwcli)) {
    console.log(`Playwright not found at ${pwcli} — skipping browser runtime benchmarks.`);
    console.log("Browser benchmarks only run locally (version tag pushes). CI uses Node.js benchmarks only.");
    return;
  }

  const server = createStaticServer(PUBLIC_DIR);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  try {
    const pageUrl = `http://${HOST}:${PORT}${PAGE_PATH}`;
    console.log(`Opening ${pageUrl} in Playwright...`);
    runPlaywrightCommand(["open", pageUrl]);

    console.log("Running browser runtime benchmarks...");
    const rawOutput = runPlaywrightCommand([
      "eval",
      `window.__ts2wasmRunBrowserRuntimeBenchmarks().then((rows) => { document.getElementById("${RESULT_ID}").textContent = JSON.stringify(rows); return document.getElementById("${RESULT_ID}").textContent; })`,
    ]);
    const browserRows = extractJson(rawOutput);
    writeJson(BROWSER_RESULTS_PATH, browserRows);
    copyFileTo(BROWSER_RESULTS_PATH, BROWSER_PUBLIC_PATH);

    const computeRows = readJson(PLAYGROUND_RESULTS_PATH);
    const mergedRows = mergeRuntimeSnapshots(computeRows, browserRows);
    writeJson(PLAYGROUND_RESULTS_PATH, mergedRows);
    copyFileTo(PLAYGROUND_RESULTS_PATH, PLAYGROUND_PUBLIC_PATH);
    copyFileTo(PLAYGROUND_RESULTS_PATH, PLAYGROUND_PLAYGROUND_PUBLIC_PATH);

    console.log(`Wrote ${BROWSER_RESULTS_PATH}`);
    console.log(`Updated ${PLAYGROUND_RESULTS_PATH}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
