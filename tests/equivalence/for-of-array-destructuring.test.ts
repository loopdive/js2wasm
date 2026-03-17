import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("for-of array destructuring", () => {
  it("tuple array: for (const [a, b] of pairs)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const pairs: [number, number][] = [[1, 2], [3, 4], [5, 6]];
        let sum = 0;
        for (const [a, b] of pairs) {
          sum += a + b;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("tuple array with mixed types: for (const [s, n] of entries)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const entries: [number, number][] = [[10, 1], [20, 2], [30, 3]];
        let total = 0;
        for (const [key, value] of entries) {
          total += key * value;
        }
        return total;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array destructuring in for-of (vec of vecs)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const data: number[][] = [[1, 2], [3, 4]];
        let sum = 0;
        for (const [a, b] of data) {
          sum += a + b;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("tuple with three elements", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const triples: [number, number, number][] = [[1, 2, 3], [4, 5, 6]];
        let sum = 0;
        for (const [a, b, c] of triples) {
          sum += a + b + c;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("tuple destructuring with partial binding (fewer bindings than fields)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const pairs: [number, number][] = [[10, 20], [30, 40]];
        let sum = 0;
        for (const [a] of pairs) {
          sum += a;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("tuple destructuring with omitted element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const pairs: [number, number, number][] = [[1, 2, 3], [4, 5, 6]];
        let sum = 0;
        for (const [a, , c] of pairs) {
          sum += a + c;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("single-iteration tuple for-of", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const items: [number, number][] = [[42, 58]];
        let result = 0;
        for (const [a, b] of items) {
          result = a + b;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
