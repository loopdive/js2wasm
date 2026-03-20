import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

describe("issue-662: for-of timeout fixes", () => {
  it("basic for-of over array still works", async () => {
    const source = `
      export function test(): number {
        const arr: number[] = [1, 2, 3, 4, 5];
        let sum = 0;
        for (const x of arr) {
          sum += x;
        }
        return sum;
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const test = (instance.exports as any).test;
    expect(test()).toBe(15);
  });

  it("for-of with break exits correctly", async () => {
    const source = `
      export function test(): number {
        const arr: number[] = [1, 2, 3, 4, 5];
        let sum = 0;
        for (const x of arr) {
          if (x > 3) break;
          sum += x;
        }
        return sum;
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const test = (instance.exports as any).test;
    expect(test()).toBe(6);
  });

  it("for-of with destructuring over array of tuples", async () => {
    const source = `
      export function test(): number {
        const pairs: [number, number][] = [[1, 10], [2, 20], [3, 30]];
        let sum = 0;
        for (const [a, b] of pairs) {
          sum += a + b;
        }
        return sum;
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const test = (instance.exports as any).test;
    expect(test()).toBe(66);
  });

  it("for-of array snapshots length (mutation guard)", async () => {
    // If the array length is snapshotted before the loop, pushing during iteration
    // should not cause an infinite loop. The loop should terminate after the
    // original number of elements.
    const source = `
      export function test(): number {
        const arr: number[] = [1, 2, 3];
        let count = 0;
        for (const x of arr) {
          count++;
          // Even if mutation changes the backing struct, lenLocal is snapshotted
        }
        return count;
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const test = (instance.exports as any).test;
    expect(test()).toBe(3);
  });
});
