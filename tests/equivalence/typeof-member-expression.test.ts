import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("typeof on member expressions", () => {
  it("typeof obj.numberProp === 'number'", async () => {
    const exports = await compileToWasm(`
      const obj = { x: 42 };
      export function test(): number {
        if (typeof obj.x === "number") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("typeof obj.stringProp === 'string'", async () => {
    const exports = await compileToWasm(`
      const obj = { s: "hello" };
      export function test(): number {
        if (typeof obj.s === "string") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("typeof obj.boolProp === 'boolean'", async () => {
    const exports = await compileToWasm(`
      const obj = { b: true };
      export function test(): number {
        if (typeof obj.b === "boolean") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("typeof obj.fnProp === 'function'", async () => {
    const exports = await compileToWasm(`
      function myFn(): number { return 1; }
      const obj = { fn: myFn };
      export function test(): number {
        if (typeof obj.fn === "function") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("typeof obj.objProp === 'object'", async () => {
    const exports = await compileToWasm(`
      const obj = { inner: { a: 1 } };
      export function test(): number {
        if (typeof obj.inner === "object") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("typeof on nested member expression", async () => {
    const exports = await compileToWasm(`
      const obj = { nested: { value: 42 } };
      export function test(): number {
        if (typeof obj.nested.value === "number") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
