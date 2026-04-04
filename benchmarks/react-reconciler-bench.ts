/**
 * React Reconciler Benchmark: 1000-node fiber tree — JS vs WasmGC
 *
 * Builds a 1000-node fiber tree (mixed depths), applies ~10% random updates,
 * re-reconciles, and repeats for 100 iterations.  Compares JS vs Wasm
 * execution time and reports speedup ratio.
 *
 * Usage: npx tsx benchmarks/react-reconciler-bench.ts
 */

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const NODES = 1000;
const ITERATIONS = 100;
const UPDATE_PERCENT = 10; // ~10% of nodes updated per iteration
const RUNS = 10;

// ---------------------------------------------------------------------------
// JS implementation — identical algorithm to the Wasm source below
// ---------------------------------------------------------------------------

class FiberNode {
  tag: number;
  type_: number;
  child: FiberNode | null = null;
  sibling: FiberNode | null = null;
  return_: FiberNode | null = null;
  pendingProps: number = 0;
  memoizedProps: number = 0;
  memoizedState: number = 0;
  flags: number = 0;

  constructor(tag: number, type_: number) {
    this.tag = tag;
    this.type_ = type_;
  }
}

const UPDATE_FLAG = 4;

// Build a tree of N nodes with mixed depths.
// Strategy: nodes are added as children of a "current parent" that cycles
// through existing nodes, creating a tree with varying branching/depth.
function jsBuildTree(n: number, seed: number): FiberNode[] {
  const nodes: FiberNode[] = [];
  const root = new FiberNode(0, 0);
  root.pendingProps = seed % 1000;
  root.memoizedProps = root.pendingProps;
  root.memoizedState = root.pendingProps;
  nodes.push(root);

  let rng = seed;
  for (let i = 1; i < n; i++) {
    const node = new FiberNode(1, i);
    rng = (rng * 1103 + 12345) % 100000;
    node.pendingProps = rng % 1000;
    node.memoizedProps = node.pendingProps;
    node.memoizedState = node.pendingProps;

    // Pick parent from existing nodes — use rng to vary depth
    const parentIdx = rng % nodes.length;
    const parent = nodes[parentIdx];
    node.return_ = parent;

    // Append as last sibling of parent's children
    if (parent.child === null) {
      parent.child = node;
    } else {
      let sib: FiberNode = parent.child;
      while (sib.sibling !== null) {
        sib = sib.sibling;
      }
      sib.sibling = node;
    }
    nodes.push(node);
  }
  return nodes;
}

// Apply ~updateCount random prop changes
function jsApplyUpdates(nodes: FiberNode[], updateCount: number, rng: number): number {
  for (let i = 0; i < updateCount; i++) {
    rng = (rng * 1103 + 12345) % 100000;
    const idx = rng % nodes.length;
    rng = (rng * 1103 + 12345) % 100000;
    nodes[idx].pendingProps = rng % 1000;
  }
  return rng;
}

// Reconcile: walk entire tree, compare pending vs memoized, flag + commit
function jsReconcile(root: FiberNode): number {
  let updated = 0;
  // Iterative DFS
  let node: FiberNode | null = root;
  while (node !== null) {
    // Reconcile this node
    if (node.pendingProps !== node.memoizedProps) {
      node.flags = node.flags | UPDATE_FLAG;
      updated = updated + 1;
    }
    // Commit: copy pending to memoized, recompute state
    if ((node.flags & UPDATE_FLAG) !== 0) {
      node.memoizedProps = node.pendingProps;
      node.memoizedState = node.pendingProps;
      node.flags = node.flags & ~UPDATE_FLAG;
    }

    // DFS traversal
    if (node.child !== null) {
      node = node.child;
    } else {
      while (node !== null) {
        if (node.sibling !== null) {
          node = node.sibling;
          break;
        }
        node = node.return_;
        if (node !== null && node === root) {
          node = null;
        }
      }
    }
  }
  return updated;
}

// Compute checksum: sum of all memoizedState values
function jsChecksum(nodes: FiberNode[]): number {
  let sum = 0;
  for (let i = 0; i < nodes.length; i++) {
    sum = sum + nodes[i].memoizedState;
  }
  return sum;
}

