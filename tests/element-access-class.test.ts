import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm, compile } from "./helpers.js";

describe("element access on class instances", () => {
  it("bracket notation with string literal on class instance", async () => {
    await assertEquivalent(
      `
      class C { x: number = 1; y: number = 2; }
      export function test(): number {
        var c = new C();
        return c["x"];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("bracket notation reading multiple fields", async () => {
    await assertEquivalent(
      `
      class Point { x: number = 10; y: number = 20; }
      export function test(): number {
        var p = new Point();
        return p["x"] + p["y"];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("bracket notation with const variable key", async () => {
    await assertEquivalent(
      `
      class C { x: number = 42; }
      export function test(): number {
        var c = new C();
        const key = "x";
        return c[key];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("bracket notation on object literal fields", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = { a: 10, b: 20 };
        return obj["a"] + obj["b"];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("dynamic key on struct compiles without error (externref fallback)", () => {
    // When key can't be resolved at compile time, should fall back
    // to externref conversion instead of producing a compile error
    const result = compile(`
      export function test(key: string): any {
        var obj = { x: 10, y: 20 };
        return obj[key];
      }
    `);
    expect(result.success).toBe(true);
  });
});
