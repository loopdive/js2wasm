/**
 * Standalone test262 runner — processes one category at a time,
 * writes per-test results as JSONL for incremental updates.
 *
 * Usage:
 *   npx tsx scripts/run-test262.ts              # run all categories
 *   npx tsx scripts/run-test262.ts Math Array    # run matching categories only
 *   npx tsx scripts/run-test262.ts --resume      # resume an interrupted run (same git HEAD only)
 *
 * Output:
 *   benchmarks/results/test262-results.jsonl  — one JSON line per test result
 *   benchmarks/results/test262-report.json    — summary with error frequency
 */
import { TEST_CATEGORIES, findTestFiles, runTest262File, type TestResult, type TestTiming } from "../tests/test262-runner.js";
import { join } from "path";
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

const RESULTS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results");
const JSONL_PATH = join(RESULTS_DIR, "test262-results.jsonl");
const REPORT_PATH = join(RESULTS_DIR, "test262-report.json");
const META_PATH = join(RESULTS_DIR, "test262-run.meta.json");

function getGitHead(): string {
  try { return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim(); }
  catch { return "unknown"; }
}

// Parse CLI args: separate --resume flag from category filters
const rawArgs = process.argv.slice(2);
const resumeFlag = rawArgs.includes("--resume");
const filterArgs = rawArgs.filter(a => a !== "--resume");
const categories = filterArgs.length > 0
  ? TEST_CATEGORIES.filter(cat => filterArgs.some(f => cat.toLowerCase().includes(f.toLowerCase())))
  : TEST_CATEGORIES;

// --resume: load completed tests from a previous interrupted run (same HEAD only)
const completedFiles = new Set<string>();
if (resumeFlag && existsSync(META_PATH) && existsSync(JSONL_PATH)) {
  const meta = JSON.parse(readFileSync(META_PATH, "utf-8"));
  const currentHead = getGitHead();
  if (meta.gitHead === currentHead && meta.status === "running") {
    // Same code, incomplete run — load already-completed test paths
    for (const line of readFileSync(JSONL_PATH, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.file) completedFiles.add(r.file); } catch {}
    }
    console.log(`Resuming interrupted run (${completedFiles.size} tests already done, HEAD=${currentHead.slice(0, 8)})\n`);
  } else if (meta.gitHead !== currentHead) {
    console.log(`Code changed since last run (${meta.gitHead?.slice(0, 8)} → ${currentHead.slice(0, 8)}), starting fresh.\n`);
  } else {
    console.log(`Previous run completed successfully, starting fresh.\n`);
  }
}

// Load existing results (if running a subset, preserve other results)
const existingResults = new Map<string, string>(); // file → jsonl line
if (filterArgs.length > 0 && !resumeFlag && existsSync(JSONL_PATH)) {
  for (const line of readFileSync(JSONL_PATH, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.file) existingResults.set(r.file, line);
    } catch {}
  }
}

const allResults: TestResult[] = [];
const stats = { pass: 0, fail: 0, skip: 0, compile_error: 0 };

// Count total
let total = 0;
for (const cat of categories) total += findTestFiles(cat).length;

