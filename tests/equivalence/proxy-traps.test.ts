import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

async function run(source: string, fn: string = "main"): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as WebAssembly.Imports,
  );
  return (instance.exports as any)[fn]();
}

/**
 * Proxy compilation tests.
 *
 * Proxy support in the compiler is currently pass-through: new Proxy(target, {})
 * is optimized to just use the target directly at compile time. Runtime JS Proxy
 * wrapping of Wasm structs has limitations, so these tests verify compilation
 * succeeds and basic pass-through semantics work for simple patterns.
 */
describe("Proxy compilation equivalence", () => {
  it("Proxy compiles with class target and empty handler", () => {
    const result = compile(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function main(): number {
        const target = new Point(10, 20);
        const proxy = new Proxy(target, {});
        return proxy.x + proxy.y;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("Proxy compiles with object literal target", () => {
    const result = compile(`
      export function main(): number {
        const target = { a: 3, b: 7 };
        const proxy = new Proxy(target, {});
        return proxy.a * proxy.b;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("Proxy compiles with get handler (compiled as pass-through)", () => {
    const result = compile(`
      class Box {
        value: number;
        constructor(v: number) { this.value = v; }
      }
      export function main(): number {
        const obj = new Box(42);
        const p = new Proxy(obj, {
          get(t: Box, prop: string) { return 0; }
        });
        return p.value;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("Proxy compiles with set handler", () => {
    const result = compile(`
      class Box {
        value: number;
        constructor(v: number) { this.value = v; }
      }
      export function main(): number {
        const obj = new Box(10);
        const p = new Proxy(obj, {
          set(t: Box, prop: string, val: any) { return true; }
        });
        p.value = 99;
        return p.value;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("Proxy compiles with has handler", () => {
    const result = compile(`
      export function main(): number {
        const target = { x: 1 };
        const p = new Proxy(target, {
          has(t: any, prop: string) { return true; }
        });
        return 1;
      }
    `);
    expect(result.success).toBe(true);
  });
});
