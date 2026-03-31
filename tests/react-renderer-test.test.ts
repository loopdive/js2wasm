/**
 * React Milestone 4: Minimal custom renderer test.
 *
 * Validates the full React-like pipeline in Wasm: fiber tree construction,
 * hooks state management, component "rendering", state updates, and
 * re-rendering with updated output.
 *
 * Instead of DOM output, components return numeric encodings that get
 * collected into a "rendered output" via fiber tree traversal.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

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
// Shared infrastructure: FiberNode + HookState + hooks + renderer
// ---------------------------------------------------------------------------
const FIBER_CLASS = `
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
`;

const HOOKS_SOURCE = `
class HookState {
  memoizedState: number;
  next: HookState | null = null;
  constructor(initial: number) { this.memoizedState = initial; }
}

let firstHook: HookState | null = null;
let currentHook: HookState | null = null;
let lastHook: HookState | null = null;
let isInitialRender: number = 1;

function useState(initial: number): number {
  if (isInitialRender === 1) {
    const hook = new HookState(initial);
    if (firstHook === null) { firstHook = hook; }
    if (lastHook !== null) { lastHook.next = hook; }
    lastHook = hook;
    currentHook = hook;
    return initial;
  }
  if (currentHook === null) { return 0; }
  const value = currentHook.memoizedState;
  currentHook = currentHook.next;
  return value;
}

function setState(hookIndex: number, newValue: number): void {
  let hook = firstHook;
  let i = 0;
  while (hook !== null && i < hookIndex) { hook = hook.next; i = i + 1; }
  if (hook !== null) { hook.memoizedState = newValue; }
}

function resetHooks(): void {
  currentHook = firstHook;
  isInitialRender = 0;
}

function clearHooks(): void {
  firstHook = null;
  currentHook = null;
  lastHook = null;
  isInitialRender = 1;
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("React Milestone 4: Minimal custom renderer", () => {
  describe("single component render cycle", () => {
    it("renders a counter component and reads initial state", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
function Counter(): number {
  const count = useState(0);
  return count;
}

export function test(): number {
  clearHooks();
  const fiber = new FiberNode(1, 100);

  // Initial render
  const output = Counter();
  fiber.memoizedState = output;

  return fiber.memoizedState;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("re-renders after state update and output changes", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
function Counter(): number {
  const count = useState(0);
  return count;
}

export function test(): number {
  clearHooks();

  // Initial render
  const v1 = Counter();

  // Update state: set hook 0 to 42
  setState(0, 42);

  // Re-render
  resetHooks();
  const v2 = Counter();

  // v1 should be 0, v2 should be 42
  return v1 * 1000 + v2;
}
`;
      expect(await run(source)).toBe(42); // 0*1000 + 42
    });

    it("multiple state updates accumulate correctly", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
function Counter(): number {
  const count = useState(0);
  return count;
}

export function test(): number {
  clearHooks();

  // Render 1: initial
  const v1 = Counter();

  // Update to 10
  setState(0, 10);
  resetHooks();
  const v2 = Counter();

  // Update to 25
  setState(0, 25);
  resetHooks();
  const v3 = Counter();

  // v1=0, v2=10, v3=25
  return v1 * 10000 + v2 * 100 + v3;
}
`;
      expect(await run(source)).toBe(1025); // 0 + 1000 + 25
    });
  });

  describe("multi-hook component", () => {
    it("component with two useState hooks", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
function TwoCounters(): number {
  const a = useState(10);
  const b = useState(20);
  return a + b;
}

export function test(): number {
  clearHooks();
  const v1 = TwoCounters();
  return v1;
}
`;
      expect(await run(source)).toBe(30);
    });

    it("updates second hook independently", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
function TwoCounters(): number {
  const a = useState(10);
  const b = useState(20);
  return a * 100 + b;
}

export function test(): number {
  clearHooks();
  const v1 = TwoCounters();

  // Update only hook index 1 (b) to 99
  setState(1, 99);
  resetHooks();
  const v2 = TwoCounters();

  // v1 = 1020, v2 = 1099
  if (v1 !== 1020) return 10000 + v1;
  if (v2 !== 1099) return 20000 + v2;
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });
  });

  describe("fiber tree with component output", () => {
    it("builds fiber tree and stores component outputs", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
export function test(): number {
  // Build a 2-node fiber tree: root -> child
  const root = new FiberNode(0, 1);
  const child = new FiberNode(1, 2);
  root.child = child;
  child.return_ = root;

  // Assign rendered outputs
  root.memoizedState = 100;
  child.memoizedState = 200;

  // "renderToNumber": walk tree, sum outputs
  let sum = 0;
  sum = sum + root.memoizedState;
  let current: FiberNode | null = root.child;
  while (current !== null) {
    sum = sum + current.memoizedState;
    current = current.sibling;
  }
  return sum;
}
`;
      expect(await run(source)).toBe(300);
    });

    it("renders tree with sibling chain", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
export function test(): number {
  const root = new FiberNode(0, 0);
  const c1 = new FiberNode(1, 1);
  const c2 = new FiberNode(1, 2);
  const c3 = new FiberNode(1, 3);

  root.child = c1;
  c1.sibling = c2;
  c2.sibling = c3;
  c1.return_ = root;
  c2.return_ = root;
  c3.return_ = root;

  // Each "component" produces its type_ * 10 as output
  root.memoizedState = root.type_ * 10;
  c1.memoizedState = c1.type_ * 10;
  c2.memoizedState = c2.type_ * 10;
  c3.memoizedState = c3.type_ * 10;

  // renderToNumber: root + all children
  let result = root.memoizedState;
  let fiber: FiberNode | null = root.child;
  while (fiber !== null) {
    result = result + fiber.memoizedState;
    fiber = fiber.sibling;
  }
  return result;
}
`;
      expect(await run(source)).toBe(60); // 0 + 10 + 20 + 30
    });
  });

  describe("full render pipeline: component + fiber + hooks + re-render", () => {
    it("component renders into fiber, state updates, re-renders with new output", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
function Counter(): number {
  const count = useState(0);
  // "render" output is count * 2 + 1  (odd numbers indicate rendered)
  return count * 2 + 1;
}

function renderFiber(fiber: FiberNode): void {
  const output = Counter();
  fiber.memoizedState = output;
}

export function test(): number {
  clearHooks();
  const fiber = new FiberNode(1, 42);

  // Initial render
  renderFiber(fiber);
  const firstOutput = fiber.memoizedState;   // 0*2+1 = 1

  // Simulate state update: increment counter to 5
  setState(0, 5);
  resetHooks();

  // Re-render
  renderFiber(fiber);
  const secondOutput = fiber.memoizedState;  // 5*2+1 = 11

  // Verify outputs changed
  if (firstOutput !== 1) return 1000 + firstOutput;
  if (secondOutput !== 11) return 2000 + secondOutput;
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("reconciliation: detects which fibers need update via flag diffing", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
const Update = 4;

export function test(): number {
  const root = new FiberNode(0, 0);
  const child1 = new FiberNode(1, 1);
  const child2 = new FiberNode(1, 2);

  root.child = child1;
  child1.sibling = child2;
  child1.return_ = root;
  child2.return_ = root;

  // Initial render: all fibers get output
  child1.memoizedState = 10;
  child1.memoizedProps = 10;
  child1.pendingProps = 10;

  child2.memoizedState = 20;
  child2.memoizedProps = 20;
  child2.pendingProps = 20;

  // Simulate prop change on child2 only
  child2.pendingProps = 30;

  // Reconciliation pass: mark dirty fibers
  let needsUpdate = 0;
  let fiber: FiberNode | null = root.child;
  while (fiber !== null) {
    if (fiber.pendingProps !== fiber.memoizedProps) {
      fiber.flags = fiber.flags | Update;
      needsUpdate = needsUpdate + 1;
    }
    fiber = fiber.sibling;
  }

  // Commit pass: update memoizedProps for flagged fibers
  fiber = root.child;
  while (fiber !== null) {
    if ((fiber.flags & Update) !== 0) {
      fiber.memoizedProps = fiber.pendingProps;
      fiber.memoizedState = fiber.pendingProps * 2;
      fiber.flags = fiber.flags & ~Update;
    }
    fiber = fiber.sibling;
  }

  // Verify: child1 unchanged, child2 updated
  if (child1.memoizedState !== 10) return 100 + child1.memoizedState;
  if (child2.memoizedState !== 60) return 200 + child2.memoizedState;
  if (needsUpdate !== 1) return 300 + needsUpdate;

  // Verify flags cleared
  if (child1.flags !== 0) return 400;
  if (child2.flags !== 0) return 500;

  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });

    it("full pipeline: 3-fiber tree with hooks, render, update, re-render, collect output", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
// Component function: returns count + type offset
function renderComponent(typeOffset: number): number {
  const count = useState(0);
  return count + typeOffset;
}

export function test(): number {
  clearHooks();

  // Build fiber tree: root -> child1, child1.sibling -> child2
  const root = new FiberNode(0, 0);
  const child1 = new FiberNode(1, 100);
  const child2 = new FiberNode(1, 200);
  root.child = child1;
  child1.sibling = child2;
  child1.return_ = root;
  child2.return_ = root;

  // Phase 1: Initial render of root component
  root.memoizedState = renderComponent(root.type_);
  // root output = 0 + 0 = 0

  // Phase 2: Collect rendered tree output (walk fiber tree)
  // For simplicity, child fibers store static values for now
  child1.memoizedState = child1.type_;   // 100
  child2.memoizedState = child2.type_;   // 200

  let totalBefore = root.memoizedState;
  let f: FiberNode | null = root.child;
  while (f !== null) {
    totalBefore = totalBefore + f.memoizedState;
    f = f.sibling;
  }
  // totalBefore = 0 + 100 + 200 = 300

  // Phase 3: State update on root (simulate user interaction)
  setState(0, 50);
  resetHooks();

  // Phase 4: Re-render root component
  root.memoizedState = renderComponent(root.type_);
  // root output = 50 + 0 = 50

  // Phase 5: Collect output again
  let totalAfter = root.memoizedState;
  f = root.child;
  while (f !== null) {
    totalAfter = totalAfter + f.memoizedState;
    f = f.sibling;
  }
  // totalAfter = 50 + 100 + 200 = 350

  if (totalBefore !== 300) return 1000 + totalBefore;
  if (totalAfter !== 350) return 2000 + totalAfter;
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });
  });

  describe("renderToNumber: depth-first tree traversal", () => {
    it("depth-first traversal collects output from nested fiber tree", async () => {
      const source =
        FIBER_CLASS +
        `
// Iterative depth-first traversal using return_ pointers.
// Uses iterative approach because the compiler does not yet narrow
// nullable refs for recursive function call arguments.
function renderToNumber(start: FiberNode): number {
  let sum = 0;
  let node: FiberNode | null = start;
  while (node !== null) {
    sum = sum + node.memoizedState;
    // Descend to first child if available
    if (node.child !== null) {
      node = node.child;
    } else {
      // No child: try sibling, or walk up via return_
      while (node !== null) {
        if (node.sibling !== null) {
          node = node.sibling;
          break;
        }
        // Walk up to parent
        node = node.return_;
        // If we walked back to start's parent (or null), we are done
        if (node !== null && node.tag === start.tag && node.type_ === start.type_) {
          node = null;
        }
      }
    }
  }
  return sum;
}

export function test(): number {
  //       root(1)
  //      /       \\
  //   mid1(10)   mid2(100)
  //     |
  //   leaf(1000)

  const root = new FiberNode(0, 0);
  const mid1 = new FiberNode(1, 1);
  const mid2 = new FiberNode(1, 2);
  const leaf = new FiberNode(2, 3);

  root.child = mid1;
  mid1.sibling = mid2;
  mid1.return_ = root;
  mid2.return_ = root;
  mid1.child = leaf;
  leaf.return_ = mid1;

  root.memoizedState = 1;
  mid1.memoizedState = 10;
  mid2.memoizedState = 100;
  leaf.memoizedState = 1000;

  return renderToNumber(root);
}
`;
      expect(await run(source)).toBe(1111); // 1 + 10 + 1000 + 100
    });

    it("traversal on single node returns its value", async () => {
      const source =
        FIBER_CLASS +
        `
function renderToNumber(start: FiberNode): number {
  let sum = 0;
  let node: FiberNode | null = start;
  while (node !== null) {
    sum = sum + node.memoizedState;
    if (node.child !== null) {
      node = node.child;
    } else {
      while (node !== null) {
        if (node.sibling !== null) {
          node = node.sibling;
          break;
        }
        node = node.return_;
        if (node !== null && node.tag === start.tag && node.type_ === start.type_) {
          node = null;
        }
      }
    }
  }
  return sum;
}

export function test(): number {
  const single = new FiberNode(0, 0);
  single.memoizedState = 777;
  return renderToNumber(single);
}
`;
      expect(await run(source)).toBe(777);
    });
  });

  describe("effect-like patterns", () => {
    it("useEffect simulation: runs side-effect after render", async () => {
      const source =
        FIBER_CLASS +
        HOOKS_SOURCE +
        `
// Simulate useEffect by storing effect result in a separate hook slot
// Hook 0 = count, Hook 1 = effect output (derived from count)
function ComponentWithEffect(): number {
  const count = useState(0);
  const effectOutput = useState(0);
  // "effect": derive effectOutput from count (count * 3)
  // In real React this runs after render; we simulate inline
  setState(1, count * 3);
  return count;
}

export function test(): number {
  clearHooks();

  // Initial render
  const v1 = ComponentWithEffect();

  // Read effect output (hook 1)
  let effectHook = firstHook;
  if (effectHook !== null && effectHook.next !== null) {
    effectHook = effectHook.next;
  }
  let effect1 = 0;
  if (effectHook !== null) { effect1 = effectHook.memoizedState; }

  // Update count to 7
  setState(0, 7);
  resetHooks();
  const v2 = ComponentWithEffect();

  // Read effect output again
  effectHook = firstHook;
  if (effectHook !== null && effectHook.next !== null) {
    effectHook = effectHook.next;
  }
  let effect2 = 0;
  if (effectHook !== null) { effect2 = effectHook.memoizedState; }

  // v1=0, effect1=0 (0*3), v2=7, effect2=21 (7*3)
  if (v1 !== 0) return 1000 + v1;
  if (effect1 !== 0) return 2000 + effect1;
  if (v2 !== 7) return 3000 + v2;
  if (effect2 !== 21) return 4000 + effect2;
  return 0;
}
`;
      expect(await run(source)).toBe(0);
    });
  });
});
