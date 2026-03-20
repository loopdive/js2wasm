/**
 * Test262 conformance tests via vitest with per-test disk cache.
 *
 * Compiles each test262 file through ts2wasm. Compiled Wasm binaries are
 * cached to `.test262-cache/` keyed by a hash of (test source + compiler source).
 * Subsequent runs skip recompilation for unchanged tests.
 *
 * Runs all test262 categories with per-test disk cache.
 *
 * Run: npx vitest run tests/test262-vitest.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { join, relative } from "path";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import {
  findTestFiles,
  parseMeta,
  wrapTest,
  shouldSkip,
  TEST_CATEGORIES,
} from "./test262-runner.js";

// ── Cache setup ──────────────────────────────────────────────────────

const CACHE_DIR = join(import.meta.dirname ?? ".", "..", ".test262-cache");
mkdirSync(CACHE_DIR, { recursive: true });

/**
 * Build a short hash of all compiler source files. When any codegen file
 * changes, the entire cache is effectively invalidated (new hashes).
 */
function buildCompilerHash(): string {
  const h = createHash("md5");
  const srcDir = join(import.meta.dirname ?? ".", "..", "src");
  const codegenDir = join(srcDir, "codegen");
  const files = [
    join(codegenDir, "expressions.ts"),
    join(codegenDir, "index.ts"),
    join(codegenDir, "statements.ts"),
    join(codegenDir, "type-coercion.ts"),
    join(codegenDir, "peephole.ts"),
    join(codegenDir, "structs.ts"),
    join(codegenDir, "functions.ts"),
    join(srcDir, "runtime.ts"),
  ];
  for (const f of files) {
    try {
      h.update(readFileSync(f));
    } catch {
      // File missing — hash will differ from any cached value
      h.update(f);
    }
  }
  return h.digest("hex").slice(0, 12);
}

const compilerHash = buildCompilerHash();

// ── Cache-aware compilation ──────────────────────────────────────────

interface CachedCompileResult {
  binary: Uint8Array;
  success: true;
  stringPool: string[];
  imports: any[];
}

/**
 * Compile wrapped test source via pool, with disk cache.
 * Cache hit: <1ms (read from disk). Cache miss: ~100ms (pool worker compiles).
 */
