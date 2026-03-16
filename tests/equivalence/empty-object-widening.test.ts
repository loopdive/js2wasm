import { describe, it, expect } from "vitest";
import { compileToWasm, assertEquivalent, compile } from "./helpers.js";

describe("Empty object widening: var obj = {} with later property assignments", () => {
  it("basic numeric properties: var obj = {}; obj.x = 1; return obj.x", async () => {
    const src = `
      export function test(): number {
        var obj = {};
        obj.x = 1;
        return obj.x;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(1);
  });

  it("multiple numeric properties", async () => {
    const src = `
      export function test(): number {
        var obj = {};
        obj.x = 1;
        obj.y = 2;
        return obj.x + obj.y;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(3);
  });

  it("overwrite property after initial assignment", async () => {
    const src = `
      export function test(): number {
        var obj = {};
        obj.x = 1;
        obj.x = 42;
        return obj.x;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(42);
  });

  it("mixed numeric properties with arithmetic", async () => {
    const src = `
      export function test(): number {
        var obj = {};
        obj.a = 10;
        obj.b = 20;
        obj.c = 30;
        return obj.a + obj.b + obj.c;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(60);
  });

  it("property assigned from expression", async () => {
    const src = `
      export function test(): number {
        var obj = {};
        var x = 5;
        obj.val = x * 2;
        return obj.val;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(10);
  });

  it("string property on widened object", async () => {
    const src = `
      export function test(): string {
        var obj = {};
        obj.name = "hello";
        return obj.name;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe("hello");
  });

  it("mixed number and string properties", async () => {
    const src = `
      export function test(): number {
        var obj = {};
        obj.x = 1;
        obj.label = "test";
        obj.y = 2;
        return obj.x + obj.y;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(3);
  });

  it("top-level empty object widening", async () => {
    const src = `
      var obj = {};
      obj.x = 100;
      obj.y = 200;
      export function test(): number {
        return obj.x + obj.y;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(300);
  });

  it("let declaration with empty object widening", async () => {
    const src = `
      export function test(): number {
        let obj = {};
        obj.x = 10;
        obj.y = 20;
        return obj.x + obj.y;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(30);
  });

  it("const declaration with empty object widening", async () => {
    const src = `
      export function test(): number {
        const obj = {};
        obj.x = 7;
        obj.y = 3;
        return obj.x + obj.y;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.test()).toBe(10);
  });
});
