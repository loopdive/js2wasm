import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Compound assignment on element access for non-ref targets", () => {
  it("plus-equals on any-typed object with bracket notation compiles", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any, key: any): number {
        obj[key] += 10;
        return obj[key] as number;
      }
    `);
    const obj = { x: 5 };
    const result = exports.test(obj, "x");
    expect(result).toBe(15);
  });

  it("multiply-equals on any-typed object with bracket notation", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any, key: any): number {
        obj[key] *= 4;
        return obj[key] as number;
      }
    `);
    const obj = { a: 3 };
    const result = exports.test(obj, "a");
    expect(result).toBe(12);
  });

  it("xor-equals on any-typed object with bracket notation", async () => {
    // Test bitwise compound assignment (^=) which is common in test262
    const exports = await compileToWasm(`
      export function test(obj: any, key: any): number {
        obj[key] ^= 0xFF;
        return obj[key] as number;
      }
    `);
    const obj = { v: 0x0F };
    const result = exports.test(obj, "v");
    expect(result).toBe(0xF0);
  });

  it("compound assignment on array element access", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var arr: number[] = [10, 20, 30];
        arr[1] += 5;
        return arr[1];
      }
    `);
    const result = exports.test();
    expect(result).toBe(25);
  });
});