function getOrCompile(
  wrappedSource: string,
): { ok: true; binary: Uint8Array; result: any } | { ok: false; error: string } {
  const hash = createHash("md5")
    .update(wrappedSource)
    .update(compilerHash)
    .digest("hex");
  const cachePath = join(CACHE_DIR, `${hash}.wasm`);
  const metaPath = join(CACHE_DIR, `${hash}.json`);

  // Cache hit: read binary + metadata
  if (existsSync(cachePath) && existsSync(metaPath)) {
    try {
      const binary = readFileSync(cachePath);
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      return { ok: true, binary, result: meta };
    } catch {
      // Corrupted cache entry — fall through to recompile
    }
  }

  // Cache miss: compile with skipWat for speed
  try {
    const result = compile(wrappedSource, { fileName: "test.ts", sourceMap: false, emitWat: false } as any);
    if (!result.success || result.errors.some((e: any) => e.severity === "error")) {
      const errMsg = result.errors
        .filter((e: any) => e.severity === "error")
        .map((e: any) => `L${e.line}:${e.column} ${e.message}`)
        .join("; ");
      return { ok: false, error: errMsg || "unknown compile error" };
    }

    // Write to cache
    writeFileSync(cachePath, result.binary);
    writeFileSync(
      metaPath,
      JSON.stringify({
        stringPool: result.stringPool,
        imports: result.imports,
      }),
    );

    return { ok: true, binary: result.binary, result: { stringPool: result.stringPool, imports: result.imports } };
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

// ── Result tracking (JSONL output for report.html) ──────────────────

import { writeFileSync as writeSync, appendFileSync } from "fs";
import { afterAll } from "vitest";

const RESULTS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results");
mkdirSync(RESULTS_DIR, { recursive: true });
const JSONL_PATH = join(RESULTS_DIR, "test262-results.jsonl");
const REPORT_PATH = join(RESULTS_DIR, "test262-report.json");

// Clear JSONL at start
writeSync(JSONL_PATH, "");

const summary = { total: 0, pass: 0, fail: 0, compile_error: 0, skip: 0 };
const catCounts: Record<string, { pass: number; fail: number; compile_error: number; skip: number; total: number }> = {};

function recordResult(file: string, category: string, status: string, error?: string) {
  const entry = JSON.stringify({ file, category, status, error: error || undefined });
  appendFileSync(JSONL_PATH, entry + "\n");
  summary.total++;
  (summary as any)[status]++;
  if (!catCounts[category]) catCounts[category] = { pass: 0, fail: 0, compile_error: 0, skip: 0, total: 0 };
  (catCounts[category] as any)[status]++;
  catCounts[category].total++;
}

afterAll(() => {
  const report = {
    timestamp: new Date().toISOString(),
    summary: { ...summary, compilable: summary.pass + summary.fail, stale: 0 },
    categories: Object.entries(catCounts)
      .map(([name, c]) => ({ name, ...c }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nTest262: ${summary.total} total — ${summary.pass} pass, ${summary.fail} fail, ${summary.compile_error} CE, ${summary.skip} skip`);
});

// ── Test generation ──────────────────────────────────────────────────

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

// Run all categories — disk cache makes re-runs instant
for (const category of TEST_CATEGORIES) {
  const files = findTestFiles(category);
  if (files.length === 0) continue;

  describe(`test262: ${category}`, () => {
    for (const filePath of files) {
      const relPath = relative(TEST262_ROOT, filePath);

      it(relPath, async () => {
        const source = readFileSync(filePath, "utf-8");
        const meta = parseMeta(source);

        // Skip unsupported tests
        const filter = shouldSkip(source, meta, filePath);
        if (filter.skip) {
          recordResult(relPath, category, "skip", filter.reason);
          return;
        }

        // Handle negative parse/early tests: compilation should fail
        if (
          meta.negative &&
          (meta.negative.phase === "parse" || meta.negative.phase === "early" || meta.negative.phase === "resolution")
        ) {
          const { source: wrapped } = wrapTest(source, meta);
          const compileResult = getOrCompile(wrapped);
          if (!compileResult.ok) { recordResult(relPath, category, "pass"); return; }
          try {
            const imports = buildImports(compileResult.result.imports, undefined, compileResult.result.stringPool);
            await WebAssembly.instantiate(compileResult.binary, imports as any);
          } catch {
            recordResult(relPath, category, "pass"); return;
          }
          recordResult(relPath, category, "fail", `expected ${meta.negative!.phase} error but compiled`);
          return;
        }

        // Wrap and compile
        const { source: wrapped } = wrapTest(source, meta);
        const compileResult = getOrCompile(wrapped);

        if (!compileResult.ok) {
          recordResult(relPath, category, "compile_error", compileResult.error);
          return;
        }

        // Instantiate and run — all errors are conformance issues, not vitest failures
        try {
          const imports = buildImports(compileResult.result.imports, undefined, compileResult.result.stringPool);
          const importObj = imports as any;
          const { instance } = await WebAssembly.instantiate(compileResult.binary, importObj);

          // Wire up setExports for callback support
          if (typeof importObj.setExports === "function") {
            importObj.setExports(instance.exports);
          }

          const testFn = (instance.exports as any).test;
          if (typeof testFn !== "function") {
            recordResult(relPath, category, "compile_error", "no test export");
            return;
          }

          const isRuntimeNegative = meta.negative?.phase === "runtime";

          try {
            const ret = testFn();

            if (isRuntimeNegative) {
              recordResult(relPath, category, "fail", `expected runtime ${meta.negative!.type} but succeeded`);
              return;
            }

            if (ret === 1) {
              recordResult(relPath, category, "pass");
            } else {
              recordResult(relPath, category, "fail", `returned ${ret}`);
            }
          } catch (execErr: any) {
            if (isRuntimeNegative) {
              recordResult(relPath, category, "pass");
            } else {
              recordResult(relPath, category, "fail", execErr.message ?? String(execErr));
            }
            return;
          }
        } catch (instantiateErr: any) {
          recordResult(relPath, category, "compile_error", instantiateErr.message ?? String(instantiateErr));
          return;
        }
      }, 90_000);
    }
  });
}
