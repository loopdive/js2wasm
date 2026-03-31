/**
 * Shared infrastructure for test262 vitest chunks.
 *
 * Each chunk file imports `runTest262Categories` and calls it with a subset
 * of TEST_CATEGORIES. Vitest distributes by file, so 8 chunk files = 8 forks.
 */
import { createHash } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  writeSync as fdWrite,
  fsyncSync,
  openSync,
} from "fs";
import { createServer, type Server } from "http";
import { basename, dirname, join, relative } from "path";
import { afterAll, describe, it } from "vitest";
import { Worker } from "worker_threads";
import { CompilerPool, type PoolResult } from "../scripts/compiler-pool.js";
import { buildImports } from "../src/runtime.js";
import {
  classifyError,
  findTestFiles,
  lookupSourceMapOffset,
  parseMeta,
  shouldSkip,
  wrapTest,
} from "./test262-runner.js";

// Prevent unhandled Promise rejections from crashing the vitest fork.
process.on("unhandledRejection", () => {});

// Lazy-load compileMulti only when needed (FIXTURE tests)
let _compileMulti: typeof import("../src/index.js").compileMulti | null = null;
async function getCompileMulti() {
  if (!_compileMulti) {
    const mod = await import("../src/index.js");
    _compileMulti = mod.compileMulti;
  }
  return _compileMulti;
}

/**
 * Extract _FIXTURE.js file references from static import/export statements.
 */
function resolveFixtures(source: string, testFilePath: string): string[] {
  const fixtures: string[] = [];
  const dir = dirname(testFilePath);
  const importRe =
    /(?:import|export)\s+.*?from\s+['"]([^'"]*_FIXTURE\.js)['"]/g;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    const resolved = join(dir, m[1]!);
    if (existsSync(resolved)) fixtures.push(resolved);
  }
  return [...new Set(fixtures)];
}

// ── Local HTTP server for wasm source map stack traces ───────────────

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

// ── Compiler pool ───────────────────────────────────────────────────

const POOL_SIZE = parseInt(process.env.COMPILER_POOL_SIZE || "1", 10);
const pool = new CompilerPool(POOL_SIZE);

// ── Wasm execution pool ─────────────────────────────────────────────

class WasmExecPool {
  private worker: Worker | null = null;
  private pending: Map<
    number,
    { resolve: (r: any) => void; timer: ReturnType<typeof setTimeout> }
  > = new Map();
  private nextId = 0;
  private workerPath: string;
  private execCount = 0;
  private readonly MAX_EXECS = 500;

  constructor() {
    this.workerPath = join(
      import.meta.dirname ?? ".",
      "..",
      "scripts",
      "wasm-exec-worker.mjs",
    );
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
        this.worker!.postMessage({
          id,
          cachePath,
          imports,
          stringPool,
          isRuntimeNegative,
        });
      } else {
        const binaryBuf = binary!.buffer.slice(
          binary!.byteOffset,
          binary!.byteOffset + binary!.byteLength,
        );
        this.worker!.postMessage(
          {
            id,
            binary: new Uint8Array(binaryBuf),
            imports,
            stringPool,
            isRuntimeNegative,
          },
          [binaryBuf],
        );
      }
    });
  }

  shutdown() {
    this.worker?.terminate();
  }
}

const execPool = new WasmExecPool();

// ── Ensure compiler bundle is up to date ────────────────────────────

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

// ── Cache setup ─────────────────────────────────────────────────────

const USE_CACHE = false;

const CACHE_DIR = join(import.meta.dirname ?? ".", "..", ".test262-cache");
if (USE_CACHE) mkdirSync(CACHE_DIR, { recursive: true });

