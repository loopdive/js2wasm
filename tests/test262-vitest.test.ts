/**
 * Test262 conformance tests via vitest — Phase 2 (execution only).
 *
 * Reads pre-compiled .wasm + .json from `.test262-cache/` (written by
 * Phase 1: scripts/precompile-tests.ts). No compilation happens here.
 *
 * Run: pnpm run test:262  (runs both phases via run-test262-vitest.sh)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "fs";
import { Worker } from "worker_threads";

// Prevent unhandled Promise rejections from crashing the vitest fork.
process.on("unhandledRejection", () => {});
import { createHash } from "crypto";
import { join, relative, dirname, basename } from "path";
import { buildImports } from "../src/runtime.js";
// Lazy-load compileMulti only when needed (FIXTURE tests) to avoid
// loading the full compiler into the fork alongside the pool worker.
let _compileMulti: typeof import("../src/index.js").compileMulti | null = null;
async function getCompileMulti() {
  if (!_compileMulti) {
    const mod = await import("../src/index.js");
    _compileMulti = mod.compileMulti;
  }
  return _compileMulti;
}
import {
  classifyError,
  classifyTestScope,
  computeWasmSha,
  findTestFiles,
  parseMeta,
  wrapTest,
  shouldSkip,
  TEST_CATEGORIES,
  type Test262Scope,
} from "./test262-runner.js";

/**
 * Extract _FIXTURE.js file references from static import/export statements.
 * Returns resolved absolute paths of fixture files.
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

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..");

// ── Wasm execution pool (persistent worker for running compiled tests) ────
class WasmExecPool {
  private worker: Worker | null = null;
  private pending: Map<number, { resolve: (r: any) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
  private nextId = 0;
  private workerPath: string;
  private execCount = 0;
  private readonly MAX_EXECS = 500;

  constructor() {
    this.workerPath = join(import.meta.dirname ?? ".", "..", "scripts", "wasm-exec-worker.mjs");
    this.spawn();
  }

  private spawn() {
    this.worker = new Worker(this.workerPath, { execArgv: [] });
    this.worker.on("message", (msg: any) => {
      const job = this.pending.get(msg.id);
      if (job) {
        clearTimeout(job.timer);
        this.pending.delete(msg.id);
        job.resolve(msg);
      }
    });
    this.worker.on("error", (err: Error) => {
      for (const [id, job] of this.pending) {
        clearTimeout(job.timer);
        job.resolve({ ok: false, error: err.message, workerError: true });
      }
      this.pending.clear();
      this.spawn();
    });
    this.worker.on("exit", () => {
      for (const [id, job] of this.pending) {
        clearTimeout(job.timer);
        job.resolve({ ok: false, error: "worker exited", workerError: true });
      }
      this.pending.clear();
      this.spawn();
    });
  }

  run(
    binary: Uint8Array | undefined,
    imports: any[],
    stringPool: string[],
    isRuntimeNegative: boolean,
    timeoutMs: number,
    cachePath?: string,
  ): Promise<any> {
    this.execCount++;
    if (this.execCount >= this.MAX_EXECS) {
      this.execCount = 0;
      this.worker?.terminate();
      this.worker = null;
      this.spawn();
    }

    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "runtime timeout (10s)", timeout: true });
        this.worker?.terminate();
        this.worker = null;
        this.spawn();
      }, timeoutMs);

      this.pending.set(id, { resolve, timer });

      if (cachePath) {
        this.worker!.postMessage({ id, cachePath, imports, stringPool, isRuntimeNegative });
      } else {
        const binaryBuf = binary!.buffer.slice(binary!.byteOffset, binary!.byteOffset + binary!.byteLength);
        this.worker!.postMessage({ id, binary: new Uint8Array(binaryBuf), imports, stringPool, isRuntimeNegative }, [
          binaryBuf,
        ]);
      }
    });
  }

  shutdown() {
    this.worker?.terminate();
  }
}

const execPool = new WasmExecPool();

// ── Ensure compiler bundle is up to date ─────────────────────────
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

// Build runtime bundle for wasm-exec-worker
try {
  const root = join(import.meta.dirname ?? ".", "..");
  execSync(
    "npx esbuild src/runtime.ts --bundle --platform=node --format=esm --outfile=scripts/runtime-bundle.mjs --external:typescript",
    { cwd: root, stdio: "pipe", timeout: 30000 },
  );
} catch {
  // Runtime bundle build failed — worker will fail to load
}

// ── Cache setup ──────────────────────────────────────────────────

const CACHE_DIR = join(import.meta.dirname ?? ".", "..", ".test262-cache");

/**
 * Build a short hash of compiler source files (must match precompile-tests.ts).
 */
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

