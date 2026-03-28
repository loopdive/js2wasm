/**
 * Standalone test262 pre-compiler — compiles all tests in parallel,
 * writing to the disk cache. Run this BEFORE vitest to warm the cache.
 *
 * Usage: npx tsx scripts/precompile-tests.ts
 *
 * Uses all CPU cores for compilation. Vitest then runs pure execution
 * (cache hits only) with no compilation overhead.
 */
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
const JSONL_PATH = join(RESULTS_DIR, "test262-results.jsonl");
await mkdir(CACHE_DIR, { recursive: true });
await mkdir(RESULTS_DIR, { recursive: true });

// JSONL output — append compile results for reporting
import { openSync, writeSync as fdWrite, closeSync, fsyncSync } from "fs";
const jsonlFd = openSync(JSONL_PATH, "w"); // overwrite

function recordCompileResult(relPath: string, category: string, status: string, error?: string, compileMs?: number) {
  const entry = JSON.stringify({
    file: relPath, category, status,
    error: error || undefined,
    compile_ms: compileMs !== undefined ? Math.round(compileMs) : undefined,
  });
  fdWrite(jsonlFd, entry + "\n");
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
const POOL_SIZE = parseInt(process.env.COMPILER_POOL_SIZE || String(availableParallelism()), 10);
const pool = new CompilerPool(POOL_SIZE);

console.log(`Pre-compiling test262 with ${POOL_SIZE} workers...`);

// Collect all test file paths (fast — just readdir, no file reads)
const allTests: { filePath: string; relPath: string; category: string }[] = [];
for (const category of TEST_CATEGORIES) {
  for (const filePath of findTestFiles(category)) {
    allTests.push({ filePath, relPath: relative(TEST262_ROOT, filePath), category });
  }
}
console.log(`${allTests.length} test files found`);

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

// Process all tests fully async with controlled concurrency
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

for (const { filePath, relPath, category } of allTests) {
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
        // Read cached metadata for compile time and status
        const cachedMeta = JSON.parse(await readFile(metaPath, "utf-8"));
        if (cachedMeta.ok === false) {
          recordCompileResult(relPath, category, "compile_error", cachedMeta.error, cachedMeta.compileMs);
        } else {
          recordCompileResult(relPath, category, "compiled", undefined, cachedMeta.compileMs);
        }
        cached++;
        releaseSlot();
        return;
      } catch {
        // Cache miss — compile
      }

      const result = await pool.compile(wrapped, 10_000, false, undefined, relPath);
      if (result.ok) {
        await writeFile(cachePath, result.binary);
        await writeFile(metaPath, JSON.stringify({
          ok: true,
          stringPool: result.stringPool,
          imports: result.imports,
          sourceMap: result.sourceMap,
          compileMs: result.compileMs,
        }));
        // Write "compiled" status — vitest will update with exec result
        recordCompileResult(relPath, category, "compiled", undefined, result.compileMs);
        compiled++;
      } else {
        await writeFile(cachePath, new Uint8Array(0));
        await writeFile(metaPath, JSON.stringify({ ok: false, error: result.error, compileMs: result.compileMs }));
        recordCompileResult(relPath, category, "compile_error", result.error, result.compileMs);
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
pool.shutdown();
try { fsyncSync(jsonlFd); } catch {}
closeSync(jsonlFd);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s — ${compiled} compiled, ${cached} cached, ${skipped} skipped, ${errors} errors`);
