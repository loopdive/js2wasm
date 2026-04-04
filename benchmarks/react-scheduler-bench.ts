/**
 * React Scheduler Min-Heap Benchmark: JS vs WasmGC
 *
 * Compares performance of the React scheduler min-heap implementation
 * running natively in JS vs compiled to WasmGC via js2wasm.
 *
 * Usage: npx tsx benchmarks/react-scheduler-bench.ts
 */

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const N = 10_000; // number of tasks to push/pop
const RUNS = 10; // number of benchmark iterations

// ---------------------------------------------------------------------------
// Pre-generate random priorities (shared between JS and Wasm)
// ---------------------------------------------------------------------------
function generatePriorities(n: number, seed: number): number[] {
  // xorshift32
  let state = seed;
  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    result.push((state >>> 0) % 100_000);
  }
  return result;
}

// ---------------------------------------------------------------------------
// JS min-heap implementation (same algorithm as the Wasm version)
// ---------------------------------------------------------------------------
class HeapNode {
  id: number;
  sortIndex: number;
  constructor(id: number, sortIndex: number) {
    this.id = id;
    this.sortIndex = sortIndex;
  }
}

let jsHeap: (HeapNode | null)[] = [];
let jsHeapSize = 0;

function jsCompare(a: HeapNode, b: HeapNode): number {
  const diff = a.sortIndex - b.sortIndex;
  if (diff !== 0) return diff;
  return a.id - b.id;
}

function jsPush(node: HeapNode): void {
  const index = jsHeapSize;
  jsHeap[index] = node;
  jsHeapSize++;
  jsSiftUp(index);
}

function jsSiftUp(startIndex: number): void {
  let index = startIndex;
  while (index > 0) {
    const parentIndex = (index - 1) >> 1;
    const parent = jsHeap[parentIndex]!;
    const node = jsHeap[index]!;
    if (jsCompare(parent, node) > 0) {
      jsHeap[parentIndex] = node;
      jsHeap[index] = parent;
      index = parentIndex;
    } else {
      break;
    }
  }
}

function jsPopSort(): number {
  if (jsHeapSize === 0) return -1;
  const first = jsHeap[0]!;
  const firstSort = first.sortIndex;
  jsHeapSize--;
  if (jsHeapSize === 0) {
    return firstSort;
  }
  const last = jsHeap[jsHeapSize]!;
  jsHeap[0] = last;
  jsSiftDown(0);
  return firstSort;
}

function jsSiftDown(startIndex: number): void {
  let index = startIndex;
  const length = jsHeapSize;
  const halfLength = length >> 1;
  while (index < halfLength) {
    const leftIndex = 2 * (index + 1) - 1;
    const left = jsHeap[leftIndex]!;
    const rightIndex = leftIndex + 1;
    const node = jsHeap[index]!;

    if (jsCompare(left, node) < 0) {
      if (rightIndex < length) {
        const right = jsHeap[rightIndex]!;
        if (jsCompare(right, left) < 0) {
          jsHeap[index] = right;
          jsHeap[rightIndex] = node;
          index = rightIndex;
        } else {
          jsHeap[index] = left;
          jsHeap[leftIndex] = node;
          index = leftIndex;
        }
      } else {
        jsHeap[index] = left;
        jsHeap[leftIndex] = node;
        index = leftIndex;
      }
    } else if (rightIndex < length) {
      const right = jsHeap[rightIndex]!;
      if (jsCompare(right, node) < 0) {
        jsHeap[index] = right;
        jsHeap[rightIndex] = node;
        index = rightIndex;
      } else {
        break;
      }
    } else {
      break;
    }
  }
}

function jsReset(): void {
  jsHeap = [];
  jsHeapSize = 0;
}

