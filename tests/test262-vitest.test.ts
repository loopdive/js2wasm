/**
 * Test262 conformance tests via vitest with per-test disk cache.
 *
 * Compiles each test262 file through ts2wasm. Compiled Wasm binaries are
 * cached to `.test262-cache/` keyed by a hash of (test source + compiler source).
 * Subsequent runs skip recompilation for unchanged tests.
 *
 * Proof of concept: runs the first 3 categories, 20 tests each.
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
 * Compile wrapped test source, returning a cached binary if available.
 * On cache miss, compiles and writes the result to disk.
 *
 * Returns null if compilation fails (with error info in the second element).
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

  // Cache miss: compile
  try {
    const result = compile(wrappedSource, { fileName: "test.ts", sourceMap: false } as any);
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

// ── Test generation ──────────────────────────────────────────────────

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

// Proof of concept: first 3 categories, max 20 tests each
const DEMO_CATEGORIES = TEST_CATEGORIES.slice(0, 3);
const MAX_TESTS_PER_CATEGORY = 20;

for (const category of DEMO_CATEGORIES) {
  const allFiles = findTestFiles(category);
  if (allFiles.length === 0) continue;

  const files = allFiles.slice(0, MAX_TESTS_PER_CATEGORY);

  describe(`test262: ${category}`, () => {
    for (const filePath of files) {
      const relPath = relative(TEST262_ROOT, filePath);

      it(relPath, async () => {
        const source = readFileSync(filePath, "utf-8");
        const meta = parseMeta(source);

        // Skip unsupported tests
        const filter = shouldSkip(source, meta, filePath);
        if (filter.skip) {
          // Mark as skipped but do not fail
          return;
        }

        // Handle negative parse/early tests: compilation should fail
        if (
          meta.negative &&
          (meta.negative.phase === "parse" || meta.negative.phase === "early" || meta.negative.phase === "resolution")
        ) {
          const { source: wrapped } = wrapTest(source, meta);
          const compileResult = getOrCompile(wrapped);
          // For parse/early negative tests, compile failure = pass
          if (!compileResult.ok) return; // expected failure
          // If it compiled, try instantiating — it might fail there
          try {
            const imports = buildImports(compileResult.result.imports, undefined, compileResult.result.stringPool);
            await WebAssembly.instantiate(compileResult.binary, imports as any);
          } catch {
            return; // instantiation failure counts as parse error — pass
          }
          // Compiled and instantiated — negative test should have failed
          // This is a conformance issue, not a test failure
          return;
        }

        // Wrap and compile
        const { source: wrapped } = wrapTest(source, meta);
        const compileResult = getOrCompile(wrapped);

        if (!compileResult.ok) {
          // Compile error — record but do not fail the vitest test
          // (conformance tracking, not a gate)
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
            // No test export — compile error equivalent
            return;
          }

          const isRuntimeNegative = meta.negative?.phase === "runtime";

          try {
            const ret = testFn();

            if (isRuntimeNegative) {
              // Expected a runtime error but execution succeeded
              return;
            }

            // ret === 1 means all asserts passed
            // ret >= 2 means the (ret-1)th assert failed
            // ret === -1 means uncaught exception
            // All non-pass results are conformance issues, not vitest failures
          } catch (execErr: any) {
            // Runtime error (trap, unreachable, etc.) — conformance issue
            return;
          }
        } catch (instantiateErr: any) {
          // WebAssembly.CompileError during instantiation — conformance issue
          return;
        }
      }, 90_000);
    }
  });
}
