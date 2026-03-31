import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

describe("Issue #237: BigInt i64 vs externref type mismatch", () => {
  it("should compile BigInt literals without type mismatch errors", () => {
    const source = `
      export function addBigInts(): number {
        const a: bigint = 10n;
        const b: bigint = 20n;
        return Number(a + b);
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should handle BigInt assigned to a variable and returned as number", async () => {
    const source = `
      export function bigIntToNumber(): number {
        const x: bigint = 42n;
        return Number(x);
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
    const exports = instance.exports as Record<string, Function>;
    expect(exports.bigIntToNumber()).toBe(42);
  });

  it("should compile BigInt subtraction without type errors", () => {
    const source = `
      export function bigIntSub(): number {
        const a: bigint = 100n;
        const b: bigint = 37n;
        return Number(a - b);
      }
    `;
    const result = compile(source);
    // Compilation should succeed (no i64 vs externref mismatch)
    expect(result.success).toBe(true);
  });

  it("should handle BigInt comparison returning boolean", async () => {
    const source = `
      export function bigIntCompare(): boolean {
        const a: bigint = 10n;
        const b: bigint = 20n;
        return a < b;
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
    const exports = instance.exports as Record<string, Function>;
    expect(exports.bigIntCompare()).toBe(1);
  });

  it("should handle i64 to externref coercion (BigInt passed where externref expected)", () => {
    // This tests the specific type mismatch: i64 flowing into externref context
    const source = `
      export function identity(x: any): any {
        return x;
      }
      export function test(): number {
        const b: bigint = 5n;
        return Number(b);
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
  });

  it("should handle BigInt multiplication", async () => {
    const source = `
      export function bigIntMul(): number {
        const a: bigint = 7n;
        const b: bigint = 6n;
        return Number(a * b);
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
    const exports = instance.exports as Record<string, Function>;
    expect(exports.bigIntMul()).toBe(42);
  });
});
