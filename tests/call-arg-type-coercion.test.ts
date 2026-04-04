import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Issue #626: Wasm call/call_ref type mismatch
 *
 * Tests for argument type coercion before call instructions.
 * When a function parameter expects externref but gets f64 (or vice versa),
 * the compiler must insert coercion instructions.
 */

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
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

describe("call argument type coercion (#626)", () => {
  it("f64 arithmetic result passed to any-typed parameter", async () => {
    // Pattern: call[0] expected externref, found f64
    const result = await run(
      `
      function takeAny(x: any): any { return x; }
      export function test(): number {
        const a = 2 + 3;
        return takeAny(a);
      }
    `,
      "test",
    );
    expect(result).toBe(5);
  });

  it("boolean (i32) passed to any-typed parameter", async () => {
    // Pattern: call[0] expected externref, found i32
    const result = await run(
      `
      function identity(x: any): any { return x; }
      export function test(): number {
        return identity(true) ? 1 : 0;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("any-typed value passed to number parameter", async () => {
    // Pattern: call[0] expected f64, found externref
    const result = await run(
      `
      function addOne(x: number): number { return x + 1; }
      export function test(): number {
        const s: any = 5;
        return addOne(s);
      }
    `,
      "test",
    );
    expect(result).toBe(6);
  });

  it("closure call_ref with f64 where externref expected", async () => {
    // Pattern: call_ref[1] expected externref, found f64
    const result = await run(
      `
      export function test(): number {
        const fn = (x: any): any => x;
        const val = 1 + 2;
        return fn(val);
      }
    `,
      "test",
    );
    expect(result).toBe(3);
  });

  it("class method call with f64 where externref expected", async () => {
    // Pattern: call[1] expected externref, found f64
    const result = await run(
      `
      class Foo {
        process(x: any): any { return x; }
      }
      export function test(): number {
        const f = new Foo();
        return f.process(42);
      }
    `,
      "test",
    );
    expect(result).toBe(42);
  });

  it("multiple argument types coerced correctly", async () => {
    const result = await run(
      `
      function combine(a: any, b: any): number {
        return a + b;
      }
      export function test(): number {
        return combine(10, 20);
      }
    `,
      "test",
    );
    expect(result).toBe(30);
  });
});