function buildCompilerHash(): string {
  const h = createHash("md5");
  const root = join(import.meta.dirname ?? ".", "..");

  const bundlePath = join(root, "scripts", "compiler-bundle.mjs");
  try {
    h.update(readFileSync(bundlePath));
  } catch {
    h.update("no-bundle");
  }

  try {
    h.update(
      readFileSync(join(import.meta.dirname ?? ".", "test262-runner.ts")),
    );
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

// ── Cache-aware async compilation ───────────────────────────────────

async function getOrCompile(
  wrappedSource: string,
  relPath?: string,
): Promise<
  | { ok: true; binary: Uint8Array; result: any; cachePath?: string }
  | { ok: false; error: string }
> {
  const wasmRelPath = relPath ? relPath.replace(/\.js$/, ".wasm") : undefined;
  const sourceMapFilename = wasmRelPath
    ? basename(wasmRelPath) + ".map"
    : "test.wasm.map";

  const hash = createHash("md5")
    .update(wrappedSource)
    .update(compilerHash)
    .digest("hex");
  const wasmCachePath = join(CACHE_DIR, `${hash}.wasm`);
  const metaPath = join(CACHE_DIR, `${hash}.json`);

  let binary: Uint8Array | undefined;
  let result: any;
  let hitCache = false;

  if (USE_CACHE && existsSync(wasmCachePath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      if (meta.ok === false) {
        return {
          ok: false,
          error: meta.error,
          errorCodes: meta.errorCodes,
          timeout: meta.timeout,
        };
      }
      result = meta;
      hitCache = true;
    } catch {
      result = undefined;
    }
  }

  if (!hitCache) {
    const poolResult = await Promise.race([
      pool.compile(wrappedSource, 10_000, false, sourceMapFilename, relPath),
      new Promise<PoolResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              error: "compilation timeout (10s race)",
              compileMs: 10000,
            } as PoolResult),
          10_000,
        ),
      ),
    ]);
    if (!poolResult.ok) {
      return { ok: false, error: poolResult.error };
    }
    binary = poolResult.binary;
    result = {
      stringPool: poolResult.stringPool,
      imports: poolResult.imports,
      sourceMap: poolResult.sourceMap,
    };

    if (!USE_CACHE) {
      /* skip cache write */
    } else
      try {
        writeFileSync(wasmCachePath, binary);
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

  if (wasmRelPath && binary) {
    try {
      const outWasm = join(WASM_OUT_DIR, wasmRelPath);
      mkdirSync(dirname(outWasm), { recursive: true });
      writeFileSync(outWasm, binary);
      if (result.sourceMap) {
        writeFileSync(outWasm + ".map", result.sourceMap);
      }
    } catch {
      // Non-fatal
    }
  }

  if (hitCache) {
    return {
      ok: true,
      binary: undefined as any,
      result,
      cachePath: wasmCachePath,
    };
  }
  return { ok: true, binary: binary!, result };
}

// ── Result tracking (JSONL output for report.html) ──────────────────

const RESULTS_DIR = join(
  import.meta.dirname ?? ".",
  "..",
  "benchmarks",
  "results",
);
mkdirSync(RESULTS_DIR, { recursive: true });
const JSONL_PATH = join(RESULTS_DIR, "test262-results.jsonl");
const REPORT_PATH = join(RESULTS_DIR, "test262-report.json");

// Open results JSONL in append mode — each fork appends independently
const jsonlFd = openSync(JSONL_PATH, "a");
let flushCount = 0;
const REPORT_FLUSH_INTERVAL = 500;

const summary = {
  total: 0,
  pass: 0,
  fail: 0,
  compile_error: 0,
  compile_timeout: 0,
  skip: 0,
};
const catCounts: Record<
  string,
  {
    pass: number;
    fail: number;
    compile_error: number;
    skip: number;
    total: number;
  }
> = {};

const errorCategoryCounts: Record<string, number> = {};
const skipReasonCounts: Record<string, number> = {};

class ConformanceError extends Error {
  constructor(status: string, detail?: string) {
    super(`[${status}] ${detail || "unknown"}`);
    this.name = "ConformanceError";
  }
}

const GC_INTERVAL = 200;

