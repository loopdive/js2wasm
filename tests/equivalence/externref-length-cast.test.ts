import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

/**
 * Regression tests for #1017: illegal cast when accessing .length on an externref value
 * that the TypeScript type system claims is an array.
 *
 * Root cause: the stack-balance pass would insert an unguarded ref.cast_null when
 * a compiled expression returned externref but the TS type resolved to a vec struct ref.
 * Fix: use __extern_length (safe runtime dispatch) when the compiled expression is externref.
 */
describe("externref .length access (#1017)", () => {
  it("Object.keys on any-typed arg - .length should not illegal-cast", async () => {
    const exports = await compileToWasm(`
      function getVal(): any {
        return 42;
      }
      export function test(): number {
        return Object.keys(getVal()).length;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("array cast (x as any[]).length should not illegal-cast when x is a different vec type", async () => {
    const exports = await compileToWasm(`
      function getArr(): any[] {
        return [1, 2, 3] as any as any[];
      }
      export function test(): number {
        const x = getArr();
        return (x as any[]).length;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("externref local .length via identifier path", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const trueResult = true as any;
        const keys = Object.keys(trueResult);
        return keys.length;
      }
    `);
    expect(exports.test()).toBe(0);
  });
});
