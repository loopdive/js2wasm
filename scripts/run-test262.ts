/**
 * Standalone test262 runner — processes one category at a time,
 * writes per-test results as JSONL for incremental updates.
 *
 * Usage:
 *   npx tsx scripts/run-test262.ts              # run all categories
 *   npx tsx scripts/run-test262.ts Math Array    # run matching categories only
 *
 * Output:
 *   benchmarks/results/test262-results.jsonl  — one JSON line per test result
 *   benchmarks/results/test262-report.json    — summary with error frequency
 */
import { TEST_CATEGORIES, findTestFiles, runTest262File, type TestResult } from "../tests/test262-runner.js";
import { join } from "path";
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";

const RESULTS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results");
const JSONL_PATH = join(RESULTS_DIR, "test262-results.jsonl");
const REPORT_PATH = join(RESULTS_DIR, "test262-report.json");

// Filter categories by CLI args if provided
const filterArgs = process.argv.slice(2);
const categories = filterArgs.length > 0
  ? TEST_CATEGORIES.filter(cat => filterArgs.some(f => cat.toLowerCase().includes(f.toLowerCase())))
  : TEST_CATEGORIES;

// Load existing results (if running a subset, preserve other results)
const existingResults = new Map<string, string>(); // file → jsonl line
if (filterArgs.length > 0 && existsSync(JSONL_PATH)) {
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
if (filterArgs.length > 0) {
  for (const cat of categories) {
    for (const f of findTestFiles(cat)) {
      const relPath = f.replace(/.*test262\/test\//, "");
      existingResults.delete(relPath);
    }
  }
}

// Start fresh JSONL if running all categories
if (filterArgs.length === 0) {
  writeFileSync(JSONL_PATH, "");
} else {
  // Rewrite JSONL with existing results (minus categories being re-run)
  const lines = [...existingResults.values()];
  writeFileSync(JSONL_PATH, lines.length > 0 ? lines.join("\n") + "\n" : "");
}

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

const failures = allResults.filter(r => r.status === "fail");
if (failures.length > 0) {
  console.log(`\nFailing tests (${failures.length}):`);
  for (const f of failures) {
    console.log(`  ✗ ${f.file}: ${f.error}`);
  }
}

console.log(`\nResults: ${JSONL_PATH}`);
console.log(`Report:  ${REPORT_PATH}`);
