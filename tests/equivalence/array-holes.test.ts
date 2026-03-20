import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Array holes / OmittedExpression (#328)", () => {
  it("array literal with hole [1, , 3]", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr = [1, , 3];
        return arr.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("array literal with leading hole [, 2, 3]", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr = [, 2, 3];
        return arr.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("array literal with trailing hole [1, 2, ,]", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr = [1, 2, ,];
        return arr.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("all holes [, , ,]", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr = [, , ,];
        return arr.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("hole element value is treated as 0 in numeric array", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr = [10, , 30];
        return arr[0] + arr[2];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("destructuring with holes skips elements", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr = [10, 20, 30, 40];
        const [a, , c] = arr;
        return a + c;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("destructuring with leading hole", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr = [10, 20, 30];
        const [, b, c] = arr;
        return b + c;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
