import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("default parameters", () => {
  it("single default parameter used", async () => {
    await assertEquivalent(
      `
      function greet(x: number = 42): number {
        return x;
      }
      export function test(): number {
        return greet();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("single default parameter overridden", async () => {
    await assertEquivalent(
      `
      function greet(x: number = 42): number {
        return x;
      }
      export function test(): number {
        return greet(100);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple default parameters", async () => {
    await assertEquivalent(
      `
      function add(a: number = 10, b: number = 20): number {
        return a + b;
      }
      export function test(): number {
        return add() + add(1) + add(1, 2);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("default parameter with expression", async () => {
    await assertEquivalent(
      `
      const BASE = 100;
      function compute(x: number = BASE + 5): number {
        return x;
      }
      export function test(): number {
        return compute();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("default parameter after required parameter", async () => {
    await assertEquivalent(
      `
      function make(a: number, b: number = 10): number {
        return a * b;
      }
      export function test(): number {
        return make(5) + make(5, 3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("default used in recursive-style call", async () => {
    await assertEquivalent(
      `
      function step(n: number, acc: number = 0): number {
        if (n <= 0) return acc;
        return step(n - 1, acc + n);
      }
      export function test(): number {
        return step(5);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
