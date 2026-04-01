#!/usr/bin/env node

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PLAYGROUND_DIST = join(ROOT, "playground-dist");
const PAGES_DIST = join(ROOT, "pages-dist");
const DASHBOARD_DIR = join(ROOT, "dashboard");
const BENCHMARKS_RESULTS_DIR = join(ROOT, "benchmarks", "results");
const RUNS_DIR = join(BENCHMARKS_RESULTS_DIR, "runs");

function ensureExists(path) {
  if (!existsSync(path)) {
    throw new Error(`Required path does not exist: ${path}`);
  }
}

function copyFile(source, destination) {
  ensureExists(source);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(realpathSync(source), destination);
}

function copyDirectory(source, destination) {
  ensureExists(source);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
  });
}

function copyFileIfExists(source, destination) {
  if (!existsSync(source)) return false;
  copyFile(source, destination);
  return true;
}

function latestMatchingFile(dir, suffix) {
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort();
  if (matches.length === 0) return null;
  return join(dir, matches[matches.length - 1]);
}

function copyPreferredFile(primarySource, fallbackSource, destination) {
  if (existsSync(primarySource)) {
    copyFile(primarySource, destination);
    return;
  }
  if (fallbackSource && existsSync(fallbackSource)) {
    copyFile(fallbackSource, destination);
    return;
  }
  throw new Error(`Required path does not exist: ${primarySource}`);
}

ensureExists(PLAYGROUND_DIST);
ensureExists(join(DASHBOARD_DIR, "index.html"));
ensureExists(join(DASHBOARD_DIR, "data"));
ensureExists(join(DASHBOARD_DIR, "data.js"));

rmSync(PAGES_DIST, { recursive: true, force: true });
mkdirSync(PAGES_DIST, { recursive: true });

// Start from the Vite playground build, which already includes /benchmarks HTML
// and shared public assets.
copyDirectory(PLAYGROUND_DIST, PAGES_DIST);

// Add the static dashboard route and pre-generated dashboard data.
copyFile(join(DASHBOARD_DIR, "index.html"), join(PAGES_DIST, "dashboard", "index.html"));
copyDirectory(join(DASHBOARD_DIR, "data"), join(PAGES_DIST, "dashboard", "data"));
copyFile(join(DASHBOARD_DIR, "data.js"), join(PAGES_DIST, "dashboard", "data.js"));

// Add the benchmark data files fetched by the public report pages.
copyFileIfExists(join(BENCHMARKS_RESULTS_DIR, "history.json"), join(PAGES_DIST, "benchmarks", "results", "history.json"));
copyFileIfExists(join(BENCHMARKS_RESULTS_DIR, "latest.json"), join(PAGES_DIST, "benchmarks", "results", "latest.json"));
copyPreferredFile(
  join(BENCHMARKS_RESULTS_DIR, "test262-report.json"),
  latestMatchingFile(RUNS_DIR, "-report.json"),
  join(PAGES_DIST, "benchmarks", "results", "test262-report.json"),
);
copyPreferredFile(
  join(BENCHMARKS_RESULTS_DIR, "test262-results.jsonl"),
  latestMatchingFile(RUNS_DIR, "-results.jsonl"),
  join(PAGES_DIST, "benchmarks", "results", "test262-results.jsonl"),
);
copyFile(
  join(BENCHMARKS_RESULTS_DIR, "runs", "index.json"),
  join(PAGES_DIST, "benchmarks", "results", "runs", "index.json"),
);

// Disable Jekyll processing so all generated assets are published as-is.
writeFileSync(join(PAGES_DIST, ".nojekyll"), "");

console.log(`GitHub Pages artifact ready at ${PAGES_DIST}`);
