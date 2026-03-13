import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, compileToWasm } from "./equivalence/helpers.js";

describe("Issue #232: Method calls on object literals", () => {
  it("method call on object literal - simple", async () => {
    const result = compile(`
      const obj = { foo() { return 42; } };
      export function test(): number {
        return obj.foo();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe(42);
  });

  it("method call with arguments", async () => {
    const result = compile(`
      const obj = { add(a: number, b: number) { return a + b; } };
      export function test(): number {
        return obj.add(10, 32);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe(42);
  });

  it("valueOf on object literal", async () => {
    const result = compile(`
      const obj = { valueOf() { return 99; } };
      export function test(): number {
        return obj.valueOf();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe(99);
  });

  it("multiple methods on same object", async () => {
    const result = compile(`
      const obj = {
        a() { return 1; },
        b() { return 2; },
      };
      export function test(): number {
        return obj.a() + obj.b();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe(3);
  });

  it("method on object literal returned from function", async () => {
    const result = compile(`
      function makeObj() {
        return { getValue() { return 77; } };
      }
      export function test(): number {
        const obj = makeObj();
        return obj.getValue();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe(77);
  });

  it("method accessing this.property", async () => {
    const result = compile(`
      const obj = {
        x: 10,
        getX() { return this.x; }
      };
      export function test(): number {
        return obj.getX();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe(10);
  });
});
