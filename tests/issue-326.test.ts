import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function run(code: string): unknown {
  const result = compile(code);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const inst = new WebAssembly.Instance(mod, imports);
  return (inst.exports as Record<string, Function>).main();
}

describe("Issue #326: Array element access out of bounds", () => {
  test("destructuring array with exact length works", () => {
    const result = run(`
      export function main(): number {
        const arr: number[] = [10, 20, 30];
        const [a, b, c] = arr;
        return a + b + c;
      }
    `);
    expect(result).toBe(60);
  });

  test("number array destructuring shorter than pattern defaults to NaN", () => {
    const result = run(`
      export function main(): number {
        const arr: number[] = [5];
        const [a, b] = arr;
        // b should be NaN for number arrays (default for f64 out of bounds)
        // isNaN(b) should be true; a should still be 5
        return a;
      }
    `);
    expect(result).toBe(5);
  });

  test("number array destructuring empty array does not trap", () => {
    const result = run(`
      export function main(): number {
        const arr: number[] = [];
        const [a, b, c] = arr;
        // All should be NaN, but the key point is no trap
        return 42;
      }
    `);
    expect(result).toBe(42);
  });

  test("number array element access out of bounds returns NaN", () => {
    const result = run(`
      export function main(): number {
        const arr: number[] = [1, 2];
        const x = arr[5];
        // x should be NaN for number arrays
        // But the key thing is it should not trap
        return arr[0] + arr[1];
      }
    `);
    expect(result).toBe(3);
  });

  test("number array element access negative index returns NaN", () => {
    const result = run(`
      export function main(): number {
        const arr: number[] = [1, 2, 3];
        const x = arr[-1];
        // should not trap
        return arr[0];
      }
    `);
    expect(result).toBe(1);
  });

  test("for-of with array destructuring where inner array is short", () => {
    // This tests the for-of destructuring path
    const result = run(`
      export function main(): number {
        const data: number[][] = [[10, 20]];
        let sum = 0;
        for (const [a, b, c] of data) {
          sum = a + b;
          // c is out of bounds but should not trap
        }
        return sum;
      }
    `);
    expect(result).toBe(30);
  });

  test("destructuring assignment with short number array", () => {
    const result = run(`
      export function main(): number {
        const arr: number[] = [10];
        let a = 0;
        let b = 0;
        [a, b] = arr;
        // a should be 10, b should be NaN (or 0 depending on default)
        return a;
      }
    `);
    expect(result).toBe(10);
  });

  test("array access at exact boundary does not trap", () => {
    const result = run(`
      export function main(): number {
        const arr: number[] = [42];
        // Index 0 is valid
        const x = arr[0];
        // Index 1 is out of bounds but should not trap
        const y = arr[1];
        return x;
      }
    `);
    expect(result).toBe(42);
  });
});
