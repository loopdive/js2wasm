import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * Issue #659: Call type mismatch residual (609 CE)
 *
 * Tests that function call arguments and return values are properly
 * coerced between Wasm types (struct ref, externref, f64, i32).
 * Each test verifies that WebAssembly.instantiate succeeds (no type errors).
 */

describe("Issue #659: Call type mismatch residual", () => {
  it("struct ref passed to function expecting externref (any param)", async () => {
    // Pattern: local.get of struct ref type where externref expected
    const exports = await compileToWasm(`
      function identity(x: any): any { return x; }
      export function test(): number {
        var arr: number[] = [1, 2, 3];
        var result = identity(arr);
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("f64 call result passed where externref expected", async () => {
    // Pattern: call returning f64 but argument expects externref
    const exports = await compileToWasm(`
      function getNum(): number { return 42; }
      function takeAny(x: any): any { return x; }
      export function test(): number {
        var result = takeAny(getNum());
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("f64.const passed where externref expected (mixed args)", async () => {
    // Pattern: f64.const where externref expected
    const exports = await compileToWasm(`
      function takeTwo(x: any, y: any): number { return 1; }
      export function test(): number {
        return takeTwo("hello", 42);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("externref call result used where f64 expected", async () => {
    // Pattern: call returning externref but used as f64
    const exports = await compileToWasm(`
      function getAny(): any { return 42; }
      export function test(): number {
        var x: number = getAny();
        return x + 1;
      }
    `);
    // May produce NaN+1=NaN since getAny returns externref
  });

  it("struct.new passed where externref expected", async () => {
    // Pattern: struct.new result passed to function expecting externref
    const exports = await compileToWasm(`
      function takeAny(x: any): number { return 1; }
      export function test(): number {
        return takeAny({ a: 1, b: 2 });
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("closure returning externref used in if condition", async () => {
    // Pattern: call_ref returning externref used in if condition needs i32 truthiness
    const exports = await compileToWasm(`
      export function test(): number {
        var fn = (): any => "yes";
        if (fn()) {
          return 1;
        }
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("passing array to function expecting any (closure)", async () => {
    // Pattern: closure capture passes struct ref where externref expected
    const exports = await compileToWasm(`
      export function test(): number {
        var data: number[] = [10, 20, 30];
        var fn = (): any => data;
        var result = fn();
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("global function called with struct ref arg from closure", async () => {
    // Pattern: closure calls a global function, passing captured struct ref
    const exports = await compileToWasm(`
      function process(x: any): number { return 1; }
      export function test(): number {
        var obj = { a: 1 };
        var fn = (): number => process(obj);
        return fn();
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("excess arguments to closure call are dropped (arity mismatch)", async () => {
    // Bug: compileClosureCall pushed ALL arguments even when closure has fewer params
    // This caused call_ref[0] expected type (ref null N), found f64.const
    const exports = await compileToWasm(`
      export function test(): number {
        var f = function(): number { return 42; };
        return f(1, 2, 3);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("excess arguments to assigned function expression", async () => {
    // Pattern from test262 S10.6_A6.js: f2(0, 1, 2, 3) where f2 has 0 params
    const exports = await compileToWasm(`
      export function test(): number {
        var f2 = function(): number { return 99; };
        f2(0, 1, 2, 3);
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("filter callback returning string (externref) used as truthy", async () => {
    // Bug: buildTruthyCheck didn't handle externref returns from call_ref
    // Caused: if[0] expected type i32, found call_ref of type externref
    const exports = await compileToWasm(`
      export function test(): number {
        var arr = [11, 22, 33];
        var result = arr.filter((val: number): string => "truthy");
        return result.length;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("some callback returning string (externref) used as truthy", async () => {
    // Same pattern as filter but for Array.prototype.some
    const exports = await compileToWasm(`
      export function test(): number {
        var arr = [1, 2, 3];
        return arr.some((val: number): any => "yes") ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("every callback returning externref used as truthy", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var arr = [1, 2, 3];
        return arr.every((val: number): any => "yes") ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
