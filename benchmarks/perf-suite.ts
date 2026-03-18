#!/usr/bin/env npx tsx
/**
 * Performance benchmark suite for ts2wasm.
 *
 * Compiles TypeScript workloads to WebAssembly, runs both JS and Wasm versions,
 * measures execution time over 10 iterations, and reports speedup ratios.
 *
 * Workloads:
 *   1. Fibonacci (recursive, n=35)         - pure computation
 *   2. Quicksort (10,000 elements)          - array manipulation
 *   3. Matrix multiply (100x100)            - numeric compute
 *   4. Sieve of Eratosthenes (100,000)      - array + conditionals
 *   5. Binary search (1M array, 10K lookups) - branching
 *
 * Usage:
 *   npx tsx benchmarks/perf-suite.ts
 *   npx tsx benchmarks/perf-suite.ts --iterations 20
 *   npx tsx benchmarks/perf-suite.ts --filter fibonacci
 */

import { compile, buildImports, instantiateWasm } from "../src/index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const ITERATIONS = parseInt(getArg("iterations") ?? "10", 10);
const WARMUP = 3;
const nameFilter = getArg("filter");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchResult {
  name: string;
  jsTimings: number[];
  wasmTimings: number[];
  jsMedian: number;
  wasmMedian: number;
  speedup: number;
  binarySize: number;
  compileMs: number;
}

interface Workload {
  name: string;
  description: string;
  /** TypeScript source that exports a `run(): number` function. */
  source: string;
  /** Equivalent JS function for baseline measurement. */
  js: () => number;
}

// ---------------------------------------------------------------------------
// JS baseline implementations
// ---------------------------------------------------------------------------

function fibonacciJS(): number {
  function fib(n: number): number {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
  }
  return fib(35);
}

function quicksortJS(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) {
    arr.push((i * 2654435761 + 13) % 10000);
  }

  function qsort(a: number[], lo: number, hi: number): void {
    if (lo >= hi) return;
    const pivot = a[Math.floor((lo + hi) / 2)]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i]! < pivot) i++;
      while (a[j]! > pivot) j--;
      if (i <= j) {
        const tmp = a[i]!;
        a[i] = a[j]!;
        a[j] = tmp;
        i++;
        j--;
      }
    }
    if (lo < j) qsort(a, lo, j);
    if (i < hi) qsort(a, i, hi);
  }

  qsort(arr, 0, arr.length - 1);
  return arr[0]!;
}

function matrixMultiplyJS(): number {
  const N = 100;
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < N * N; i++) {
    a.push(((i * 7 + 3) % 100) / 100);
    b.push(((i * 13 + 5) % 100) / 100);
    c.push(0);
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let sum = 0;
      for (let k = 0; k < N; k++) {
        sum += a[i * N + k]! * b[k * N + j]!;
      }
      c[i * N + j] = sum;
    }
  }
  return c[0]!;
}

function sieveJS(): number {
  const N = 100000;
  const isPrime: number[] = [];
  for (let i = 0; i < N; i++) isPrime.push(1);
  isPrime[0] = 0;
  isPrime[1] = 0;
  for (let i = 2; i * i < N; i++) {
    if (isPrime[i]) {
      for (let j = i * i; j < N; j += i) {
        isPrime[j] = 0;
      }
    }
  }
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (isPrime[i]) count++;
  }
  return count;
}

