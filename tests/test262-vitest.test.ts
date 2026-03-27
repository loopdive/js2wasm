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
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { join, relative, dirname, basename } from "path";
import { createServer, type Server } from "http";
import { buildImports } from "../src/runtime.js";
import { CompilerPool, type PoolResult } from "../scripts/compiler-pool.js";
import {
  findTestFiles,
  parseMeta,
  wrapTest,
  shouldSkip,
  lookupSourceMapOffset,
  classifyError,
  TEST_CATEGORIES,
} from "./test262-runner.js";


// ── Local HTTP server for wasm source map stack traces ───────────────
// V8 only resolves wasm source maps when loading from a URL (not in-memory buffer).
// We serve compiled .wasm + .wasm.map from test262-out/ so that error stacks include
// mapped source locations.

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..");
const WASM_OUT_DIR = join(PROJECT_ROOT, "test262-out");
mkdirSync(WASM_OUT_DIR, { recursive: true });

let wasmServer: Server;
let WASM_PORT = 0;

const serverReady = new Promise<void>((resolve) => {
  wasmServer = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? "/");
    const filePath = join(WASM_OUT_DIR, url);
    try {
      const data = readFileSync(filePath);
      const ct = url.endsWith(".wasm")
        ? "application/wasm"
        : url.endsWith(".map")
          ? "application/json"
          : "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  wasmServer.listen(0, "127.0.0.1", () => {
    const addr = wasmServer.address();
    WASM_PORT = typeof addr === "object" && addr ? addr.port : 0;
    resolve();
  });
});

// ── Compiler pool (async worker threads) ─────────────────────────────

const POOL_SIZE = parseInt(process.env.TEST262_WORKERS ?? "8", 10);
const pool = new CompilerPool(POOL_SIZE);
// Pool workers load compiler-bundle.mjs — already has skipSemanticDiagnostics

// ── Ensure compiler bundle is up to date ─────────────────────────────
// Always rebuild before running tests — prevents stale bundle regardless
// of how vitest is invoked (script, direct, agent, etc.)
import { execSync } from "child_process";
try {
  const root = join(import.meta.dirname ?? ".", "..");
  execSync(
    "npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=scripts/compiler-bundle.mjs --external:typescript",
    { cwd: root, stdio: "pipe", timeout: 30000 },
  );
} catch {
  // Bundle build failed — tests will use whatever bundle exists
}

// ── Cache setup ──────────────────────────────────────────────────────

const CACHE_DIR = join(import.meta.dirname ?? ".", "..", ".test262-cache");
mkdirSync(CACHE_DIR, { recursive: true });

/**
 * Build a short hash of all compiler source files. When any codegen file
 * changes, the entire cache is effectively invalidated (new hashes).
 *
 * Hashes ALL .ts files in src/codegen/ (not a fixed list) plus the checker
 * and runtime — so new extracted files are automatically included.
 */
function buildCompilerHash(): string {
  const h = createHash("md5");
  const root = join(import.meta.dirname ?? ".", "..");

  // Hash the compiler bundle — this is what actually runs.
  // If the bundle is stale, the hash won't match and we recompile.
  const bundlePath = join(root, "scripts", "compiler-bundle.mjs");
  try {
    h.update(readFileSync(bundlePath));
  } catch {
    // No bundle — hash all source files as fallback
    h.update("no-bundle");
  }

  // Also hash the test runner (affects test wrapping/harness)
  try {
    h.update(readFileSync(join(import.meta.dirname ?? ".", "test262-runner.ts")));
  } catch {
    h.update("no-runner");
  }

  // And runtime.ts (affects host imports)
  try {
    h.update(readFileSync(join(root, "src", "runtime.ts")));
  } catch {
    h.update("no-runtime");
  }

  return h.digest("hex").slice(0, 12);
}

const compilerHash = buildCompilerHash();

// ── Cache-aware async compilation via pool ───────────────────────────

