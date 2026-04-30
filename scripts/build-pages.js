#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PLAYGROUND_DIST = join(ROOT, "dist", "playground");
const PAGES_DIST = join(ROOT, "dist", "pages");
const DASHBOARD_DIR = join(ROOT, "dashboard");
const PLAN_DIR = join(ROOT, "plan");
const BENCHMARKS_RESULTS_DIR = join(ROOT, "benchmarks", "results");
const PUBLIC_BENCH = join(ROOT, "public", "benchmarks", "results");
const RUNS_DIR = join(BENCHMARKS_RESULTS_DIR, "runs");
const PLAYGROUND_DATA_DIR = join(PAGES_DIST, "playground-data");
const PLAYGROUND_APP_DATA_DIR = join(PAGES_DIST, "playground", "playground-data");
const PLAYGROUND_BENCHMARKS_RESULTS_DIR = join(PAGES_DIST, "playground", "benchmarks", "results");
const TEST262_REPO_ROOT = join(ROOT, "test262");
const PLAYGROUND_EXAMPLES_DIR = join(ROOT, "playground", "examples");
const EQUIV_DIR = join(ROOT, "tests", "equivalence");
const TS_WASM_EQUIV_FILE = join(ROOT, "tests", "ts-wasm-equivalence.test.ts");

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

function copyDirectoryIfExists(source, destination) {
  if (!existsSync(source)) return false;
  copyDirectory(source, destination);
  return true;
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

function latestNamedFile(dir, prefix, suffix) {
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort();
  if (matches.length === 0) return null;
  return join(dir, matches[matches.length - 1]);
}

function resolvePreferredFile(primarySource, ...fallbackSources) {
  if (existsSync(primarySource)) return primarySource;
  for (const fallbackSource of fallbackSources) {
    if (fallbackSource && existsSync(fallbackSource)) return fallbackSource;
  }
  throw new Error(`Required path does not exist: ${primarySource}`);
}

function resolvePreferredFileOrNull(primarySource, ...fallbackSources) {
  if (existsSync(primarySource)) return primarySource;
  for (const fallbackSource of fallbackSources) {
    if (fallbackSource && existsSync(fallbackSource)) return fallbackSource;
  }
  return null;
}

function writeJson(destination, value) {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(value));
}

function collectFiles(dir, predicate, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, predicate, files);
    else if (predicate(entry.name, full)) files.push(full);
  }
  return files.sort();
}

function normalizeSnippet(source) {
  const lines = source.split("\n");
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return source.trim();
  const minIndent = Math.min(...nonEmpty.map((line) => line.match(/^(\s*)/)?.[1].length ?? 0));
  return lines
    .map((line) => line.slice(minIndent))
    .join("\n")
    .trim();
}

function extractEquivTestsFromFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const tests = [];
  const itRegex = /it\("([^"]+)"[\s\S]*?(?:compileToWasm|assertEquivalent)\(\s*`([\s\S]*?)`/g;
  let match;
  while ((match = itRegex.exec(content)) !== null) {
    tests.push({
      name: match[1],
      source: normalizeSnippet(match[2]),
    });
  }
  return tests;
}

function buildEquivTests() {
  const files = [];
  if (existsSync(TS_WASM_EQUIV_FILE)) files.push(TS_WASM_EQUIV_FILE);
  files.push(...collectFiles(EQUIV_DIR, (name) => name.endsWith(".test.ts")));
  return files.flatMap((filePath) => extractEquivTestsFromFile(filePath));
}

function buildStaticTest262Data(resultsJsonlPath) {
  const categorySummaries = new Map();
  const filesByCategory = new Map();
  const resultsByCategory = new Map();
  const copiedFiles = new Set();

  const lines = readFileSync(resultsJsonlPath, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const category = entry.category;
    const file = entry.file;
    if (!category || !file) continue;

    if (!filesByCategory.has(category)) filesByCategory.set(category, new Set());
    filesByCategory.get(category).add(file);

    if (!resultsByCategory.has(category)) resultsByCategory.set(category, []);
    resultsByCategory.get(category).push({
      file,
      status: entry.status,
      error: entry.error,
    });

    const normalizedFile = file.startsWith("test/") ? file : `test/${file}`;
    const src = join(TEST262_REPO_ROOT, normalizedFile);
    if (!copiedFiles.has(file) && existsSync(src) && statSync(src).isFile()) {
      copyFile(src, join(PAGES_DIST, "test262", normalizedFile));
      copiedFiles.add(file);
    }
  }

  for (const [category, files] of filesByCategory) {
    categorySummaries.set(category, {
      name: category,
      path: category,
      fileCount: files.size,
    });
  }

  const categories = [...categorySummaries.values()].sort((a, b) => a.name.localeCompare(b.name));
  const filesJson = Object.fromEntries(
    [...filesByCategory.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, files]) => [category, [...files].sort()]),
  );
  const resultsJson = Object.fromEntries([...resultsByCategory.entries()].sort(([a], [b]) => a.localeCompare(b)));

  return {
    categories: { categories },
    filesJson,
    resultsJson,
  };
}

