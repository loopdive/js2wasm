import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Array out-of-bounds access does not trap (#709)", () => {
  it("pop on non-empty array", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr.pop()!;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("shift on non-empty array", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr.shift()!;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("at() with negative index", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr.at(-1)!;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("slice with negative indices", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [10, 20, 30, 40, 50];
        const sliced = arr.slice(-3, -1);
        return sliced.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("destructuring shorter array does not trap", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [1];
        const [a, b] = arr;
        return a + b;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
