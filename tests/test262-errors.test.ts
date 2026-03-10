/**
 * Compile-error harvester — runs ALL test262 categories (not just the tracked
 * subset) and reports the unique compiler error messages across every
 * compile_error result. Used to identify missing language features.
 */
import { describe, it, afterAll } from "vitest";
import { join } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import { runTest262File, findTestFiles } from "./test262-runner.js";

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

// Enumerate ALL top-level test categories
function allCategories(): string[] {
  const cats: string[] = [];
  const bases = ["language/expressions", "language/statements", "language/types",
    "language/computed-property-names", "language/destructuring",
    "language/default-parameters", "language/rest-parameters",
    "language/template-literals", "language/spread-operator",
    "built-ins/Math", "built-ins/Number", "built-ins/String/prototype",
    "built-ins/Array/prototype", "built-ins/Array",
    "built-ins/Object", "built-ins/JSON",
    "built-ins/Map/prototype", "built-ins/Set/prototype",
    "built-ins/Promise", "built-ins/isNaN", "built-ins/isFinite",
    "built-ins/parseInt", "built-ins/parseFloat",
    "built-ins/Boolean",
  ];
  for (const base of bases) {
    const dir = join(TEST262_ROOT, "test", base);
    if (!existsSync(dir)) continue;
    // If the dir itself has .js files, add it directly
    const entries = readdirSync(dir, { withFileTypes: true });
    const hasJs = entries.some(e => e.isFile() && e.name.endsWith(".js"));
    const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    if (hasJs || subdirs.length === 0) {
      cats.push(base);
    } else {
      for (const sub of subdirs) {
        cats.push(`${base}/${sub}`);
      }
    }
  }
  return cats;
}

const errorCounts = new Map<string, number>();
const errorExamples = new Map<string, string>();
let totalCompileErrors = 0;
let totalTests = 0;
let totalSkip = 0;

describe("test262 compile-error harvest", () => {
  const categories = allCategories();

  for (const cat of categories) {
    it(cat, async () => {
      const files = findTestFiles(cat);
      for (const file of files) {
        totalTests++;
        const result = await runTest262File(file, cat);
        if (result.status === "skip") { totalSkip++; continue; }
        if (result.status === "compile_error" && result.error) {
          totalCompileErrors++;
          // Normalize error: strip line numbers, file paths, quoted values
          const normalized = result.error
            .replace(/line \d+/g, "line N")
            .replace(/column \d+/g, "col N")
            .replace(/'[^']*'/g, "'X'")
            .replace(/"[^"]*"/g, '"X"')
            .replace(/\d+/g, "N");
          const count = (errorCounts.get(normalized) ?? 0) + 1;
          errorCounts.set(normalized, count);
          if (!errorExamples.has(normalized)) {
            errorExamples.set(normalized, `${result.file}: ${result.error}`);
          }
        }
      }
    }, 300_000);
  }

  afterAll(() => {
    console.log(`\n=== COMPILE ERROR SUMMARY ===`);
    console.log(`Total: ${totalTests} tests, ${totalSkip} skipped, ${totalCompileErrors} compile errors\n`);
    const sorted = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [msg, count] of sorted) {
      console.log(`[${count}x] ${msg}`);
      console.log(`  e.g. ${errorExamples.get(msg)}`);
    }
  });
});
