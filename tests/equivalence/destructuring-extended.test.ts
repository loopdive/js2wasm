import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("destructuring extended", () => {
  it("swap via array destructuring", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let a = 1;
        let b = 2;
        [b, a] = [a, b];
        return a * 10 + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array rest element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const [first, ...rest] = [1, 2, 3, 4, 5];
        return first * 100 + rest.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("destructuring in for-of loop", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const pairs: [number, number][] = [[1, 10], [2, 20], [3, 30]];
        let sum = 0;
        for (const [k, v] of pairs) {
          sum += k + v;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("destructured function parameters with defaults", async () => {
    await assertEquivalent(
      `
      function process(x: number, y: number = 10): number {
        return x + y;
      }
      export function test(): number {
        return process(5) + process(5, 20);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
