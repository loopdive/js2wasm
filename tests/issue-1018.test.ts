/**
 * Tests for #1018: Object.getOwnPropertyDescriptor returns null for built-in globals.
 *
 * Root cause: built-in globals like Math, Object, Array etc. were compiled to
 * ref.null.extern in compileIdentifier's graceful fallback, so when used as
 * the first arg to Object.getOwnPropertyDescriptor, __getOwnPropertyDescriptor
 * received null and returned undefined.
 *
 * Fix: in the getOwnPropertyDescriptor fallback path in calls.ts, when arg0 is
 * a known built-in identifier, use __get_builtin(name) to get the real JS object
 * instead of compiling the identifier normally. Mirrors the same pattern already
 * used for __extern_method_call receivers (BUILTIN_CLASS_NAMES).
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

describe("#1018 — GOPD on built-in globals returns valid descriptor", () => {
  it("Object.getOwnPropertyDescriptor(Math, 'PI') returns non-null descriptor", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(Math, "PI");
        return desc != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(Math, 'atan2') returns non-null descriptor", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(Math, "atan2");
        return desc != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(Math, 'LOG2E') returns correct flags", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(Math, "LOG2E");
        if (desc == null) return 0;
        if (desc.writable !== false) return 0;
        if (desc.enumerable !== false) return 0;
        if (desc.configurable !== false) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(Math, 'caller') returns undefined for non-existent", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(Math, "caller");
        return desc == null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(Array, 'isArray') returns descriptor with function value", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(Array, "isArray");
        if (desc == null) return 0;
        if (typeof desc.value !== "function") return 0;
        if (desc.writable !== true) return 0;
        if (desc.enumerable !== false) return 0;
        if (desc.configurable !== true) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(JSON, 'stringify') returns non-null", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(JSON, "stringify");
        return desc != null ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyDescriptor(Math, 'PI') has correct value (Math.PI)", async () => {
    const result = await run(`
      export function main(): number {
        const desc = Object.getOwnPropertyDescriptor(Math, "PI");
        if (desc == null) return 0;
        // Math.PI constant is inlined by the compiler, so compare value
        return desc.value > 3.14 && desc.value < 3.15 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  // Shadowing safety tests — local declarations MUST win over built-ins
  // (These tests pass the actual shadowed value, not 1)

  it("local variable 'let Math = 42' shadows the built-in", async () => {
    const result = await run(`
      export function main(): number {
        let Math = 42;
        return Math as unknown as number;
      }
    `);
    expect(result).toBe(42);
  });

  it("local variable 'let Object = 5' shadows the built-in", async () => {
    const result = await run(`
      export function main(): number {
        let Object = 5;
        return Object as unknown as number;
      }
    `);
    expect(result).toBe(5);
  });

  it("function parameter named 'Math' shadows the built-in", async () => {
    const result = await run(`
      function f(Math: number): number { return Math; }
      export function main(): number { return f(99); }
    `);
    expect(result).toBe(99);
  });

  it("'var Array = [1,2,3]' shadows the built-in Array constructor", async () => {
    const result = await run(`
      export function main(): number {
        var Array = [1, 2, 3];
        return Array.length;
      }
    `);
    expect(result).toBe(3);
  });

  // No regression on user-defined objects
  it("Object.getOwnPropertyDescriptor on user-defined struct still works", async () => {
    const result = await run(`
      export function main(): number {
        const obj = { x: 42 };
        const desc = Object.getOwnPropertyDescriptor(obj, "x");
        return desc != null && desc.value === 42 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});
