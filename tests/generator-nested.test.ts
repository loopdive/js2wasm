import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("generator functions in nested positions", () => {
  it("generator function declaration nested inside another function", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* gen(): Generator<number> {
          yield 10;
          yield 20;
          yield 30;
        }
        var sum: number = 0;
        for (const x of gen()) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator function declaration nested with captures", async () => {
    await assertEquivalent(
      `export function test(): number {
        var multiplier: number = 3;
        function* gen(): Generator<number> {
          yield 1 * multiplier;
          yield 2 * multiplier;
          yield 3 * multiplier;
        }
        var sum: number = 0;
        for (const x of gen()) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator function declaration nested with loop yield", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* range(n: number): Generator<number> {
          for (let i: number = 0; i < n; i++) {
            yield i;
          }
        }
        var sum: number = 0;
        for (const x of range(5)) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator function declaration nested with early return", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* gen(limit: number): Generator<number> {
          for (let i: number = 0; i < 10; i++) {
            yield i;
            if (i >= limit) {
              return;
            }
          }
        }
        var sum: number = 0;
        for (const x of gen(3)) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
