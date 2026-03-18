import { describe, it } from "vitest";
import { assertEquivalent, compileToWasm } from "./helpers.js";

describe("Inline small functions (#465)", () => {
  it("identity function is inlined correctly", { timeout: 15000 }, async () => {
    await assertEquivalent(
      `
      function identity(x: number): number {
        return x;
      }
      export function test1(): number {
        return identity(42);
      }
      export function test2(): number {
        return identity(identity(7));
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
      ],
    );
  });

  it("simple arithmetic wrapper is inlined", async () => {
    await assertEquivalent(
      `
      function double(x: number): number {
        return x * 2;
      }
      function add(a: number, b: number): number {
        return a + b;
      }
      export function test1(): number {
        return double(21);
      }
      export function test2(): number {
        return add(10, 32);
      }
      export function test3(): number {
        return add(double(5), double(16));
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
        { fn: "test3", args: [] },
      ],
    );
  });

  it("single-field getter is inlined", async () => {
    await assertEquivalent(
      `
      function negate(x: number): number {
        return -x;
      }
      export function test1(): number {
        return negate(5);
      }
      export function test2(): number {
        return negate(-3);
      }
      `,
      [
        { fn: "test1", args: [] },
        { fn: "test2", args: [] },
      ],
    );
  });

  it("constant-returning function is inlined", async () => {
    await assertEquivalent(
      `
      function getFortyTwo(): number {
        return 42;
      }
      export function test(): number {
        return getFortyTwo();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple calls to same inline function work correctly", async () => {
    await assertEquivalent(
      `
      function inc(x: number): number {
        return x + 1;
      }
      export function test(): number {
        return inc(1) + inc(2) + inc(3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
