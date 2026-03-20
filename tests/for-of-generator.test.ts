import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("for-of with generators", () => {
  it("iterates over generator yielding numbers", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> { yield 1; yield 2; yield 3; }
      export function test(): number {
        var sum: number = 0;
        for (const x of gen()) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("break in for-of generator loop", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> { yield 1; yield 2; yield 3; yield 4; }
      export function test(): number {
        var sum: number = 0;
        for (const x of gen()) {
          if (x === 3) break;
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("continue in for-of generator loop", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> { yield 1; yield 2; yield 3; yield 4; }
      export function test(): number {
        var sum: number = 0;
        for (const x of gen()) {
          if (x === 2) continue;
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("empty generator", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> { }
      export function test(): number {
        var sum: number = 0;
        for (const x of gen()) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator yielding strings", async () => {
    await assertEquivalent(
      `function* gen(): Generator<string> { yield "a"; yield "b"; yield "c"; }
      export function test(): string {
        var result: string = "";
        for (const x of gen()) {
          result = result + x;
        }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
