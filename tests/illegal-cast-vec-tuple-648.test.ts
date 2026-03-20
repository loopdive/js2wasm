/**
 * Tests for #648: Residual illegal cast — vec-to-tuple, vec-to-vec,
 * struct narrowing, and externref-to-ref guarded cast.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function compileAndRun(source: string): any {
  const result = compile(source, "test.ts");
  if (!result.binary || result.binary.length === 0) {
    throw new Error("Compilation failed: " + (result.errors?.map((e: any) => e.message).join("; ") || "empty binary"));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const inst = new WebAssembly.Instance(mod, imports);
  return inst.exports;
}

describe("illegal cast guard (#648)", () => {
  it("vec-to-tuple: array literal passed to destructuring function parameter", () => {
    const exports = compileAndRun(`
      function destructure([x, y, z]: number[]): number {
        return x + y + z;
      }
      export function test(): number {
        return destructure([10, 20, 30]);
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("vec-to-tuple: multiple elements with coercion", () => {
    const exports = compileAndRun(`
      function first([a, b]: number[]): number {
        return a;
      }
      export function test(): number {
        return first([42, 99]);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("struct narrowing: larger struct cast to smaller subset", () => {
    const exports = compileAndRun(`
      function getEnum(obj: { enumerable: number }): number {
        return obj.enumerable;
      }
      export function test(): number {
        const desc = { configurable: 1, enumerable: 1, value: 0, writable: 1 };
        return getEnum(desc);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("closure via externref: function passed as externref callback", () => {
    const exports = compileAndRun(`
      function callFn(fn: () => number): number {
        return fn();
      }
      export function test(): number {
        const f = (): number => 42;
        return callFn(f);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("nested destructuring with array", () => {
    const exports = compileAndRun(`
      function sum([a, b, c]: number[]): number {
        return a + b + c;
      }
      export function test(): number {
        let result: number = 0;
        result = sum([1, 2, 3]);
        result = result + sum([10, 20, 30]);
        return result;
      }
    `);
    expect(exports.test()).toBe(66);
  });
});
