import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    Math_sin: Math.sin,
    Math_cos: Math.cos,
    Math_tan: Math.tan,
    Math_asin: Math.asin,
    Math_acos: Math.acos,
    Math_atan: Math.atan,
    Math_atan2: Math.atan2,
    Math_exp: Math.exp,
    Math_log: Math.log,
    Math_log2: Math.log2,
    Math_log10: Math.log10,
    Math_pow: Math.pow,
    Math_random: Math.random,
    Math_acosh: Math.acosh,
    Math_asinh: Math.asinh,
    Math_atanh: Math.atanh,
    Math_cbrt: Math.cbrt,
    Math_expm1: Math.expm1,
    Math_log1p: Math.log1p,
    number_toString: (v: number) => String(v),
    __typeof_number: (v: unknown) => (typeof v === "number" ? 1 : 0),
    __typeof_string: (v: unknown) => (typeof v === "string" ? 1 : 0),
    __typeof_boolean: (v: unknown) => (typeof v === "boolean" ? 1 : 0),
    __typeof: (v: unknown) => typeof v,
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    parseFloat: (s: any) => parseFloat(String(s)),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    __unbox_number: (v: unknown) => Number(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    __make_callback: () => null,
  };
  return {
    env,
    "wasm:js-string": {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) => s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    },
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports;
}

async function compileToWasm(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
  return instance.exports as Record<string, Function>;
}

const HOOKS_SOURCE = `
class HookState {
  memoizedState: number;
  next: HookState | null = null;
  constructor(initial: number) { this.memoizedState = initial; }
}

let firstHook: HookState | null = null;
let currentHook: HookState | null = null;
let lastHook: HookState | null = null;

function useState(initial: number): number {
  if (currentHook === null) {
    const hook = new HookState(initial);
    if (firstHook === null) { firstHook = hook; }
    if (lastHook !== null) { lastHook.next = hook; }
    lastHook = hook;
    currentHook = hook;
  }
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
}
`;

describe("Issue #469: React hooks state machine", () => {
  it("useState returns initial value", async () => {
    const exports = await compileToWasm(`
      ${HOOKS_SOURCE}
      export function test(): number {
        const count = useState(42);
        return count;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("setState updates hook and re-render reads new value", async () => {
    const exports = await compileToWasm(`
      ${HOOKS_SOURCE}

      function render(): number {
        const count = useState(0);
        return count;
      }

      export function test(): number {
        // First render: initializes hook with 0
        const v1 = render();
        // Update state to 99
        setState(0, 99);
        // Re-render: reset cursor and read updated value
        resetHooks();
        const v2 = render();
        return v1 + v2;  // 0 + 99 = 99
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("multiple useState hooks form linked list", async () => {
    const exports = await compileToWasm(`
      ${HOOKS_SOURCE}

      function render(): number {
        const a = useState(10);
        const b = useState(20);
        const c = useState(30);
        return a + b + c;
      }

      export function test(): number {
        return render();
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("setState on second hook in linked list", async () => {
    const exports = await compileToWasm(`
      ${HOOKS_SOURCE}

      function render(): number {
        const a = useState(10);
        const b = useState(20);
        return a + b;
      }

      export function test(): number {
        const v1 = render();
        // Update second hook (index 1) to 50
        setState(1, 50);
        resetHooks();
        const v2 = render();
        return v2;  // 10 + 50 = 60
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("self-referencing struct with null field", async () => {
    const exports = await compileToWasm(`
      class Node {
        value: number;
        next: Node | null = null;
        constructor(v: number) { this.value = v; }
      }

      export function test(): number {
        const n = new Node(42);
        if (n.next === null) {
          return n.value;
        }
        return 0;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("linked list traversal with while loop", async () => {
    const exports = await compileToWasm(`
      class Node {
        value: number;
        next: Node | null = null;
        constructor(v: number) { this.value = v; }
      }

      export function test(): number {
        const a = new Node(1);
        const b = new Node(2);
        const c = new Node(3);
        a.next = b;
        b.next = c;

        let sum = 0;
        let current: Node | null = a;
        while (current !== null) {
          sum = sum + current.value;
          current = current.next;
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("mutation of struct field through linked list", async () => {
    const exports = await compileToWasm(`
      class Node {
        value: number;
        next: Node | null = null;
        constructor(v: number) { this.value = v; }
      }

      export function test(): number {
        const a = new Node(10);
        const b = new Node(20);
        a.next = b;

        // Mutate b's value through a.next
        let target: Node | null = a.next;
        if (target !== null) {
          target.value = 99;
        }

        return b.value;
      }
    `);
    expect(exports.test()).toBe(99);
  });
});
