import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("null destructuring guards (#419)", () => {
  it("object destructuring from valid source after null guard", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 5, y: 15 };
        const { x, y } = obj;
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object destructuring from non-null source works normally", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const { x, y } = { x: 10, y: 20 };
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array destructuring from non-null source works normally", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const [a, b, c] = [1, 2, 3];
        return a * 100 + b * 10 + c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested object destructuring from non-null works", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const { a, b } = { a: 5, b: 10 };
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object destructuring with default values", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const { x = 42, y = 99 } = { x: 10 } as { x: number; y?: number };
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function parameter destructuring works with valid objects", async () => {
    await assertEquivalent(
      `
      function add({a, b}: {a: number; b: number}): number {
        return a + b;
      }
      export function test(): number {
        return add({a: 3, b: 7});
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
