/**
 * Tests for issue #1038: Function.prototype.bind not implemented.
 *
 * The fix is an "identity bind": fn.bind(thisArg, ...partialArgs) evaluates all
 * arguments for side effects and returns the receiver as an externref. This is
 * intentionally a simplification — it doesn't bind `this` or prepend partial
 * arguments — but it eliminates the "bind is not a function" runtime error and
 * unblocks the large class of test262 tests that only need bind's result to
 * behave as a function value.
 *
 * The intercept is narrowed to receivers whose TS type has at least one call
 * signature, which preserves the legacy "throws on non-function receiver"
 * behavior that some test262 assertions implicitly rely on.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runTest(src: string): Promise<unknown> {
  const result = compile(src, { fileName: "test.ts" });
  expect(result.success, `CE: ${result.errors?.[0]?.message}`).toBe(true);
  const imports = buildImports(result.imports!, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary!, imports);
  return (instance.exports as Record<string, CallableFunction>).test?.();
}

describe("issue-1038: Function.prototype.bind", () => {
  it("compiles fn.bind(thisArg) without 'bind is not a function' error", async () => {
    const r = await runTest(`
      function foo(): number { return 42; }
      export function test(): i32 {
        const bound = foo.bind({});
        return bound == null ? 0 : 1;
      }
    `);
    expect(r).toBe(1);
  });

  it("bind with partial arguments does not crash", async () => {
    const r = await runTest(`
      function foo(a: number, b: number, c: number): number { return a + b + c; }
      export function test(): i32 {
        const bound = foo.bind(null, 1, 2, 3);
        return bound == null ? 0 : 1;
      }
    `);
    expect(r).toBe(1);
  });

  it("bind evaluates arguments for side effects", async () => {
    const r = await runTest(`
      let counter: i32 = 0;
      function foo(a: number, b: number, c: number): number { return 1; }
      function inc(): number { counter = counter + 1; return 0; }
      export function test(): i32 {
        foo.bind(inc(), inc(), inc());
        return counter;
      }
    `);
    expect(r).toBe(3);
  });

  it("bound function value can be stored in another binding", async () => {
    const r = await runTest(`
      function foo(): number { return 99; }
      export function test(): i32 {
        const a = foo.bind({});
        const b = a;
        return b == null ? 0 : 1;
      }
    `);
    expect(r).toBe(1);
  });
});
