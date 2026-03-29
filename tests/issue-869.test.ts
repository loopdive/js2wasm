import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

/**
 * #869: Caller-side default parameter insertion.
 * Verifies that constant defaults are inlined at call sites and
 * that NaN is correctly distinguished from "missing argument".
 */

async function runTest(source: string): Promise<number> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports.test as () => number)();
}

describe("Default params: caller-side insertion (#869)", () => {
  it("constant default is used when arg missing", async () => {
    const result = await runTest(`
      function f(x: number = 42): number { return x; }
      export function test(): number { return f(); }
    `);
    expect(result).toBe(42);
  });

  it("constant default is overridden when arg provided", async () => {
    const result = await runTest(`
      function f(x: number = 42): number { return x; }
      export function test(): number { return f(100); }
    `);
    expect(result).toBe(100);
  });

  it("explicit NaN does NOT trigger default", async () => {
    const result = await runTest(`
      function f(x: number = 42): number { return x; }
      export function test(): number { return f(NaN) !== f(NaN) ? 1 : 0; }
    `);
    // f(NaN) should return NaN (not 42), and NaN !== NaN is true
    expect(result).toBe(1);
  });

  it("explicit 0 does NOT trigger default", async () => {
    const result = await runTest(`
      function f(x: number = 42): number { return x; }
      export function test(): number { return f(0); }
    `);
    expect(result).toBe(0);
  });

  it("negative constant default", async () => {
    const result = await runTest(`
      function f(x: number = -10): number { return x; }
      export function test(): number { return f(); }
    `);
    expect(result).toBe(-10);
  });

  it("multiple constant defaults, partial application", async () => {
    const result = await runTest(`
      function f(a: number = 10, b: number = 20): number { return a + b; }
      export function test(): number {
        return f() + f(1) + f(1, 2);
      }
    `);
    // f() = 10+20=30, f(1) = 1+20=21, f(1,2) = 1+2=3 → 54
    expect(result).toBe(54);
  });

  it("Infinity default", async () => {
    const result = await runTest(`
      function f(x: number = Infinity): number { return x > 1e308 ? 1 : 0; }
      export function test(): number { return f(); }
    `);
    expect(result).toBe(1);
  });

  it("zero default — explicitly passing 0 should give 0", async () => {
    const result = await runTest(`
      function f(x: number = 99): number { return x; }
      export function test(): number { return f(0); }
    `);
    expect(result).toBe(0);
  });
});