/**
 * Compile wrapped test source via worker pool, with disk cache.
 * Cache hit: <1ms (read from disk). Cache miss: async dispatch to pool worker.
 * Multiple tests can await compilation concurrently — pool dispatches to
 * free workers and queues the rest.
 */
async function getOrCompile(
  wrappedSource: string,
  fullDiagnostics = false,
  relPath?: string,
): Promise<{ ok: true; binary: Uint8Array; result: any } | { ok: false; error: string }> {
  // Compute the source map URL filename from relPath (e.g. "test/.../S11.js" -> "S11.wasm.map")
  const wasmRelPath = relPath ? relPath.replace(/\.js$/, ".wasm") : undefined;
  const sourceMapFilename = wasmRelPath ? basename(wasmRelPath) + ".map" : "test.wasm.map";

  const hash = createHash("md5")
    .update(wrappedSource)
    .update(compilerHash)
    .update(fullDiagnostics ? "diag" : "")
    .digest("hex");
  const cachePath = join(CACHE_DIR, `${hash}.wasm`);
  const metaPath = join(CACHE_DIR, `${hash}.json`);

  let binary: Uint8Array;
  let result: any;

  // Cache hit: read binary + metadata
  if (existsSync(cachePath) && existsSync(metaPath)) {
    try {
      const cachedBinary = readFileSync(cachePath);
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      binary = cachedBinary;
      result = meta;
    } catch {
      // Corrupted cache entry — fall through to recompile
      binary = undefined as any;
      result = undefined;
    }
  }

  if (!binary) {
    // Cache miss: async compile via pool worker with race timeout
    const poolResult = await Promise.race([
      pool.compile(wrappedSource, 10_000, fullDiagnostics, sourceMapFilename),
      new Promise<PoolResult>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: "compilation timeout (10s race)", compileMs: 10000 } as PoolResult), 10_000)
      ),
    ]);
    if (!poolResult.ok) {
      return { ok: false, error: poolResult.error };
    }
    binary = poolResult.binary;
    result = { stringPool: poolResult.stringPool, imports: poolResult.imports, sourceMap: poolResult.sourceMap };

    // Write to cache
    try {
      writeFileSync(cachePath, binary);
      writeFileSync(
        metaPath,
        JSON.stringify({
          stringPool: poolResult.stringPool,
          imports: poolResult.imports,
          sourceMap: poolResult.sourceMap,
        }),
      );
    } catch {
      // Cache write failure is non-fatal
    }
  }

  // Write .wasm and .wasm.map to test262-out/ for HTTP serving
  if (wasmRelPath) {
    try {
      const outWasm = join(WASM_OUT_DIR, wasmRelPath);
      mkdirSync(dirname(outWasm), { recursive: true });
      writeFileSync(outWasm, binary);
      if (result.sourceMap) {
        writeFileSync(outWasm + ".map", result.sourceMap);
      }
    } catch {
      // Non-fatal — falls back to in-memory instantiation
    }
  }

  return { ok: true, binary, result };
}

// ── Result tracking (JSONL output for report.html) ──────────────────

import { writeFileSync as writeSync, openSync, writeSync as fdWrite, closeSync, fsyncSync } from "fs";
import { afterAll } from "vitest";

const RESULTS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results");
mkdirSync(RESULTS_DIR, { recursive: true });
const JSONL_PATH = join(RESULTS_DIR, "test262-results.jsonl");
const REPORT_PATH = join(RESULTS_DIR, "test262-report.json");

// Open JSONL with a raw file descriptor for reliable writes from threads
writeSync(JSONL_PATH, "");
const jsonlFd = openSync(JSONL_PATH, "a");
let flushCount = 0;
const REPORT_FLUSH_INTERVAL = 500; // update report.json every 500 tests

