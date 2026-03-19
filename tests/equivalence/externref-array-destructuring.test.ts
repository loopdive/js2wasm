import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("externref array destructuring (#615)", () => {
  it("assignment destructuring from any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(arr: any): number {
        let a: any, b: any, c: any;
        [a, b, c] = arr;
        return (a as number) + (b as number) + (c as number);
      }
    `);
    expect(exports.test([10, 20, 30])).toBe(60);
  });

  it("variable declaration destructuring from any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(arr: any): number {
        const [x, y, z] = arr;
        return (x as number) + (y as number) + (z as number);
      }
    `);
    expect(exports.test([1, 2, 3])).toBe(6);
  });

  it("destructuring with holes from any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(arr: any): number {
        let a: any, c: any;
        [a, , c] = arr;
        return (a as number) + (c as number);
      }
    `);
    expect(exports.test([1, 2, 3])).toBe(4);
  });

  it("variable declaration destructuring from any-typed function return", async () => {
    const exports = await compileToWasm(`
      export function test(arr: any): number {
        const [a, b] = arr;
        return (a as number) + (b as number);
      }
    `);
    expect(exports.test([100, 200])).toBe(300);
  });

  it("two-element destructuring from any-typed parameter", async () => {
    const exports = await compileToWasm(`
      export function test(arr: any): number {
        let first: any, second: any;
        [first, second] = arr;
        return (first as number) * (second as number);
      }
    `);
    expect(exports.test([3, 7])).toBe(21);
  });
});
