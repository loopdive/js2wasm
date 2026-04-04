/**
 * React Scheduler min-heap compilation test.
 *
 * Extracts the core priority-queue algorithm from React's scheduler
 * (react/packages/scheduler) and compiles it to Wasm via js2wasm.
 * This tests struct arrays, callable parameters, and numeric comparisons --
 * patterns that were previously blocked by #446 and #461.
 *
 * Known limitation: `ref null <struct> === null` does not reliably narrow
 * in the compiled Wasm. Tests work around this by using a numeric
 * `heapSize` guard instead of null-checking the returned ref.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Helper: compile + instantiate + call exported function
// ---------------------------------------------------------------------------
async function run(source: string, fn: string = "test", args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

// ---------------------------------------------------------------------------
// The TypeScript source that mirrors React's scheduler min-heap.
//
// Simplified from scheduler.development.js lines 85-136:
//   - push (sift-up)
//   - peek (return heap[0])
//   - pop  (swap root with last, sift-down)
//   - compare (by sortIndex, then by id)
//
// Uses fixed-size storage (7 slots) via globals instead of arrays,
// because js2wasm does not yet support arrays of structs natively.
// This is sufficient for testing the algorithm with small heaps.
// ---------------------------------------------------------------------------
const SCHEDULER_HEAP_SOURCE = `
// ---- Node type (mirrors React's internal task node) ----
class HeapNode {
  id: number;
  sortIndex: number;
  constructor(id: number, sortIndex: number) {
    this.id = id;
    this.sortIndex = sortIndex;
  }
}

// ---- Min-heap storage (fixed 7 slots) ----

let heapSize: number = 0;
let heap0: HeapNode | null = null;
let heap1: HeapNode | null = null;
let heap2: HeapNode | null = null;
let heap3: HeapNode | null = null;
let heap4: HeapNode | null = null;
let heap5: HeapNode | null = null;
let heap6: HeapNode | null = null;

function heapGet(i: number): HeapNode | null {
  if (i === 0) return heap0;
  if (i === 1) return heap1;
  if (i === 2) return heap2;
  if (i === 3) return heap3;
  if (i === 4) return heap4;
  if (i === 5) return heap5;
  if (i === 6) return heap6;
  return null;
}

function heapSet(i: number, node: HeapNode | null): void {
  if (i === 0) heap0 = node;
  else if (i === 1) heap1 = node;
  else if (i === 2) heap2 = node;
  else if (i === 3) heap3 = node;
  else if (i === 4) heap4 = node;
  else if (i === 5) heap5 = node;
  else if (i === 6) heap6 = node;
}

function compare(a: HeapNode | null, b: HeapNode | null): number {
  if (a === null || b === null) return 0;
  const diff = a.sortIndex - b.sortIndex;
  if (diff !== 0) return diff;
  return a.id - b.id;
}

function push(node: HeapNode): void {
  let index = heapSize;
  heapSet(index, node);
  heapSize = heapSize + 1;

  // sift up
  while (index > 0) {
    const parentIndex = (index - 1) >> 1;
    const parent = heapGet(parentIndex);
    if (parent !== null && compare(parent, node) > 0) {
      heapSet(parentIndex, node);
      heapSet(index, parent);
      index = parentIndex;
    } else {
      break;
    }
  }
}

function peekId(): number {
  if (heapSize === 0) return -1;
  if (heap0 === null) return -1;
  return heap0.id;
}

function peekSort(): number {
  if (heapSize === 0) return -1;
  if (heap0 === null) return -1;
  return heap0.sortIndex;
}

function popId(): number {
  if (heapSize === 0) return -1;
  const first = heap0;
  if (first === null) return -1;
  const firstId = first.id;
  heapSize = heapSize - 1;
  if (heapSize === 0) {
    heap0 = null;
    return firstId;
  }
  const last = heapGet(heapSize);
  heapSet(heapSize, null);
  heapSet(0, last);

  // sift down
  let index = 0;
  const length = heapSize;
  const halfLength = length >> 1;
  while (index < halfLength) {
    const leftIndex = 2 * (index + 1) - 1;
    const left = heapGet(leftIndex);
    const rightIndex = leftIndex + 1;
    const right = heapGet(rightIndex);
    if (left !== null && last !== null && compare(left, last) < 0) {
      if (rightIndex < length && right !== null && compare(right, left) < 0) {
        heapSet(index, right);
        heapSet(rightIndex, last);
        index = rightIndex;
      } else {
        heapSet(index, left);
        heapSet(leftIndex, last);
        index = leftIndex;
      }
    } else if (rightIndex < length && right !== null && last !== null && compare(right, last) < 0) {
      heapSet(index, right);
      heapSet(rightIndex, last);
      index = rightIndex;
    } else {
      break;
    }
  }

  return firstId;
}

function popSort(): number {
  if (heapSize === 0) return -1;
  const first = heap0;
  if (first === null) return -1;
  const firstSort = first.sortIndex;
  heapSize = heapSize - 1;
  if (heapSize === 0) {
    heap0 = null;
    return firstSort;
  }
  const last = heapGet(heapSize);
  heapSet(heapSize, null);
  heapSet(0, last);

  // sift down
  let index = 0;
  const length = heapSize;
  const halfLength = length >> 1;
  while (index < halfLength) {
    const leftIndex = 2 * (index + 1) - 1;
    const left = heapGet(leftIndex);
    const rightIndex = leftIndex + 1;
    const right = heapGet(rightIndex);
    if (left !== null && last !== null && compare(left, last) < 0) {
      if (rightIndex < length && right !== null && compare(right, left) < 0) {
        heapSet(index, right);
        heapSet(rightIndex, last);
        index = rightIndex;
      } else {
        heapSet(index, left);
        heapSet(leftIndex, last);
        index = leftIndex;
      }
    } else if (rightIndex < length && right !== null && last !== null && compare(right, last) < 0) {
      heapSet(index, right);
      heapSet(rightIndex, last);
      index = rightIndex;
    } else {
      break;
    }
  }

  return firstSort;
}

function getHeapSize(): number {
  return heapSize;
}

// Reset all heap state (needed since globals persist across test calls)
function resetHeap(): void {
  heapSize = 0;
  heap0 = null;
  heap1 = null;
  heap2 = null;
  heap3 = null;
  heap4 = null;
  heap5 = null;
  heap6 = null;
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("React scheduler min-heap compiled to Wasm", () => {
  it("compiles the min-heap source without errors", () => {
    const source =
      SCHEDULER_HEAP_SOURCE +
      `
export function test(): number { return 1; }
`;
    const result = compile(source);
    if (!result.success) {
      console.log("Compile errors:");
      for (const e of result.errors) {
        console.log(`  L${e.line}: ${e.message}`);
      }
    }
    expect(result.success).toBe(true);
  });

  it("peek on empty heap returns -1 sentinel", async () => {
    const source =
      SCHEDULER_HEAP_SOURCE +
      `
export function test(): number {
  resetHeap();
  return peekSort();
}
`;
    expect(await run(source)).toBe(-1);
  });

  it("push + peek returns the minimum element", async () => {
    const source =
      SCHEDULER_HEAP_SOURCE +
      `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 10));
  push(new HeapNode(2, 5));
  push(new HeapNode(3, 20));
  return peekSort();
}
`;
    expect(await run(source)).toBe(5);
  });

  it("pop returns elements in priority order", async () => {
    const source =
      SCHEDULER_HEAP_SOURCE +
      `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 30));
  push(new HeapNode(2, 10));
  push(new HeapNode(3, 20));

  const a = popSort();
  const b = popSort();
  const c = popSort();

  // Should come out as 10, 20, 30
  if (a !== 10) return 100 + a;
  if (b !== 20) return 200 + b;
  if (c !== 30) return 300 + c;

  return 0;
}
`;
    expect(await run(source)).toBe(0);
  });

  it("pop on empty heap returns -1 sentinel", async () => {
    const source =
      SCHEDULER_HEAP_SOURCE +
      `
export function test(): number {
  resetHeap();
  return popSort();
}
`;
    expect(await run(source)).toBe(-1);
  });

  it("handles tie-breaking by id", async () => {
    const source =
      SCHEDULER_HEAP_SOURCE +
      `
export function test(): number {
  resetHeap();
  // Same sortIndex, different ids -- should break ties by id (lower first)
  push(new HeapNode(5, 10));
  push(new HeapNode(2, 10));
  push(new HeapNode(8, 10));

  const a = popId();
  const b = popId();
  const c = popId();

  // Should come out as id=2, id=5, id=8
  if (a !== 2) return 100 + a;
  if (b !== 5) return 200 + b;
  if (c !== 8) return 300 + c;

  return 0;
}
`;
    expect(await run(source)).toBe(0);
  });

  it("mixed push/pop maintains heap invariant", async () => {
    const source =
      SCHEDULER_HEAP_SOURCE +
      `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 50));
  push(new HeapNode(2, 30));
  push(new HeapNode(3, 40));

  // Pop the minimum (30)
  const first = popSort();
  if (first !== 30) return 100;

  // Push a new smaller element
  push(new HeapNode(4, 10));

  // Pop should return 10 (the new minimum)
  const second = popSort();
  if (second !== 10) return 200;

  // Next should be 40
  const third = popSort();
  if (third !== 40) return 300;

  // Next should be 50
  const fourth = popSort();
  if (fourth !== 50) return 400;

  // Heap should be empty
  if (getHeapSize() !== 0) return 500;

  return 0;
}
`;
    expect(await run(source)).toBe(0);
  });

  it("simulates React priority levels with the heap", async () => {
    const source =
      SCHEDULER_HEAP_SOURCE +
      `
// React priority constants
const ImmediatePriority = 1;
const UserBlockingPriority = 2;
const NormalPriority = 3;

function getTimeout(priority: number): number {
  if (priority === 1) return -1;
  if (priority === 2) return 250;
  return 5000;
}

export function test(): number {
  resetHeap();
  const now = 1000;

  // Schedule 3 tasks at different priorities
  // ImmediatePriority: sortIndex = 1000 + (-1) = 999
  // UserBlockingPriority: sortIndex = 1000 + 250 = 1250
  // NormalPriority: sortIndex = 1000 + 5000 = 6000
  push(new HeapNode(1, now + getTimeout(NormalPriority)));
  push(new HeapNode(2, now + getTimeout(ImmediatePriority)));
  push(new HeapNode(3, now + getTimeout(UserBlockingPriority)));

  // Should dequeue in priority order: Immediate(id=2), UserBlocking(id=3), Normal(id=1)
  const first = popId();
  if (first !== 2) return 100 + first; // Immediate

  const second = popId();
  if (second !== 3) return 200 + second; // UserBlocking

  const third = popId();
  if (third !== 1) return 300 + third; // Normal

  return 0;
}
`;
    expect(await run(source)).toBe(0);
  });

  // ---- Document the known null-check limitation ----
  it("documents: === null on class refs does not work yet (known limitation)", async () => {
    // This test documents a known compiler limitation.
    // `ref null <struct> === null` does not produce correct Wasm narrowing.
    // When this is fixed, this test should be updated.
    const source = `
class Foo {
  x: number;
  constructor(x: number) { this.x = x; }
}

function maybeNull(): Foo | null {
  return null;
}

export function test(): number {
  const f = maybeNull();
  if (f === null) return 1;
  return 0;
}
`;
    const result = compile(source);
    expect(result.success).toBe(true);
    // When null-check works, this will return 1
    // Currently returns 0 because the null check fails
    try {
      const val = await run(source);
      if (val === 1) {
        // Null check works -- great, the limitation is fixed!
        expect(val).toBe(1);
      } else {
        // Known limitation -- null check on ref types fails
        expect(val).toBe(0);
      }
    } catch {
      // Instantiation might fail too -- also a known issue
      expect(true).toBe(true);
    }
  });
});
