#!/usr/bin/env npx tsx
/**
 * Combined benchmark runner for js2wasm.
 *
 * Runs all benchmark suites and produces a single combined JSON report:
 *   1. Suite benchmarks (strings, arrays, dom, mixed) via benchmarks/run.ts harness
 *   2. Performance suite (fibonacci, quicksort, matrix, sieve, binary-search)
 *   3. React scheduler min-heap benchmark
 *
 * Output: benchmarks/results/benchmark-latest.json
 *
 * Usage:
 *   npx tsx scripts/run-benchmarks.ts
 *   npx tsx scripts/run-benchmarks.ts --iterations 10
 *   npx tsx scripts/run-benchmarks.ts --skip-suites        # skip harness suites
 *   npx tsx scripts/run-benchmarks.ts --skip-perf           # skip perf suite
 *   npx tsx scripts/run-benchmarks.ts --skip-react          # skip react scheduler
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { compile, buildImports, instantiateWasm } from "../src/index.js";
import { runSuite, type BenchmarkResult, type Strategy } from "../benchmarks/harness.js";
import { stringBenchmarks } from "../benchmarks/suites/strings.js";
import { arrayBenchmarks } from "../benchmarks/suites/arrays.js";
import { domBenchmarks } from "../benchmarks/suites/dom.js";
import { mixedBenchmarks } from "../benchmarks/suites/mixed.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const ITERATIONS = parseInt(getArg("iterations") ?? "5", 10);
const WARMUP = 3;
const skipSuites = hasFlag("skip-suites");
const skipPerf = hasFlag("skip-perf");
const skipReact = hasFlag("skip-react");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PerfBenchResult {
  name: string;
  category: string;
  jsMedianMs: number;
  wasmMedianMs: number;
  speedup: number;
  binarySize: number;
  compileMs: number;
}

interface ReactBenchResult {
  name: string;
  category: string;
  jsAvgMs: number;
  wasmAvgMs: number;
  speedup: number;
  correct: boolean;
  binarySize: number;
  compileMs: number;
}

interface CombinedReport {
  timestamp: string;
  node: string;
  platform: string;
  iterations: number;
  suites?: BenchmarkResult[];
  perf?: PerfBenchResult[];
  react?: ReactBenchResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Perf suite workloads (inline to avoid import issues)
// ---------------------------------------------------------------------------

interface Workload {
  name: string;
  source: string;
  js: () => number;
}

function fibonacciJS(): number {
  function fib(n: number): number {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
  }
  return fib(35);
}

function quicksortJS(): number {
  const arr: number[] = [];
  for (let i = 0; i < 1000; i++) arr.push((i * 2654435761 + 13) % 1000);
  function qsort(a: number[], lo: number, hi: number): void {
    if (lo >= hi) return;
    const pivot = a[Math.floor((lo + hi) / 2)]!;
    let i = lo,
      j = hi;
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

function sieveJS(): number {
  const N = 10000;
  const isPrime: number[] = [];
  for (let i = 0; i < N; i++) isPrime.push(1);
  isPrime[0] = 0;
  isPrime[1] = 0;
  for (let i = 2; i * i < N; i++) {
    if (isPrime[i]) {
      for (let j = i * i; j < N; j += i) isPrime[j] = 0;
    }
  }
  let count = 0;
  for (let i = 0; i < N; i++) if (isPrime[i]) count++;
  return count;
}

const perfWorkloads: Workload[] = [
  {
    name: "fibonacci-recursive",
    js: fibonacciJS,
    source: `
function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}
export function run(): number { return fib(35); }`,
  },
  {
    name: "quicksort",
    js: quicksortJS,
    source: `
function qsort(a: number[], lo: number, hi: number): void {
  if (lo >= hi) return;
  const mid = (lo + hi) / 2;
  const midFloor = mid - mid % 1;
  const pivot = a[midFloor];
  let i = lo; let j = hi;
  while (i <= j) {
    while (a[i] < pivot) i = i + 1;
    while (a[j] > pivot) j = j - 1;
    if (i <= j) { const tmp = a[i]; a[i] = a[j]; a[j] = tmp; i = i + 1; j = j - 1; }
  }
  if (lo < j) qsort(a, lo, j);
  if (i < hi) qsort(a, i, hi);
}
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 1000; i = i + 1) arr.push((i * 2654435761 + 13) % 1000);
  qsort(arr, 0, arr.length - 1);
  return arr[0];
}`,
  },
  {
    name: "sieve-eratosthenes",
    js: sieveJS,
    source: `
export function run(): number {
  const N = 10000;
  const isPrime: number[] = [];
  for (let i = 0; i < N; i = i + 1) isPrime.push(1);
  isPrime[0] = 0; isPrime[1] = 0;
  for (let i = 2; i * i < N; i = i + 1) {
    if (isPrime[i] === 1) { for (let j = i * i; j < N; j = j + i) isPrime[j] = 0; }
  }
  let count = 0;
  for (let i = 0; i < N; i = i + 1) if (isPrime[i] === 1) count = count + 1;
  return count;
}`,
  },
];

async function runPerfSuite(): Promise<PerfBenchResult[]> {
  console.log("\n=== Performance Suite ===\n");
  const results: PerfBenchResult[] = [];

  for (const workload of perfWorkloads) {
    process.stdout.write(`  ${workload.name} ...`);

    try {
      const t0 = performance.now();
      const compileResult = compile(workload.source, { fast: false });
      const compileMs = performance.now() - t0;

      if (!compileResult.success) {
        console.log(" COMPILE FAILED");
        continue;
      }

      const imports = buildImports(compileResult.imports, {}, compileResult.stringPool);
      const { instance } = await instantiateWasm(compileResult.binary, imports.env, imports.string_constants);
      if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);

      const wasmRun = (instance.exports as Record<string, Function>).run as () => number;
      if (!wasmRun) {
        console.log(" NO run EXPORT");
        continue;
      }

      // Warmup
      for (let i = 0; i < WARMUP; i++) {
        workload.js();
        wasmRun();
      }

      // Timed runs
      const jsTimings: number[] = [];
      const wasmTimings: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        let t = performance.now();
        workload.js();
        jsTimings.push(performance.now() - t);
        t = performance.now();
        wasmRun();
        wasmTimings.push(performance.now() - t);
      }

      const jsMedian = median(jsTimings);
      const wasmMedian = median(wasmTimings);
      const speedup = jsMedian / wasmMedian;

      results.push({
        name: workload.name,
        category: "perf",
        jsMedianMs: jsMedian,
        wasmMedianMs: wasmMedian,
        speedup,
        binarySize: compileResult.binary.byteLength,
        compileMs,
      });

      const label = speedup >= 1 ? `${speedup.toFixed(2)}x faster` : `${(1 / speedup).toFixed(2)}x slower`;
      console.log(` JS: ${jsMedian.toFixed(3)}ms | Wasm: ${wasmMedian.toFixed(3)}ms | ${label}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(` ERROR: ${msg.split("\n")[0]}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// React scheduler benchmark (simplified)
// ---------------------------------------------------------------------------

const REACT_SOURCE = `
class HeapNode {
  id: number;
  sortIndex: number;
  constructor(id: number, sortIndex: number) {
    this.id = id;
    this.sortIndex = sortIndex;
  }
}

let heap: (HeapNode | null)[] = [];
let heapSize: number = 0;

function compare(a: HeapNode | null, b: HeapNode | null): number {
  if (a === null || b === null) return 0;
  const diff = a.sortIndex - b.sortIndex;
  if (diff !== 0) return diff;
  return a.id - b.id;
}

function siftUp(startIndex: number): void {
  let index = startIndex;
  while (index > 0) {
    const parentIndex = (index - 1) >> 1;
    const parent: HeapNode | null = heap[parentIndex];
    const node: HeapNode | null = heap[index];
    if (parent !== null && node !== null && compare(parent, node) > 0) {
      heap[parentIndex] = node;
      heap[index] = parent;
      index = parentIndex;
    } else {
      break;
    }
  }
}

function siftDown(startIndex: number): void {
  let index = startIndex;
  const length = heapSize;
  const halfLength = length >> 1;
  while (index < halfLength) {
    const leftIndex = 2 * (index + 1) - 1;
    const left: HeapNode | null = heap[leftIndex];
    const rightIndex = leftIndex + 1;
    const node: HeapNode | null = heap[index];

    if (left !== null && node !== null && compare(left, node) < 0) {
      if (rightIndex < length) {
        const right: HeapNode | null = heap[rightIndex];
        if (right !== null && compare(right, left) < 0) {
          heap[index] = right;
          heap[rightIndex] = node;
          index = rightIndex;
        } else {
          heap[index] = left;
          heap[leftIndex] = node;
          index = leftIndex;
        }
      } else {
        heap[index] = left;
        heap[leftIndex] = node;
        index = leftIndex;
      }
    } else if (rightIndex < length) {
      const right: HeapNode | null = heap[rightIndex];
      if (right !== null && node !== null && compare(right, node) < 0) {
        heap[index] = right;
        heap[rightIndex] = node;
        index = rightIndex;
      } else {
        break;
      }
    } else {
      break;
    }
  }
}

export function benchmarkInternal(n: number, seed: number): number {
  heap = [];
  heapSize = 0;

  let rng = seed;
  let i = 0;
  while (i < n) {
    rng = (rng * 1103 + 12345) % 100000;
    const node = new HeapNode(i, rng);
    const idx = heapSize;
    heap[idx] = node;
    heapSize = heapSize + 1;
    siftUp(idx);
    i = i + 1;
  }

  let checksum: number = 0;
  let j = 0;
  while (j < n) {
    if (heapSize === 0) break;
    const first: HeapNode | null = heap[0];
    if (first === null) break;
    const val = first.sortIndex;
    heapSize = heapSize - 1;
    if (heapSize > 0) {
      const last: HeapNode | null = heap[heapSize];
      heap[0] = last;
      siftDown(0);
    }
    checksum = checksum + val;
    j = j + 1;
  }
  return checksum;
}

export function test(): number { return 1; }
`;

// JS min-heap for baseline
class HeapNode {
  constructor(
    public id: number,
    public sortIndex: number,
  ) {}
}
let jsHeap: (HeapNode | null)[] = [];
let jsHeapSize = 0;

function jsCompare(a: HeapNode, b: HeapNode): number {
  const diff = a.sortIndex - b.sortIndex;
  return diff !== 0 ? diff : a.id - b.id;
}

function jsPush(node: HeapNode): void {
  jsHeap[jsHeapSize] = node;
  jsHeapSize++;
  let index = jsHeapSize - 1;
  while (index > 0) {
    const pi = (index - 1) >> 1;
    const p = jsHeap[pi]!,
      n = jsHeap[index]!;
    if (jsCompare(p, n) > 0) {
      jsHeap[pi] = n;
      jsHeap[index] = p;
      index = pi;
    } else break;
  }
}

function jsPopSort(): number {
  if (jsHeapSize === 0) return -1;
  const first = jsHeap[0]!;
  const val = first.sortIndex;
  jsHeapSize--;
  if (jsHeapSize === 0) return val;
  jsHeap[0] = jsHeap[jsHeapSize]!;
  // sift down
  let index = 0;
  const half = jsHeapSize >> 1;
  while (index < half) {
    const li = 2 * (index + 1) - 1,
      ri = li + 1;
    const left = jsHeap[li]!,
      node = jsHeap[index]!;
    if (jsCompare(left, node) < 0) {
      if (ri < jsHeapSize) {
        const right = jsHeap[ri]!;
        if (jsCompare(right, left) < 0) {
          jsHeap[index] = right;
          jsHeap[ri] = node;
          index = ri;
        } else {
          jsHeap[index] = left;
          jsHeap[li] = node;
          index = li;
        }
      } else {
        jsHeap[index] = left;
        jsHeap[li] = node;
        index = li;
      }
    } else if (ri < jsHeapSize) {
      const right = jsHeap[ri]!;
      if (jsCompare(right, node) < 0) {
        jsHeap[index] = right;
        jsHeap[ri] = node;
        index = ri;
      } else break;
    } else break;
  }
  return val;
}

function jsInternalBenchmark(n: number, seed: number): number {
  jsHeap = [];
  jsHeapSize = 0;
  let rng = seed;
  for (let i = 0; i < n; i++) {
    rng = (rng * 1103 + 12345) % 100000;
    jsPush(new HeapNode(i, rng));
  }
  let checksum = 0;
  for (let j = 0; j < n; j++) checksum += jsPopSort();
  return checksum;
}

async function runReactBench(): Promise<ReactBenchResult[]> {
  console.log("\n=== React Scheduler Min-Heap ===\n");
  const N = 10_000;

  try {
    const t0 = performance.now();
    const result = compile(REACT_SOURCE, { fast: true });
    const compileMs = performance.now() - t0;

    if (!result.success) {
      console.log("  COMPILE FAILED");
      return [];
    }

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const wasmExports = instance.exports as {
      benchmarkInternal: (n: number, seed: number) => number;
    };

    if (typeof wasmExports.benchmarkInternal !== "function") {
      console.log("  benchmarkInternal not available");
      return [];
    }

    // Warmup
    for (let w = 0; w < WARMUP; w++) {
      jsInternalBenchmark(1000, 42);
      wasmExports.benchmarkInternal(1000, 42);
    }

    // Verify correctness
    const jsCheck = jsInternalBenchmark(N, 77777);
    const wasmCheck = wasmExports.benchmarkInternal(N, 77777);
    const correct = jsCheck === wasmCheck;

    // Timed runs
    const jsTimes: number[] = [];
    const wasmTimes: number[] = [];
    for (let run = 0; run < ITERATIONS; run++) {
      const seed = 54321 + run;
      let t = performance.now();
      jsInternalBenchmark(N, seed);
      jsTimes.push(performance.now() - t);

      t = performance.now();
      wasmExports.benchmarkInternal(N, seed);
      wasmTimes.push(performance.now() - t);
    }

    const jsAvg = jsTimes.reduce((a, b) => a + b, 0) / jsTimes.length;
    const wasmAvg = wasmTimes.reduce((a, b) => a + b, 0) / wasmTimes.length;
    const speedup = jsAvg / wasmAvg;

    const label = speedup >= 1 ? `${speedup.toFixed(2)}x faster` : `${(1 / speedup).toFixed(2)}x slower`;
    console.log(`  JS avg: ${jsAvg.toFixed(2)}ms | Wasm avg: ${wasmAvg.toFixed(2)}ms | ${label}`);
    console.log(`  Correctness: ${correct ? "PASS" : "FAIL"}`);

    return [
      {
        name: "react-scheduler-minheap",
        category: "react",
        jsAvgMs: jsAvg,
        wasmAvgMs: wasmAvg,
        speedup,
        correct,
        binarySize: result.binary.byteLength,
        compileMs,
      },
    ];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ERROR: ${msg.split("\n")[0]}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("js2wasm Combined Benchmark Runner");
  console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
  console.log(`Iterations: ${ITERATIONS} | Warmup: ${WARMUP}`);

  const report: CombinedReport = {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    iterations: ITERATIONS,
  };

  // 1. Harness suites
  if (!skipSuites) {
    const suites: Record<string, any[]> = {
      strings: stringBenchmarks,
      arrays: arrayBenchmarks,
      dom: domBenchmarks,
      mixed: mixedBenchmarks,
    };

    const allSuiteResults: BenchmarkResult[] = [];
    for (const [name, defs] of Object.entries(suites)) {
      const results = await runSuite(name, defs);
      allSuiteResults.push(...results);
    }
    report.suites = allSuiteResults;
  }

  // 2. Perf suite
  if (!skipPerf) {
    report.perf = await runPerfSuite();
  }

  // 3. React scheduler
  if (!skipReact) {
    report.react = await runReactBench();
  }

  // Save combined report
  const outDir = path.resolve(import.meta.dirname, "../benchmarks/results");
  const outPath = path.join(outDir, "benchmark-latest.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nCombined report saved to ${outPath}`);

  // Print summary
  console.log("\n=== Summary ===\n");

  if (report.suites) {
    console.log(`  Suite benchmarks: ${report.suites.length} results`);
  }
  if (report.perf) {
    const faster = report.perf.filter((r) => r.speedup >= 1).length;
    console.log(`  Perf benchmarks:  ${report.perf.length} results (${faster} Wasm faster)`);
  }
  if (report.react) {
    for (const r of report.react) {
      const label =
        r.speedup >= 1 ? `Wasm ${r.speedup.toFixed(2)}x faster` : `JS ${(1 / r.speedup).toFixed(2)}x faster`;
      console.log(`  React scheduler:  ${label}, correct=${r.correct}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
