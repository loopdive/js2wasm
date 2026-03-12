import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("BigInt", () => {
  it("bigint comparison", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 42n;
        const b: bigint = 42n;
        if (a === b) return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("bigint vs Infinity comparison does not trap (#227)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 0n;
        const inf: number = Infinity;
        const negInf: number = -Infinity;
        let result = 0;
        if (a < inf) result += 1;      // true: 0 < Infinity
        if (a > negInf) result += 2;    // true: 0 > -Infinity
        if (!(a > inf)) result += 4;    // true: 0 is not > Infinity
        if (!(a < negInf)) result += 8; // true: 0 is not < -Infinity
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint vs number loose equality (#228)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 0n;
        const b: number = 0;
        const c: bigint = 42n;
        const d: number = 42;
        let result = 0;
        if (a == b) result += 1;   // true: 0n == 0
        if (c == d) result += 2;   // true: 42n == 42
        if (!(a == d)) result += 4; // true: 0n != 42
        return result;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("bigint vs number strict equality returns false (#228)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 0n;
        const b: number = 0;
        let result = 0;
        if (!(a === b)) result += 1;  // true: different types
        if (a !== b) result += 2;     // true: different types
        return result;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("bigint comparison operators with numbers (#227)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const big: bigint = 10n;
        const num: number = 5;
        let result = 0;
        if (big > num) result += 1;   // true: 10 > 5
        if (big >= num) result += 2;  // true: 10 >= 5
        if (!(big < num)) result += 4; // true: 10 is not < 5
        if (!(big <= num)) result += 8; // true: 10 is not <= 5
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });
});
