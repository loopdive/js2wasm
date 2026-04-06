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
const PLAYGROUND_DIST = join(ROOT, "playground-dist");
const PAGES_DIST = join(ROOT, "pages-dist");
const DASHBOARD_DIR = join(ROOT, "dashboard");
const PLAN_DIR = join(ROOT, "plan");
const BENCHMARKS_RESULTS_DIR = join(ROOT, "benchmarks", "results");
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

function resolvePreferredFile(primarySource, fallbackSource) {
  if (existsSync(primarySource)) return primarySource;
  if (fallbackSource && existsSync(fallbackSource)) return fallbackSource;
  throw new Error(`Required path does not exist: ${primarySource}`);
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

ensureExists(PLAYGROUND_DIST);
ensureExists(join(DASHBOARD_DIR, "index.html"));
ensureExists(join(DASHBOARD_DIR, "data"));
ensureExists(join(DASHBOARD_DIR, "data.js"));
ensureExists(join(PLAN_DIR, "issues-graph.html"));
ensureExists(join(PLAN_DIR, "graph-data.json"));

rmSync(PAGES_DIST, { recursive: true, force: true });
mkdirSync(PAGES_DIST, { recursive: true });

// Start from the Vite multi-page build, which now includes the landing page
// at / and the playground at /playground/.
copyDirectory(PLAYGROUND_DIST, PAGES_DIST);
copyDirectory(PLAYGROUND_EXAMPLES_DIR, join(PAGES_DIST, "examples"));

// Add the static dashboard route and pre-generated dashboard data.
copyFile(join(DASHBOARD_DIR, "index.html"), join(PAGES_DIST, "progress", "index.html"));
copyDirectory(join(DASHBOARD_DIR, "data"), join(PAGES_DIST, "progress", "data"));
copyFile(join(DASHBOARD_DIR, "data.js"), join(PAGES_DIST, "progress", "data.js"));
copyFile(join(PLAN_DIR, "issues-graph.html"), join(PAGES_DIST, "issues-graph.html"));
copyFile(join(PLAN_DIR, "graph-data.json"), join(PAGES_DIST, "graph-data.json"));

// Add the benchmark data files fetched by the public report pages.
copyFileIfExists(
  join(BENCHMARKS_RESULTS_DIR, "history.json"),
  join(PAGES_DIST, "benchmarks", "results", "history.json"),
);
copyFileIfExists(join(BENCHMARKS_RESULTS_DIR, "latest.json"), join(PAGES_DIST, "benchmarks", "results", "latest.json"));
const test262ReportSource = resolvePreferredFile(
  join(BENCHMARKS_RESULTS_DIR, "test262-report.json"),
  latestMatchingFile(RUNS_DIR, "-report.json"),
);
const test262ResultsSource = resolvePreferredFile(
  join(BENCHMARKS_RESULTS_DIR, "test262-results.jsonl"),
  latestMatchingFile(RUNS_DIR, "-results.jsonl"),
);
copyFile(test262ReportSource, join(PAGES_DIST, "benchmarks", "results", "test262-report.json"));
copyFile(test262ResultsSource, join(PAGES_DIST, "benchmarks", "results", "test262-results.jsonl"));
copyFile(
  join(BENCHMARKS_RESULTS_DIR, "runs", "index.json"),
  join(PAGES_DIST, "benchmarks", "results", "runs", "index.json"),
);

const equivTests = buildEquivTests();
writeJson(join(PLAYGROUND_DATA_DIR, "equiv-tests.json"), equivTests);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "equiv-tests.json"), equivTests);

const test262Data = buildStaticTest262Data(test262ResultsSource);
writeJson(join(PLAYGROUND_DATA_DIR, "test262-index-summary.json"), test262Data.categories);
writeJson(join(PLAYGROUND_DATA_DIR, "test262-files.json"), test262Data.filesJson);
writeJson(join(PLAYGROUND_DATA_DIR, "test262-file-results.json"), test262Data.resultsJson);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "test262-index-summary.json"), test262Data.categories);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "test262-files.json"), test262Data.filesJson);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "test262-file-results.json"), test262Data.resultsJson);

copyFileIfExists(
  join(BENCHMARKS_RESULTS_DIR, "playground-benchmark-sidebar.json"),
  join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "playground-benchmark-sidebar.json"),
);
copyFileIfExists(
  join(BENCHMARKS_RESULTS_DIR, "runs", "index.json"),
  join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "runs", "index.json"),
);
copyFileIfExists(
  join(PAGES_DIST, "benchmarks", "results", "test262-report.json"),
  join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "test262-report.json"),
);
copyFileIfExists(
  join(BENCHMARKS_RESULTS_DIR, "size-benchmarks.json"),
  join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "size-benchmarks.json"),
);

// Disable Jekyll processing so all generated assets are published as-is.
writeFileSync(join(PAGES_DIST, ".nojekyll"), "");

// Sync benchmark data to public/ for the landing page (Vite serves public/ as static)
const PUBLIC_BENCH = join(ROOT, "public", "benchmarks", "results");
mkdirSync(PUBLIC_BENCH, { recursive: true });
copyFileIfExists(join(BENCHMARKS_RESULTS_DIR, "test262-report.json"), join(PUBLIC_BENCH, "test262-report.json"));
copyFileIfExists(
  join(BENCHMARKS_RESULTS_DIR, "playground-benchmark-sidebar.json"),
  join(PUBLIC_BENCH, "playground-benchmark-sidebar.json"),
);
copyFileIfExists(join(BENCHMARKS_RESULTS_DIR, "test262-editions.json"), join(PUBLIC_BENCH, "test262-editions.json"));
copyFileIfExists(join(BENCHMARKS_RESULTS_DIR, "size-benchmarks.json"), join(PUBLIC_BENCH, "size-benchmarks.json"));

// Copy web components to pages-dist root and dashboard
const COMPONENTS_DIR = join(ROOT, "components");
for (const file of ["site-nav.js", "t262-charts.js", "trend-chart.js"]) {
  copyFileIfExists(join(COMPONENTS_DIR, file), join(PAGES_DIST, "components", file));
}

// Copy sprint-stats.json to dashboard data
copyFileIfExists(
  join(ROOT, "dashboard", "data", "sprint-stats.json"),
  join(PAGES_DIST, "progress", "data", "sprint-stats.json"),
);

console.log(`GitHub Pages artifact ready at ${PAGES_DIST}`);
