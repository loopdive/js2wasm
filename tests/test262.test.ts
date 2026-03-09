/**
 * Test262 conformance tests — runs a filtered subset of the official
 * ECMAScript test suite through the ts2wasm compiler.
 *
 * Tests are non-failing: we track pass/fail/skip/compile_error counts
 * as a conformance dashboard, not as a gate.
 */
import { describe, it, expect, afterAll } from "vitest";
import { TEST_CATEGORIES, findTestFiles, runTest262File, TestResult } from "./test262-runner.js";
import { relative, join } from "path";
import { writeFileSync } from "fs";

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

const allResults: TestResult[] = [];

for (const category of TEST_CATEGORIES) {
  const files = findTestFiles(category);
  if (files.length === 0) continue;

  describe(`test262: ${category}`, () => {
    for (const filePath of files) {
      const relPath = relative(TEST262_ROOT, filePath);

      it(relPath, async () => {
        const result = await runTest262File(filePath, category);
        allResults.push(result);
        // All tests pass in vitest — conformance is tracked via the report
      });
    }
  });
}

afterAll(() => {
  // Print conformance report
  const stats = { pass: 0, fail: 0, skip: 0, compile_error: 0 };
  const byCategory = new Map<string, { pass: number; fail: number; skip: number; compile_error: number }>();

  for (const r of allResults) {
    stats[r.status]++;
    if (!byCategory.has(r.category)) {
      byCategory.set(r.category, { pass: 0, fail: 0, skip: 0, compile_error: 0 });
    }
    byCategory.get(r.category)![r.status]++;
  }

  const total = allResults.length;
  const compilable = stats.pass + stats.fail;
  console.log("\n══════════════════════════════════════════════════════");
  console.log("           Test262 Conformance Report");
  console.log("══════════════════════════════════════════════════════");
  console.log(`  Total tests:     ${total}`);
  console.log(`  Passed:          ${stats.pass}  (${compilable > 0 ? ((stats.pass / compilable * 100) | 0) : 0}% of compilable)`);
  console.log(`  Failed:          ${stats.fail}`);
  console.log(`  Compile errors:  ${stats.compile_error}`);
  console.log(`  Skipped:         ${stats.skip}`);
  console.log("──────────────────────────────────────────────────────");

  for (const [cat, s] of [...byCategory.entries()].sort()) {
    const catCompilable = s.pass + s.fail;
    const pct = catCompilable > 0 ? ((s.pass / catCompilable * 100) | 0) : 0;
    const short = cat
      .replace("built-ins/Math/", "Math.")
      .replace("built-ins/", "")
      .replace("language/expressions/", "expr/")
      .replace("language/statements/", "stmt/")
      .replace("language/types/", "types/");
    console.log(`  ${short.padEnd(26)} ${String(s.pass).padStart(3)}/${String(catCompilable).padStart(3)} pass (${String(pct).padStart(3)}%)  skip:${String(s.skip).padStart(3)}  err:${String(s.compile_error).padStart(3)}`);
  }

  console.log("══════════════════════════════════════════════════════");

  // Write JSON report for the report page
  const reportData = {
    timestamp: new Date().toISOString(),
    summary: { total, ...stats, compilable },
    categories: [...byCategory.entries()].sort().map(([cat, s]) => ({
      name: cat,
      ...s,
      compilable: s.pass + s.fail,
    })),
  };
  const reportPath = join(import.meta.dirname ?? ".", "..", "benchmarks", "results", "test262-report.json");
  try { writeFileSync(reportPath, JSON.stringify(reportData, null, 2)); } catch {}

  // Print failures for debugging
  const failures = allResults.filter(r => r.status === "fail");
  if (failures.length > 0) {
    console.log(`\nFailing tests (${failures.length}):`);
    for (const f of failures) {
      console.log(`  ✗ ${f.file}: ${f.error}`);
    }
  }

  // Print all compile errors for debugging
  const compileErrors = allResults.filter(r => r.status === "compile_error");
  if (compileErrors.length > 0) {
    console.log(`\nCompile errors (${compileErrors.length}):`);
    for (const e of compileErrors) {
      console.log(`  ⚠ ${e.file}: ${e.error?.substring(0, 120)}`);
    }
  }
});