function binarySearchJS(): number {
  const N = 1000000;
  const arr: number[] = [];
  for (let i = 0; i < N; i++) arr.push(i * 2);

  function search(a: number[], target: number): number {
    let lo = 0;
    let hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const val = a[mid]!;
      if (val === target) return mid;
      if (val < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  let found = 0;
  for (let i = 0; i < 10000; i++) {
    const target = ((i * 7919) % N) * 2;
    if (search(arr, target) >= 0) found++;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Workload definitions
// ---------------------------------------------------------------------------

const workloads: Workload[] = [
  {
    name: "fibonacci-recursive",
    description: "Recursive fibonacci (n=35) - pure computation",
    js: fibonacciJS,
    source: `
function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

export function run(): number {
  return fib(35);
}`,
  },
  {
    name: "quicksort",
    description: "Quicksort on 10,000 elements - array manipulation",
    js: quicksortJS,
    source: `
function qsort(a: number[], lo: number, hi: number): void {
  if (lo >= hi) return;
  const mid = (lo + hi) / 2;
  const midFloor = mid - mid % 1;
  const pivot = a[midFloor];
  let i = lo;
  let j = hi;
  while (i <= j) {
    while (a[i] < pivot) i = i + 1;
    while (a[j] > pivot) j = j - 1;
    if (i <= j) {
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
      i = i + 1;
      j = j - 1;
    }
  }
  if (lo < j) qsort(a, lo, j);
  if (i < hi) qsort(a, i, hi);
}

export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push((i * 2654435761 + 13) % 10000);
  }
  qsort(arr, 0, arr.length - 1);
  return arr[0];
}`,
  },
  {
    name: "matrix-multiply",
    description: "100x100 matrix multiply - numeric compute",
    js: matrixMultiplyJS,
    source: `
export function run(): number {
  const N = 100;
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < N * N; i = i + 1) {
    a.push(((i * 7 + 3) % 100) / 100);
    b.push(((i * 13 + 5) % 100) / 100);
    c.push(0);
  }
  for (let i = 0; i < N; i = i + 1) {
    for (let j = 0; j < N; j = j + 1) {
      let sum = 0;
      for (let k = 0; k < N; k = k + 1) {
        sum = sum + a[i * N + k] * b[k * N + j];
      }
      c[i * N + j] = sum;
    }
  }
  return c[0];
}`,
  },
  {
    name: "sieve-eratosthenes",
    description: "Primes up to 100,000 - array + conditionals",
    js: sieveJS,
    source: `
export function run(): number {
  const N = 100000;
  const isPrime: number[] = [];
  for (let i = 0; i < N; i = i + 1) {
    isPrime.push(1);
  }
  isPrime[0] = 0;
  isPrime[1] = 0;
  for (let i = 2; i * i < N; i = i + 1) {
    if (isPrime[i] === 1) {
      for (let j = i * i; j < N; j = j + i) {
        isPrime[j] = 0;
      }
    }
  }
  let count = 0;
  for (let i = 0; i < N; i = i + 1) {
    if (isPrime[i] === 1) count = count + 1;
  }
  return count;
}`,
  },
  {
    name: "binary-search",
    description: "1M element array, 10K lookups - branching",
    js: binarySearchJS,
    source: `
function search(a: number[], target: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const val = a[mid];
    if (val === target) return mid;
    if (val < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function run(): number {
  const N = 1000000;
  const arr: number[] = [];
  for (let i = 0; i < N; i = i + 1) {
    arr.push(i * 2);
  }
  let found = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    const target = ((i * 7919) % N) * 2;
    if (search(arr, target) >= 0) found = found + 1;
  }
  return found;
}`,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function fmtMs(ms: number): string {
  if (ms < 0.01) return ms.toFixed(4) + "ms";
  if (ms < 1) return ms.toFixed(3) + "ms";
  if (ms < 100) return ms.toFixed(2) + "ms";
  return ms.toFixed(1) + "ms";
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

function fmtSpeedup(ratio: number): string {
  if (ratio >= 1) return `${ratio.toFixed(2)}x faster`;
  return `${(1 / ratio).toFixed(2)}x slower`;
}

// ---------------------------------------------------------------------------
// Compile and instantiate a workload
// ---------------------------------------------------------------------------

async function compileWorkload(
  source: string,
): Promise<{ run: () => number; binarySize: number; compileMs: number }> {
  const t0 = performance.now();
  const result = compile(source, { fast: false });
  const compileMs = performance.now() - t0;

  if (!result.success) {
    throw new Error(
      "Compilation failed:\n" +
        result.errors.map((e: { message: string }) => `  ${e.message}`).join("\n"),
    );
  }

  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
  );
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }

  const run = (instance.exports as Record<string, Function>).run;
  if (!run) {
    throw new Error('No "run" export found in compiled module');
  }

  return {
    run: run as () => number,
    binarySize: result.binary.byteLength,
    compileMs,
  };
}

// ---------------------------------------------------------------------------
// Run a single workload
// ---------------------------------------------------------------------------

async function runWorkload(workload: Workload): Promise<BenchResult | null> {
  // Compile TS to Wasm
  let wasmRun: () => number;
  let binarySize: number;
  let compileMs: number;

  try {
    const compiled = await compileWorkload(workload.source);
    wasmRun = compiled.run;
    binarySize = compiled.binarySize;
    compileMs = compiled.compileMs;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [SKIP] ${workload.name}: compilation failed`);
    console.error(`         ${msg.split("\n")[0]}`);
    return null;
  }

  // Warmup JS
  try {
    for (let i = 0; i < WARMUP; i++) workload.js();
  } catch {
    console.error(`  [SKIP] ${workload.name}: JS warmup failed`);
    return null;
  }

  // Warmup Wasm
  try {
    for (let i = 0; i < WARMUP; i++) wasmRun();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [SKIP] ${workload.name}: Wasm warmup failed`);
    console.error(`         ${msg.split("\n")[0]}`);
    return null;
  }

  // Timed JS runs
  const jsTimings: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    workload.js();
    jsTimings.push(performance.now() - t0);
  }

  // Timed Wasm runs
  const wasmTimings: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    wasmRun();
    wasmTimings.push(performance.now() - t0);
  }

  const jsMedian = median(jsTimings);
  const wasmMedian = median(wasmTimings);
  const speedup = jsMedian / wasmMedian;

  return {
    name: workload.name,
    jsTimings,
    wasmTimings,
    jsMedian,
    wasmMedian,
    speedup,
    binarySize,
    compileMs,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printReport(results: BenchResult[]): void {
  const SEP = "-".repeat(100);

  console.log("\n" + SEP);
  console.log("  PERFORMANCE BENCHMARK RESULTS");
  console.log(SEP);
  console.log(`  Date:       ${new Date().toISOString()}`);
  console.log(`  Node:       ${process.version}`);
  console.log(`  Platform:   ${process.platform} ${process.arch}`);
  console.log(`  Iterations: ${ITERATIONS} (warmup: ${WARMUP})`);
  console.log(SEP);

  // Header
  console.log(
    "\n  " +
      "Workload".padEnd(25) +
      "JS (median)".padStart(14) +
      "Wasm (median)".padStart(16) +
      "Speedup".padStart(16) +
      "Binary".padStart(10) +
      "Compile".padStart(12),
  );
  console.log("  " + "-".repeat(93));

  for (const r of results) {
    const speedupStr = fmtSpeedup(r.speedup);
    console.log(
      "  " +
        r.name.padEnd(25) +
        fmtMs(r.jsMedian).padStart(14) +
        fmtMs(r.wasmMedian).padStart(16) +
        speedupStr.padStart(16) +
        fmtSize(r.binarySize).padStart(10) +
        fmtMs(r.compileMs).padStart(12),
    );
  }

  console.log("");

  // Per-workload detail
  for (const r of results) {
    const jsSorted = [...r.jsTimings].sort((a, b) => a - b);
    const wasmSorted = [...r.wasmTimings].sort((a, b) => a - b);

    console.log(`  ${r.name}:`);
    console.log(
      `    JS   - min: ${fmtMs(jsSorted[0]!)}  median: ${fmtMs(r.jsMedian)}  max: ${fmtMs(jsSorted[jsSorted.length - 1]!)}`,
    );
    console.log(
      `    Wasm - min: ${fmtMs(wasmSorted[0]!)}  median: ${fmtMs(r.wasmMedian)}  max: ${fmtMs(wasmSorted[wasmSorted.length - 1]!)}`,
    );
    console.log(
      `    Speedup: ${fmtSpeedup(r.speedup)}  |  Binary: ${fmtSize(r.binarySize)}  |  Compile: ${fmtMs(r.compileMs)}`,
    );
    console.log("");
  }

  // Summary
  const avgSpeedup =
    results.reduce((sum, r) => sum + r.speedup, 0) / results.length;
  const geomSpeedup = Math.pow(
    results.reduce((prod, r) => prod * r.speedup, 1),
    1 / results.length,
  );

  console.log(SEP);
  console.log(`  Average speedup (arithmetic): ${avgSpeedup.toFixed(2)}x`);
  console.log(`  Average speedup (geometric):  ${geomSpeedup.toFixed(2)}x`);
  console.log(SEP);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("ts2wasm Performance Benchmark Suite");
  console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
  console.log(`Iterations: ${ITERATIONS} | Warmup: ${WARMUP}`);

  let selected = workloads;
  if (nameFilter) {
    selected = workloads.filter((w) =>
      w.name.toLowerCase().includes(nameFilter.toLowerCase()),
    );
    if (selected.length === 0) {
      console.error(`No workloads match filter: "${nameFilter}"`);
      process.exit(1);
    }
    console.log(`Filter: ${nameFilter} (${selected.length} workloads)`);
  }

  console.log(`\nRunning ${selected.length} workloads...\n`);

  const results: BenchResult[] = [];

  for (const workload of selected) {
    process.stdout.write(`  ${workload.name} (${workload.description}) ...`);
    const result = await runWorkload(workload);
    if (result) {
      results.push(result);
      console.log(
        ` JS: ${fmtMs(result.jsMedian)} | Wasm: ${fmtMs(result.wasmMedian)} | ${fmtSpeedup(result.speedup)}`,
      );
    } else {
      console.log(" SKIPPED");
    }
  }

  if (results.length === 0) {
    console.log("\nNo workloads completed successfully.");
    process.exit(1);
  }

  printReport(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
