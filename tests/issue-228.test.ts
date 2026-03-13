import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #228: BigInt equality with Number/Boolean", () => {
  it("bigint vs number loose equality", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 0n;
        const b: number = 0;
        const c: bigint = 42n;
        const d: number = 42;
        let result = 0;
        if (a == b) result += 1;    // true: 0n == 0
        if (c == d) result += 2;    // true: 42n == 42
        if (!(a == d)) result += 4; // true: 0n != 42
        if (c != b) result += 8;    // true: 42n != 0
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint vs number strict equality always false", async () => {
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

  it("bigint vs boolean loose equality", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const zero: bigint = 0n;
        const one: bigint = 1n;
        const t: boolean = true;
        const f: boolean = false;
        let result = 0;
        if (zero == f) result += 1;   // true: 0n == false (0)
        if (one == t) result += 2;    // true: 1n == true (1)
        if (!(zero == t)) result += 4; // true: 0n != true
        if (!(one == f)) result += 8;  // true: 1n != false
        return result;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("bigint vs boolean strict equality always false", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: bigint = 1n;
        const b: boolean = true;
        let result = 0;
        if (!(a === b)) result += 1;  // true: different types
        if (a !== b) result += 2;     // true: different types
        return result;
      }
    `);
    expect(exports.test()).toBe(3);
  });
});
