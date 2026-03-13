import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #237: BigInt i64 vs externref type mismatch", () => {
  it("BigInt literal returned as number (i64 -> f64)", async () => {
    const exports = await compileToWasm(`
      export function getBigInt(): number {
        const x: bigint = 42n;
        return Number(x);
      }
    `);
    expect(exports.getBigInt()).toBe(42);
  });

  it("BigInt arithmetic", async () => {
    const exports = await compileToWasm(`
      export function addBigInt(): number {
        const a: bigint = 10n;
        const b: bigint = 20n;
        return Number(a + b);
      }
    `);
    expect(exports.addBigInt()).toBe(30);
  });

  it("BigInt subtraction returned as number", async () => {
    const exports = await compileToWasm(`
      export function subBigInt(): number {
        const a: bigint = 50n;
        const b: bigint = 20n;
        return Number(a - b);
      }
    `);
    expect(exports.subBigInt()).toBe(30);
  });

  it("BigInt comparison", async () => {
    const exports = await compileToWasm(`
      export function compareBigInt(): number {
        const a: bigint = 10n;
        const b: bigint = 20n;
        if (a < b) return 1;
        return 0;
      }
    `);
    expect(exports.compareBigInt()).toBe(1);
  });

  it("BigInt passed to function expecting any (i64 -> AnyValue boxing)", async () => {
    const exports = await compileToWasm(`
      function identity(x: any): any { return x; }
      export function testBigIntToAny(): number {
        const x: bigint = 42n;
        identity(x);
        return 1;
      }
    `);
    expect(exports.testBigIntToAny()).toBe(1);
  });

  it("BigInt assigned to variable of type any", async () => {
    const exports = await compileToWasm(`
      export function bigIntAnyVar(): number {
        const x: bigint = 100n;
        let y: any = x;
        return 1;
      }
    `);
    expect(exports.bigIntAnyVar()).toBe(1);
  });

  it("BigInt negation", async () => {
    const exports = await compileToWasm(`
      export function negateBigInt(): number {
        const x: bigint = 42n;
        return Number(-x);
      }
    `);
    expect(exports.negateBigInt()).toBe(-42);
  });

  it("BigInt bitwise operations", async () => {
    const exports = await compileToWasm(`
      export function bitwiseAnd(): number {
        const a: bigint = 0xFFn;
        const b: bigint = 0x0Fn;
        return Number(a & b);
      }
      export function bitwiseOr(): number {
        const a: bigint = 0xF0n;
        const b: bigint = 0x0Fn;
        return Number(a | b);
      }
    `);
    expect(exports.bitwiseAnd()).toBe(0x0F);
    expect(exports.bitwiseOr()).toBe(0xFF);
  });

  it("BigInt equality comparison", async () => {
    const exports = await compileToWasm(`
      export function eqBigInt(): number {
        const a: bigint = 42n;
        const b: bigint = 42n;
        return a === b ? 1 : 0;
      }
      export function neqBigInt(): number {
        const a: bigint = 42n;
        const b: bigint = 43n;
        return a !== b ? 1 : 0;
      }
    `);
    expect(exports.eqBigInt()).toBe(1);
    expect(exports.neqBigInt()).toBe(1);
  });
});
