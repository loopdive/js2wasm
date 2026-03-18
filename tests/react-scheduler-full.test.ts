/**
 * React Scheduler full min-heap test with idiomatic TypeScript.
 *
 * This test uses HeapNode[] arrays and direct `=== null` / `!== null`
 * comparisons on class references, testing the compiler's ability to
 * handle nullable struct refs properly.
 *
 * Based on React's scheduler min-heap implementation:
 *   react/packages/scheduler/src/SchedulerMinHeap.js
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Helper: compile + instantiate + call exported function
// ---------------------------------------------------------------------------
async function run(
  source: string,
  fn: string = "test",
  args: unknown[] = [],
): Promise<unknown> {
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
// Full idiomatic min-heap source using HeapNode[] array
// ---------------------------------------------------------------------------
const HEAP_SOURCE_ARRAY = `
class HeapNode {
  id: number;
  sortIndex: number;
  constructor(id: number, sortIndex: number) {
    this.id = id;
    this.sortIndex = sortIndex;
  }
}

// Global heap array and size tracker.
// Using (HeapNode | null)[] so that array element access produces ref_null
// in Wasm, matching what the compiler actually returns from array.get.
let heap: (HeapNode | null)[] = [];
let heapSize: number = 0;

// compare accepts nullable params because array element reads always
// produce ref_null in Wasm (the compiler does not yet narrow after guards).
function compare(a: HeapNode | null, b: HeapNode | null): number {
  if (a === null || b === null) return 0;
  const diff = a.sortIndex - b.sortIndex;
  if (diff !== 0) return diff;
  return a.id - b.id;
}

function push(node: HeapNode): void {
  const index = heapSize;
  heap[index] = node;
  heapSize = heapSize + 1;
  siftUp(index);
}

function siftUp(startIndex: number): void {
  let index = startIndex;
  while (index > 0) {
    const parentIndex = (index - 1) >> 1;
    const parent: HeapNode | null = heap[parentIndex];
    const node: HeapNode | null = heap[index];
    if (parent !== null && node !== null && compare(parent, node) > 0) {
      // parent is larger, swap
      heap[parentIndex] = node;
      heap[index] = parent;
      index = parentIndex;
    } else {
      break;
    }
  }
}

function peekId(): number {
  if (heapSize === 0) return -1;
  const node: HeapNode | null = heap[0];
  if (node === null) return -1;
  return node.id;
}

function peekSort(): number {
  if (heapSize === 0) return -1;
  const node: HeapNode | null = heap[0];
  if (node === null) return -1;
  return node.sortIndex;
}

function popId(): number {
  if (heapSize === 0) return -1;
  const first: HeapNode | null = heap[0];
  if (first === null) return -1;
  const firstId = first.id;
  heapSize = heapSize - 1;
  if (heapSize === 0) {
    return firstId;
  }
  // Move last element to root and sift down
  const last: HeapNode | null = heap[heapSize];
  heap[0] = last;
  siftDown(0);
  return firstId;
}

function popSort(): number {
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

function getHeapSize(): number {
  return heapSize;
}

function resetHeap(): void {
  heap = [];
  heapSize = 0;
}
`;

// ---------------------------------------------------------------------------
// Fallback: Uses globals (like original test) but with direct null checks
// This tests === null on struct refs without depending on array-of-structs
// ---------------------------------------------------------------------------
const HEAP_SOURCE_GLOBALS_WITH_NULL_CHECKS = `
class HeapNode {
  id: number;
  sortIndex: number;
  constructor(id: number, sortIndex: number) {
    this.id = id;
    this.sortIndex = sortIndex;
  }
}

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

function siftUp(startIndex: number): void {
  let index = startIndex;
  const node = heapGet(index);
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

function push(node: HeapNode): void {
  const index = heapSize;
  heapSet(index, node);
  heapSize = heapSize + 1;
  siftUp(index);
}

function peekNode(): HeapNode | null {
  if (heapSize === 0) return null;
  return heap0;
}

function peekId(): number {
  const node = peekNode();
  if (node === null) return -1;
  return node.id;
}

function peekSort(): number {
  const node = peekNode();
  if (node === null) return -1;
  return node.sortIndex;
}

function siftDown(startIndex: number): void {
  let index = startIndex;
  const length = heapSize;
  const halfLength = length >> 1;
  while (index < halfLength) {
    const leftIndex = 2 * (index + 1) - 1;
    const left = heapGet(leftIndex);
    const rightIndex = leftIndex + 1;
    const right = heapGet(rightIndex);
    const node = heapGet(index);
    if (node === null) break;

    if (left !== null && compare(left, node) < 0) {
      if (rightIndex < length && right !== null && compare(right, left) < 0) {
        heapSet(index, right);
        heapSet(rightIndex, node);
        index = rightIndex;
      } else {
        heapSet(index, left);
        heapSet(leftIndex, node);
        index = leftIndex;
      }
    } else if (rightIndex < length && right !== null && compare(right, node) < 0) {
      heapSet(index, right);
      heapSet(rightIndex, node);
      index = rightIndex;
    } else {
      break;
    }
  }
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
  siftDown(0);
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
  siftDown(0);
  return firstSort;
}

function getHeapSize(): number {
  return heapSize;
}

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
describe("React scheduler full min-heap", () => {

  // === Section 1: Array-based heap (idiomatic TypeScript) ===
  describe("array-based heap (idiomatic)", () => {

    it("compiles the array-based heap source", () => {
      const source = HEAP_SOURCE_ARRAY + `
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

    it("peek on empty heap returns -1", async () => {
      const source = HEAP_SOURCE_ARRAY + `
export function test(): number {
  resetHeap();
  return peekSort();
}
`;
      expect(await run(source)).toBe(-1);
    });

    it("push + peek returns the minimum element", async () => {
      const source = HEAP_SOURCE_ARRAY + `
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

    it("pop returns elements in priority order (by sortIndex)", async () => {
      const source = HEAP_SOURCE_ARRAY + `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 30));
  push(new HeapNode(2, 10));
  push(new HeapNode(3, 20));

  const a = popSort();
  const b = popSort();
  const c = popSort();

  if (a !== 10) return 100 + a;
  if (b !== 20) return 200 + b;
  if (c !== 30) return 300 + c;
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("pop on empty heap returns -1", async () => {
      const source = HEAP_SOURCE_ARRAY + `
export function test(): number {
  resetHeap();
  return popSort();
}
`;
      expect(await run(source)).toBe(-1);
    });

    it("handles tie-breaking by id", async () => {
      const source = HEAP_SOURCE_ARRAY + `
export function test(): number {
  resetHeap();
  push(new HeapNode(5, 10));
  push(new HeapNode(2, 10));
  push(new HeapNode(8, 10));

  const a = popId();
  const b = popId();
  const c = popId();

  if (a !== 2) return 100 + a;
  if (b !== 5) return 200 + b;
  if (c !== 8) return 300 + c;
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("peek returns highest priority without removing", async () => {
      const source = HEAP_SOURCE_ARRAY + `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 50));
  push(new HeapNode(2, 10));
  push(new HeapNode(3, 30));

  // Peek should return 10 (minimum sortIndex)
  const first = peekSort();
  if (first !== 10) return 100 + first;

  // Peek again -- should still be 10 (not removed)
  const second = peekSort();
  if (second !== 10) return 200 + second;

  // Size should still be 3
  if (getHeapSize() !== 3) return 300;

  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("mixed push/pop maintains heap invariant", async () => {
      const source = HEAP_SOURCE_ARRAY + `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 50));
  push(new HeapNode(2, 30));
  push(new HeapNode(3, 40));

  const first = popSort();
  if (first !== 30) return 100;

  push(new HeapNode(4, 10));

  const second = popSort();
  if (second !== 10) return 200;

  const third = popSort();
  if (third !== 40) return 300;

  const fourth = popSort();
  if (fourth !== 50) return 400;

  if (getHeapSize() !== 0) return 500;
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("handles 7 elements correctly", async () => {
      const source = HEAP_SOURCE_ARRAY + `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 70));
  push(new HeapNode(2, 20));
  push(new HeapNode(3, 50));
  push(new HeapNode(4, 10));
  push(new HeapNode(5, 60));
  push(new HeapNode(6, 30));
  push(new HeapNode(7, 40));

  // Should come out: 10, 20, 30, 40, 50, 60, 70
  const expected: number[] = [10, 20, 30, 40, 50, 60, 70];
  let i = 0;
  while (i < 7) {
    const val = popSort();
    if (val !== expected[i]) return 100 * (i + 1) + val;
    i = i + 1;
  }
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("simulates React priority levels", async () => {
      const source = HEAP_SOURCE_ARRAY + `
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

  push(new HeapNode(1, now + getTimeout(NormalPriority)));
  push(new HeapNode(2, now + getTimeout(ImmediatePriority)));
  push(new HeapNode(3, now + getTimeout(UserBlockingPriority)));

  const first = popId();
  if (first !== 2) return 100 + first;

  const second = popId();
  if (second !== 3) return 200 + second;

  const third = popId();
  if (third !== 1) return 300 + third;

  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });
  });

  // === Section 2: Null-check tests (struct ref === null) ===
  describe("null checks on class refs", () => {

    it("=== null returns true for null ref", async () => {
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
      expect(await run(source)).toBe(1);
    });

    it("!== null returns true for non-null ref", async () => {
      const source = `
class Bar {
  val: number;
  constructor(val: number) { this.val = val; }
}

function makeBar(): Bar | null {
  return new Bar(42);
}

export function test(): number {
  const b = makeBar();
  if (b !== null) return b.val;
  return -1;
}
`;
      expect(await run(source)).toBe(42);
    });

    it("null narrowing allows property access after check", async () => {
      const source = `
class Node {
  value: number;
  constructor(value: number) { this.value = value; }
}

function getNode(flag: number): Node | null {
  if (flag > 0) return new Node(flag * 10);
  return null;
}

export function test(): number {
  const a = getNode(3);
  const b = getNode(0);

  let result = 0;
  if (a !== null) {
    result = result + a.value;  // 30
  }
  if (b === null) {
    result = result + 1;  // 31
  }
  return result;
}
`;
      expect(await run(source)).toBe(31);
    });
  });

  // === Section 3: Global-based heap with direct null checks ===
  describe("globals-based heap with null checks", () => {

    it("peekNode returns null on empty heap", async () => {
      const source = HEAP_SOURCE_GLOBALS_WITH_NULL_CHECKS + `
export function test(): number {
  resetHeap();
  const node = peekNode();
  if (node === null) return 1;
  return 0;
}
`;
      expect(await run(source)).toBe(1);
    });

    it("peekNode returns non-null after push", async () => {
      const source = HEAP_SOURCE_GLOBALS_WITH_NULL_CHECKS + `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 42));
  const node = peekNode();
  if (node !== null) return node.sortIndex;
  return -1;
}
`;
      expect(await run(source)).toBe(42);
    });

    it("pop returns elements in priority order with null checks", async () => {
      const source = HEAP_SOURCE_GLOBALS_WITH_NULL_CHECKS + `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 30));
  push(new HeapNode(2, 10));
  push(new HeapNode(3, 20));

  const a = popSort();
  const b = popSort();
  const c = popSort();

  if (a !== 10) return 100 + a;
  if (b !== 20) return 200 + b;
  if (c !== 30) return 300 + c;
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("pop on fully drained heap returns -1", async () => {
      const source = HEAP_SOURCE_GLOBALS_WITH_NULL_CHECKS + `
export function test(): number {
  resetHeap();
  push(new HeapNode(1, 10));
  popSort();
  return popSort();
}
`;
      expect(await run(source)).toBe(-1);
    });

    it("handles tie-breaking by id with null checks", async () => {
      const source = HEAP_SOURCE_GLOBALS_WITH_NULL_CHECKS + `
export function test(): number {
  resetHeap();
  push(new HeapNode(5, 10));
  push(new HeapNode(2, 10));
  push(new HeapNode(8, 10));

  const a = popId();
  const b = popId();
  const c = popId();

  if (a !== 2) return 100 + a;
  if (b !== 5) return 200 + b;
  if (c !== 8) return 300 + c;
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("simulates React scheduling with null-check based peek/pop", async () => {
      const source = HEAP_SOURCE_GLOBALS_WITH_NULL_CHECKS + `
export function test(): number {
  resetHeap();
  const now = 1000;

  // Schedule tasks at different priorities
  push(new HeapNode(1, now + 5000));  // Normal
  push(new HeapNode(2, now - 1));     // Immediate
  push(new HeapNode(3, now + 250));   // UserBlocking

  // Peek should show the immediate task (id=2)
  const peeked = peekId();
  if (peeked !== 2) return 100 + peeked;

  // Pop all in order
  const first = popId();
  if (first !== 2) return 200 + first;

  const second = popId();
  if (second !== 3) return 300 + second;

  const third = popId();
  if (third !== 1) return 400 + third;

  // Heap should be empty now
  if (getHeapSize() !== 0) return 500;
  if (peekId() !== -1) return 600;

  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });
  });
});