const summary = { total: 0, pass: 0, fail: 0, compile_error: 0, skip: 0 };
const catCounts: Record<string, { pass: number; fail: number; compile_error: number; skip: number; total: number }> = {};

/**
 * Error category counts — tracks how many failures fall into each bucket.
 * See classifyError() in test262-runner.ts for category definitions.
 */
const errorCategoryCounts: Record<string, number> = {};

/** Thrown by recordResult for non-passing tests so vitest reports real failures */
class ConformanceError extends Error {
  constructor(status: string, detail?: string) {
    super(`[${status}] ${detail || "unknown"}`);
    this.name = "ConformanceError";
  }
}

function recordResult(file: string, category: string, status: string, error?: string) {
  const errorCategory = (status === "fail" || status === "compile_error") ? classifyError(error) : undefined;
  const entry = JSON.stringify({
    file,
    category,
    status,
    error: error || undefined,
    error_category: errorCategory,
  });
  fdWrite(jsonlFd, entry + "\n");
  summary.total++;
  (summary as any)[status]++;
  if (!catCounts[category]) catCounts[category] = { pass: 0, fail: 0, compile_error: 0, skip: 0, total: 0 };
  (catCounts[category] as any)[status]++;
  catCounts[category].total++;

  // Track error category counts
  if (errorCategory) {
    errorCategoryCounts[errorCategory] = (errorCategoryCounts[errorCategory] || 0) + 1;
  }

  // Periodically flush JSONL and update report.json for live viewing
  flushCount++;
  if (flushCount % 50 === 0) {
    try { fsyncSync(jsonlFd); } catch {}
  }
  if (flushCount % REPORT_FLUSH_INTERVAL === 0) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: { ...summary, compilable: summary.pass + summary.fail, stale: 0 },
      categories: Object.entries(catCounts)
        .map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      error_categories: { ...errorCategoryCounts },
    };
    try { writeSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch {}
  }

  // Fail the vitest test for non-passing results
  if (status !== "pass" && status !== "skip") {
    throw new ConformanceError(status, error);
  }
}