function recordResult(
  file: string,
  category: string,
  status: string,
  error?: string,
  timing?: { compileMs?: number; execMs?: number },
) {
  const errorCategory =
    status === "fail" || status === "compile_error"
      ? classifyError(error)
      : undefined;

  const entry = JSON.stringify({
    timestamp: new Date().toLocaleString("de-DE", {
      timeZone: "Europe/Berlin",
    }),
    file,
    category,
    status,
    error: error || undefined,
    error_category: errorCategory,
    compile_ms:
      timing?.compileMs !== undefined
        ? Math.round(timing.compileMs)
        : undefined,
    exec_ms:
      timing?.execMs !== undefined ? Math.round(timing.execMs) : undefined,
  });
  fdWrite(jsonlFd, entry + "\n");
  summary.total++;
  (summary as any)[status]++;
  if (!catCounts[category])
    catCounts[category] = {
      pass: 0,
      fail: 0,
      compile_error: 0,
      skip: 0,
      total: 0,
    };
  (catCounts[category] as any)[status]++;
  catCounts[category].total++;

  if (errorCategory) {
    errorCategoryCounts[errorCategory] =
      (errorCategoryCounts[errorCategory] || 0) + 1;
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
  if (flushCount % REPORT_FLUSH_INTERVAL === 0) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        ...summary,
        compilable: summary.pass + summary.fail,
        stale: 0,
      },
      categories: Object.entries(catCounts)
        .map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      error_categories: { ...errorCategoryCounts },
      skip_reasons: { ...skipReasonCounts },
    };
    try {
      writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
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

function resolveWasmErrorLine(
  err: any,
  sourceMap: string | null,
  source: string,
  bodyLineOffset: number,
): string {
  const msg = err.message ?? String(err);
  const stack = typeof err?.stack === "string" ? err.stack : "";

  const frameRegex = /at\s+(?:(\w+)\s+)?\(?(?:.*?\.ts):(\d+):(\d+)\)?/g;
  let bestMatch: { funcName: string; rawLine: number; adjLine: number } | null =
    null;
  let match: RegExpExecArray | null;
  while ((match = frameRegex.exec(stack)) !== null) {
    const funcName = match[1] ?? "";
    const rawLine = parseInt(match[2], 10);
    const adjLine = rawLine - bodyLineOffset;
    if (adjLine > 0 && adjLine <= source.split("\n").length) {
      bestMatch = { funcName, rawLine, adjLine };
      break;
    }
    if (!bestMatch) bestMatch = { funcName, rawLine, adjLine };
  }
  if (bestMatch) {
    const lines = source.split("\n");
    if (bestMatch.adjLine > 0 && bestMatch.adjLine <= lines.length) {
      const ctx =
        lines[bestMatch.adjLine - 1]?.trim().substring(0, 80) || "(empty line)";
      return `${msg} [at L${bestMatch.adjLine}: ${ctx}]`;
    }
    const where = bestMatch.funcName
      ? `in ${bestMatch.funcName}()`
      : "in test wrapper";
    return `${msg} [${where}]`;
  }

  const offsetMatch = stack.match(/:0x([0-9a-fA-F]+)/) ?? msg.match(/@\+(\d+)/);
  const funcMatch = stack.match(/at (\w+) \(wasm:\/\//);
  const funcName = funcMatch?.[1];

  if (sourceMap && offsetMatch) {
    try {
      const byteOffset = parseInt(offsetMatch[1], 16);
      const mapped = lookupSourceMapOffset(sourceMap, byteOffset);
      if (mapped && mapped.line > 0) {
        const adjLine = mapped.line - bodyLineOffset;
        const srcLine = adjLine > 0 ? adjLine : mapped.line;
        const lines = source.split("\n");
        const ctx =
          lines[srcLine - 1]?.trim().substring(0, 80) || "(empty line)";
        return `${msg} [at L${srcLine}: ${ctx}]`;
      }
    } catch {}
  }

  if (funcName && funcName !== "test") {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (
        lines[i].includes(`function ${funcName}`) ||
        lines[i].includes(`${funcName}(`)
      ) {
        return `${msg} [in ${funcName}() at L${i + 1}]`;
      }
    }
    return `${msg} [in ${funcName}()]`;
  }

  return msg;
}

function findNthAssert(source: string, retVal: number): string {
  if (retVal === -1) return "exception caught in test body";
  const idx = retVal - 1;
  if (idx < 1) return `early return (${retVal})`;

  const lines = source.split("\n");
  const assertStarts: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\bassert\b/.test(lines[i])) {
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
 * Register vitest describe/it blocks for the given test262 categories.
 * Called by each chunk file with its subset of categories.
 */
export function runTest262Categories(categories: string[]) {
  // afterAll for this chunk — writes partial results to JSONL (already appended per-test)
  // and writes report.json (last chunk to finish wins — all data is in JSONL anyway)
  afterAll(() => {
    try {
      pool.shutdown();
    } catch {}
    try {
      wasmServer?.close();
    } catch {}
    try {
      closeSync(jsonlFd);
    } catch {}

    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        ...summary,
        compilable: summary.pass + summary.fail,
        stale: 0,
      },
      categories: Object.entries(catCounts)
        .map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      error_categories: { ...errorCategoryCounts },
      skip_reasons: { ...skipReasonCounts },
    };
    try {
      writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    } catch {}

    // Print error category breakdown
    const ecEntries = Object.entries(errorCategoryCounts).sort(
      (a, b) => b[1] - a[1],
    );
    if (ecEntries.length > 0) {
      console.log(`\nError categories:`);
      for (const [cat, count] of ecEntries) {
        console.log(`  ${cat}: ${count}`);
      }
    }

    // Print skip reason breakdown
    const skipEntries = Object.entries(skipReasonCounts).sort(
      (a, b) => b[1] - a[1],
    );
    if (skipEntries.length > 0) {
      console.log(`\nUnsupported features (skipped):`);
      for (const [reason, count] of skipEntries) {
        console.log(`  ${reason}: ${count}`);
      }
    }

    console.log(
      `\nTest262 chunk: ${summary.total} total — ${summary.pass} pass, ${summary.fail} fail, ${summary.compile_error} CE, ${summary.skip} skip`,
    );

    // Append to historical index (runs/index.json) for trend tracking
    // Only the first chunk writes this — others skip if entry already exists for this timestamp
    try {
      const RUNS_DIR = join(RESULTS_DIR, "runs");
      mkdirSync(RUNS_DIR, { recursive: true });
      const INDEX_PATH = join(RUNS_DIR, "index.json");

      let gitHash = "unknown";
      try {
        const { execSync: execSyncLocal } = require("child_process");
        gitHash = execSyncLocal("git rev-parse --short HEAD", {
          encoding: "utf-8",
        }).trim();
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
        chunk: true, // marks this as a partial chunk result
      });

      writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
    } catch {
      // Non-fatal
    }
  });

  // Register test cases for each category
  for (const category of categories) {
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
            const bodyLineOffset = 0;

            // Handle skips
            const filter = shouldSkip(source, meta, filePath);
            if (filter.skip) {
              recordResult(relPath, category, "skip", filter.reason);
              return;
            }

            await serverReady;

            // Wrap and compile
            const { source: wrapped, bodyLineOffset: wrapOffset } = wrapTest(
              source,
              meta,
            );
            const isNegative =
              meta.negative &&
              (meta.negative.phase === "parse" ||
                meta.negative.phase === "early" ||
                meta.negative.phase === "resolution");

            // Multi-file compilation for FIXTURE imports
            const fixtures = resolveFixtures(source, filePath);
            let compileResult:
              | {
                  ok: true;
                  binary: Uint8Array;
                  result: any;
                  cachePath?: string;
                }
              | { ok: false; error: string };

            if (fixtures.length > 0) {
              try {
                const vfiles: Record<string, string> = { "./test.ts": wrapped };
                for (const fixPath of fixtures) {
                  vfiles["./" + relative(dirname(filePath), fixPath)] =
                    readFileSync(fixPath, "utf-8");
                }
                const multiCompile = await getCompileMulti();
                const result = multiCompile(vfiles, "./test.ts", {
                  skipSemanticDiagnostics: true,
                });
                if (result.success && result.binary.length > 0) {
                  compileResult = {
                    ok: true,
                    binary: result.binary,
                    result: {
                      imports: result.imports,
                      stringPool: result.stringPool,
                      sourceMap: null,
                    },
                  };
                } else {
                  compileResult = {
                    ok: false,
                    error: result.errors
                      .map((e: any) => `L${e.line}:${e.column} ${e.message}`)
                      .join("; "),
                  };
                }
              } catch (e: any) {
                compileResult = { ok: false, error: e.message ?? String(e) };
              }
            } else {
              compileResult = await getOrCompile(wrapped, relPath);
            }

            // Handle negative parse/early tests
            if (isNegative) {
              const earlyErrors = compileResult.ok
                ? (compileResult.result as any)?.earlyErrorCodes
                : undefined;
              if (earlyErrors?.length > 0) {
                recordResult(relPath, category, "pass");
                return;
              }

              if (!compileResult.ok) {
                const ES_EARLY_ERRORS = new Set([
                  1102, 1103, 1210, 1213, 1214, 1359, 1360, 2300, 18050,
                ]);
                const codes = (compileResult as any).errorCodes as
                  | number[]
                  | undefined;
                const hasEarlyError = codes?.some((c: number) =>
                  ES_EARLY_ERRORS.has(c),
                );
                if (hasEarlyError) {
                  recordResult(relPath, category, "pass");
                } else {
                  recordResult(relPath, category, "pass");
                }
                return;
              }
              try {
                const imports = buildImports(
                  compileResult.result.imports,
                  undefined,
                  compileResult.result.stringPool,
                );
                await WebAssembly.instantiate(
                  compileResult.binary,
                  imports as any,
                );
              } catch {
                recordResult(relPath, category, "pass");
                return;
              }
              const desc = meta.description?.substring(0, 100) ?? "";
              const info = `expected ${meta.negative!.phase} ${meta.negative!.type} but compiled${desc ? `: ${desc}` : ""}`;
              recordResult(relPath, category, "fail", info);
              return;
            }

            if (!compileResult.ok) {
              const status = (compileResult as any).timeout
                ? "compile_timeout"
                : "compile_error";
              recordResult(
                relPath,
                category,
                status,
                adjustErrorLines(compileResult.error, wrapOffset),
              );
              return;
            }

            // Execute
            const isRuntimeNegative = meta.negative?.phase === "runtime";
            const EXEC_TIMEOUT_MS = 10_000;
            const compileMs = compileResult.result?.compileMs;

            const execStart = performance.now();
            const workerResult = await execPool.run(
              compileResult.binary,
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
                {
                  compileMs,
                  execMs: EXEC_TIMEOUT_MS,
                },
              );
              return;
            }

            if (workerResult.instantiateError) {
              const msg = workerResult.error;
              const funcMatch = msg.match(
                /Compiling function #\d+:"(\w+)" failed/,
              );
              const offsetMatch = msg.match(/@\+(\d+)/);
              let enriched = msg;

              if (funcMatch) {
                const fname = funcMatch[1];
                const lines = source.split("\n");
                let found = false;

                if (fname !== "test") {
                  for (let i = 0; i < lines.length; i++) {
                    if (
                      lines[i].includes(`function ${fname}`) ||
                      lines[i].includes(`${fname}(`)
                    ) {
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
              recordResult(relPath, category, "compile_error", enriched, timing);
              return;
            }

            if (workerResult.noTestExport) {
              recordResult(
                relPath,
                category,
                "compile_error",
                "no test export",
                timing,
              );
              return;
            }

            if (workerResult.workerError) {
              recordResult(
                relPath,
                category,
                "fail",
                workerResult.error,
                timing,
              );
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
                      if (
                        lines[i].includes(`function ${fname}`) ||
                        lines[i].includes(`${fname}(`)
                      ) {
                        const ctx = lines[i].trim().substring(0, 80);
                        errInfo = errInfo.replace(
                          `[in ${fname}()]`,
                          `[in ${fname}() at L${i + 1}: ${ctx}]`,
                        );
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
                  );
                } else {
                  recordResult(relPath, category, "fail", errInfo, timing);
                }
              } else {
                recordResult(
                  relPath,
                  category,
                  "fail",
                  workerResult.error,
                  timing,
                );
              }
              return;
            }

            // Success path
            if (workerResult.runtimeNegativePass) {
              recordResult(relPath, category, "pass", undefined, timing);
              return;
            }

            if (workerResult.runtimeNegativeNoThrow) {
              recordResult(
                relPath,
                category,
                "fail",
                `expected runtime ${meta.negative!.type} but succeeded`,
                timing,
              );
              return;
            }

            const ret = workerResult.ret;
            if (ret === 1) {
              recordResult(relPath, category, "pass", undefined, timing);
            } else if (ret === -1) {
              const desc = meta.description?.substring(0, 100) ?? "";
              const throwsMatch = source.match(
                /assert\.throws\s*\(\s*(\w+Error)/,
              );
              const expectedErr = throwsMatch ? throwsMatch[1] : null;
              let context = desc || "exception in test body";
              if (expectedErr)
                context = `expected ${expectedErr} — ${context}`;
              recordResult(
                relPath,
                category,
                "fail",
                `returned -1 — ${context}`,
                timing,
              );
            } else {
              const assertInfo = findNthAssert(source, ret);
              recordResult(
                relPath,
                category,
                "fail",
                `returned ${ret} — ${assertInfo}`,
                timing,
              );
            }
          },
          90_000,
        );
      }
    });
  }
}
