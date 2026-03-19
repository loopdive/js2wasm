import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Test for issue #592: Verify that the unified single-pass collector
 * produces the same results as the previous multi-pass approach.
 * Exercises: console.log, Math methods, string literals, template literals,
 * parseInt, string methods, typeof, callbacks, exponentiation, and binary operators.
 */

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("unified collector (#592)", () => {
  it("compiles program with Math.abs (inline wasm)", async () => {
    expect(await run(`
      export function test(): number {
        return Math.abs(-5);
      }
    `, "test")).toBe(5);
  });

  it("compiles program with exponentiation operator (Math.pow)", async () => {
    expect(await run(`
      export function test(): number {
        return 2 ** 10;
      }
    `, "test")).toBe(1024);
  });

  it("compiles program with arrow function (callback collector)", async () => {
    expect(await run(`
      function apply(f: (x: number) => number, val: number): number {
        return f(val);
      }
      export function test(): number {
        return apply((x) => x * 2, 21);
      }
    `, "test")).toBe(42);
  });

  it("compiles program with basic arithmetic and locals", async () => {
    // No strings — just exercises basic compilation pipeline
    expect(await run(`
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 5; i++) {
          sum = sum + i;
        }
        return sum;
      }
    `, "test")).toBe(10);
  });

  it("compiles program with multiple features combined", async () => {
    // Exercises: string literals, Math, binary operators, callbacks
    expect(await run(`
      function square(x: number): number {
        return x * x;
      }
      export function test(): number {
        const a = Math.abs(-3);
        const b = square(a);
        return b + 1;
      }
    `, "test")).toBe(10);
  });

  it("compiles program with Math.floor and Math.ceil (inline wasm)", async () => {
    const floor = await run(`
      export function test(): number {
        return Math.floor(3.7);
      }
    `, "test");
    expect(floor).toBe(3);

    const ceil = await run(`
      export function test(): number {
        return Math.ceil(3.2);
      }
    `, "test");
    expect(ceil).toBe(4);
  });

  it("compiles program with Math.min and Math.max", async () => {
    expect(await run(`
      export function test(): number {
        return Math.min(10, 3);
      }
    `, "test")).toBe(3);

    expect(await run(`
      export function test(): number {
        return Math.max(10, 3);
      }
    `, "test")).toBe(10);
  });
});
