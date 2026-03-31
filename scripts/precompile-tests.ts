/**
 * Standalone test262 pre-compiler — compiles all tests in parallel,
 * writing to the disk cache. Run this BEFORE vitest to warm the cache.
 *
 * Usage: npx tsx scripts/precompile-tests.ts
 *
 * Uses all CPU cores for compilation. Vitest then runs pure execution
 * (cache hits only) with no compilation overhead.
 */
// Propagate --expose-gc to compiler worker threads so they can GC periodically
if (!process.env.NODE_OPTIONS?.includes("--expose-gc")) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --expose-gc`.trim();
}

import { readFile, writeFile, access, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join, relative } from "path";
import { createHash } from "crypto";
import { availableParallelism } from "os";
import { CompilerPool, type PoolResult } from "./compiler-pool.js";
import {
  findTestFiles,
  parseMeta,
  wrapTest,
  shouldSkip,
  TEST_CATEGORIES,
} from "../tests/test262-runner.js";

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");
const CACHE_DIR = join(import.meta.dirname ?? ".", "..", ".test262-cache");
const RESULTS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results");
const COMPILE_JSONL_PATH = join(RESULTS_DIR, "test262-compile.jsonl");
await mkdir(CACHE_DIR, { recursive: true });
await mkdir(RESULTS_DIR, { recursive: true });

// JSONL output — batched async writes for performance
import { openSync, writeSync as fdWrite, closeSync, fsyncSync } from "fs";
const jsonlFd = openSync(COMPILE_JSONL_PATH, "w"); // overwrite
const FLUSH_SIZE = 100; // flush every N entries
let jsonlBuffer: string[] = [];

function recordCompileResult(relPath: string, category: string, status: string, error?: string, compileMs?: number) {
  const entry = JSON.stringify({
    timestamp: new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
    file: relPath, category, status,
    error: error || undefined,
    compile_ms: compileMs !== undefined ? Math.round(compileMs) : undefined,
  });
  jsonlBuffer.push(entry);
  if (jsonlBuffer.length >= FLUSH_SIZE) {
    fdWrite(jsonlFd, jsonlBuffer.join("\n") + "\n");
    jsonlBuffer = [];
  }
}

function flushJsonl() {
  if (jsonlBuffer.length > 0) {
    fdWrite(jsonlFd, jsonlBuffer.join("\n") + "\n");
    jsonlBuffer = [];
  }
  try { fsyncSync(jsonlFd); } catch {}
}

// Build compiler hash (same logic as test262-vitest.test.ts)
function buildCompilerHash(): string {
  const h = createHash("md5");
  const root = join(import.meta.dirname ?? ".", "..");
  try { h.update(readFileSync(join(root, "scripts", "compiler-bundle.mjs"))); } catch { h.update("no-bundle"); }
  try { h.update(readFileSync(join(root, "tests", "test262-runner.ts"))); } catch { h.update("no-runner"); }
  try { h.update(readFileSync(join(root, "src", "runtime.ts"))); } catch { h.update("no-runtime"); }
  return h.digest("hex").slice(0, 12);
}

const compilerHash = buildCompilerHash();
const POOL_SIZE = parseInt(process.env.COMPILER_POOL_SIZE || String(Math.max(1, availableParallelism() - 2)), 10);
const NUM_BATCHES = parseInt(process.env.COMPILER_BATCHES || "8", 10);

// Collect all test file paths (fast — just readdir, no file reads)
const allTests: { filePath: string; relPath: string; category: string }[] = [];
for (const category of TEST_CATEGORIES) {
  for (const filePath of findTestFiles(category)) {
    allTests.push({ filePath, relPath: relative(TEST262_ROOT, filePath), category });
  }
}
console.log(`${allTests.length} test files found`);
console.log(`Sequential batching: ${NUM_BATCHES} batches × ${POOL_SIZE} workers`);

let compiled = 0;
let cached = 0;
let skipped = 0;
let errors = 0;
const startTime = Date.now();

function logProgress() {
  const total = compiled + cached + errors + skipped;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = (total / parseFloat(elapsed)).toFixed(0);
  console.log(`  ${total}/${allTests.length} (${rate}/s) — ${compiled} compiled, ${cached} cached, ${skipped} skipped, ${errors} errors [${elapsed}s]`);
}

/**
 * Process a batch of tests with a fresh compiler pool.
 * Pool is created at start and fully shut down at end, freeing all worker memory.
 */
async function processBatch(tests: typeof allTests, pool: CompilerPool) {
  const CONCURRENCY = POOL_SIZE * 3;
  let inFlight = 0;
  let resolveSlot: (() => void) | null = null;

  function releaseSlot() {
    inFlight--;
    if (resolveSlot) { const r = resolveSlot; resolveSlot = null; r(); }
  }

  async function waitForSlot() {
    if (inFlight < CONCURRENCY) { inFlight++; return; }
    await new Promise<void>(r => { resolveSlot = r; });
    inFlight++;
  }

  const jobs: Promise<void>[] = [];

  for (const { filePath, relPath, category } of tests) {
    await waitForSlot();

    const job = (async () => {
      try {
        const source = await readFile(filePath, "utf-8");
        const meta = parseMeta(source);
        const filter = shouldSkip(source, meta, filePath);
        if (filter.skip) { skipped++; recordCompileResult(relPath, category, "skip", filter.reason); releaseSlot(); return; }

        let wrapped: string;
        try {
          wrapped = wrapTest(source, meta).source;
        } catch {
          errors++; releaseSlot(); return;
        }

        const hash = createHash("md5").update(wrapped).update(compilerHash).digest("hex");
        const cachePath = join(CACHE_DIR, `${hash}.wasm`);
        const metaPath = join(CACHE_DIR, `${hash}.json`);

        // Check cache async
        try {
          await access(cachePath);
          await access(metaPath);
          const cachedMeta = JSON.parse(await readFile(metaPath, "utf-8"));
          if (cachedMeta.ok === false) {
            recordCompileResult(relPath, category, "cached_error", cachedMeta.error, cachedMeta.compileMs);
          } else {
            recordCompileResult(relPath, category, "cached", undefined, cachedMeta.compileMs);
          }
          cached++;
          releaseSlot();
          return;
        } catch {
          // Cache miss — compile
        }

        const isNegative = meta.negative && (meta.negative.phase === "parse" || meta.negative.phase === "early" || meta.negative.phase === "resolution");

        const result = await pool.compile(wrapped, 20_000, false, undefined, relPath);
        if (result.ok) {
          let earlyErrorCodes: number[] | undefined;
          if (isNegative) {
            const diagResult = await pool.compile(wrapped, 20_000, true, undefined, relPath);
            if (!diagResult.ok) {
              const ES_EARLY_ERRORS = new Set([1102, 1103, 1210, 1213, 1214, 1359, 1360, 2300, 18050]);
              earlyErrorCodes = ((diagResult as any).errorCodes || []).filter((c: number) => ES_EARLY_ERRORS.has(c));
            }
          }

          await writeFile(cachePath, result.binary);
          await writeFile(metaPath, JSON.stringify({
            ok: true,
            stringPool: result.stringPool,
            imports: result.imports,
            sourceMap: result.sourceMap,
            compileMs: result.compileMs,
            earlyErrorCodes: earlyErrorCodes?.length ? earlyErrorCodes : undefined,
          }));
          recordCompileResult(relPath, category, "compiled", undefined, result.compileMs);
          compiled++;
        } else {
          const isTimeout = result.error?.includes("timeout");
          await writeFile(cachePath, new Uint8Array(0));
          await writeFile(metaPath, JSON.stringify({
            ok: false,
            timeout: isTimeout,
            error: result.error,
            errorCodes: (result as any).errorCodes,
            compileMs: result.compileMs,
          }));
          recordCompileResult(relPath, category, isTimeout ? "compile_timeout" : "compile_error", result.error, result.compileMs);
          errors++;
        }

        const total = compiled + cached + errors + skipped;
        if (total % 1000 === 0) logProgress();
      } catch {
        errors++;
      }
      releaseSlot();
    })();

    jobs.push(job);
  }

  await Promise.all(jobs);
}

// Split tests into batches and process sequentially.
// Between batches: shutdown pool → GC → fresh pool.
// Between batches: shutdown forks → OS reclaims all memory → fresh forks.
const batchSize = Math.ceil(allTests.length / NUM_BATCHES);

for (let b = 0; b < NUM_BATCHES; b++) {
  const batchTests = allTests.slice(b * batchSize, (b + 1) * batchSize);
  console.log(`\nBatch ${b + 1}/${NUM_BATCHES}: ${batchTests.length} tests, ${POOL_SIZE} workers`);

  const pool = new CompilerPool(POOL_SIZE);
  await processBatch(batchTests, pool);
  pool.shutdown();

  // Force GC between batches to free all worker memory
  if (typeof globalThis.gc === "function") globalThis.gc();
  logProgress();
}

flushJsonl();
closeSync(jsonlFd);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s — ${compiled} compiled, ${cached} cached, ${skipped} skipped, ${errors} errors`);
