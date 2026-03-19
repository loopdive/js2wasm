/**
 * Standalone test262 runner — processes one category at a time,
 * writes per-test results as JSONL for incremental updates.
 *
 * Usage:
 *   npx tsx scripts/run-test262.ts              # run all categories
 *   npx tsx scripts/run-test262.ts Math Array    # run matching categories only
 *   npx tsx scripts/run-test262.ts --resume      # resume an interrupted run (same git HEAD only)
 *
 * Output:
 *   benchmarks/results/test262-results.jsonl  — one JSON line per test result
 *   benchmarks/results/test262-report.json    — summary with error frequency
 */
import { TEST_CATEGORIES, findTestFiles, runTest262File, shouldSkip, parseMeta, wrapTest, type TestResult, type TestTiming } from "../tests/test262-runner.js";
import { join } from "path";
import { writeFileSync, appendFileSync, readFileSync, existsSync, openSync, closeSync, writeSync, unlinkSync, mkdirSync, copyFileSync, readdirSync, statSync } from "fs";
import { execSync, fork } from "child_process";
import { createHash } from "crypto";

/** Known tests that cause infinite loops in compiled Wasm — skip these */
const KNOWN_HANGING_TESTS = new Set([
  "test/language/statements/for-of/let-block-with-newline.js",
  "test/language/statements/for-of/let-identifier-with-newline.js",
]);

/** Compute a short hash of a string or buffer */
function shortHash(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/** Recursively collect all file paths under a directory, sorted for determinism */
function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (st.isFile()) {
      results.push(full);
    }
  }
  return results.sort();
}

/** Compiler fingerprint — hash of actual file contents in src/.
 *  Detects uncommitted changes, unlike git rev-parse. */
function computeCompilerHash(): string {
  try {
    const srcDir = join(process.cwd(), "src");
    const files = collectFiles(srcDir);
    const hash = createHash("sha256");
    for (const f of files) {
      // Include relative path so renames are detected
      hash.update(f.slice(srcDir.length));
      hash.update(readFileSync(f));
    }
    return hash.digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

const compilerHash = computeCompilerHash();
// Compiler hash logged after RESULTS_DIR is set up
type CacheEntry = { status: string; error?: string; wasmHash?: string };
let resultCache = new Map<string, CacheEntry>();
const sourceHashCache = new Map<string, CacheEntry>();

/** Load previous results to prioritize failures first on re-runs */
function loadPreviousFailures(): Set<string> {
  const failures = new Set<string>();
  if (!existsSync(JSONL_PATH)) return failures;
  try {
    const lines = readFileSync(JSONL_PATH, "utf-8").split("\n");
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (r.file && (r.status === "fail" || r.status === "compile_error")) {
          failures.add(r.file);
        }
      } catch {}
    }
  } catch {}
  return failures;
}