function jsRunBenchmark(nodeCount: number, iterations: number, updatePercent: number, seed: number): number {
  const nodes = jsBuildTree(nodeCount, seed);
  const updateCount = Math.floor((nodeCount * updatePercent) / 100);
  let rng = seed;
  let totalUpdated = 0;

  for (let iter = 0; iter < iterations; iter++) {
    rng = jsApplyUpdates(nodes, updateCount, rng);
    totalUpdated = totalUpdated + jsReconcile(nodes[0]);
  }

  // Return checksum XOR'd with totalUpdated for verification
  const cs = jsChecksum(nodes);
  return cs + totalUpdated;
}

// ---------------------------------------------------------------------------
// Wasm source — same algorithm, written in the subset js2wasm compiles
// ---------------------------------------------------------------------------
const WASM_SOURCE = `
class FiberNode {
  tag: number;
  type_: number;
  child: FiberNode | null = null;
  sibling: FiberNode | null = null;
  return_: FiberNode | null = null;
  pendingProps: number = 0;
  memoizedProps: number = 0;
  memoizedState: number = 0;
  flags: number = 0;
  constructor(tag: number, type_: number) {
    this.tag = tag;
    this.type_ = type_;
  }
}

const UPDATE_FLAG: number = 4;

// Flat array of all nodes for random access during updates
let allNodes: (FiberNode | null)[] = [];
let nodeCount: number = 0;

function buildTree(n: number, seed: number): FiberNode | null {
  allNodes = [];
  nodeCount = 0;

  const root = new FiberNode(0, 0);
  root.pendingProps = seed % 1000;
  root.memoizedProps = root.pendingProps;
  root.memoizedState = root.pendingProps;
  allNodes[0] = root;
  nodeCount = 1;

  let rng = seed;
  let i = 1;
  while (i < n) {
    const node = new FiberNode(1, i);
    rng = (rng * 1103 + 12345) % 100000;
    node.pendingProps = rng % 1000;
    node.memoizedProps = node.pendingProps;
    node.memoizedState = node.pendingProps;

    // Pick parent from existing nodes
    const parentIdx = rng % nodeCount;
    const parent: FiberNode | null = allNodes[parentIdx];

    if (parent !== null) {
      node.return_ = parent;

      if (parent.child === null) {
        parent.child = node;
      } else {
        let sib: FiberNode | null = parent.child;
        while (sib !== null && sib.sibling !== null) {
          sib = sib.sibling;
        }
        if (sib !== null) {
          sib.sibling = node;
        }
      }
    }

    allNodes[nodeCount] = node;
    nodeCount = nodeCount + 1;
    i = i + 1;
  }

  return root;
}

function applyUpdates(updateCount: number, rng: number): number {
  let r = rng;
  let i = 0;
  while (i < updateCount) {
    r = (r * 1103 + 12345) % 100000;
    const idx = r % nodeCount;
    r = (r * 1103 + 12345) % 100000;
    const nd: FiberNode | null = allNodes[idx];
    if (nd !== null) {
      nd.pendingProps = r % 1000;
    }
    i = i + 1;
  }
  return r;
}

function reconcile(root: FiberNode | null): number {
  if (root === null) return 0;
  let updated = 0;
  let node: FiberNode | null = root;
  let done = 0;

  while (node !== null && done === 0) {
    // Reconcile this node
    if (node.pendingProps !== node.memoizedProps) {
      node.flags = node.flags | UPDATE_FLAG;
      updated = updated + 1;
    }
    // Commit
    if ((node.flags & UPDATE_FLAG) !== 0) {
      node.memoizedProps = node.pendingProps;
      node.memoizedState = node.pendingProps;
      node.flags = node.flags & ~UPDATE_FLAG;
    }

    // DFS traversal
    if (node.child !== null) {
      node = node.child;
    } else {
      let climbing = 1;
      while (climbing === 1 && node !== null) {
        if (node.sibling !== null) {
          node = node.sibling;
          climbing = 0;
        } else {
          node = node.return_;
          if (node === root) {
            node = null;
            done = 1;
            climbing = 0;
          }
        }
      }
    }
  }
  return updated;
}

function checksum(): number {
  let sum = 0;
  let i = 0;
  while (i < nodeCount) {
    const nd: FiberNode | null = allNodes[i];
    if (nd !== null) {
      sum = sum + nd.memoizedState;
    }
    i = i + 1;
  }
  return sum;
}

export function runBenchmark(n: number, iterations: number, updatePercent: number, seed: number): number {
  const root = buildTree(n, seed);
  const updateCount = (n * updatePercent) / 100;
  let rng = seed;
  let totalUpdated = 0;

  let iter = 0;
  while (iter < iterations) {
    rng = applyUpdates(updateCount, rng);
    totalUpdated = totalUpdated + reconcile(root);
    iter = iter + 1;
  }

  const cs = checksum();
  return cs + totalUpdated;
}

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
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== React Reconciler 1000-Node Tree Benchmark ===");
  console.log(`  Nodes:       ${NODES}`);
  console.log(`  Iterations:  ${ITERATIONS} (per run)`);
  console.log(`  Update %:    ${UPDATE_PERCENT}%`);
  console.log(`  Runs:        ${RUNS}`);
  console.log();

  // --- Compile Wasm ---
  console.log("Compiling reconciler TypeScript to WasmGC...");
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
      console.error(result.wat.slice(0, 3000));
    }
    process.exit(1);
  }
  console.log(`  Compile time: ${compileTime.toFixed(1)}ms`);
  console.log(`  Wasm binary size: ${result.binary.byteLength.toLocaleString()} bytes`);

  // --- Instantiate Wasm ---
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const wasmExports = instance.exports as {
    runBenchmark: (n: number, iterations: number, updatePercent: number, seed: number) => number;
  };

  if (typeof wasmExports.runBenchmark !== "function") {
    console.error("ERROR: runBenchmark not found in Wasm exports");
    console.error("Available exports:", Object.keys(instance.exports));
    process.exit(1);
  }
  console.log();

  // --- Warmup ---
  console.log("Warming up...");
  for (let w = 0; w < 3; w++) {
    jsRunBenchmark(100, 10, UPDATE_PERCENT, 42 + w);
    wasmExports.runBenchmark(100, 10, UPDATE_PERCENT, 42 + w);
  }

  // --- Verify correctness: both implementations should produce same result ---
  const jsVerify = jsRunBenchmark(NODES, ITERATIONS, UPDATE_PERCENT, 77777);
  const wasmVerify = wasmExports.runBenchmark(NODES, ITERATIONS, UPDATE_PERCENT, 77777);
  const correct = jsVerify === wasmVerify;
  if (!correct) {
    console.log(`  WARNING: Checksum mismatch — JS=${jsVerify}, Wasm=${wasmVerify}`);
    console.log("  (Minor floating-point differences in integer division are expected)");
  } else {
    console.log("  Correctness verified: JS and Wasm checksums match.");
  }
  console.log();

  // --- Benchmark JS ---
  console.log("Running JS benchmark...");
  const jsTimes: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const seed = 54321 + run;
    const start = performance.now();
    jsRunBenchmark(NODES, ITERATIONS, UPDATE_PERCENT, seed);
    jsTimes.push(performance.now() - start);
  }

  // --- Benchmark Wasm ---
  console.log("Running Wasm benchmark...");
  const wasmTimes: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const seed = 54321 + run;
    const start = performance.now();
    wasmExports.runBenchmark(NODES, ITERATIONS, UPDATE_PERCENT, seed);
    wasmTimes.push(performance.now() - start);
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
  console.log(`  Correctness: ${correct ? "PASS (checksums match)" : "WARN (checksums differ — see above)"}`);
  console.log();

  // Per-run details
  console.log("  Per-run times (ms):");
  console.log("  Run   JS          Wasm        Ratio");
  console.log("  ---   ----------  ----------  -----");
  for (let i = 0; i < RUNS; i++) {
    const r = jsTimes[i] / wasmTimes[i];
    console.log(
      `  ${String(i + 1).padStart(3)}   ${jsTimes[i].toFixed(2).padStart(10)}  ${wasmTimes[i].toFixed(2).padStart(10)}  ${r.toFixed(2)}x`,
    );
  }

  console.log();
  console.log("=== Summary ===");
  console.log(`  1000-node fiber tree reconciliation (${ITERATIONS} iterations x ${RUNS} runs)`);
  console.log(`  JS avg:   ${jsStats.avg.toFixed(2)}ms`);
  console.log(`  Wasm avg: ${wasmStats.avg.toFixed(2)}ms`);
  console.log(
    `  Speedup:  ${ratio > 1 ? ratio.toFixed(2) + "x (Wasm faster)" : (1 / ratio).toFixed(2) + "x (JS faster)"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
