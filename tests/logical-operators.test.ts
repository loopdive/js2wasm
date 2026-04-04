import { describe, it, expect } from "vitest";
import {
  compileToWasm,
  evaluateAsJs,
  assertEquivalent,
  buildImports,
  compile,
  readFileSync,
  resolve,
} from "./helpers.js";

describe("Logical operators returning values", () => {
  it("0 || 42 returns 42", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 0 || 42;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("5 || 42 returns 5", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 5 || 42;
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("1 && 42 returns 42", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 && 42;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("0 && 42 returns 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 0 && 42;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("variable || default value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 0;
        let result = x || 99;
        return result;
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("truthy variable || default value returns variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 7;
        let result = x || 99;
        return result;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("chained logical or", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 0 || 0 || 3;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("chained logical and", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 && 2 && 3;
      }
    `);
    expect(exports.test()).toBe(3);
  });
});
