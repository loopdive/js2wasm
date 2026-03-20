import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("typeof comparison", () => {
  it("typeof number === 'number'", async () => {
    const exports = await compileToWasm(`
      export function test(x: number): number {
        if (typeof x === "number") return 1;
        return 0;
      }
    `);
    expect(exports.test(42)).toBe(1);
  });

  it("typeof string === 'string'", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const s: string = "hello";
        if (typeof s === "string") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("typeof boolean === 'boolean'", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const b: boolean = true;
        if (typeof b === "boolean") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
