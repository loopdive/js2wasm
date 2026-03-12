import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("in operator edge cases", () => {
  it("known property is 'in' the object", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { x: 1, y: 2 };
        if (!("x" in obj)) return 0;
        if (!("y" in obj)) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("valueOf is 'in' any object (prototype property)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj: Record<string, any> = {};
        if (!("valueOf" in obj)) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("toString is 'in' any object (prototype property)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { a: 1 };
        if (!("toString" in obj)) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});

