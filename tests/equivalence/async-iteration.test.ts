import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

/**
 * Async iteration equivalence tests.
 *
 * The js2wasm compiler compiles `for await...of` as regular `for...of`
 * (since async is compiled synchronously). These tests verify that the
 * compiled async iteration patterns produce correct results.
 */
describe("Async iteration equivalence", () => {
  it("for await...of sums array elements", async () => {
    const src = `
      async function sumArray(arr: number[]): Promise<number> {
        let total = 0;
        for await (const x of arr) {
          total += x;
        }
        return total;
      }
      export function main(): number {
        return sumArray([1, 2, 3, 4, 5]) as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(15);
  });

  it("for await...of counts elements", async () => {
    const src = `
      async function countItems(arr: number[]): Promise<number> {
        let count = 0;
        for await (let item of arr) {
          count += 1;
        }
        return count;
      }
      export function main(): number {
        return countItems([10, 20, 30, 40]) as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(4);
  });

  it("for await...of accumulates products", async () => {
    const src = `
      async function product(arr: number[]): Promise<number> {
        let result = 1;
        for await (const x of arr) {
          result *= x;
        }
        return result;
      }
      export function main(): number {
        return product([2, 3, 5]) as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(30);
  });

  it("for await...of with conditional accumulation", async () => {
    const src = `
      async function sumPositive(arr: number[]): Promise<number> {
        let total = 0;
        for await (const x of arr) {
          if (x > 0) total += x;
        }
        return total;
      }
      export function main(): number {
        return sumPositive([1, -2, 3, -4, 5]) as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(9);
  });

  it("for await...of with break", async () => {
    const src = `
      async function sumUntilNeg(arr: number[]): Promise<number> {
        let total = 0;
        for await (const x of arr) {
          if (x < 0) break;
          total += x;
        }
        return total;
      }
      export function main(): number {
        return sumUntilNeg([1, 2, 3, -1, 4, 5]) as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(6);
  });

  it("for await...of over string characters", async () => {
    const src = `
      async function countChars(s: string): Promise<number> {
        let n = 0;
        for await (const c of s) {
          n += 1;
        }
        return n;
      }
      export function main(): number {
        return countChars("hello") as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(5);
  });

  it("nested for await...of loops", async () => {
    const src = `
      async function nestedSum(a: number[], b: number[]): Promise<number> {
        let total = 0;
        for await (const x of a) {
          for await (const y of b) {
            total += x * y;
          }
        }
        return total;
      }
      export function main(): number {
        return nestedSum([1, 2], [3, 4]) as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    // (1*3 + 1*4) + (2*3 + 2*4) = 7 + 14 = 21
    expect(wasm.main()).toBe(21);
  });
});
