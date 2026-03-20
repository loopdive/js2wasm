import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Compound assignment on externref element access", () => {
  it("plus-equals on any-typed object element", async () => {
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

  it("minus-equals on any-typed object element", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any, key: any): number {
        obj[key] -= 3;
        return obj[key] as number;
      }
    `);
    const obj = { val: 10 };
    const result = exports.test(obj, "val");
    expect(result).toBe(7);
  });

  it("multiply-equals on any-typed object element", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any, key: any): number {
        obj[key] *= 4;
        return obj[key] as number;
      }
    `);
    const obj = { n: 3 };
    const result = exports.test(obj, "n");
    expect(result).toBe(12);
  });

  it("divide-equals on any-typed object element", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any, key: any): number {
        obj[key] /= 2;
        return obj[key] as number;
      }
    `);
    const obj = { n: 10 };
    const result = exports.test(obj, "n");
    expect(result).toBe(5);
  });

  it("modulo-equals on any-typed object element", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any, key: any): number {
        obj[key] %= 3;
        return obj[key] as number;
      }
    `);
    const obj = { n: 10 };
    const result = exports.test(obj, "n");
    expect(result).toBe(1);
  });

  it("compound assignment returns the new value", async () => {
    const exports = await compileToWasm(`
      export function test(obj: any, key: any): number {
        const result: number = (obj[key] += 5);
        return result;
      }
    `);
    const obj = { a: 7 };
    const result = exports.test(obj, "a");
    expect(result).toBe(12);
  });
});
