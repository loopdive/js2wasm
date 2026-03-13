import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./equivalence/helpers.js";

describe("Issue #378: Increment/decrement on property/element access", () => {
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

  it("increment property used in for loop", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let counter = { val: 0 };
        let sum = 0;
        for (let i = 0; i < 5; i++) {
          sum += counter.val++;
        }
        return sum + counter.val;  // 0+1+2+3+4 + 5 = 15
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("decrement array element in loop", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [10, 20, 30];
        arr[0]--;
        arr[1]--;
        arr[2]--;
        return arr[0] + arr[1] + arr[2];  // 9 + 19 + 29 = 57
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested property increment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { a: { b: 5 } };
        let result = ++obj.a.b;
        return result;  // 6
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix on nested property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { a: { b: 5 } };
        let old = obj.a.b++;
        return old + obj.a.b;  // 5 + 6 = 11
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("increment property with variable index on array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [10, 20, 30];
        let i = 1;
        let old = arr[i]++;
        return old + arr[i];  // 20 + 21 = 41
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("mixed property and element increment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 1 };
        let arr = [10];
        obj.x++;
        arr[0]++;
        return obj.x + arr[0];  // 2 + 11 = 13
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
