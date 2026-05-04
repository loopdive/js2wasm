// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #862 — iterator protocol on function-declaration binding-pattern params.
 *
 * Before the fix, `function f([a, b]) {}` and class methods with binding-pattern
 * params never drove the iterator protocol: `f(generator)` bypassed `.next()`,
 * skipping any throws from the generator. After the fix, these declaration
 * forms widen unannotated binding-pattern params to `externref`, which routes
 * through `__array_from_iter` in `destructureParamArray` — same path as the
 * arrow/function-expression forms (already working via closures.ts #1151).
 *
 * The tuple-struct fast path in `destructureParamArray` prevents Wasm-native
 * tuple struct callers (`f([1, 2])`) from getting boxed through the iterator
 * and losing type information (see PR #255 retrospective in #862 issue file).
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#862 — iterator protocol on function-declaration binding-pattern params", () => {
  it("function declaration param destructuring calls .next() and propagates throws", async () => {
    const exports = await compileToWasm(`
      function* gen(): any { yield 1; throw new Error("stop"); }
      function f([a, b]: any) { return (a as number) + (b as number); }
      export function test(): any {
        try { f(gen()); return "no-throw"; }
        catch (e: any) { return (e as any).message; }
      }
    `);
    expect(exports.test()).toBe("stop");
  });

  it("rest element iterator step error propagates", async () => {
    const exports = await compileToWasm(`
      function* gen(): any { yield 1; throw new Error("at 2"); }
      function f([...r]: any) { return (r as any).length; }
      export function test(): any {
        try { f(gen()); return "no-throw"; }
        catch (e: any) { return (e as any).message; }
      }
    `);
    expect(exports.test()).toBe("at 2");
  });

  it("function declaration accepts Wasm-native array literal preserving types", async () => {
    // Critical regression test: f([3, 4]) must return 7 (numeric preserved),
    // not NaN (which happens if the caller's tuple struct is boxed through
    // Array.from / __extern_get_idx and the result is coerced back to f64).
    const exports = await compileToWasm(`
      function f([a, b]: any) { return (a as number) + (b as number); }
      export function test(): number { return f([3, 4]); }
    `);
    expect(exports.test()).toBe(7);
  });

  it("class method param destructuring drives iterator protocol", async () => {
    const exports = await compileToWasm(`
      function* gen(): any { throw new Error("step-err"); }
      class C { m([x]: any) { return x; } }
      export function test(): any {
        try { new C().m(gen()); return "no-throw"; }
        catch (e: any) { return (e as any).message; }
      }
    `);
    expect(exports.test()).toBe("step-err");
  });
});
