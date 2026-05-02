// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1276 — HOF returning closure (createMathOperation pattern).
//
// Investigation finding (2026-05-02): the documented "compiler currently
// fails" claim is partially stale. The basic HOF-returning-closure pattern
// works for INTERNAL-WASM use:
//
//   - `const add = createMathOperation(fn); add(3, 4)` inside an
//     `export function test()` returns 7 ✓
//   - Multi-instance side-by-side (e.g. `add` + `mul`) ✓
//   - HOF with captured defaultValue ✓
//
// What does NOT work and is the actual remaining issue:
//   - `export default add` exports `add` as an externref GLOBAL, not a
//     callable function. JS `instance.exports.default(3, 4)` fails with
//     "is not a function" because Wasm globals aren't directly callable.
//   - Curried HOFs (closure-returning-closure-returning-closure) — the
//     inner-most call returns 0 instead of the expected value.
//
// Both follow-ups need trampoline-export-of-closure machinery — generate
// an exported Wasm function that reads the global, struct.get the funcref
// field, and call_ref through it. Out of scope for this PR; tracked.
//
// This file locks in the working internal-call patterns (addressing the
// issue's primary use case: lodash math ops compiled and called from
// within the same Wasm module). Treats #1276 as test-only similar to
// #1250 and #1275.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true, allowJs: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1276 — HOF returning closure", () => {
  // Basic createMathOperation pattern from lodash. The closure captures the
  // operator and is called from within the wasm module.
  it("createMathOperation: basic add(3, 4) returns 7", async () => {
    const src = `
      function createMathOp(op: any): any {
        return function(a: any, b: any): any { return op(a, b); };
      }
      const add = createMathOp(function(x: any, y: any): any { return x + y; });
      export function test(): number { return add(3, 4); }
    `;
    expect(await runTest(src)).toBe(7);
  });

  // HOF with a defaultValue captured alongside the operator.
  it("createMathOperation: HOF captures both operator and defaultValue", async () => {
    const src = `
      function createMathOp(op: any, defaultValue: any): any {
        return function(value: any, other: any): any {
          if (value === undefined) value = defaultValue;
          if (other === undefined) other = defaultValue;
          return op(value, other);
        };
      }
      const sub = createMathOp(function(a: any, b: any): any { return a - b; }, 0);
      export function test(): number { return sub(10, 3); }
    `;
    expect(await runTest(src)).toBe(7);
  });

  // Two HOF-created functions side by side — each captures its own operator.
  it("two HOF-created functions share the factory but capture different operators", async () => {
    const src = `
      function createMathOp(op: any): any {
        return function(a: any, b: any): any { return op(a, b); };
      }
      const add = createMathOp(function(x: any, y: any): any { return x + y; });
      const mul = createMathOp(function(x: any, y: any): any { return x * y; });
      export function test(): number { return add(2, 3) + mul(2, 3); } // 5 + 6 = 11
    `;
    expect(await runTest(src)).toBe(11);
  });

  // Real-ish lodash _createMathOperation pattern with NaN handling.
  it("realistic createMathOperation with NaN handling", async () => {
    const src = `
      function createMathOperation(operator: any, defaultValue: any): any {
        return function(value: any, other: any): any {
          if (value === undefined && other === undefined) {
            return defaultValue;
          }
          if (value === undefined) value = other;
          if (other === undefined) return value;
          return operator(value, other);
        };
      }
      const add = createMathOperation(function(a: any, b: any): any { return a + b; }, 0);
      export function test(): number { return add(5, 7); } // 12
    `;
    expect(await runTest(src)).toBe(12);
  });

  // Note: chained call `makeAdd()(3, 4)` (call the HOF result directly
  // without an intermediate binding) currently returns 0. Same root cause
  // as the curried-HOF case (chained closure-of-closure call). Tracked as
  // a follow-up of this issue. The intermediate-binding pattern (the
  // canonical lodash pattern) works — see tests above.
});
