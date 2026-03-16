import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("unary +/- on empty string (#374)", () => {
  it("unary plus on empty string produces 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +"";
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("unary minus on empty string produces -0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const x: number = -("" as any);
        // 1/x gives -Infinity for -0
        return 1 / x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("unary plus on numeric string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +"42";
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("unary minus on numeric string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return -("42" as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("unary minus static resolution (#374)", () => {
  it("unary minus on null produces -0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const x: number = -(null as any);
        return 1 / x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("unary minus on true produces -1", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return -(true as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("unary minus on false produces -0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const x: number = -(false as any);
        return 1 / x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("named function expression reassignment (#374)", () => {
  it("name binding is read-only inside function body", async () => {
    // Can't use assertEquivalent because TS compiles to strict mode (const)
    // which throws on assignment. In Wasm/sloppy mode, assignment is silently ignored.
    // Instead, directly test that wasm produces the expected result.
    const { compileToWasm } = await import("./helpers.js");
    const exports = await compileToWasm(`
      export function test(): number {
        var f = function g(): number {
          (g as any) = 5;
          return typeof g === "function" ? 1 : 0;
        };
        return f();
      }
    `);
    // g should still be the function (assignment silently ignored), so typeof g === "function" → 1
    const { expect } = await import("vitest");
    expect(exports["test"]!()).toBe(1);
  });
});
