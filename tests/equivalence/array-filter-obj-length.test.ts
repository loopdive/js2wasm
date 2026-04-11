import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

/**
 * Regression tests for Array.prototype.filter/forEach/reduce where
 * the callback accesses obj.length (the 3rd parameter).
 * These regressed after the externref .length fix in #1017.
 */
describe("Array callback obj.length (#1017 regression)", () => {
  // Test with explicit 'any' annotations (externref params)
  it("filter - callbackfn(val: any, idx: any, obj: any) accessing obj.length", async () => {
    const exports = await compileToWasm(`
      function callbackfn(val: any, idx: any, obj: any): boolean {
        return obj.length === 2;
      }
      export function test(): number {
        return [12, 11].filter(callbackfn).length;
      }
    `);
    expect((exports as any).test()).toBe(2);
  });

  // Test without annotations (like actual test262 tests) - TypeScript infers any
  it("filter - callbackfn(val, idx, obj) no annotations - accessing obj.length", async () => {
    const exports = await compileToWasm(
      `
      function callbackfn(val, idx, obj) {
        return obj.length === 2;
      }
      export function test(): number {
        return [12, 11].filter(callbackfn).length;
      }
    `,
      { allowJs: true },
    );
    expect((exports as any).test()).toBe(2);
  });

  it("forEach - callbackfn(val, idx, obj) accessing obj.length", async () => {
    const exports = await compileToWasm(`
      let result = false;
      function callbackfn(val: any, idx: any, obj: any): void {
        result = (obj.length === 2);
      }
      export function test(): boolean {
        [12, 11].forEach(callbackfn);
        return result;
      }
    `);
    // Wasm boolean is i32; JS sees 1 (truthy) not true
    expect((exports as any).test()).toBeTruthy();
  });

  it("reduce - callbackfn(prevVal, curVal, idx, obj) accessing obj.length", async () => {
    const exports = await compileToWasm(`
      function callbackfn(prevVal: any, curVal: any, idx: any, obj: any): boolean {
        return (obj.length === 2);
      }
      export function test(): boolean {
        return [12, 11].reduce(callbackfn, 1) as boolean;
      }
    `);
    // Wasm boolean is i32; JS sees 1 (truthy) not true
    expect((exports as any).test()).toBeTruthy();
  });
});