afterAll(() => {
  try { pool.shutdown(); } catch {}
  try { wasmServer?.close(); } catch {}
  try { closeSync(jsonlFd); } catch {}
  const report = {
    timestamp: new Date().toISOString(),
    summary: { ...summary, compilable: summary.pass + summary.fail, stale: 0 },
    categories: Object.entries(catCounts)
      .map(([name, c]) => ({ name, ...c }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    error_categories: { ...errorCategoryCounts },
  };
  writeSync(REPORT_PATH, JSON.stringify(report, null, 2));

  // Print error category breakdown
  const ecEntries = Object.entries(errorCategoryCounts).sort((a, b) => b[1] - a[1]);
  if (ecEntries.length > 0) {
    console.log(`\nError categories:`);
    for (const [cat, count] of ecEntries) {
      console.log(`  ${cat}: ${count}`);
    }
  }
  console.log(`\nTest262: ${summary.total} total — ${summary.pass} pass, ${summary.fail} fail, ${summary.compile_error} CE, ${summary.skip} skip`);

  // Append to historical index (runs/index.json) for trend tracking
  try {
    const RUNS_DIR = join(RESULTS_DIR, "runs");
    mkdirSync(RUNS_DIR, { recursive: true });
    const INDEX_PATH = join(RUNS_DIR, "index.json");

    // Get git hash
    let gitHash = "unknown";
    try {
      const { execSync } = require("child_process");
      gitHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    } catch {}

    // Read existing index
    let index: any[] = [];
    try {
      index = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
    } catch {}

    // Append new entry
    index.push({
      timestamp: report.timestamp,
      pass: summary.pass,
      fail: summary.fail,
      ce: summary.compile_error,
      skip: summary.skip,
      total: summary.total,
      gitHash,
    });

    writeSync(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
  } catch {
    // Non-fatal — index update failure should not break the test run
  }
});

// ── Assertion lookup (maps returned N to the Nth assert in the source) ──

/**
 * Adjust line numbers in error messages from wrapped-source coordinates
 * back to original test file coordinates.
 */
function adjustErrorLines(msg: string, offset: number): string {
  if (offset === 0) return msg;
  return msg.replace(/\bL(\d+)(:\d+)?/g, (_m, line, col) => {
    const adjusted = parseInt(line, 10) - offset;
    return `L${adjusted > 0 ? adjusted : 1}${col ?? ""}`;
  });
}

/**
 * Use source map to resolve a wasm error to a source line.
 * Extracts byte offset from V8 wasm stack trace, looks it up in the source map,
 * and appends the original source line.
 */
function resolveWasmErrorLine(
  err: any, sourceMap: string | null, source: string, bodyLineOffset: number,
): string {
  const msg = err.message ?? String(err);
  const stack = typeof err?.stack === "string" ? err.stack : "";

  // V8 source-mapped format: "at funcName (test.ts:LINE:COL)" or "at test.ts:LINE:COL"
  // When wasm is loaded via URL with a source map, V8 resolves locations automatically.
  // V8 source-mapped stacks may have multiple frames — find the first one in the test body
  const frameRegex = /at\s+(?:(\w+)\s+)?\(?(?:.*?\.ts):(\d+):(\d+)\)?/g;
  let bestMatch: { funcName: string; rawLine: number; adjLine: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = frameRegex.exec(stack)) !== null) {
    const funcName = match[1] ?? "";
    const rawLine = parseInt(match[2], 10);
    const adjLine = rawLine - bodyLineOffset;
    // Prefer the first frame that maps to the test body (adjLine > 0 and within source)
    if (adjLine > 0 && adjLine <= source.split("\n").length) {
      bestMatch = { funcName, rawLine, adjLine };
      break;
    }
    // Keep the first frame as fallback
    if (!bestMatch) bestMatch = { funcName, rawLine, adjLine };
  }
  if (bestMatch) {
    const lines = source.split("\n");
    if (bestMatch.adjLine > 0 && bestMatch.adjLine <= lines.length) {
      const ctx = lines[bestMatch.adjLine - 1]?.trim().substring(0, 80) || "(empty line)";
      return `${msg} [at L${bestMatch.adjLine}: ${ctx}]`;
    }
    // Line is in preamble — show function name if available
    const where = bestMatch.funcName ? `in ${bestMatch.funcName}()` : "in test wrapper";
    return `${msg} [${where}]`;
  }

  // Try to extract wasm byte offset from stack trace
  // V8 formats: "at func (wasm://wasm/hash:wasm-function[N]:0xOFFSET)"
  //             "at wasm://wasm/hash:wasm-function[N]:0xOFFSET"
  const offsetMatch = stack.match(/:0x([0-9a-fA-F]+)/) ?? msg.match(/@\+(\d+)/);

  // Also extract function name from wasm stack
  const funcMatch = stack.match(/at (\w+) \(wasm:\/\//);
  const funcName = funcMatch?.[1];

  // Try source map lookup
  if (sourceMap && offsetMatch) {
    try {
      const byteOffset = parseInt(offsetMatch[1], 16);
      const mapped = lookupSourceMapOffset(sourceMap, byteOffset);
      if (mapped && mapped.line > 0) {
        const adjLine = mapped.line - bodyLineOffset;
        const srcLine = adjLine > 0 ? adjLine : mapped.line;
        const lines = source.split("\n");
        const ctx = lines[srcLine - 1]?.trim().substring(0, 80) || "(empty line)";
        return `${msg} [at L${srcLine}: ${ctx}]`;
      }
    } catch {}
  }

  // Fallback: try to find function name in source
  if (funcName && funcName !== "test") {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`function ${funcName}`) || lines[i].includes(`${funcName}(`)) {
        return `${msg} [in ${funcName}() at L${i + 1}]`;
      }
    }
    return `${msg} [in ${funcName}()]`;
  }

  return msg;
}

function findNthAssert(source: string, retVal: number): string {
  // __assert_count starts at 1 and increments before check, so returned N
  // means the (N-1)th assertion failed. -1 means a catch block fired.
  if (retVal === -1) return "exception caught in test body";
  const idx = retVal - 1; // 0-based assertion index (returned 2 → 1st assert)
  if (idx < 1) return `early return (${retVal})`;

  // Find all assert-like calls in the original source
  // Match multi-line assert calls by finding the opening and counting parens
  const lines = source.split("\n");
  const assertStarts: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\bassert\b/.test(lines[i])) {
      // Collect up to 3 lines for multi-line asserts
      const text = lines.slice(i, Math.min(i + 3, lines.length)).join(" ").trim();
      assertStarts.push({ line: i + 1, text: text.substring(0, 120) });
    }
  }

  const target = idx - 1; // convert to 0-based index into assertStarts
  if (target >= 0 && target < assertStarts.length) {
    const a = assertStarts[target];
    return `assert #${idx} at L${a.line}: ${a.text}`;
  }
  return `assert #${idx} (found ${assertStarts.length} asserts in source)`;
}

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

        // Wait for HTTP server to be ready
        await serverReady;

        // Handle negative parse/early tests: compilation should fail
        // Use skipSemanticDiagnostics:false for negative tests so TS catches more errors
        if (
          meta.negative &&
          (meta.negative.phase === "parse" || meta.negative.phase === "early" || meta.negative.phase === "resolution")
        ) {
          const { source: wrapped, bodyLineOffset } = wrapTest(source, meta);
          const compileResult = await getOrCompile(wrapped, false, relPath);
          if (!compileResult.ok) { recordResult(relPath, category, "pass"); return; }
          try {
            const imports = buildImports(compileResult.result.imports, undefined, compileResult.result.stringPool);
            await WebAssembly.instantiate(compileResult.binary, imports as any);
          } catch {
            recordResult(relPath, category, "pass"); return;
          }
          const desc = meta.description?.substring(0, 100) ?? "";
          const info = `expected ${meta.negative!.phase} ${meta.negative!.type} but compiled${desc ? `: ${desc}` : ""}`;
          recordResult(relPath, category, "fail", info);
          return;
        }

        // Wrap and compile
        const { source: wrapped, bodyLineOffset } = wrapTest(source, meta);
        const compileResult = await getOrCompile(wrapped, false, relPath);

        if (!compileResult.ok) {
          recordResult(relPath, category, "compile_error", adjustErrorLines(compileResult.error, bodyLineOffset));
          return;
        }

        // Instantiate and run — all errors are conformance issues, not vitest failures
        try {
          const imports = buildImports(compileResult.result.imports, undefined, compileResult.result.stringPool);
          const importObj = imports as any;

          // Use instantiateStreaming from local HTTP server for source map support
          const wasmRelUrl = relPath.replace(/\.js$/, ".wasm");
          let instance: WebAssembly.Instance;
          try {
            const url = `http://127.0.0.1:${WASM_PORT}/${wasmRelUrl}`;
            const response = await fetch(url);
            const result = await WebAssembly.instantiateStreaming(response, importObj);
            instance = result.instance;
          } catch {
            // Fallback to in-memory instantiation if HTTP fetch fails
            const result = await WebAssembly.instantiate(compileResult.binary, importObj);
            instance = result.instance;
          }

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
            } else if (ret === -1) {
              // Exception caught by wrapper — analyze test to provide context
              const desc = meta.description?.substring(0, 100) ?? "";
              // Look for assert.throws pattern in source — tells us what error was expected
              const throwsMatch = source.match(/assert\.throws\s*\(\s*(\w+Error)/);
              const expectedErr = throwsMatch ? throwsMatch[1] : null;
              // Look for common patterns that cause exceptions
              const hasPropertyAccess = /\.\w+\s*[=;,)]/.test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""));
              const hasDelete = /\bdelete\b/.test(source);
              const hasEval = /\beval\s*\(/.test(source);
              let context = desc || "exception in test body";
              if (expectedErr) context = `expected ${expectedErr} — ${context}`;
              recordResult(relPath, category, "fail", `returned -1 — ${context}`);
            } else {
              const assertInfo = findNthAssert(source, ret);
              recordResult(relPath, category, "fail", `returned ${ret} — ${assertInfo}`);
            }
          } catch (execErr: any) {
            if (execErr instanceof ConformanceError) throw execErr;
            if (isRuntimeNegative) {
              recordResult(relPath, category, "pass");
            } else {
              // WebAssembly.Exception from our throw $tag — extract payload
              let errInfo: string;
              if (execErr instanceof WebAssembly.Exception) {
                // Our exception tag carries one externref payload
                // Try to get it via getArg if the tag is available
                let payload: any = null;
                try {
                  const tag = (instance.exports as any).__exn_tag ?? (instance.exports as any).__tag;
                  if (tag) payload = execErr.getArg(tag, 0);
                } catch {}
                if (payload instanceof Error) {
                  errInfo = resolveWasmErrorLine(payload, compileResult.result.sourceMap, source, bodyLineOffset);
                } else {
                  // Payload is null (from typeErrorThrowInstrs) — it's a TypeError on null access
                  const desc = meta.description?.substring(0, 100) ?? "";
                  errInfo = `TypeError (null/undefined access)${desc ? `: ${desc}` : ""}`;
                }
              } else if (execErr instanceof Error) {
                errInfo = resolveWasmErrorLine(execErr, compileResult.result.sourceMap, source, bodyLineOffset);
              } else {
                errInfo = String(execErr);
              }
              recordResult(relPath, category, "fail", errInfo);
            }
            return;
          }
        } catch (instantiateErr: any) {
          if (instantiateErr instanceof ConformanceError) throw instantiateErr;
          // Wasm validation errors — extract function name + byte offset
          const msg = instantiateErr.message ?? String(instantiateErr);
          const funcMatch = msg.match(/Compiling function #\d+:"(\w+)" failed/);
          const offsetMatch = msg.match(/@\+(\d+)/);
          let enriched = msg;

          if (funcMatch) {
            const fname = funcMatch[1];
            const lines = source.split("\n");
            let found = false;

            // Try exact function name match in source
            if (fname !== "test") {
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`function ${fname}`) || lines[i].includes(`${fname}(`)) {
                  const ctx = lines[i].trim().substring(0, 80);
                  enriched = `${msg} [in ${fname}() at L${i + 1}: ${ctx}]`;
                  found = true;
                  break;
                }
              }
            }

            // For compiler-generated names (__closure_N, __cb_N, __iife_N),
            // find the Nth arrow function / closure in source
            if (!found && /^__(?:closure|cb|iife|anon)_\d+$/.test(fname)) {
              const idx = parseInt(fname.split("_").pop()!, 10);
              let closureCount = 0;
              for (let i = 0; i < lines.length; i++) {
                if (/=>|function\s*\(/.test(lines[i])) {
                  if (closureCount === idx) {
                    const ctx = lines[i].trim().substring(0, 80);
                    enriched = `${msg} [closure #${idx} at L${i + 1}: ${ctx}]`;
                    found = true;
                    break;
                  }
                  closureCount++;
                }
              }
            }

            // Include wasm byte offset if available
            if (!found && offsetMatch) {
              enriched = `${msg} [in ${fname}() @+${offsetMatch[1]}]`;
            } else if (!found) {
              enriched = `${msg} [in ${fname}()]`;
            }
          }
          recordResult(relPath, category, "compile_error", enriched);
          return;
        }
      }, 90_000);
    }
  });
}
