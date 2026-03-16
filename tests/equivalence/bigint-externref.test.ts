import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("BigInt externref coercion (#237)", () => {
  it("bigint passed to function expecting any", async () => {
    const exports = await compileToWasm(`
      function takeAny(x: any): number {
        return 42;
      }
      export function test(): number {
        const a: bigint = 10n;
        return takeAny(a);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("bigint expression result (i64.add) to any parameter", async () => {
    const exports = await compileToWasm(`
      function takeAny(x: any): number {
        return 1;
      }
      export function test(): number {
        const a: bigint = 5n;
        const b: bigint = 3n;
        return takeAny(a + b);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("bigint subtraction result to any parameter", async () => {
    const exports = await compileToWasm(`
      function takeAny(x: any): number {
        return 1;
      }
      export function test(): number {
        const a: bigint = 10n;
        const b: bigint = 3n;
        return takeAny(a - b);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("bigint returned as any type", async () => {
    const exports = await compileToWasm(`
      function getBigInt(): any {
        const x: bigint = 99n;
        return x;
      }
      export function test(): number {
        const val = getBigInt();
        return val !== undefined ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("bigint in ternary with any result type", async () => {
    const exports = await compileToWasm(`
      function check(x: any): number {
        return 1;
      }
      export function test(): number {
        const a: bigint = 5n;
        const b: bigint = 10n;
        const flag: boolean = true;
        return check(flag ? a : b);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("bigint literal to any parameter", async () => {
    const exports = await compileToWasm(`
      function takeAny(x: any): number {
        return 1;
      }
      export function test(): number {
        return takeAny(42n);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("bigint multiplication to any parameter", async () => {
    const exports = await compileToWasm(`
      function takeAny(x: any): number {
        return 1;
      }
      export function test(): number {
        const a: bigint = 3n;
        const b: bigint = 4n;
        return takeAny(a * b);
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
