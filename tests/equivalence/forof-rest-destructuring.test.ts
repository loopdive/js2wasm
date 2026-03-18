import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("for-of rest destructuring (#526)", () => {
  it("for-of const [...x] creates correct rest array", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        const values: number[] = [1, 2, 3];
        let result = 0;
        for (const [...x] of [values]) {
          result = x[0] + x[1] + x[2];
        }
        return result;
      }
    `);
    expect(exports.main!()).toBe(6);
  });

  it("for-of const [...x] accessing x.length", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        const values: number[] = [1, 2, 3];
        let result = 0;
        for (const [...x] of [values]) {
          result = x.length;
        }
        return result;
      }
    `);
    expect(exports.main!()).toBe(3);
  });

  it("for-of const [a, ...rest] creates correct rest", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        const values: number[] = [10, 20, 30, 40];
        let result = 0;
        for (const [a, ...rest] of [values]) {
          result = a + rest.length;
        }
        return result;
      }
    `);
    expect(exports.main!()).toBe(13);
  });

  it("for-of var [...x] works correctly", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        const values: number[] = [5, 10, 15];
        let result = 0;
        for (var [...x] of [values]) {
          result = x[0] + x[1] + x[2];
        }
        return result;
      }
    `);
    expect(exports.main!()).toBe(30);
  });
});
