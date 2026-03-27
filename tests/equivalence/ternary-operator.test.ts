import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("ternary operator", () => {
  it("simple ternary true branch", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const x = 5;
        return x > 3 ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("simple ternary false branch", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const x = 1;
        return x > 3 ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested ternary", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const x = 5;
        return x > 10 ? 3 : x > 3 ? 2 : 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("deeply nested ternary", async () => {
    await assertEquivalent(
      `
      function classify(n: number): number {
        return n < 0 ? -1 : n === 0 ? 0 : n < 10 ? 1 : n < 100 ? 2 : 3;
      }
      export function test(): number {
        return classify(-5) * 10000
             + classify(0) * 1000
             + classify(5) * 100
             + classify(50) * 10
             + classify(500);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("ternary with side effects", async () => {
    await assertEquivalent(
      `
      let counter = 0;
      function inc(): number { counter++; return counter; }
      function dec(): number { counter--; return counter; }
      export function test(): number {
        counter = 0;
        const a = true ? inc() : dec();
        const b = false ? inc() : dec();
        return a * 10 + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("ternary as function argument", async () => {
    await assertEquivalent(
      `
      function double(x: number): number { return x * 2; }
      export function test(): number {
        const flag = true;
        return double(flag ? 10 : 20);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("ternary with string result", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const x = 42;
        return x > 0 ? "positive" : "non-positive";
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("ternary in assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let result = 0;
        for (let i = 0; i < 5; i++) {
          result += i % 2 === 0 ? i : -i;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
