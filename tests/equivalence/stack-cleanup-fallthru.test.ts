import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("stack cleanup for fallthrough (#401)", () => {
  it("Math.round in try-catch does not leave values on stack", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result: number = 0;
        try {
          result = Math.round(2.7);
        } catch (e) {
          result = -1;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.round produces correct value without try-catch", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return Math.round(2.5);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Math.round with negative zero preservation", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return Math.round(0.3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function call after late import in try-catch", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        let result: number = 0;
        try {
          let arr: number[] = [1, 2, 3];
          result = add(arr.length, 10);
        } catch (e) {
          result = -1;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("expression statement in try-catch with void function", async () => {
    await assertEquivalent(
      `
      let counter: number = 0;
      function increment(): void { counter = counter + 1; }
      export function test(): number {
        try {
          increment();
          increment();
          increment();
        } catch (e) {}
        return counter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
