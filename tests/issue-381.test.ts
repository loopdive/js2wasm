import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Issue #381: Nullish coalescing false positives", () => {
  it("compiles ?? on number (never nullish) without error", () => {
    const result = compile(`
      export function test(): number {
        var x = 42;
        var y = x ?? 0;
        return y;
      }
    `);
    // Should have no errors (diagnostic 2881 downgraded to warning)
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toEqual([]);
  });

  it("compiles ?? on string (never nullish) without error", () => {
    const result = compile(`
      export function test(): string {
        var s = "hello";
        var t = s ?? "default";
        return t;
      }
    `);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toEqual([]);
  });

  it("compiles ?? on boolean (never nullish) without error", () => {
    const result = compile(`
      export function test(): number {
        var flag = true;
        var val = flag ?? false;
        return val ? 1 : 0;
      }
    `);
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toEqual([]);
  });

  it("nullish coalescing on never-nullish produces correct result", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x = 10;
        var y = x ?? 99;
        return y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