function buildStaticTest262DataFromReport(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, "utf-8"));
  const categories = Array.isArray(report.categories)
    ? report.categories
        .map((entry) => ({
          name: entry.name,
          path: entry.name,
          fileCount: 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return {
    categories: { categories },
    filesJson: {},
    resultsJson: {},
  };
}

ensureExists(PLAYGROUND_DIST);
const hasDashboardBundle =
  existsSync(join(DASHBOARD_DIR, "index.html")) &&
  existsSync(join(DASHBOARD_DIR, "data")) &&
  existsSync(join(DASHBOARD_DIR, "data.js"));
// issues-graph.html and graph-data.json live in public/ — Vite copies them
// into playground-dist automatically, so they're already in PAGES_DIST.

rmSync(PAGES_DIST, { recursive: true, force: true });
mkdirSync(PAGES_DIST, { recursive: true });

// Start from the Vite multi-page build, which now includes the landing page
// at / and the playground at /playground/.
copyDirectory(PLAYGROUND_DIST, PAGES_DIST);
copyDirectory(PLAYGROUND_EXAMPLES_DIR, join(PAGES_DIST, "examples"));

// Overwrite Vite-built report pages with the latest public/ versions (which include
// web components like <t262-donut> that Vite doesn't process).
const PUBLIC_REPORT = join(ROOT, "public", "benchmarks", "results", "report.html");
const PUBLIC_REPORT_SHORT = join(ROOT, "public", "benchmarks", "report.html");
copyFileIfExists(PUBLIC_REPORT, join(PAGES_DIST, "benchmarks", "results", "report.html"));
copyFileIfExists(PUBLIC_REPORT_SHORT, join(PAGES_DIST, "benchmarks", "report.html"));

// Add the static dashboard route and pre-generated dashboard data when the
// private planning artifacts are present. Public exports intentionally omit
// them.
if (hasDashboardBundle) {
  copyFile(join(DASHBOARD_DIR, "index.html"), join(PAGES_DIST, "dashboard", "index.html"));
  copyDirectory(join(DASHBOARD_DIR, "data"), join(PAGES_DIST, "dashboard", "data"));
  copyFile(join(DASHBOARD_DIR, "data.js"), join(PAGES_DIST, "dashboard", "data.js"));
}
// issues-graph.html + graph-data.json are in public/ → included via Vite build
copyDirectoryIfExists(join(ROOT, "benchmarks", "suites"), join(PAGES_DIST, "benchmarks", "suites"));

// Add the benchmark data files fetched by the public report pages. Public pages
// should read from the already-curated public summaries, not from the full
// internal benchmark results directory.
copyFileIfExists(join(PUBLIC_BENCH, "history.json"), join(PAGES_DIST, "benchmarks", "results", "history.json"));
copyFileIfExists(join(PUBLIC_BENCH, "latest.json"), join(PAGES_DIST, "benchmarks", "results", "latest.json"));
// Preference order:
//   1. test262-current.{jsonl,json}  — committed by the nightly workflow,
//      always present in CI checkouts. THIS is what GitHub Pages should serve.
//   2. test262-results.jsonl symlink — local dev, points at the latest run.
//   3. latest test262-results-*.jsonl in benchmarks/results/ — local dev fallback.
//
// Do NOT fall back to runs/ archive — those files can be months old and would
// silently poison the deployed dashboard.
const test262ReportSource = resolvePreferredFile(
  join(PUBLIC_BENCH, "test262-report.json"),
  join(BENCHMARKS_RESULTS_DIR, "test262-current.json"),
  join(BENCHMARKS_RESULTS_DIR, "test262-report.json"),
  latestNamedFile(BENCHMARKS_RESULTS_DIR, "test262-report-", ".json"),
);
const test262ResultsSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "test262-current.jsonl"),
  join(PUBLIC_BENCH, "test262-results.jsonl"),
  join(BENCHMARKS_RESULTS_DIR, "test262-results.jsonl"),
  latestNamedFile(BENCHMARKS_RESULTS_DIR, "test262-results-", ".jsonl"),
);
const test262RunsIndexSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "runs", "index.json"),
  join(PUBLIC_BENCH, "runs", "index.json"),
);
copyFile(test262ReportSource, join(PAGES_DIST, "benchmarks", "results", "test262-report.json"));
if (test262ResultsSource) {
  copyFile(test262ResultsSource, join(PAGES_DIST, "benchmarks", "results", "test262-results.jsonl"));
}
if (test262RunsIndexSource) {
  copyFile(test262RunsIndexSource, join(PAGES_DIST, "benchmarks", "results", "runs", "index.json"));
}

