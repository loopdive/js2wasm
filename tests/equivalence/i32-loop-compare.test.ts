import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

/**
 * Verify that i32 loop variable comparisons produce correct results (#934).
 * detectI32LoopVar promotes loop counters to i32; binary-ops must use i32.lt_s
 * for comparisons instead of converting both sides to f64.
 */
describe("i32 loop comparison optimization (#934)", () => {
  it("for loop with constant upper bound accumulates correctly", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 100; i++) sum += i;
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(4950);
  });

  it("for loop counting down with >= condition", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 99; i >= 0; i--) sum += i;
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(4950);
  });

  it("for loop with large upper bound (10000)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10000; i++) sum += i;
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(49995000);
  });

  it("nested loops with i32 counters", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i++) {
          for (let j = 0; j < 10; j++) sum += i * 10 + j;
        }
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(4950);
  });

  it("for loop with <= bound", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum = 0;
        for (let i = 1; i <= 100; i++) sum += i;
        return sum;
      }
    `);
    expect(exports["test"]!()).toBe(5050);
  });
});
