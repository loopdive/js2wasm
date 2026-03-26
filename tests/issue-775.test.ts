/**
 * Tests for issue #775: Null pointer traps should be catchable TypeError
 *
 * Verifies that null/undefined property access, element access, and
 * for-of iteration throw catchable TypeError instead of causing Wasm traps.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compile error: ${r.errors[0]?.message}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as Function)();
}

describe("Issue #775: null TypeError", () => {
  it("null property access throws catchable error", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        try {
          const x: any = null;
          const y = x.foo;
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("null element access throws catchable error", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        try {
          const x: any = null;
          const y = x[0];
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("undefined property access throws catchable error", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        try {
          const x: any = undefined;
          const y = x.bar;
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("non-null property access works normally", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const x = { foo: 42 };
        return x.foo;
      }
    `);
    expect(result).toBe(42);
  });

  it("non-null element access works normally", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const arr = [10, 20, 30];
        return arr[1];
      }
    `);
    expect(result).toBe(20);
  });

  it("for-of on array works normally", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        let sum = 0;
        const arr = [1, 2, 3];
        for (const x of arr) {
          sum += x;
        }
        return sum;
      }
    `);
    expect(result).toBe(6);
  });
});