/** Sort test files: previously-failed tests first, then alphabetical */
function prioritizeTests(files: string[], previousFailures: Set<string>): string[] {
  const failed: string[] = [];
  const rest: string[] = [];
  for (const f of files) {
    const rel = f.replace(/.*test262\//, "");
    if (previousFailures.has(rel)) {
      failed.push(f);
    } else {
      rest.push(f);
    }
  }
  return [...failed, ...rest];
}

/** Batch worker pool — splits all tests across N workers, each processes its chunk.
 *  Workers send results back as they complete each test.
 *  If a worker doesn't send a result for 30s, it's killed (hung test). */
const POOL_SIZE = 8;
const WORKER_TIMEOUT_MS = 30_000;
const workerPath = join(process.cwd(), "scripts", "test262-worker.ts");

type TestJob = { filePath: string; category: string; relPath: string };
type WorkerResult = { file: string; category: string; status: string; error?: string; reason?: string; timing?: any };

/** Dispatch a batch of tests to a fresh worker. Returns all results.
 *  If the worker hangs on a test for > 30s, it's killed and remaining tests
 *  in the batch are reported as "timeout". */
function runBatch(batch: TestJob[]): Promise<WorkerResult[]> {
  return new Promise((resolve) => {
    const results: WorkerResult[] = [];
    const proc = fork(workerPath, [], { stdio: "pipe", execArgv: ["--import", "tsx"] });
    proc.setMaxListeners(0);
    let lastActivity = Date.now();
    let done = false;

    // Watchdog: kill worker if no activity for WORKER_TIMEOUT_MS
    const watchdog = setInterval(() => {
      if (done) return;
      if (Date.now() - lastActivity > WORKER_TIMEOUT_MS) {
        clearInterval(watchdog);
        done = true;
        try { proc.kill("SIGKILL"); } catch {}
        // Report remaining tests as timeout
        const completed = new Set(results.map(r => r.file));
        for (const job of batch) {
          if (!completed.has(job.relPath)) {
            results.push({ file: job.relPath, category: job.category, status: "fail", error: "timeout: worker hung > 30s" });
          }
        }
        resolve(results);
      }
    }, 5000);

    proc.on("message", (msg: any) => {
      if (msg.ready) {
        // Worker ready — send the batch
        proc.send({ batch });
        return;
      }
      if (msg.batchDone) {
        clearInterval(watchdog);
        done = true;
        proc.kill();
        resolve(results);
        return;
      }
      // Individual test result
      lastActivity = Date.now();
      results.push(msg);
    });

    proc.on("exit", () => {
      if (!done) {
        clearInterval(watchdog);
        done = true;
        // Report remaining as crashed
        const completed = new Set(results.map(r => r.file));
        for (const job of batch) {
          if (!completed.has(job.relPath)) {
            results.push({ file: job.relPath, category: job.category, status: "compile_error", error: "worker crashed" });
          }
        }
        resolve(results);
      }
    });
  });
}

const RESULTS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results");
const JSONL_PATH = join(RESULTS_DIR, "test262-results.jsonl");
const REPORT_PATH = join(RESULTS_DIR, "test262-report.json");
const META_PATH = join(RESULTS_DIR, "test262-run.meta.json");

// Safe-write: all writes go to a timestamped run file; main files updated only on success
const RUNS_DIR = join(RESULTS_DIR, "runs");
mkdirSync(RUNS_DIR, { recursive: true });
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_JSONL = join(RUNS_DIR, `${RUN_TIMESTAMP}-results.jsonl`);
const RUN_REPORT = join(RUNS_DIR, `${RUN_TIMESTAMP}-report.json`);

// Initialize persistent cache (after RESULTS_DIR is available)
const CACHE_PATH = join(RESULTS_DIR, "test262-cache.json");
console.log(`Compiler hash: ${compilerHash}`);

function loadCache() {
  if (!existsSync(CACHE_PATH)) return;
  try {
    const data = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    if (data.compilerHash === compilerHash && data.entries) {
      resultCache = new Map(Object.entries(data.entries));
      console.log(`Loaded ${resultCache.size} cached results (compiler ${compilerHash})`);
    } else {
      console.log(`Cache invalidated (compiler changed: ${data.compilerHash} → ${compilerHash})`);
    }
  } catch {}
}

function saveCache() {
  const entries: Record<string, CacheEntry> = {};
  for (const [k, v] of resultCache) entries[k] = v;
  writeFileSync(CACHE_PATH, JSON.stringify({ compilerHash, entries }, null, 0));
}

loadCache();

// Lockfile to prevent concurrent runs
const LOCK_PATH = join(RESULTS_DIR, "test262.lock");

function acquireLock(): void {
  try {
    const fd = openSync(LOCK_PATH, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
  } catch (e: any) {
    if (e.code === "EEXIST") {
      try {
        const lock = JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
        try {
          process.kill(lock.pid, 0);
          console.error(`Another test262 run is active (PID ${lock.pid}, started ${lock.startedAt}). Exiting.`);
          process.exit(1);
        } catch {
          console.log(`Removing stale lock from dead PID ${lock.pid}\n`);
          unlinkSync(LOCK_PATH);
          return acquireLock();
        }
      } catch {
        unlinkSync(LOCK_PATH);
        return acquireLock();
      }
    }
    throw e;
  }
}

function releaseLock(): void {
  try { unlinkSync(LOCK_PATH); } catch {}
}

acquireLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(130); });
process.on("SIGTERM", () => { releaseLock(); process.exit(143); });

