import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("test262-style destructuring assignment patterns", () => {
  it("array elem target identifier - chained assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let y: number = 0;
        let z: number = 0;
        let vals: number[] = [1, 2, 3];
        [x, y, z] = vals;
        return x + y + z;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array elision - skip elements", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let vals: number[] = [42, 99];
        [, x] = vals;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array rest after element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let y: number[] = [];
        let vals: number[] = [1, 2, 3];
        [x, ...y] = vals;
        return x + y.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("parenthesized identifier assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        (x) = 42;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array destructuring", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let vals: number[][] = [[7]];
        [[x]] = vals;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
