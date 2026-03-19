import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("Symbol.asyncIterator support (#612)", () => {
  it("for await...of over an array of numbers", async () => {
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
    expect(await run(src, "main")).toBe(10);
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
    expect(await run(src, "main")).toBe(3);
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
    expect(await run(src, "main")).toBe(30);
  });

  it("Symbol.asyncIterator is a well-known symbol constant", async () => {
    // Symbol.asyncIterator should resolve to a constant i32 (12)
    const src = `
      export function main(): number {
        const sym = Symbol.asyncIterator;
        return sym as any as number;
      }
    `;
    expect(await run(src, "main")).toBe(12);
  });

  it("[Symbol.asyncIterator] as computed property name resolves correctly", async () => {
    // Test that [Symbol.asyncIterator] resolves to @@asyncIterator struct field
    const result = compile(`
      const obj = {
        [Symbol.asyncIterator]() {
          return { next() { return { value: 42, done: true }; } };
        }
      };
      export function main(): number { return 1; }
    `);
    // Should compile without errors (the diagnostic is suppressed)
    expect(result.success).toBe(true);
  });
});