/**
 * Read pre-compiled test from disk cache. Returns cached metadata + cachePath,
 * or null if the cache entry doesn't exist (unexpected in two-phase mode).
 */
function readFromCache(
  wrappedSource: string,
):
  | { ok: true; result: any; cachePath: string }
  | { ok: false; error: string; errorCodes?: number[]; timeout?: boolean }
  | null {
  const hash = createHash("md5").update(wrappedSource).update(compilerHash).digest("hex");
  const wasmCachePath = join(CACHE_DIR, `${hash}.wasm`);
  const metaPath = join(CACHE_DIR, `${hash}.json`);

  if (!existsSync(wasmCachePath) || !existsSync(metaPath)) {
    return null; // Cache miss — not precompiled
  }

  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    if (meta.ok === false) {
      return { ok: false, error: meta.error, errorCodes: meta.errorCodes, timeout: meta.timeout };
    }
    return { ok: true, result: meta, cachePath: wasmCachePath };
  } catch {
    return null; // Corrupted cache entry
  }
}

// ── Result tracking (JSONL output for report.html) ──────────────

import { writeFileSync as writeSync, openSync, writeSync as fdWrite, closeSync, fsyncSync } from "fs";
import { afterAll } from "vitest";

const RESULTS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results");
mkdirSync(RESULTS_DIR, { recursive: true });
const JSONL_PATH = join(RESULTS_DIR, "test262-results.jsonl");
const REPORT_PATH = join(RESULTS_DIR, "test262-report.json");

const jsonlFd = openSync(JSONL_PATH, "a");
let flushCount = 0;
const REPORT_FLUSH_INTERVAL = 500;

const summary = { total: 0, pass: 0, fail: 0, compile_error: 0, compile_timeout: 0, skip: 0 };
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
const scopeCounts: Record<Test262Scope, StatusCounts> = {
  standard: createEmptyCounts(),
  annex_b: createEmptyCounts(),
  proposal: createEmptyCounts(),
};
const errorCategoryCounts: Record<string, number> = {};
const skipReasonCounts: Record<string, number> = {};

class ConformanceError extends Error {
  constructor(status: string, detail?: string) {
    super(`[${status}] ${detail || "unknown"}`);
    this.name = "ConformanceError";
  }
}

// Periodic GC to prevent fork OOM
const GC_INTERVAL = 200;

function buildSummary(counts: StatusCounts) {
  return {
    ...counts,
    compilable: counts.pass + counts.fail,
    stale: 0,
  };
}

function buildOfficialSummary() {
  const counts = createEmptyCounts();
  for (const scope of ["standard", "annex_b"] as const) {
    const scoped = scopeCounts[scope];
    counts.pass += scoped.pass;
    counts.fail += scoped.fail;
    counts.compile_error += scoped.compile_error;
    counts.compile_timeout += scoped.compile_timeout;
    counts.skip += scoped.skip;
    counts.total += scoped.total;
  }
  return buildSummary(counts);
}

function recordResult(
  file: string,
  category: string,
  status: string,
  error?: string,
  timing?: { compileMs?: number; execMs?: number },
  scopeInfo?: { scope: Test262Scope; official: boolean; reason?: string; strict?: "only" | "no" | "both" },
  wasmSha?: string | null,
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
    // #1222: 12-char sha256 hex of the compiled Wasm binary (or null when no
    // binary was produced — skip / compile_error / compile_timeout). The PR
    // regression-gate compares wasm_sha across base & branch; matching hashes
    // imply byte-identical Wasm and any pass→fail flip is CI noise.
    wasm_sha: wasmSha ?? null,
  });
  fdWrite(jsonlFd, entry + "\n");
  summary.total++;
  (summary as any)[status]++;
  if (!catCounts[category]) catCounts[category] = createEmptyCounts();
  (catCounts[category] as any)[status]++;
  catCounts[category].total++;
  const scopeKey = scopeInfo?.scope ?? "standard";
  (scopeCounts[scopeKey] as any)[status]++;
  scopeCounts[scopeKey].total++;

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
  if (flushCount % GC_INTERVAL === 0 && typeof globalThis.gc === "function") {
    globalThis.gc();
  }
  if (flushCount % REPORT_FLUSH_INTERVAL === 0) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: buildOfficialSummary(),
      official_summary: buildOfficialSummary(),
      full_summary: buildSummary(summary),
      scope_summaries: { ...scopeCounts },
      categories: Object.entries(catCounts)
        .map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      error_categories: { ...errorCategoryCounts },
      skip_reasons: { ...skipReasonCounts },
    };
    try {
      writeSync(REPORT_PATH, JSON.stringify(report, null, 2));
    } catch {}
  }

  if (status !== "pass") {
    throw new ConformanceError(status, error);
  }
}

