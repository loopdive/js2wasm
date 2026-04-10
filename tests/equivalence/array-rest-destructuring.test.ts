import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("array rest destructuring", () => {
  it("rest in function parameter", async () => {
    await assertEquivalent(
      `
      function f([...x]: number[]): number {
        return x.length;
      }
      export function test(): number {
        return f([1, 2, 3]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("rest with leading elements in param", async () => {
    await assertEquivalent(
      `
      function f([a, b, ...rest]: number[]): number {
        return a + b + rest.length;
      }
      export function test(): number {
        return f([10, 20, 30, 40, 50]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("rest in variable destructuring", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [1, 2, 3, 4, 5];
        const [...x] = arr;
        return x.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("rest with leading elements in variable", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30, 40];
        const [a, ...rest] = arr;
        return a + rest.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("rest element value access", async () => {
    await assertEquivalent(
      `
      function f([a, ...rest]: number[]): number {
        return rest[0] + rest[1];
      }
      export function test(): number {
        return f([1, 2, 3]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("rest with var reassignment (externref pre-alloc)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 0;
        var y: number[] = [];
        [x, ...y] = [10, 20, 30];
        return y[0] + y[1];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("rest with untyped var", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var arr = [10, 20, 30, 40];
        var rest: number[];
        [, ...rest] = arr;
        return rest[0] + rest[1] + rest[2];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
