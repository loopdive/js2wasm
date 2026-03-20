import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("for-await-of (compiled as regular for-of)", () => {
  it("for await...of iterates an array of numbers", async () => {
    const src = `
      async function sumArray(arr: number[]): Promise<number> {
        let total = 0;
        for await (const x of arr) {
          total += x;
        }
        return total;
      }
      export function main(): number {
        return sumArray([1, 2, 3, 4]) as any as number;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(10);
  });

  it("for await...of with let binding", async () => {
    const src = `
      async function countItems(arr: number[]): Promise<number> {
        let count = 0;
        for await (let item of arr) {
          count += 1;
        }
        return count;
      }
      export function main(): number {
        return countItems([10, 20, 30]) as any as number;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(3);
  });

  it("for await...of with string iteration", async () => {
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
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(5);
  });

  it("for await...of with accumulation", async () => {
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
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(30);
  });
});
