// Issue #1131 — SSA IR Phase 2: interprocedural type propagation.
//
// Phase 2 extends the middle-end IR to cover direct calls between
// locally-declared functions and adds a context-insensitive
// type-propagation pass that seeds untyped params from caller argument
// types. The motivating case is `fib-recursive.js`:
//
//     function fib(n) {              // no annotation → checker reports `any`
//       if (n <= 1) return n;
//       return fib(n - 1) + fib(n - 2);
//     }
//     /** @param {number} n @returns {number} */
//     export function run(n) { return fib(n); }
//
// The legacy path compiles `fib` as `(externref) -> externref` and boxes
// every recursive call through `__box_number` / `__unbox_number`. Phase 2
// propagates the JSDoc/explicit annotation from `run` into `fib` via the
// call site, the selector claims both functions (call-graph-closed), and
// the IR emits `fib: (f64) -> f64` with plain `call $fib` in its body.
//
// These tests check:
//   1. Correctness of `fib(n)` for small and mid-size inputs.
//   2. Absence of `__box_number` / `__unbox_number` calls inside fib's
//      Wasm body.
//   3. The propagation path works end-to-end without a flag.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { compile } from "../src/index.js";

const ENV = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    // Boxing shims — only referenced when the legacy path is used
    // (experimentalIR: false) or when an IR-claimed function takes an
    // externref argument. Needed for the "legacy still works" test.
    __box_number: (v: number) => v,
    __unbox_number: (v: unknown) => Number(v),
  },
};

describe("issue #1131 — SSA IR Phase 2 — numeric recursive kernel", () => {
  const SOURCE_TYPED = `
    function fib(n: number): number {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    }
    export function run(n: number): number { return fib(n); }
  `;

  const SOURCE_PROPAGATED = `
    function fib(n) {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    }
    export function run(n: number): number { return fib(n); }
  `;

  it("fully-typed fib computes correct values", async () => {
    const result = compile(SOURCE_TYPED, { nativeStrings: true });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, ENV);
    const run = instance.exports.run as (n: number) => number;
    expect(run(0)).toBe(0);
    expect(run(1)).toBe(1);
    expect(run(2)).toBe(1);
    expect(run(10)).toBe(55);
    expect(run(20)).toBe(6765);
  });

  it("fully-typed fib body contains no boxing imports", () => {
    const result = compile(SOURCE_TYPED, { nativeStrings: true });
    expect(result.success).toBe(true);
    const fibBody = extractFuncBody(result.wat, "fib");
    expect(fibBody).not.toBeNull();
    expect(fibBody!).not.toContain("__box_number");
    expect(fibBody!).not.toContain("__unbox_number");
  });

  it("propagates typed caller into untyped callee (f64 signature)", async () => {
    // fib has no annotation in source. run's explicit TS annotation should
    // flow into fib's param via propagation, and the IR should claim both.
    const result = compile(SOURCE_PROPAGATED, { nativeStrings: true });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, ENV);
    const run = instance.exports.run as (n: number) => number;
    expect(run(0)).toBe(0);
    expect(run(10)).toBe(55);
  });

  it("propagated fib body contains no boxing imports", () => {
    const result = compile(SOURCE_PROPAGATED, { nativeStrings: true });
    expect(result.success).toBe(true);
    const fibBody = extractFuncBody(result.wat, "fib");
    expect(fibBody).not.toBeNull();
    expect(fibBody!).not.toContain("__box_number");
    expect(fibBody!).not.toContain("__unbox_number");
  });

  it("propagated fib signature matches run's (f64) -> f64", () => {
    // The strongest check we can make from the WAT dump: fib and run
    // must reference the same function-type index. Since `run` is
    // explicitly annotated as `(n: number): number`, if fib shares
    // run's type-index then fib is also (f64) -> f64. This is
    // independent of the particular index the emitter chose.
    const result = compile(SOURCE_PROPAGATED, { nativeStrings: true });
    expect(result.success).toBe(true);
    const fibHeader = result.wat.match(/\(func \$fib\s+\(type\s+(\d+)\)/);
    const runHeader = result.wat.match(/\(func \$run\s+\(type\s+(\d+)\)/);
    expect(fibHeader).not.toBeNull();
    expect(runHeader).not.toBeNull();
    expect(fibHeader![1]).toBe(runHeader![1]);
  });

  it("works without experimentalIR flag (IR is on by default)", async () => {
    // No `experimentalIR` in options → should still produce f64 fib.
    const result = compile(SOURCE_PROPAGATED, { nativeStrings: true });
    expect(result.success).toBe(true);
    const fibBody = extractFuncBody(result.wat, "fib");
    expect(fibBody!).not.toContain("__box_number");
  });

  it("benchmarks/competitive/programs/fib-recursive.js compiles fib without boxing", () => {
    // The real benchmark file uses JSDoc annotations — this test ensures
    // the end-to-end compile path against the exact file the benchmark
    // harness consumes, so a later refactor can't silently drop the
    // Phase 2 win. Runtime invocation is skipped because the file also
    // declares a `benchmark` const literal, whose compiled form needs
    // string_constants import wiring the test ENV doesn't provide.
    const source = readFileSync(resolve(__dirname, "../benchmarks/competitive/programs/fib-recursive.js"), "utf8");
    const result = compile(source, { allowJs: true, nativeStrings: true });
    expect(result.success).toBe(true);
    const fibBody = extractFuncBody(result.wat, "fib");
    expect(fibBody).not.toBeNull();
    expect(fibBody!).not.toContain("__box_number");
    expect(fibBody!).not.toContain("__unbox_number");
  });

  it("legacy path still works when experimentalIR: false is explicit", async () => {
    // Escape hatch for divergence tests: the legacy path must remain
    // reachable via `experimentalIR: false`.
    const result = compile(SOURCE_PROPAGATED, { nativeStrings: true, experimentalIR: false });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, ENV);
    const run = instance.exports.run as (n: number) => number;
    expect(run(10)).toBe(55);
  });
});

/**
 * Extract the WAT body of a function by name. Returns null when not found.
 * The parser is deliberately naive — matches the `(func $<name> …)` s-expr
 * by tracking parenthesis nesting, which is good enough for the WAT
 * emitter's format and avoids pulling in a real s-expr parser.
 */
function extractFuncBody(wat: string, name: string): string | null {
  const marker = `(func $${name}`;
  const start = wat.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < wat.length; i++) {
    const ch = wat[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return wat.slice(start, i + 1);
    }
  }
  return null;
}
