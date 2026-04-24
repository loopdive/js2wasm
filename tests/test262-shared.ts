/**
 * Shared infrastructure for test262 vitest chunks.
 *
 * Unified fork architecture: each it() sends source to a pool of fork
 * processes. Each fork compiles + executes the test in one process, then
 * sends back just the result. No binaries over IPC, no disk I/O in the
 * critical path. Forks self-manage memory (GC + compiler recreation).
 *
 * Vitest runs chunks sequentially; fork dies between chunks for full
 * memory reclaim of the vitest process itself.
 */
import { createHash } from "crypto";
import { closeSync, existsSync, mkdirSync, readFileSync, writeSync as fdWrite, fsyncSync, openSync } from "fs";
import { dirname, join, relative } from "path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { availableParallelism } from "os";
import { CompilerPool, type TestResult } from "../scripts/compiler-pool.js";
import {
  buildNegativeCompileSource,
  classifyError,
  classifyTestScope,
  findTestFiles,
  parseMeta,
  shouldSkip,
  TEST_CATEGORIES,
  type Test262Scope,
  wrapTest,
} from "./test262-runner.js";

// Prevent unhandled Promise rejections from crashing the vitest fork.
process.on("unhandledRejection", () => {});

// Lazy-load compileMulti and buildImports only when needed (FIXTURE tests)
let _compileMulti: typeof import("../src/index.js").compileMulti | null = null;
async function getCompileMulti() {
  if (!_compileMulti) {
    const mod = await import("../src/index.js");
    _compileMulti = mod.compileMulti;
  }
  return _compileMulti;
}

let _buildImports: typeof import("../src/runtime.js").buildImports | null = null;
async function getBuildImports() {
  if (!_buildImports) {
    const mod = await import("../src/runtime.js");
    _buildImports = mod.buildImports;
  }
  return _buildImports;
}

/**
 * Extract _FIXTURE.js file references from static import/export statements.
 */
function resolveFixtures(source: string, testFilePath: string): string[] {
  const fixtures: string[] = [];
  const dir = dirname(testFilePath);
  const importRe = /(?:import|export)\s+.*?from\s+['"]([^'"]*_FIXTURE\.js)['"]/g;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    const resolved = join(dir, m[1]!);
    if (existsSync(resolved)) fixtures.push(resolved);
  }
  return [...new Set(fixtures)];
}

// ── Cache setup (for disk cache side-effect) ───────────────────────

const CACHE_DIR = join(import.meta.dirname ?? ".", "..", ".test262-cache");
mkdirSync(CACHE_DIR, { recursive: true });

function buildCompilerHash(): string {
  const h = createHash("md5");
  const root = join(import.meta.dirname ?? ".", "..");
  try {
    h.update(readFileSync(join(root, "scripts", "compiler-bundle.mjs")));
  } catch {
    h.update("no-bundle");
  }
  try {
    h.update(readFileSync(join(import.meta.dirname ?? ".", "test262-runner.ts")));
  } catch {
    h.update("no-runner");
  }
  try {
    h.update(readFileSync(join(root, "src", "runtime.ts")));
  } catch {
    h.update("no-runtime");
  }
  return h.digest("hex").slice(0, 12);
}

const compilerHash = buildCompilerHash();

function getCachePaths(wrappedSource: string): { wasmPath: string; metaPath: string } {
  const hash = createHash("md5").update(wrappedSource).update(compilerHash).digest("hex");
  return {
    wasmPath: join(CACHE_DIR, `${hash}.wasm`),
    metaPath: join(CACHE_DIR, `${hash}.json`),
  };
}

// ── Pool setup ─────────────────────────────────────────────────────

const POOL_SIZE = parseInt(process.env.COMPILER_POOL_SIZE || String(Math.max(1, availableParallelism() - 1)), 10);

let pool: CompilerPool | null = null;

// ── Result tracking (JSONL output for report.html) ──────────────────

const RESULTS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results");
mkdirSync(RESULTS_DIR, { recursive: true });

// Timestamped filename — env var from run-test262-vitest.sh, or generate one
const RUN_TIMESTAMP =
  process.env.RUN_TIMESTAMP || new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+/, "").slice(0, 15);
const JSONL_PATH = join(RESULTS_DIR, `test262-results-${RUN_TIMESTAMP}.jsonl`);

// Open results JSONL — each chunk appends independently
const jsonlFd = openSync(JSONL_PATH, "a");
let flushCount = 0;

