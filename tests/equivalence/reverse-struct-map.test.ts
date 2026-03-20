import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("typeIdxToStructName reverse map (#638)", () => {
  it("object destructuring resolves struct via reverse map", async () => {
    await assertEquivalent(
      `
      function makePoint(): { x: number; y: number } {
        return { x: 10, y: 20 };
      }
      export function test(): number {
        const { x, y } = makePoint();
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested object destructuring uses reverse map for inner struct", async () => {
    await assertEquivalent(
      `
      function makeNested(): { a: number; inner: { b: number; c: number } } {
        return { a: 1, inner: { b: 2, c: 3 } };
      }
      export function test(): number {
        const { a, inner: { b, c } } = makeNested();
        return a + b + c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("property access on struct ref uses reverse map", async () => {
    await assertEquivalent(
      `
      function makeObj(): { val: number } {
        return { val: 42 };
      }
      export function test(): number {
        const obj = makeObj();
        return obj.val;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
