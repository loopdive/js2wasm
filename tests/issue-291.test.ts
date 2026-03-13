import { describe, it, expect } from "vitest";
import { compileToWasm, assertEquivalent } from "./equivalence/helpers.js";

describe("Issue #291: in operator", () => {
  it("static key found in object literal", async () => {
    const exports = await compileToWasm(`
      const obj = { x: 1, y: 2 };
      export function test(): boolean { return "x" in obj; }
    `);
    expect(exports.test()).toBe(1);
  });

  it("static key not found in object literal", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean { return "z" in { x: 1 }; }
    `);
    expect(exports.test()).toBe(0);
  });

  it("multiple property checks", async () => {
    const exports = await compileToWasm(`
      const obj = { a: 10, b: 20, c: 30 };
      export function hasA(): boolean { return "a" in obj; }
      export function hasB(): boolean { return "b" in obj; }
      export function hasD(): boolean { return "d" in obj; }
    `);
    expect(exports.hasA()).toBe(1);
    expect(exports.hasB()).toBe(1);
    expect(exports.hasD()).toBe(0);
  });

  it("in operator with numeric key", async () => {
    const exports = await compileToWasm(`
      const obj = { 0: "hello", 1: "world" };
      export function test(): boolean { return "0" in obj; }
    `);
    expect(exports.test()).toBe(1);
  });
});