const summary = {
  total: 0,
  pass: 0,
  fail: 0,
  compile_error: 0,
  compile_timeout: 0,
  skip: 0,
};
type StatusCounts = {
  pass: number;
  fail: number;
  compile_error: number;
  compile_timeout: number;
  skip: number;
  total: number;
};

function createEmptyCounts(): StatusCounts {
  return {
    pass: 0,
    fail: 0,
    compile_error: 0,
    compile_timeout: 0,
    skip: 0,
    total: 0,
  };
}

const catCounts: Record<string, StatusCounts> = {};

const errorCategoryCounts: Record<string, number> = {};
const skipReasonCounts: Record<string, number> = {};

class ConformanceError extends Error {
  constructor(status: string, detail?: string) {
    super(`[${status}] ${detail || "unknown"}`);
    this.name = "ConformanceError";
  }
}

function recordResult(
  file: string,
  category: string,
  status: string,
  error?: string,
  timing?: { compileMs?: number; execMs?: number },
  scopeInfo?: { scope: Test262Scope; official: boolean; reason?: string; strict?: "only" | "no" | "both" },
) {
  const errorCategory = status === "fail" || status === "compile_error" ? classifyError(error) : undefined;

  const entry = JSON.stringify({
    timestamp: new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
    file,
    category,
    status,
    error: error || undefined,
    error_category: errorCategory,
    compile_ms: timing?.compileMs !== undefined ? Math.round(timing.compileMs) : undefined,
    exec_ms: timing?.execMs !== undefined ? Math.round(timing.execMs) : undefined,
    scope: scopeInfo?.scope ?? "standard",
    scope_official: scopeInfo?.official ?? true,
    scope_reason: scopeInfo?.reason,
    strict: scopeInfo?.strict ?? "both",
  });
  fdWrite(jsonlFd, entry + "\n");
  summary.total++;
  (summary as any)[status]++;
  if (!catCounts[category]) catCounts[category] = createEmptyCounts();
  (catCounts[category] as any)[status]++;
  catCounts[category].total++;

  if (errorCategory) {
    errorCategoryCounts[errorCategory] = (errorCategoryCounts[errorCategory] || 0) + 1;
  }
  if (status === "skip" && error) {
    skipReasonCounts[error] = (skipReasonCounts[error] || 0) + 1;
  }

  flushCount++;
  if (flushCount % 50 === 0) {
    try {
      fsyncSync(jsonlFd);
    } catch {}
  }

  if (status !== "pass") {
    throw new ConformanceError(status, error || status);
  }
}

// ── Assertion lookup ────────────────────────────────────────────────

function adjustErrorLines(msg: string, offset: number): string {
  if (offset === 0) return msg;
  return msg.replace(/\bL(\d+)(:\d+)?/g, (_m, line, col) => {
    const adjusted = parseInt(line, 10) - offset;
    return `L${adjusted > 0 ? adjusted : 1}${col ?? ""}`;
  });
}

function findNthAssert(source: string, retVal: number): string {
  if (retVal === -1) return "exception caught in test body";
  const idx = retVal - 1;
  if (idx < 1) return `early return (${retVal})`;

  const lines = source.split("\n");
  const assertStarts: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(assert\b|assert\.\w+|\$DONOTEVALUATE|verify\w+)/.test(lines[i])) {
      const text = lines
        .slice(i, Math.min(i + 3, lines.length))
        .join(" ")
        .trim();
      assertStarts.push({ line: i + 1, text: text.substring(0, 120) });
    }
  }

  const target = idx - 1;
  if (target >= 0 && target < assertStarts.length) {
    const a = assertStarts[target];
    return `assert #${idx} at L${a.line}: ${a.text}`;
  }
  return `assert #${idx} (found ${assertStarts.length} asserts in source)`;
}

// ── Test generation ─────────────────────────────────────────────────

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

/**
 * Register vitest describe/it blocks for this chunk's share of tests.
 *
 * Each it() sends source to a unified fork pool that compiles + executes
 * the test in one process. No separate Phase 1 needed.
 */
