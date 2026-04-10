import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

/**
 * Regression tests for #1018: Object.getOwnPropertyDescriptor returns null/undefined
 * when called with built-in global objects (Math, Object, Array, Date, etc.).
 *
 * Root cause: built-in globals used as standalone expressions (not method calls)
 * compiled to ref.null.extern in identifiers.ts graceful fallback.
 * Fix: emit globalThis[name] instead of null for known global objects.
 */
describe("Object.getOwnPropertyDescriptor on built-in globals (#1018)", () => {
  it("Math.atan2 descriptor is not undefined", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const desc = Object.getOwnPropertyDescriptor(Math, "atan2");
        if (desc === undefined) return -1;
        if (desc === null) return -2;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Math.PI descriptor has correct value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const desc = Object.getOwnPropertyDescriptor(Math, "PI");
        if (desc === undefined || desc === null) return -1;
        // Math.PI ~ 3.14159, so value should be > 3
        return (desc as any).value > 3 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Object.assign descriptor is not undefined", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const desc = Object.getOwnPropertyDescriptor(Object, "assign");
        if (desc === undefined || desc === null) return -1;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("known global used as expression returns actual object (not null)", async () => {
    const exports = await compileToWasm(`
      function checkGlobal(g: any): number {
        return g !== null && g !== undefined ? 1 : 0;
      }
      export function test(): number {
        return checkGlobal(Math);
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
