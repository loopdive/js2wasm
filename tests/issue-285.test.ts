import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./equivalence/helpers.js";

describe("Issue #285: For-loop complex heads and function declarations", () => {
  it("multiple variable declarations in for-loop init", async () => {
    const source = `
      export function test(): number {
        let result = 0;
        for (var a = 0, b = 10; a < b; a++, b--) {
          result += 1;
        }
        return result;
      }
    `;
    await assertEquivalent(source, [{ fn: "test", args: [] }]);
  });

  it("three variables in for-loop init", async () => {
    const source = `
      export function test(): number {
        let sum = 0;
        for (var i = 0, j = 1, k = 2; i < 3; i++, j++, k++) {
          sum += i + j + k;
        }
        return sum;
      }
    `;
    await assertEquivalent(source, [{ fn: "test", args: [] }]);
  });

  it("comma expression in for-loop update", async () => {
    const source = `
      export function test(): number {
        let sum = 0;
        for (var i = 0, j = 10; i < 5; i++, j--) {
          sum += j - i;
        }
        return sum;
      }
    `;
    await assertEquivalent(source, [{ fn: "test", args: [] }]);
  });

  it("arrow function initializer in for-loop", async () => {
    const source = `
      export function test(): number {
        let result = 0;
        for (var fn = (x: number) => x * 2, i = 0; i < 3; i++) {
          result += fn(i);
        }
        return result;
      }
    `;
    await assertEquivalent(source, [{ fn: "test", args: [] }]);
  });

  it("function declaration inside for-loop body", async () => {
    const source = `
      export function test(): number {
        let result = 0;
        for (var i = 0; i < 3; i++) {
          function addOne(x: number): number { return x + 1; }
          result += addOne(i);
        }
        return result;
      }
    `;
    await assertEquivalent(source, [{ fn: "test", args: [] }]);
  });

  it("var re-declaration in for-loop", async () => {
    const source = `
      export function test(): number {
        var i = 100;
        for (var i = 0; i < 5; i++) {
        }
        return i;
      }
    `;
    await assertEquivalent(source, [{ fn: "test", args: [] }]);
  });

  it("multiple declarations with no initializer", async () => {
    const source = `
      export function test(): number {
        let sum = 0;
        for (var i = 0, j: number; i < 3; i++) {
          j = i * 2;
          sum += j;
        }
        return sum;
      }
    `;
    await assertEquivalent(source, [{ fn: "test", args: [] }]);
  });
});