export function runTest262Chunk(chunkIndex: number, totalChunks: number) {
  // Build full test list, filtering out proposals unless explicitly included.
  // This avoids registering ~5,200 proposal tests that would be skipped anyway,
  // saving ~10% of run time and keeping the statusline total accurate.
  const includeProposals = process.env.TEST262_INCLUDE_PROPOSALS === "1";
  const allTests: { category: string; filePath: string }[] = [];
  for (const category of TEST_CATEGORIES) {
    for (const filePath of findTestFiles(category)) {
      // Skip staging/ and proposal-tagged tests at the file level
      const relPath = filePath.replace(/.*test262\//, "");
      if (!includeProposals && (relPath.startsWith("test/staging/") || relPath.startsWith("staging/"))) continue;
      allTests.push({ category, filePath });
    }
  }

  const myTests = allTests.filter((_, i) => i % totalChunks === chunkIndex);
  const byCategory = new Map<string, string[]>();
  for (const { category, filePath } of myTests) {
    let arr = byCategory.get(category);
    if (!arr) {
      arr = [];
      byCategory.set(category, arr);
    }
    arr.push(filePath);
  }

  beforeAll(() => {
    pool = new CompilerPool(POOL_SIZE, "unified");
    console.log(`Chunk ${chunkIndex + 1}/${totalChunks}: ${myTests.length} tests, ${POOL_SIZE} unified fork workers`);
  }, 30_000);

  afterAll(() => {
    try {
      pool?.shutdown();
      pool = null;
    } catch {}
    try {
      closeSync(jsonlFd);
    } catch {}

    const ecEntries = Object.entries(errorCategoryCounts).sort((a, b) => b[1] - a[1]);
    if (ecEntries.length > 0) {
      console.log(`\nError categories:`);
      for (const [cat, count] of ecEntries) {
        console.log(`  ${cat}: ${count}`);
      }
    }

    const skipEntries = Object.entries(skipReasonCounts).sort((a, b) => b[1] - a[1]);
    if (skipEntries.length > 0) {
      console.log(`\nUnsupported features (skipped):`);
      for (const [reason, count] of skipEntries) {
        console.log(`  ${reason}: ${count}`);
      }
    }

    console.log(
      `\nTest262 chunk ${chunkIndex + 1}/${totalChunks}: ${summary.total} total — ${summary.pass} pass, ${summary.fail} fail, ${summary.compile_error} CE, ${summary.skip} skip`,
    );
  });

  for (const [category, files] of byCategory) {
    // describe.concurrent lets vitest run it() blocks within this describe up
    // to `maxConcurrency` at a time (set in vitest.config.ts). Without it,
    // vitest runs tests sequentially within a describe, starving the
    // CompilerPool of work and stretching runs from ~15 min to 150+ min.
    describe.concurrent(`test262: ${category}`, () => {
      for (const filePath of files) {
        const relPath = relative(TEST262_ROOT, filePath);

        it(
          relPath,
          async () => {
            const source = readFileSync(filePath, "utf-8");
            const meta = parseMeta(source);
            const scopeInfo = classifyTestScope(source, meta, filePath);

            // Don't record proposal tests at all — they inflate JSONL without adding value
            if (!includeProposals && scopeInfo.scope === "proposal") return;

            const filter = shouldSkip(source, meta, filePath);
            if (filter.skip) {
              recordResult(relPath, category, "skip", filter.reason, undefined, scopeInfo);
              return;
            }

            const { source: wrapped, bodyLineOffset: wrapOffset } = wrapTest(source, meta);
            const isNegative =
              meta.negative &&
              (meta.negative.phase === "parse" ||
                meta.negative.phase === "early" ||
                meta.negative.phase === "resolution");
            const isRuntimeNegative = meta.negative?.phase === "runtime";
            const compileSource = isNegative ? buildNegativeCompileSource(source, meta, category) : wrapped;
            const lineAdjustOffset = isNegative ? 0 : wrapOffset;

            // Multi-file compilation for FIXTURE imports (handled in-process)
            const fixtures = resolveFixtures(source, filePath);
            if (fixtures.length > 0) {
              // Fixture tests are rare — compile in-process
              try {
                const vfiles: Record<string, string> = { "./test.ts": compileSource };
                for (const fixPath of fixtures) {
                  vfiles["./" + relative(dirname(filePath), fixPath)] = readFileSync(fixPath, "utf-8");
                }
                const multiCompile = await getCompileMulti();
                const result = multiCompile(vfiles, "./test.ts", {
                  skipSemanticDiagnostics: true,
                });
                if (!result.success || result.binary.length === 0) {
                  if (isNegative) {
                    recordResult(relPath, category, "pass", undefined, undefined, scopeInfo);
                  } else {
                    const errMsg = result.errors.map((e: any) => `L${e.line}:${e.column} ${e.message}`).join("; ");
                    recordResult(relPath, category, "compile_error", errMsg, undefined, scopeInfo);
                  }
                  return;
                }
                // Execute the compiled binary in-process (fixture tests are rare,
                // in-process execution is acceptable for 172 tests).
                const buildImports = await getBuildImports();
                try {
                  const importObj = buildImports(result.imports, undefined, result.stringPool);
                  const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
                  if (typeof (importObj as any).setExports === "function") {
                    (importObj as any).setExports(instance.exports);
                  }
                  const testFn = (instance.exports as any).test;
                  if (typeof testFn !== "function") {
                    recordResult(relPath, category, "compile_error", "no test export", undefined, scopeInfo);
                    return;
                  }
                  const ret = testFn();
                  if (isRuntimeNegative) {
                    // Execution completed without error — expected runtime throw didn't happen
                    recordResult(
                      relPath,
                      category,
                      "fail",
                      `expected runtime ${meta.negative!.type} but execution succeeded`,
                      undefined,
                      scopeInfo,
                    );
                  } else if (ret === 1 || ret === 1.0) {
                    recordResult(relPath, category, "pass", undefined, undefined, scopeInfo);
                  } else {
                    recordResult(relPath, category, "fail", `returned ${ret}`, undefined, scopeInfo);
                  }
                } catch (execErr: any) {
                  if (isRuntimeNegative) {
                    recordResult(relPath, category, "pass", undefined, undefined, scopeInfo);
                  } else {
                    recordResult(relPath, category, "fail", String(execErr), undefined, scopeInfo);
                  }
                }
              } catch (e: any) {
                recordResult(relPath, category, "compile_error", e.message ?? String(e), undefined, scopeInfo);
              }
              return;
            }

            // ── Normal path: unified compile+execute in fork ────────
            // Cache disabled — stale cache entries caused false baselines.
            // Every test is compiled and executed fresh each run.
            const wasmPath = "";
            const metaPath = "";
            const r = await pool!.runTest(
              compileSource,
              {
                isNegative: isNegative || false,
                isRuntimeNegative: isRuntimeNegative || false,
                expectedErrorType: meta.negative?.type,
                wasmPath,
                metaPath,
                label: relPath,
              },
              30_000,
            );

            const timing = { compileMs: r.compileMs, execMs: r.execMs };

            // Map worker result to recordResult
            if (r.status === "pass") {
              recordResult(relPath, category, "pass", undefined, timing, scopeInfo);
              return;
            }

            if (r.status === "compile_error" || r.status === "compile_timeout") {
              const error = r.error ? adjustErrorLines(r.error, lineAdjustOffset) : r.status;
              recordResult(relPath, category, r.status, error, timing, scopeInfo);
              return;
            }

            if (r.status === "fail") {
              let error = r.error || "unknown failure";

              // Enrich error with source context
              if (r.isException) {
                const fnMatch = error.match(/\[in (\w+)\(\)\]/);
                if (fnMatch) {
                  const fname = fnMatch[1];
                  if (fname !== "test") {
                    const lines = source.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                      if (lines[i].includes(`function ${fname}`) || lines[i].includes(`${fname}(`)) {
                        const ctx = lines[i].trim().substring(0, 80);
                        error = error.replace(`[in ${fname}()]`, `[in ${fname}() at L${i + 1}: ${ctx}]`);
                        break;
                      }
                    }
                  }
                }
                const desc = meta.description?.substring(0, 100) ?? "";
                if (/TypeError \(null\/undefined/.test(error) && desc) {
                  error = `${error}: ${desc}`;
                }
              }

              if (r.runtimeNegativeNoThrow) {
                error = `expected runtime ${meta.negative!.type} but succeeded`;
              }

              if (r.ret !== undefined && r.ret !== 1 && !r.isException && !r.runtimeNegativeNoThrow) {
                if (r.ret === -1) {
                  const desc = meta.description?.substring(0, 100) ?? "";
                  const throwsMatch = source.match(/assert\.throws\s*\(\s*(\w+Error)/);
                  const expectedErr = throwsMatch ? throwsMatch[1] : null;
                  let context = desc || "exception in test body";
                  if (expectedErr) context = `expected ${expectedErr} — ${context}`;
                  error = `returned -1 — ${context}`;
                } else {
                  error = `returned ${r.ret} — ${findNthAssert(source, r.ret)}`;
                }
              }

              recordResult(relPath, category, "fail", error, timing, scopeInfo);
              return;
            }

            // Fallback
            recordResult(relPath, category, r.status || "fail", r.error || "unknown", timing, scopeInfo);
          },
          90_000,
        );
      }
    });
  }
}
