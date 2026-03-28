/**
 * Standalone test262 pre-compiler — compiles all tests in parallel,
 * writing to the disk cache. Run this BEFORE vitest to warm the cache.
 *
 * Usage: npx tsx scripts/precompile-tests.ts
 *
 * Uses all CPU cores for compilation. Vitest then runs pure execution
 * (cache hits only) with no compilation overhead.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
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
mkdirSync(CACHE_DIR, { recursive: true });

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

// Collect all tests
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
const CONCURRENCY = POOL_SIZE * 2;
const pending: Promise<void>[] = [];

for (const { filePath, relPath } of allTests) {
  const source = readFileSync(filePath, "utf-8");
  const meta = parseMeta(source);
  const filter = shouldSkip(source, meta, filePath);
  if (filter.skip) { skipped++; continue; }

  let wrapped: string;
  try {
    wrapped = wrapTest(source, meta).source;
  } catch {
    errors++;
    continue;
  }
  const hash = createHash("md5").update(wrapped).update(compilerHash).digest("hex");
  const cachePath = join(CACHE_DIR, `${hash}.wasm`);
  const metaPath = join(CACHE_DIR, `${hash}.json`);

  // Skip if already cached
  if (existsSync(cachePath) && existsSync(metaPath)) { cached++; continue; }

  // Dispatch to pool
  const job = pool.compile(wrapped, 10_000).then((result: PoolResult) => {
    if (result.ok) {
      try {
        writeFileSync(cachePath, result.binary);
        writeFileSync(metaPath, JSON.stringify({
          ok: true,
          stringPool: result.stringPool,
          imports: result.imports,
          sourceMap: result.sourceMap,
        }));
      } catch {}
      compiled++;
    } else {
      // Store compile error in cache so vitest can report it without recompiling
      try {
        writeFileSync(cachePath, new Uint8Array(0));
        writeFileSync(metaPath, JSON.stringify({
          ok: false,
          error: result.error,
        }));
      } catch {}
      errors++;
    }

    const total = compiled + cached + errors;
    if (total % 500 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (total / parseFloat(elapsed)).toFixed(0);
      console.log(`  ${total}/${allTests.length - skipped} (${rate}/s) — ${compiled} compiled, ${cached} cached, ${errors} errors [${elapsed}s]`);
    }
  });

  pending.push(job);

  // Throttle concurrency
  if (pending.length >= CONCURRENCY) {
    await Promise.race(pending);
    for (let i = pending.length - 1; i >= 0; i--) {
      const settled = await Promise.race([pending[i], Promise.resolve("pending")]);
      if (settled !== "pending") pending.splice(i, 1);
    }
  }
}

await Promise.all(pending);
pool.shutdown();

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s — ${compiled} compiled, ${cached} cached, ${skipped} skipped, ${errors} errors`);