// ---------------------------------------------------------------------------
// Wasm source: min-heap with exported push/pop/reset functions
// ---------------------------------------------------------------------------
const WASM_SOURCE = `
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

export function pushItem(id: number, sortIndex: number): void {
  const node = new HeapNode(id, sortIndex);
  const index = heapSize;
  heap[index] = node;
  heapSize = heapSize + 1;
  siftUp(index);
}

export function popSort(): number {
  if (heapSize === 0) return -1;
  const first: HeapNode | null = heap[0];
  if (first === null) return -1;
  const firstSort = first.sortIndex;
  heapSize = heapSize - 1;
  if (heapSize === 0) {
    return firstSort;
  }
  const last: HeapNode | null = heap[heapSize];
  heap[0] = last;
  siftDown(0);
  return firstSort;
}

export function resetHeap(): void {
  heap = [];
  heapSize = 0;
}

// Internal benchmark: push N items then pop all, no boundary crossing.
// Uses a simple LCG PRNG that avoids bitwise ops (which behave differently in Wasm f64).
export function benchmarkInternal(n: number, seed: number): number {
  heap = [];
  heapSize = 0;

  let rng = seed;
  let i = 0;
  while (i < n) {
    // LCG: next = (a * rng + c) mod m, using values that stay in safe integer range
    rng = (rng * 1103 + 12345) % 100000;
    const priority = rng;
    const node = new HeapNode(i, priority);
    const idx = heapSize;
    heap[idx] = node;
    heapSize = heapSize + 1;
    siftUp(idx);
    i = i + 1;
  }

  let checksum: number = 0;
  let j = 0;
  while (j < n) {
    const val = popSort();
    checksum = checksum + val;
    j = j + 1;
  }
  return checksum;
}

// Dummy test export for compatibility
export function test(): number { return 1; }
`;

// ---------------------------------------------------------------------------
// Timing utilities
// ---------------------------------------------------------------------------
function stats(times: number[]): { avg: number; min: number; max: number } {
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { avg, min, max };
}