const equivTests = buildEquivTests();
writeJson(join(PLAYGROUND_DATA_DIR, "equiv-tests.json"), equivTests);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "equiv-tests.json"), equivTests);

const test262Data = test262ResultsSource
  ? buildStaticTest262Data(test262ResultsSource)
  : buildStaticTest262DataFromReport(test262ReportSource);
writeJson(join(PLAYGROUND_DATA_DIR, "test262-index-summary.json"), test262Data.categories);
writeJson(join(PLAYGROUND_DATA_DIR, "test262-files.json"), test262Data.filesJson);
writeJson(join(PLAYGROUND_DATA_DIR, "test262-file-results.json"), test262Data.resultsJson);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "test262-index-summary.json"), test262Data.categories);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "test262-files.json"), test262Data.filesJson);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "test262-file-results.json"), test262Data.resultsJson);

// Landing page (top-level) and playground both reference these JSONs.
// The canonical source lives in benchmarks/results/ (committed); fall back to
// public/benchmarks/results/ for any files curated there.
const TOP_BENCH_RESULTS = join(PAGES_DIST, "benchmarks", "results");
for (const fileName of ["playground-benchmark-sidebar.json", "loadtime-benchmarks.json", "size-benchmarks.json"]) {
  const source = resolvePreferredFileOrNull(join(BENCHMARKS_RESULTS_DIR, fileName), join(PUBLIC_BENCH, fileName));
  if (source) {
    copyFile(source, join(TOP_BENCH_RESULTS, fileName));
    copyFile(source, join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, fileName));
  }
}
if (existsSync(join(PUBLIC_BENCH, "loadtime"))) {
  copyDirectory(join(PUBLIC_BENCH, "loadtime"), join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "loadtime"));
}
if (test262RunsIndexSource) {
  copyFile(test262RunsIndexSource, join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "runs", "index.json"));
}
copyFileIfExists(
  join(PAGES_DIST, "benchmarks", "results", "test262-report.json"),
  join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "test262-report.json"),
);

// Iframe nav-sync glue (referenced from the landing page header at /).
copyFileIfExists(join(ROOT, "frame-nav-sync.js"), join(PAGES_DIST, "frame-nav-sync.js"));

// Disable Jekyll processing so all generated assets are published as-is.
writeFileSync(join(PAGES_DIST, ".nojekyll"), "");

// Emit CNAME so the GitHub Pages custom domain (js2.loopdive.com) survives
// every re-deploy. GitHub Pages reads this file from the deployed artifact
// and points the Pages site at the custom domain. Bare hostname only —
// no scheme, trailing newline. See plan/issues/sprints/46/1188.md.
writeFileSync(join(PAGES_DIST, "CNAME"), "js2.loopdive.com\n");

// Copy web components to pages-dist root and dashboard
const COMPONENTS_DIR = join(ROOT, "components");
for (const file of ["site-nav.js", "t262-charts.js", "trend-chart.js", "perf-benchmark-chart.js"]) {
  copyFileIfExists(join(COMPONENTS_DIR, file), join(PAGES_DIST, "components", file));
}

// Render ADR markdown → HTML pages so the landing page can link to
// on-origin /js2wasm/docs/adr/*.html instead of broken raw .md URLs.
await import("./build-adr-html.mjs");

// Copy sprint-stats.json to dashboard data when dashboard artifacts exist.
if (hasDashboardBundle) {
  copyFileIfExists(
    join(ROOT, "dashboard", "data", "sprint-stats.json"),
    join(PAGES_DIST, "dashboard", "data", "sprint-stats.json"),
  );
}

console.log(`GitHub Pages artifact ready at ${PAGES_DIST}`);