// If running a subset, clear only those entries from existing results
if (filterArgs.length > 0 && !resumeFlag) {
  for (const cat of categories) {
    for (const f of findTestFiles(cat)) {
      const relPath = f.replace(/.*test262\/test\//, "");
      existingResults.delete(relPath);
    }
  }
}

// Start fresh JSONL unless resuming
if (resumeFlag && completedFiles.size > 0) {
  // Keep existing JSONL, we'll append new results
} else if (filterArgs.length === 0) {
  writeFileSync(JSONL_PATH, "");
} else {
  // Rewrite JSONL with existing results (minus categories being re-run)
  const lines = [...existingResults.values()];
  writeFileSync(JSONL_PATH, lines.length > 0 ? lines.join("\n") + "\n" : "");
}

// Write run metadata (status=running until we finish)
writeFileSync(META_PATH, JSON.stringify({ gitHead: getGitHead(), status: "running", startedAt: new Date().toISOString() }));

console.log(`Running ${total} tests across ${categories.length} categories...\n`);

// Group categories into batches for display
function batchKey(cat: string): string {
  const parts = cat.split("/");
  if (parts[0] === "built-ins" && parts[1] === "Math") return "Math";
  if (parts[0] === "built-ins" && ["Number", "Boolean", "isNaN", "isFinite", "parseInt", "parseFloat"].includes(parts[1]!)) return parts[1]!;
  if (parts[0] === "built-ins") {
    const last = parts[parts.length - 1] ?? "";
    return `${parts[1]}/${last}`;
  }
  if (parts[0] === "language") {
    const last = parts[parts.length - 1] ?? "";
    const group = parts[1] === "expressions" ? "expr" : parts[1] === "statements" ? "stmt" : parts[1] ?? "";
    return `${group}/${last}`;
  }
  return cat;
}

const batches = new Map<string, string[]>();
for (const cat of categories) {
  const key = batchKey(cat);
  if (!batches.has(key)) batches.set(key, []);
  batches.get(key)!.push(cat);
}

let processed = 0;

for (const [batchName, batchCats] of batches) {
  const batchStart = Date.now();
  const batchStats = { pass: 0, fail: 0, skip: 0, compile_error: 0 };
  let buffer: string[] = [];

  for (const category of batchCats) {
    const files = findTestFiles(category);
    if (files.length === 0) continue;

    for (const filePath of files) {
      const relPath = filePath.replace(/.*test262\/test\//, "");
      if (completedFiles.has(relPath)) {
        processed++;
        continue;
      }
      const result = await runTest262File(filePath, category);
      allResults.push(result);
      stats[result.status]++;
      batchStats[result.status]++;
      processed++;

      buffer.push(JSON.stringify({
        file: result.file,
        category: result.category,
        status: result.status,
        ...(result.error ? { error: result.error.substring(0, 300) } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.timing ? { timing: result.timing } : {}),
      }));

      // Flush every 100 tests to balance I/O and progress tracking
      if (buffer.length >= 100) {
        appendFileSync(JSONL_PATH, buffer.join("\n") + "\n");
        buffer = [];
      }
    }
  }
  // Flush remaining
  if (buffer.length > 0) {
    appendFileSync(JSONL_PATH, buffer.join("\n") + "\n");
    buffer = [];
  }

  const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
  const pct = ((processed / total) * 100).toFixed(0);
  console.log(
    `  [${pct.padStart(3)}%] ${batchName.padEnd(20)} ` +
    `pass:${String(batchStats.pass).padStart(3)}  fail:${String(batchStats.fail).padStart(2)}  ` +
    `err:${String(batchStats.compile_error).padStart(3)}  skip:${String(batchStats.skip).padStart(4)}  (${elapsed}s)`
  );
}

// Build compile error frequency map
const errorFreq = new Map<string, { count: number; files: string[] }>();
for (const r of allResults) {
  if (r.status === "compile_error" && r.error) {
    const msgs = r.error.split("; ");
    for (const msg of msgs) {
      const normalized = normalizeError(msg);
      const entry = errorFreq.get(normalized) ?? { count: 0, files: [] };
      entry.count++;
      if (entry.files.length < 5) entry.files.push(r.file);
      errorFreq.set(normalized, entry);
    }
  }
}
const errorFreqSorted = [...errorFreq.entries()].sort((a, b) => b[1].count - a[1].count);

function normalizeError(msg: string): string {
  return msg
    .replace(/'\w+'/g, "'X'")
    .replace(/type '\w+'/g, "type 'X'")
    .replace(/struct type: __anon_\d+/g, "struct type: __anon_N")
    .replace(/Cannot compile expression: \d+/g, "Cannot compile expression: N");
}

// Aggregate timing data
const timedResults = allResults.filter(r => r.timing);
const totalCompileMs = timedResults.reduce((s, r) => s + (r.timing?.compileMs ?? 0), 0);
const totalInstantiateMs = timedResults.reduce((s, r) => s + (r.timing?.instantiateMs ?? 0), 0);
const totalExecuteMs = timedResults.reduce((s, r) => s + (r.timing?.executeMs ?? 0), 0);
const totalWallMs = timedResults.reduce((s, r) => s + (r.timing?.totalMs ?? 0), 0);

// Top 20 slowest tests by compile time
const slowestByCompile = [...timedResults]
  .sort((a, b) => (b.timing?.compileMs ?? 0) - (a.timing?.compileMs ?? 0))
  .slice(0, 20);

// Top 20 slowest tests by total time
const slowestByTotal = [...timedResults]
  .sort((a, b) => (b.timing?.totalMs ?? 0) - (a.timing?.totalMs ?? 0))
  .slice(0, 20);

// Per-category average compile time
const categoryTiming = new Map<string, { count: number; compileMs: number; totalMs: number }>();
for (const r of timedResults) {
  const entry = categoryTiming.get(r.category) ?? { count: 0, compileMs: 0, totalMs: 0 };
  entry.count++;
  entry.compileMs += r.timing!.compileMs;
  entry.totalMs += r.timing!.totalMs;
  categoryTiming.set(r.category, entry);
}
const categoryTimingSorted = [...categoryTiming.entries()]
  .map(([cat, t]) => ({ category: cat, ...t, avgCompileMs: t.compileMs / t.count, avgTotalMs: t.totalMs / t.count }))
  .sort((a, b) => b.avgCompileMs - a.avgCompileMs);

// Write JSON report
const compilable = stats.pass + stats.fail;
const byCategory = new Map<string, { pass: number; fail: number; skip: number; compile_error: number }>();
for (const r of allResults) {
  if (!byCategory.has(r.category)) byCategory.set(r.category, { pass: 0, fail: 0, skip: 0, compile_error: 0 });
  byCategory.get(r.category)![r.status]++;
}

const reportData = {
  timestamp: new Date().toISOString(),
  summary: { total: allResults.length, ...stats, compilable },
  categories: [...byCategory.entries()].sort().map(([cat, s]) => ({
    name: cat, ...s, compilable: s.pass + s.fail,
  })),
  compileErrors: errorFreqSorted.map(([msg, { count, files }]) => ({ message: msg, count, examples: files })),
  timing: {
    totalWallMs: Math.round(totalWallMs),
    totalCompileMs: Math.round(totalCompileMs),
    totalInstantiateMs: Math.round(totalInstantiateMs),
    totalExecuteMs: Math.round(totalExecuteMs),
    timedTests: timedResults.length,
    avgCompileMs: timedResults.length > 0 ? Math.round(totalCompileMs / timedResults.length * 100) / 100 : 0,
    slowestByCompile: slowestByCompile.map(r => ({
      file: r.file, status: r.status, compileMs: r.timing!.compileMs, totalMs: r.timing!.totalMs,
    })),
    slowestByTotal: slowestByTotal.map(r => ({
      file: r.file, status: r.status,
      compileMs: r.timing!.compileMs, instantiateMs: r.timing!.instantiateMs,
      executeMs: r.timing!.executeMs, totalMs: r.timing!.totalMs,
    })),
    byCategory: categoryTimingSorted.slice(0, 30).map(c => ({
      category: c.category, count: c.count,
      avgCompileMs: Math.round(c.avgCompileMs * 100) / 100,
      totalCompileMs: Math.round(c.compileMs),
      avgTotalMs: Math.round(c.avgTotalMs * 100) / 100,
    })),
  },
};
try { writeFileSync(REPORT_PATH, JSON.stringify(reportData, null, 2)); } catch {}

// Console summary
console.log("\n══════════════════════════════════════════════════════");
console.log("           Test262 Conformance Report");
console.log("══════════════════════════════════════════════════════");
console.log(`  Total tests:     ${allResults.length}`);
console.log(`  Passed:          ${stats.pass}  (${compilable > 0 ? ((stats.pass / compilable * 100) | 0) : 0}% of compilable)`);
console.log(`  Failed:          ${stats.fail}`);
console.log(`  Compile errors:  ${stats.compile_error}`);
console.log(`  Skipped:         ${stats.skip}`);
console.log("──────────────────────────────────────────────────────");

if (errorFreqSorted.length > 0) {
  console.log("\n── Compile Error Frequency ─────────────────────────");
  for (const [msg, { count }] of errorFreqSorted) {
    console.log(`  ${String(count).padStart(4)}×  ${msg.substring(0, 100)}`);
  }
  console.log("────────────────────────────────────────────────────");
}

// Timing summary
if (timedResults.length > 0) {
  console.log("\n── Compilation Timing ──────────────────────────────");
  console.log(`  Tests with timing:  ${timedResults.length}`);
  console.log(`  Total compile:      ${(totalCompileMs / 1000).toFixed(1)}s`);
  console.log(`  Total instantiate:  ${(totalInstantiateMs / 1000).toFixed(1)}s`);
  console.log(`  Total execute:      ${(totalExecuteMs / 1000).toFixed(1)}s`);
  console.log(`  Total wall-clock:   ${(totalWallMs / 1000).toFixed(1)}s`);
  console.log(`  Avg compile/test:   ${(totalCompileMs / timedResults.length).toFixed(1)}ms`);
  console.log("");
  console.log("  Top 10 slowest to compile:");
  for (const r of slowestByCompile.slice(0, 10)) {
    console.log(`    ${r.timing!.compileMs.toFixed(0).padStart(6)}ms  ${r.file}`);
  }
  console.log("");
  console.log("  Slowest categories (avg compile ms):");
  for (const c of categoryTimingSorted.slice(0, 10)) {
    console.log(`    ${c.avgCompileMs.toFixed(1).padStart(8)}ms  ${c.category}  (${c.count} tests)`);
  }
  console.log("────────────────────────────────────────────────────");
}

const failures = allResults.filter(r => r.status === "fail");
if (failures.length > 0) {
  console.log(`\nFailing tests (${failures.length}):`);
  for (const f of failures) {
    console.log(`  ✗ ${f.file}: ${f.error}`);
  }
}

// Mark run as complete
writeFileSync(META_PATH, JSON.stringify({ gitHead: getGitHead(), status: "complete", finishedAt: new Date().toISOString() }));

console.log(`\nResults: ${JSONL_PATH}`);
console.log(`Report:  ${REPORT_PATH}`);
