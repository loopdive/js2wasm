import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Symbol typeof and uniqueness", () => {
  it("typeof Symbol() returns 'symbol'", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const s = Symbol();
        return typeof s === "symbol";
      }
    `);
    expect(exports.test()).toBe(1); // i32 boolean: 1 = true
  });

  it("typeof Symbol('desc') returns 'symbol'", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const s = Symbol("test");
        return typeof s === "symbol";
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Symbol() creates unique values", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const s1 = Symbol();
        const s2 = Symbol();
        return s1 !== s2;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("same Symbol is identical to itself", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const s = Symbol();
        return s === s;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Symbol with same description are still unique", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const s1 = Symbol("x");
        const s2 = Symbol("x");
        return s1 !== s2;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
