import { describe, it, expect } from "vitest";
import { compileToWasm, assertEquivalent } from "./equivalence/helpers.js";

describe("Call expression patterns", () => {
  it("should handle assignment expression as callee: (x = fn)()", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number): number { return a + b; }
      let f: (a: number, b: number) => number = add;
      export function test(): number {
        return (f = add)(3, 4);
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("should handle comma expression as callee: (0, fn)()", async () => {
    const exports = await compileToWasm(`
      function getVal(): number { return 42; }
      export function test(): number {
        return (0, getVal)();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("should handle conditional expression as callee: (cond ? fn1 : fn2)()", async () => {
    await assertEquivalent(
      `
      function double(x: number): number { return x * 2; }
      function triple(x: number): number { return x * 3; }
      export function test(useDouble: number): number {
        return (useDouble ? double : triple)(5);
      }
      `,
      [
        { fn: "test", args: [1] },
        { fn: "test", args: [0] },
      ],
    );
  });
});
