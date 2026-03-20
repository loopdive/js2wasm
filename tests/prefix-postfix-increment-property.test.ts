import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("prefix/postfix increment on property access (#195)", () => {
  it("prefix increment on object property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        let result = ++obj.x;
        return result + obj.x;  // 6 + 6 = 12
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix decrement on object property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        let result = --obj.x;
        return result + obj.x;  // 9 + 9 = 18
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment on object property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        let result = obj.x++;
        return result + obj.x;  // 5 + 6 = 11
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix decrement on object property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        let result = obj.x--;
        return result + obj.x;  // 10 + 9 = 19
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix increment on array element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [1, 2, 3];
        let result = ++arr[1];
        return result + arr[1];  // 3 + 3 = 6
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment on array element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [1, 2, 3];
        let result = arr[1]++;
        return result + arr[1];  // 2 + 3 = 5
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple increments on same property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { count: 0 };
        obj.count++;
        obj.count++;
        ++obj.count;
        return obj.count;  // 3
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("increment property in expression", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { a: 1, b: 10 };
        return obj.a++ + ++obj.b;  // 1 + 11 = 12
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