function getGitHead(): string {
  try { return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim(); }
  catch { return "unknown"; }
}

// Parse CLI args
const rawArgs = process.argv.slice(2);
const resumeFlag = rawArgs.includes("--resume");
const fullFlag = rawArgs.includes("--full");
const recheckFlag = !fullFlag; // recheck is the default; --full overrides
const filterArgs = rawArgs.filter(a => a !== "--resume" && a !== "--full");
const categories = filterArgs.length > 0
  ? TEST_CATEGORIES.filter(cat => filterArgs.some(f => cat.toLowerCase().includes(f.toLowerCase())))
  : TEST_CATEGORIES;

// Determine whether to resume or start fresh
const completedFiles = new Set<string>();
const hasPrevious = existsSync(META_PATH) && existsSync(JSONL_PATH);
const prevMeta = hasPrevious ? JSON.parse(readFileSync(META_PATH, "utf-8")) : null;
const isInterrupted = prevMeta?.status === "running";

function loadPreviousLines(): string[] {
  if (!existsSync(JSONL_PATH)) return [];
  return readFileSync(JSONL_PATH, "utf-8").split("\n").filter(l => l.trim());
}

if (hasPrevious && (isInterrupted || resumeFlag) && !fullFlag) {
  // Auto-resume interrupted run (or --resume flag)
  const prevLines = loadPreviousLines();
  for (const line of prevLines) {
    try { const r = JSON.parse(line); if (r.file) completedFiles.add(r.file); } catch {}
  }
  // Seed run file with previous results so new results append correctly
  writeFileSync(RUN_JSONL, prevLines.length > 0 ? prevLines.join("\n") + "\n" : "");
  const reason = isInterrupted ? 'interrupted run detected' : '--resume flag';
  console.log(`Auto-resuming (${reason}, ${completedFiles.size} tests already done)\n`);
} else if (recheckFlag && hasPrevious && !fullFlag) {
  // Default: carry forward pass only, re-run failures + compile errors + skips
  // Skips are always re-evaluated because skip filters change over time
  // (e.g. a feature gets implemented and the skip filter is removed)
  const prevLines = loadPreviousLines();
  const carryForwardLines: string[] = [];
  let carried = 0, recheck = 0;
  for (const line of prevLines) {
    try {
      const r = JSON.parse(line);
      if (r.file && r.status === "pass") {
        completedFiles.add(r.file);
        carryForwardLines.push(line);
        carried++;
      } else if (r.file) { recheck++; }
    } catch {}
  }
  writeFileSync(RUN_JSONL, carryForwardLines.length > 0 ? carryForwardLines.join("\n") + "\n" : "");
  console.log(`Recheck mode: carrying forward ${carried} passes, re-running ${recheck} failures/skips\n`);
} else {
  // Fresh run (--full or no previous data)
  if (filterArgs.length > 0 && hasPrevious) {
    // Subset run: carry forward results not in selected categories
    const existingResults = new Map<string, string>();
    for (const line of loadPreviousLines()) {
      try { const r = JSON.parse(line); if (r.file) existingResults.set(r.file, line); } catch {}
    }
    for (const cat of categories) {
      for (const f of findTestFiles(cat)) {
        existingResults.delete(f.replace(/.*test262\//, ""));
      }
    }
    const lines = [...existingResults.values()];
    writeFileSync(RUN_JSONL, lines.length > 0 ? lines.join("\n") + "\n" : "");
  } else {
    writeFileSync(RUN_JSONL, "");
  }
}

const allResults: TestResult[] = [];
const stats = { pass: 0, fail: 0, skip: 0, compile_error: 0 };

let total = 0;
for (const cat of categories) total += findTestFiles(cat).length;

// Write run metadata (status=running until we finish)
writeFileSync(META_PATH, JSON.stringify({ gitHead: getGitHead(), status: "running", startedAt: new Date().toISOString() }));

console.log(`Running ${total} tests across ${categories.length} categories...\n`);

// Group categories into batches for display
function batchKey(cat: string): string {
  const parts = cat.split("/");
  if (parts[0] === "built-ins" && parts[1] === "Math") return "Math";
  if (parts[0] === "built-ins" && ["Number", "Boolean", "isNaN", "isFinite", "parseInt", "parseFloat"].includes(parts[1]!)) return parts[1]!;
  if (parts[0] === "built-ins") {
    const last = parts[parts.length - 1] ?? "";
    return `${parts[1]}/${last}`;
  }
  if (parts[0] === "language") {
    const last = parts[parts.length - 1] ?? "";
    const group = parts[1] === "expressions" ? "expr" : parts[1] === "statements" ? "stmt" : parts[1] ?? "";
    return `${group}/${last}`;
  }
  return cat;
}

const batches = new Map<string, string[]>();
for (const cat of categories) {
  const key = batchKey(cat);
  if (!batches.has(key)) batches.set(key, []);
  batches.get(key)!.push(cat);
}

let processed = 0;
const previousFailures = loadPreviousFailures();
if (previousFailures.size > 0) {
  console.log(`  Retesting ${previousFailures.size} previously-failed tests...\n`);
}

for (const [batchName, batchCats] of batches) {
  // Count tests in this batch (before filtering) for progress display
  let batchTestCount = 0;
  for (const category of batchCats) batchTestCount += findTestFiles(category).length;
  const pctStart = total > 0 ? ((processed / total) * 100).toFixed(0) : "0";
  console.log(`  [${pctStart.padStart(3)}%] ${batchName} (${batchTestCount} tests)...`);

  const batchStart = Date.now();
  const batchStats = { pass: 0, fail: 0, skip: 0, compile_error: 0 };
  let buffer: string[] = [];

  // Collect ALL tests across all categories in this display batch,
  // pre-filtering skips and deduplicating by source hash in main process
  const jobs: TestJob[] = [];
  for (const category of batchCats) {
    const files = prioritizeTests(findTestFiles(category), previousFailures);
    for (const filePath of files) {
      const relPath = filePath.replace(/.*test262\//, "");
      if (completedFiles.has(relPath)) {
        processed++;
        continue;
      }
      if (KNOWN_HANGING_TESTS.has(relPath)) {
        const r = { file: relPath, category, status: "fail" as const, error: "known hanging test" };
        allResults.push(r as any);
        stats.fail++; batchStats.fail++; processed++;
        buffer.push(JSON.stringify(r));
        continue;
      }
      // Pre-filter: run shouldSkip + negative test + hash dedup in main process
      try {
        const source = readFileSync(filePath, "utf-8");
        const meta = parseMeta(source);

        // Negative tests (parse/early/resolution/runtime) bypass shouldSkip
        // entirely — they are handled specially in the worker (runTest262File).
        // Skipping them here would prevent the worker from trying to compile
        // and validate the expected error behavior.
        if (!meta.negative) {
          const skipResult = shouldSkip(source, meta, filePath);
          if (skipResult.skip) {
            const r = { file: relPath, category, status: "skip" as const, reason: skipResult.reason };
            allResults.push(r as any);
            stats.skip++; batchStats.skip++; processed++;
            buffer.push(JSON.stringify(r));
            continue;
          }
        }

        // Check persistent cache: (compiler + source) hash
        const wrapped = wrapTest(source, meta);
        const srcHash = shortHash(wrapped);
        const cacheKey = srcHash; // compiler hash already validated on load
        const cached = resultCache.get(cacheKey) || sourceHashCache.get(cacheKey);
        if (cached) {
          const r = { file: relPath, category, status: cached.status as any, error: cached.error };
          allResults.push(r as any);
          const s = cached.status as keyof typeof stats;
          if (s in stats) (stats as any)[s]++;
          if (s in batchStats) (batchStats as any)[s]++;
          processed++;
          buffer.push(JSON.stringify({ file: relPath, category, status: cached.status, ...(cached.error ? { error: cached.error } : {}) }));
          continue;
        }
      } catch {}
      jobs.push({ filePath, category, relPath });
    }
  }
  if (jobs.length > 0) {
    // Split across workers globally for better load balancing
    const chunkSize = Math.max(1, Math.ceil(jobs.length / POOL_SIZE));
    const chunks: TestJob[][] = [];
    for (let i = 0; i < jobs.length; i += chunkSize) {
      chunks.push(jobs.slice(i, i + chunkSize));
    }
    const batchResults = await Promise.all(chunks.map(chunk => runBatch(chunk)));
    for (const results of batchResults) {
      for (const r of results) {
        allResults.push(r as any);
        const s = r.status as keyof typeof stats;
        if (s in stats) stats[s]++;
        if (s in batchStats) batchStats[s]++;
        processed++;
        buffer.push(JSON.stringify({
          file: r.file, category: r.category, status: r.status,
          ...(r.error ? { error: r.error.substring(0, 300) } : {}),
          ...(r.reason ? { reason: r.reason } : {}),
          ...(r.timing ? { timing: r.timing } : {}),
        }));
        // Populate both caches for dedup
        try {
          const job = jobs.find(j => j.relPath === r.file);
          if (job) {
            const src = readFileSync(job.filePath, "utf-8");
            const meta = parseMeta(src);
            const wrapped = wrapTest(src, meta);
            const hash = shortHash(wrapped);
            const entry: CacheEntry = { status: r.status, error: r.error };
            sourceHashCache.set(hash, entry);
            resultCache.set(hash, entry);
          }
        } catch {}
      }
    }
  }
  // Flush remaining
  if (buffer.length > 0) {
    appendFileSync(RUN_JSONL, buffer.join("\n") + "\n");
    buffer = [];
  }

  const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
  const pct = total > 0 ? ((processed / total) * 100).toFixed(0) : "0";
  console.log(
    `  [${pct.padStart(3)}%] ${batchName.padEnd(20)} ` +
    `pass:${String(batchStats.pass).padStart(3)}  fail:${String(batchStats.fail).padStart(2)}  ` +
    `err:${String(batchStats.compile_error).padStart(3)}  skip:${String(batchStats.skip).padStart(4)}  (${elapsed}s)`
  );
}

// Build final results from complete JSONL (deduplicated, last entry wins)
const resultsByFile = new Map<string, any>();
for (const line of readFileSync(RUN_JSONL, "utf-8").split("\n")) {
  if (!line.trim()) continue;
  try { const r = JSON.parse(line); if (r.file && r.status) resultsByFile.set(r.file, r); } catch {}
}
const finalResults: TestResult[] = [...resultsByFile.values()];
const finalStats = { pass: 0, fail: 0, skip: 0, compile_error: 0 };
for (const r of finalResults) finalStats[r.status as keyof typeof finalStats]++;

// Build compile error frequency map
const errorFreq = new Map<string, { count: number; files: string[] }>();
for (const r of finalResults) {
  if (r.status === "compile_error" && r.error) {
    const msgs = r.error.split("; ");
    for (const msg of msgs) {
      const normalized = normalizeError(msg);
      const entry = errorFreq.get(normalized) ?? { count: 0, files: [] };
      entry.count++;
      if (entry.files.length < 5) entry.files.push(r.file);
      errorFreq.set(normalized, entry);
    }
  }
}
const errorFreqSorted = [...errorFreq.entries()].sort((a, b) => b[1].count - a[1].count);

function normalizeError(msg: string): string {
  return msg
    .replace(/'\w+'/g, "'X'")
    .replace(/type '\w+'/g, "type 'X'")
    .replace(/struct type: __anon_\d+/g, "struct type: __anon_N")
    .replace(/Cannot compile expression: \d+/g, "Cannot compile expression: N");
}

// Aggregate timing data
const timedResults = finalResults.filter(r => r.timing);
const totalCompileMs = timedResults.reduce((s, r) => s + (r.timing?.compileMs ?? 0), 0);
const totalInstantiateMs = timedResults.reduce((s, r) => s + (r.timing?.instantiateMs ?? 0), 0);
const totalExecuteMs = timedResults.reduce((s, r) => s + (r.timing?.executeMs ?? 0), 0);
const totalWallMs = timedResults.reduce((s, r) => s + (r.timing?.totalMs ?? 0), 0);

// Top 20 slowest tests by compile time
const slowestByCompile = [...timedResults]
  .sort((a, b) => (b.timing?.compileMs ?? 0) - (a.timing?.compileMs ?? 0))
  .slice(0, 20);

// Top 20 slowest tests by total time
const slowestByTotal = [...timedResults]
  .sort((a, b) => (b.timing?.totalMs ?? 0) - (a.timing?.totalMs ?? 0))
  .slice(0, 20);

// Per-category average compile time
const categoryTiming = new Map<string, { count: number; compileMs: number; totalMs: number }>();
for (const r of timedResults) {
  const entry = categoryTiming.get(r.category) ?? { count: 0, compileMs: 0, totalMs: 0 };
  entry.count++;
  entry.compileMs += r.timing!.compileMs;
  entry.totalMs += r.timing!.totalMs;
  categoryTiming.set(r.category, entry);
}
const categoryTimingSorted = [...categoryTiming.entries()]
  .map(([cat, t]) => ({ category: cat, ...t, avgCompileMs: t.compileMs / t.count, avgTotalMs: t.totalMs / t.count }))
  .sort((a, b) => b.avgCompileMs - a.avgCompileMs);

// Write JSON report
const compilable = finalStats.pass + finalStats.fail;
const byCategory = new Map<string, { pass: number; fail: number; skip: number; compile_error: number }>();
for (const r of finalResults) {
  if (!byCategory.has(r.category)) byCategory.set(r.category, { pass: 0, fail: 0, skip: 0, compile_error: 0 });
  byCategory.get(r.category)![r.status]++;
}

const reportData = {
  timestamp: new Date().toISOString(),
  summary: { total: finalResults.length, ...finalStats, compilable },
  categories: [...byCategory.entries()].sort().map(([cat, s]) => ({
    name: cat, ...s, compilable: s.pass + s.fail,
  })),
  compileErrors: errorFreqSorted.map(([msg, { count, files }]) => ({ message: msg, count, examples: files })),
  timing: {
    totalWallMs: Math.round(totalWallMs),
    totalCompileMs: Math.round(totalCompileMs),
    totalInstantiateMs: Math.round(totalInstantiateMs),
    totalExecuteMs: Math.round(totalExecuteMs),
    timedTests: timedResults.length,
    avgCompileMs: timedResults.length > 0 ? Math.round(totalCompileMs / timedResults.length * 100) / 100 : 0,
    slowestByCompile: slowestByCompile.map(r => ({
      file: r.file, status: r.status, compileMs: r.timing!.compileMs, totalMs: r.timing!.totalMs,
    })),
    slowestByTotal: slowestByTotal.map(r => ({
      file: r.file, status: r.status,
      compileMs: r.timing!.compileMs, instantiateMs: r.timing!.instantiateMs,
      executeMs: r.timing!.executeMs, totalMs: r.timing!.totalMs,
    })),
    byCategory: categoryTimingSorted.slice(0, 30).map(c => ({
      category: c.category, count: c.count,
      avgCompileMs: Math.round(c.avgCompileMs * 100) / 100,
      totalCompileMs: Math.round(c.compileMs),
      avgTotalMs: Math.round(c.avgTotalMs * 100) / 100,
    })),
  },
};
// Write report to run-specific path first; main files promoted on success below
try { writeFileSync(RUN_REPORT, JSON.stringify(reportData, null, 2)); } catch {}

// Console summary
console.log("\n══════════════════════════════════════════════════════");
console.log("           Test262 Conformance Report");
console.log("══════════════════════════════════════════════════════");
console.log(`  Total tests:     ${finalResults.length}`);
console.log(`  Passed:          ${finalStats.pass}  (${compilable > 0 ? ((finalStats.pass / compilable * 100) | 0) : 0}% of compilable)`);
console.log(`  Failed:          ${finalStats.fail}`);
console.log(`  Compile errors:  ${finalStats.compile_error}`);
console.log(`  Skipped:         ${finalStats.skip}`);
console.log("──────────────────────────────────────────────────────");

if (errorFreqSorted.length > 0) {
  console.log("\n── Compile Error Frequency ─────────────────────────");
  for (const [msg, { count }] of errorFreqSorted) {
    console.log(`  ${String(count).padStart(4)}×  ${msg.substring(0, 100)}`);
  }
  console.log("────────────────────────────────────────────────────");
}

// Timing summary
if (timedResults.length > 0) {
  console.log("\n── Compilation Timing ──────────────────────────────");
  console.log(`  Tests with timing:  ${timedResults.length}`);
  console.log(`  Total compile:      ${(totalCompileMs / 1000).toFixed(1)}s`);
  console.log(`  Total instantiate:  ${(totalInstantiateMs / 1000).toFixed(1)}s`);
  console.log(`  Total execute:      ${(totalExecuteMs / 1000).toFixed(1)}s`);
  console.log(`  Total wall-clock:   ${(totalWallMs / 1000).toFixed(1)}s`);
  console.log(`  Avg compile/test:   ${(totalCompileMs / timedResults.length).toFixed(1)}ms`);
  console.log("");
  console.log("  Top 10 slowest to compile:");
  for (const r of slowestByCompile.slice(0, 10)) {
    console.log(`    ${r.timing!.compileMs.toFixed(0).padStart(6)}ms  ${r.file}`);
  }
  console.log("");
  console.log("  Slowest categories (avg compile ms):");
  for (const c of categoryTimingSorted.slice(0, 10)) {
    console.log(`    ${c.avgCompileMs.toFixed(1).padStart(8)}ms  ${c.category}  (${c.count} tests)`);
  }
  console.log("────────────────────────────────────────────────────");
}

const failures = finalResults.filter(r => r.status === "fail");
if (failures.length > 0) {
  console.log(`\nFailing tests (${failures.length}):`);
  for (const f of failures) {
    console.log(`  ✗ ${f.file}: ${f.error}`);
  }
}

// Run completed successfully — promote run files to main paths (atomic for same-device)
try { copyFileSync(RUN_JSONL, JSONL_PATH); } catch {}
try { copyFileSync(RUN_REPORT, REPORT_PATH); } catch {}

// Save result cache for future runs
saveCache();
console.log(`Saved ${resultCache.size} entries to result cache`);

// Mark run as complete
writeFileSync(META_PATH, JSON.stringify({ gitHead: getGitHead(), status: "complete", finishedAt: new Date().toISOString() }));

console.log(`\nResults: ${JSONL_PATH}`);
console.log(`Report:  ${REPORT_PATH}`);
console.log(`Run:     ${RUN_JSONL}`);