// ---------------------------------------------------------------------------
// Main benchmark
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== React Scheduler Min-Heap Benchmark ===");
  console.log(`  Items: ${N.toLocaleString()}`);
  console.log(`  Runs:  ${RUNS}`);
  console.log();

  // --- Compile Wasm ---
  console.log("Compiling TypeScript to WasmGC...");
  const compileStart = performance.now();
  const result = compile(WASM_SOURCE, { fast: true });
  const compileTime = performance.now() - compileStart;

  if (!result.success) {
    console.error("Compilation failed:");
    for (const e of result.errors) {
      console.error(`  L${e.line}: ${e.message}`);
    }
    if (result.wat) {
      console.error("\nGenerated WAT (partial):");
      console.error(result.wat.slice(0, 2000));
    }
    process.exit(1);
  }
  console.log(`  Compile time: ${compileTime.toFixed(1)}ms`);
  console.log(`  Wasm binary size: ${result.binary.byteLength.toLocaleString()} bytes`);

  // --- Instantiate Wasm ---
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const wasmExports = instance.exports as {
    pushItem: (id: number, sortIndex: number) => void;
    popSort: () => number;
    resetHeap: () => void;
    benchmarkInternal: (n: number, seed: number) => number;
  };

  if (typeof wasmExports.pushItem !== "function") {
    console.error("ERROR: pushItem not found in Wasm exports");
    console.error("Available exports:", Object.keys(instance.exports));
    process.exit(1);
  }

  console.log();

  // --- Pre-generate priorities for each run ---
  const allPriorities: number[][] = [];
  for (let i = 0; i < RUNS; i++) {
    allPriorities.push(generatePriorities(N, 12345 + i));
  }

  // --- Warmup ---
  console.log("Warming up...");
  const warmupPriorities = generatePriorities(1000, 99999);
  for (let w = 0; w < 3; w++) {
    // JS warmup
    jsReset();
    for (let i = 0; i < 1000; i++) jsPush(new HeapNode(i, warmupPriorities[i]));
    for (let i = 0; i < 1000; i++) jsPopSort();

    // Wasm warmup
    wasmExports.resetHeap();
    for (let i = 0; i < 1000; i++) wasmExports.pushItem(i, warmupPriorities[i]);
    for (let i = 0; i < 1000; i++) wasmExports.popSort();
  }

  // --- Benchmark JS ---
  console.log("Running JS benchmark...");
  const jsTimes: number[] = [];
  const jsChecksums: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const priorities = allPriorities[run];
    const start = performance.now();

    jsReset();
    for (let i = 0; i < N; i++) {
      jsPush(new HeapNode(i, priorities[i]));
    }
    let checksum = 0;
    for (let j = 0; j < N; j++) {
      checksum += jsPopSort();
    }

    const elapsed = performance.now() - start;
    jsTimes.push(elapsed);
    jsChecksums.push(checksum);
  }

  // --- Benchmark Wasm ---
  console.log("Running Wasm benchmark...");
  const wasmTimes: number[] = [];
  const wasmChecksums: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const priorities = allPriorities[run];
    const start = performance.now();

    wasmExports.resetHeap();
    for (let i = 0; i < N; i++) {
      wasmExports.pushItem(i, priorities[i]);
    }
    let checksum = 0;
    for (let j = 0; j < N; j++) {
      checksum += wasmExports.popSort();
    }

    const elapsed = performance.now() - start;
    wasmTimes.push(elapsed);
    wasmChecksums.push(checksum);
  }

  // --- Verify correctness ---
  let correct = true;
  for (let i = 0; i < RUNS; i++) {
    if (jsChecksums[i] !== wasmChecksums[i]) {
      console.error(`CHECKSUM MISMATCH at run ${i}: JS=${jsChecksums[i]}, Wasm=${wasmChecksums[i]}`);
      correct = false;
    }
  }

  // --- Also verify ordering is correct for first run ---
  {
    const priorities = allPriorities[0];
    jsReset();
    for (let i = 0; i < N; i++) jsPush(new HeapNode(i, priorities[i]));
    let prev = -1;
    let orderCorrect = true;
    for (let j = 0; j < N; j++) {
      const val = jsPopSort();
      if (val < prev) {
        console.error(`ORDER VIOLATION at position ${j}: ${val} < ${prev}`);
        orderCorrect = false;
        break;
      }
      prev = val;
    }
    if (orderCorrect) {
      console.log("  Heap ordering verified: elements come out in sorted order.");
    }
  }

  // --- Results ---
  const jsStats = stats(jsTimes);
  const wasmStats = stats(wasmTimes);

  console.log();
  console.log("=== Results ===");
  console.log();
  console.log(
    `  JS   avg: ${jsStats.avg.toFixed(2)}ms  min: ${jsStats.min.toFixed(2)}ms  max: ${jsStats.max.toFixed(2)}ms`,
  );
  console.log(
    `  Wasm avg: ${wasmStats.avg.toFixed(2)}ms  min: ${wasmStats.min.toFixed(2)}ms  max: ${wasmStats.max.toFixed(2)}ms`,
  );
  console.log();

  const ratio = jsStats.avg / wasmStats.avg;
  if (ratio > 1) {
    console.log(`  Wasm is ${ratio.toFixed(2)}x FASTER than JS`);
  } else {
    console.log(`  JS is ${(1 / ratio).toFixed(2)}x FASTER than Wasm`);
  }

  console.log();
  console.log(`  Correctness: ${correct ? "PASS (all checksums match)" : "FAIL"}`);
  console.log();

  // Per-run details
  console.log("  Per-run times (ms):");
  console.log("  Run   JS        Wasm      Ratio");
  console.log("  ---   --------  --------  -----");
  for (let i = 0; i < RUNS; i++) {
    const r = jsTimes[i] / wasmTimes[i];
    console.log(
      `  ${String(i + 1).padStart(3)}   ${jsTimes[i].toFixed(2).padStart(8)}  ${wasmTimes[i].toFixed(2).padStart(8)}  ${r.toFixed(2)}x`,
    );
  }

  // =========================================================================
  // Internal benchmark: full workload inside Wasm (no boundary crossing)
  // =========================================================================
  console.log();
  console.log("=== Internal Benchmark (no JS<->Wasm boundary crossing) ===");
  console.log();

  // JS internal: same LCG as the Wasm benchmarkInternal
  function jsInternalBenchmark(n: number, seed: number): number {
    jsReset();
    let rng = seed;
    for (let i = 0; i < n; i++) {
      rng = (rng * 1103 + 12345) % 100000;
      jsPush(new HeapNode(i, rng));
    }
    let checksum = 0;
    for (let j = 0; j < n; j++) {
      checksum += jsPopSort();
    }
    return checksum;
  }

  // Warmup internal
  for (let w = 0; w < 3; w++) {
    jsInternalBenchmark(1000, 42);
    if (typeof wasmExports.benchmarkInternal === "function") {
      wasmExports.benchmarkInternal(1000, 42);
    }
  }

  if (typeof wasmExports.benchmarkInternal === "function") {
    // Verify checksums match
    const jsCheck = jsInternalBenchmark(N, 77777);
    const wasmCheck = wasmExports.benchmarkInternal(N, 77777);
    const internalCorrect = jsCheck === wasmCheck;

    const jsInternalTimes: number[] = [];
    const wasmInternalTimes: number[] = [];

    console.log("Running JS internal benchmark...");
    for (let run = 0; run < RUNS; run++) {
      const seed = 54321 + run;
      const start = performance.now();
      jsInternalBenchmark(N, seed);
      jsInternalTimes.push(performance.now() - start);
    }

    console.log("Running Wasm internal benchmark...");
    for (let run = 0; run < RUNS; run++) {
      const seed = 54321 + run;
      const start = performance.now();
      wasmExports.benchmarkInternal(N, seed);
      wasmInternalTimes.push(performance.now() - start);
    }

    const jsIntStats = stats(jsInternalTimes);
    const wasmIntStats = stats(wasmInternalTimes);

    console.log();
    console.log(
      `  JS   avg: ${jsIntStats.avg.toFixed(2)}ms  min: ${jsIntStats.min.toFixed(2)}ms  max: ${jsIntStats.max.toFixed(2)}ms`,
    );
    console.log(
      `  Wasm avg: ${wasmIntStats.avg.toFixed(2)}ms  min: ${wasmIntStats.min.toFixed(2)}ms  max: ${wasmIntStats.max.toFixed(2)}ms`,
    );
    console.log();

    const intRatio = jsIntStats.avg / wasmIntStats.avg;
    if (intRatio > 1) {
      console.log(`  Wasm is ${intRatio.toFixed(2)}x FASTER than JS (internal)`);
    } else {
      console.log(`  JS is ${(1 / intRatio).toFixed(2)}x FASTER than Wasm (internal)`);
    }

    console.log();
    console.log(
      `  Correctness: ${internalCorrect ? "PASS (checksums match)" : `FAIL (JS=${jsCheck}, Wasm=${wasmCheck})`}`,
    );
    console.log();

    console.log("  Per-run times (ms):");
    console.log("  Run   JS        Wasm      Ratio");
    console.log("  ---   --------  --------  -----");
    for (let i = 0; i < RUNS; i++) {
      const r = jsInternalTimes[i] / wasmInternalTimes[i];
      console.log(
        `  ${String(i + 1).padStart(3)}   ${jsInternalTimes[i].toFixed(2).padStart(8)}  ${wasmInternalTimes[i].toFixed(2).padStart(8)}  ${r.toFixed(2)}x`,
      );
    }
  } else {
    console.log("  benchmarkInternal not available in Wasm exports, skipping.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
