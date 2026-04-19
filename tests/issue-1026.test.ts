/**
 * Tests for #1026: String.prototype / Number.prototype / Boolean.prototype
 * globals access was compiling to ref.null.extern.
 *
 * Root cause: in compilePropertyAccess, when expr.expression is a known
 * built-in constructor identifier (String, Number, Boolean, etc.) and not
 * shadowed by a local variable, the compiler had no handler for the property
 * access. The identifier would fall through to a graceful fallback that emitted
 * ref.null.extern, causing runtime exceptions when the null was dereferenced.
 *
 * Fix: added a handler in compilePropertyAccess (after the globalThis handler)
 * that uses __get_builtin(name) to get the real JS constructor, then
 * __extern_get(ref, propName) to access the property.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, CallableFunction>).main?.();
}

describe("#1026 — Built-in .prototype globals resolve to real object (not null)", () => {
  it("String.prototype is non-null", async () => {
    const result = await run(`
      export function main(): number {
        const p = String.prototype;
        return p != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Number.prototype is non-null", async () => {
    const result = await run(`
      export function main(): number {
        const p = Number.prototype;
        return p != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Boolean.prototype is non-null", async () => {
    const result = await run(`
      export function main(): number {
        const p = Boolean.prototype;
        return p != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.prototype is non-null", async () => {
    const result = await run(`
      export function main(): number {
        const p = Object.prototype;
        return p != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Array.prototype is non-null", async () => {
    const result = await run(`
      export function main(): number {
        const p = Array.prototype;
        return p != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Function.prototype is non-null", async () => {
    const result = await run(`
      export function main(): number {
        const p = Function.prototype;
        return p != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.defineProperty(String.prototype, 'prop', ...) works", async () => {
    const result = await run(`
      export function main(): number {
        Object.defineProperty(String.prototype, "prop1026", {
          value: 42,
          writable: true,
          enumerable: false,
          configurable: true
        });
        const s = new String("hello");
        return (s as any).prop1026 === 42 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(String.prototype, 'length') non-null", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(String.prototype, 'length');
        return desc != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(Number.prototype, 'toFixed') non-null", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(Number.prototype, 'toFixed');
        return desc != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  // Shadowing safety: local variable with built-in name must NOT use __get_builtin
  it("local variable 'const String = 42' shadows built-in", async () => {
    const result = await run(`
      export function main(): number {
        const String = 42;
        return String as unknown as number;
      }
    `);
    expect(result).toBe(42);
  });

  it("local variable 'let Number = 5' shadows built-in", async () => {
    const result = await run(`
      export function main(): number {
        let Number = 5;
        return Number as unknown as number;
      }
    `);
    expect(result).toBe(5);
  });

  it("function parameter named 'Boolean' shadows built-in", async () => {
    const result = await run(`
      function f(Boolean: number): number { return Boolean + 1; }
      export function main(): number { return f(10); }
    `);
    expect(result).toBe(11);
  });
});
