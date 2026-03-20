import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Math.pow coercion to externref", () => {
  it("Math.pow result passed to function expecting any type", async () => {
    await assertEquivalent(
      `function check(a: any, b: any): number {
        return a === b ? 1 : 0;
      }
      export function test(): number {
        return check(Math.pow(2, 3), 8);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.pow result stored in array", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [];
        arr.push(Math.pow(2, 10));
        return arr[0]!;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.pow with special values", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = Math.pow(0, 0);      // 1
        const b = Math.pow(1, 100);    // 1
        const c = Math.pow(2, -1);     // 0.5
        return a + b + c;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.min with two arguments", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Math.min(3, 5);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.max with two arguments", async () => {
    await assertEquivalent(
      `export function test(): number {
        return Math.max(3, 5);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.pow result in conditional expression", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x = 2;
        const result = x > 0 ? Math.pow(x, 2) : -1;
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.pow with array element arguments in loop", async () => {
    await assertEquivalent(
      `function sameValue(actual: any, expected: any, msg: any): number {
        if (actual !== expected) return 0;
        return 1;
      }
      export function test(): number {
        const base: number[] = [2, 3, 4];
        const exponent = 2;
        let result = 0;
        for (let i = 0; i < 3; i++) {
          result += sameValue(Math.pow(base[i]!, exponent), Math.pow(base[i]!, exponent), base[i]);
        }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.pow result passed as any-typed argument", async () => {
    await assertEquivalent(
      `function check(a: any): number {
        return typeof a === "number" ? 1 : 0;
      }
      export function test(): number {
        return check(Math.pow(2, 3));
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