afterAll(() => {
  try {
    execPool.shutdown();
  } catch {}
  try {
    closeSync(jsonlFd);
  } catch {}

  const report = {
    timestamp: new Date().toISOString(),
    summary: buildOfficialSummary(),
    official_summary: buildOfficialSummary(),
    full_summary: buildSummary(summary),
    scope_summaries: { ...scopeCounts },
    categories: Object.entries(catCounts)
      .map(([name, c]) => ({ name, ...c }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    error_categories: { ...errorCategoryCounts },
    skip_reasons: { ...skipReasonCounts },
  };
  writeSync(REPORT_PATH, JSON.stringify(report, null, 2));

  // Sync to public/ so Vite dev and build:pages have fresh data
  try {
    const publicReport = join(RESULTS_DIR, "..", "..", "public", "benchmarks", "results", "test262-report.json");
    mkdirSync(join(RESULTS_DIR, "..", "..", "public", "benchmarks", "results"), { recursive: true });
    copyFileSync(REPORT_PATH, publicReport);
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
    `\nTest262: ${summary.total} total — ${summary.pass} pass, ${summary.fail} fail, ${summary.compile_error} CE, ${summary.skip} skip`,
  );

  // Append to historical index (runs/index.json)
  try {
    const RUNS_DIR = join(RESULTS_DIR, "runs");
    mkdirSync(RUNS_DIR, { recursive: true });
    const INDEX_PATH = join(RUNS_DIR, "index.json");

    let gitHash = "unknown";
    try {
      gitHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
      const dirty = execSync("git status --porcelain -- src/", { encoding: "utf-8" }).trim();
      if (dirty) gitHash += "+dirty";
    } catch {}

    let index: any[] = [];
    try {
      index = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
    } catch {}

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
  } catch {}
});

// ── Assertion lookup ────────────────────────────────────────────

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
    if (/\b(assert|verify\w+)\b/.test(lines[i])) {
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

// ── Test generation ──────────────────────────────────────────────

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

// Phase 2: read pre-compiled cache entries and execute them.
// Cache was populated by Phase 1 (scripts/precompile-tests.ts).
for (const category of TEST_CATEGORIES) {
  const files = findTestFiles(category);
  if (files.length === 0) continue;

  describe(`test262: ${category}`, () => {
    for (const filePath of files) {
      const relPath = relative(TEST262_ROOT, filePath);

      it(
        relPath,
        async () => {
          const source = readFileSync(filePath, "utf-8");
          const meta = parseMeta(source);
          const scopeInfo = {
            ...classifyTestScope(source, meta, filePath),
            strict: meta.flags?.includes("onlyStrict")
              ? ("only" as const)
              : meta.flags?.includes("noStrict")
                ? ("no" as const)
                : ("both" as const),
          };

          // Handle skips
          const filter = shouldSkip(source, meta, filePath);
          if (filter.skip) {
            recordResult(relPath, category, "skip", filter.reason, undefined, scopeInfo);
            return;
          }

          // Wrap test (same as precompiler — must produce identical source for hash match)
          const { source: wrapped, bodyLineOffset: wrapOffset } = wrapTest(source, meta);
          const isNegative =
            meta.negative &&
            (meta.negative.phase === "parse" ||
              meta.negative.phase === "early" ||
              meta.negative.phase === "resolution");

          // Multi-file compilation for FIXTURE imports (can't be precompiled)
          const fixtures = resolveFixtures(source, filePath);
          let compileResult:
            | { ok: true; binary: Uint8Array; result: any; cachePath?: string }
            | { ok: false; error: string; errorCodes?: number[]; timeout?: boolean };

          // #1222: 12-char sha256 of the compiled Wasm binary, attached to every
          // post-compile recordResult call. Stays null for skip / cache-miss /
          // compile_error / compile_timeout, where no binary was produced.
          let wasmSha: string | null = null;

          if (fixtures.length > 0) {
            // FIXTURE tests: compile inline (rare, can't be precompiled)
            try {
              const vfiles: Record<string, string> = { "./test.ts": wrapped };
              for (const fixPath of fixtures) {
                vfiles["./" + relative(dirname(filePath), fixPath)] = readFileSync(fixPath, "utf-8");
              }
              const multiCompile = await getCompileMulti();
              const result = multiCompile(vfiles, "./test.ts", { skipSemanticDiagnostics: true });
              if (result.success && result.binary.length > 0) {
                compileResult = {
                  ok: true,
                  binary: result.binary,
                  result: { imports: result.imports, stringPool: result.stringPool, sourceMap: null },
                };
              } else {
                compileResult = {
                  ok: false,
                  error: result.errors.map((e: any) => `L${e.line}:${e.column} ${e.message}`).join("; "),
                };
              }
            } catch (e: any) {
              compileResult = { ok: false, error: e.message ?? String(e) };
            }
          } else {
            // Normal path: read from pre-compiled cache
            const cached = readFromCache(wrapped);
            if (cached === null) {
              // Cache miss — this shouldn't happen in two-phase mode, but handle gracefully
              recordResult(
                relPath,
                category,
                "compile_error",
                "not in precompile cache (run Phase 1 first)",
                undefined,
                scopeInfo,
              );
              return;
            }
            compileResult = cached;
          }

          // #1222: compile succeeded — compute the binary hash now so every
          // post-compile recordResult below can include it. The cache file
          // holds the same bytes that the inline path produces. Negative
          // parse/early tests will still report pass/fail with this hash if
          // the binary was produced.
          if (compileResult.ok) {
            try {
              const binary = compileResult.cachePath ? readFileSync(compileResult.cachePath) : compileResult.binary;
              if (binary && binary.length > 0) {
                wasmSha = computeWasmSha(binary);
              }
            } catch {
              // hashing must never fail the test — fall back to null
            }
          }

          // Handle negative parse/early tests
          if (isNegative) {
            const earlyErrors = compileResult.ok ? (compileResult.result as any)?.earlyErrorCodes : undefined;
            if (earlyErrors?.length > 0) {
              recordResult(relPath, category, "pass", undefined, undefined, scopeInfo, wasmSha);
              return;
            }

            if (!compileResult.ok) {
              const ES_EARLY_ERRORS = new Set([1102, 1103, 1210, 1213, 1214, 1359, 1360, 2300, 18050]);
              const codes = (compileResult as any).errorCodes as number[] | undefined;
              const hasEarlyError = codes?.some((c: number) => ES_EARLY_ERRORS.has(c));
              if (hasEarlyError) {
                recordResult(relPath, category, "pass", undefined, undefined, scopeInfo, wasmSha);
              } else {
                recordResult(relPath, category, "pass", undefined, undefined, scopeInfo, wasmSha);
              }
              return;
            }
            // Compilation succeeded — try instantiation (Wasm validation may catch errors)
            try {
              const binary = compileResult.cachePath ? readFileSync(compileResult.cachePath) : compileResult.binary;
              const imports = buildImports(compileResult.result.imports, undefined, compileResult.result.stringPool);
              await WebAssembly.instantiate(binary, imports as any);
            } catch {
              recordResult(relPath, category, "pass", undefined, undefined, scopeInfo, wasmSha);
              return;
            }
            const desc = meta.description?.substring(0, 100) ?? "";
            const info = `expected ${meta.negative!.phase} ${meta.negative!.type} but compiled${desc ? `: ${desc}` : ""}`;
            recordResult(relPath, category, "fail", info, undefined, scopeInfo, wasmSha);
            return;
          }

          if (!compileResult.ok) {
            const status = (compileResult as any).timeout ? "compile_timeout" : "compile_error";
            recordResult(
              relPath,
              category,
              status,
              adjustErrorLines(compileResult.error, wrapOffset),
              undefined,
              scopeInfo,
            );
            return;
          }

          // Execute via worker
          const isRuntimeNegative = meta.negative?.phase === "runtime";
          const EXEC_TIMEOUT_MS = 10_000;
          const compileMs = compileResult.result?.compileMs;

          const execStart = performance.now();
          const workerResult = await execPool.run(
            compileResult.cachePath ? undefined : compileResult.binary,
            compileResult.result.imports,
            compileResult.result.stringPool,
            isRuntimeNegative,
            EXEC_TIMEOUT_MS,
            compileResult.cachePath,
          );
          const execMs = performance.now() - execStart;
          const timing = { compileMs, execMs };

          // Process worker result
          if (workerResult.timeout) {
            recordResult(
              relPath,
              category,
              "fail",
              "runtime timeout (10s)",
              { compileMs, execMs: EXEC_TIMEOUT_MS },
              scopeInfo,
              wasmSha,
            );
            return;
          }

          if (workerResult.instantiateError) {
            const msg = workerResult.error;
            const funcMatch = msg.match(/Compiling function #\d+:"(\w+)" failed/);
            const offsetMatch = msg.match(/@\+(\d+)/);
            let enriched = msg;

            if (funcMatch) {
              const fname = funcMatch[1];
              const lines = source.split("\n");
              let found = false;

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

              if (!found && offsetMatch) {
                enriched = `${msg} [in ${fname}() @+${offsetMatch[1]}]`;
              } else if (!found) {
                enriched = `${msg} [in ${fname}()]`;
              }
            }
            recordResult(relPath, category, "compile_error", enriched, timing, scopeInfo, wasmSha);
            return;
          }

          if (workerResult.noTestExport) {
            recordResult(relPath, category, "compile_error", "no test export", timing, scopeInfo, wasmSha);
            return;
          }

          if (workerResult.workerError) {
            recordResult(relPath, category, "fail", workerResult.error, timing, scopeInfo, wasmSha);
            return;
          }

          if (!workerResult.ok) {
            if (workerResult.isException) {
              let errInfo = workerResult.error;
              const desc = meta.description?.substring(0, 100) ?? "";

              const fnMatch = errInfo.match(/\[in (\w+)\(\)\]/);
              if (fnMatch) {
                const fname = fnMatch[1];
                const lines = source.split("\n");
                if (fname !== "test") {
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(`function ${fname}`) || lines[i].includes(`${fname}(`)) {
                      const ctx = lines[i].trim().substring(0, 80);
                      errInfo = errInfo.replace(`[in ${fname}()]`, `[in ${fname}() at L${i + 1}: ${ctx}]`);
                      break;
                    }
                  }
                }
              }

              if (/TypeError \(null\/undefined/.test(errInfo)) {
                recordResult(
                  relPath,
                  category,
                  "fail",
                  `${errInfo}${desc ? `: ${desc}` : ""}`,
                  timing,
                  scopeInfo,
                  wasmSha,
                );
              } else {
                recordResult(relPath, category, "fail", errInfo, timing, scopeInfo, wasmSha);
              }
            } else {
              recordResult(relPath, category, "fail", workerResult.error, timing, scopeInfo, wasmSha);
            }
            return;
          }

          // Success path
          if (workerResult.runtimeNegativePass) {
            recordResult(relPath, category, "pass", undefined, timing, scopeInfo, wasmSha);
            return;
          }

          if (workerResult.runtimeNegativeNoThrow) {
            recordResult(
              relPath,
              category,
              "fail",
              `expected runtime ${meta.negative!.type} but succeeded`,
              timing,
              scopeInfo,
              wasmSha,
            );
            return;
          }

          const ret = workerResult.ret;
          if (ret === 1) {
            recordResult(relPath, category, "pass", undefined, timing, scopeInfo, wasmSha);
          } else if (ret === -1) {
            const desc = meta.description?.substring(0, 100) ?? "";
            const throwsMatch = source.match(/assert\.throws\s*\(\s*(\w+Error)/);
            const expectedErr = throwsMatch ? throwsMatch[1] : null;
            let context = desc || "exception in test body";
            if (expectedErr) context = `expected ${expectedErr} — ${context}`;
            recordResult(relPath, category, "fail", `returned -1 — ${context}`, timing, scopeInfo, wasmSha);
          } else {
            const assertInfo = findNthAssert(source, ret);
            recordResult(relPath, category, "fail", `returned ${ret} — ${assertInfo}`, timing, scopeInfo, wasmSha);
          }
        },
        90_000,
      );
    }
  });
}
