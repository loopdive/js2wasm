/**
 * Tests for #797 WI1+WI2+WI4:
 * - WI1: __getOwnPropertyDescriptor for WasmGC structs (runtime path)
 * - WI2: Object.keys/values/entries respect enumerability
 * - WI4: propertyIsEnumerable respects updated flags
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) throw new Error(result.errors[0]?.message ?? "compile error");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // Set exports so runtime can use __struct_field_names and other helpers
  imports.setExports?.(instance.exports as any);
  return (instance.exports as any).test();
}

describe("#797 WI2: Object.keys enumerability (compile-time)", () => {
  it("Object.keys excludes non-enumerable field (b)", async () => {
    const src = `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        Object.defineProperty(obj, 'b', { enumerable: false });
        const keys = Object.keys(obj);
        return keys.length;
      }
    `;
    expect(await run(src)).toBe(2);
  });

  it("Object.keys includes all enumerable fields by default", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 1, y: 2 };
        const keys = Object.keys(obj);
        return keys.length;
      }
    `;
    expect(await run(src)).toBe(2);
  });

  it("Object.values excludes non-enumerable field (a)", async () => {
    // Use stored variable to avoid chained-call pre-existing limitation
    const src = `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        Object.defineProperty(obj, 'a', { enumerable: false });
        const vals = Object.values(obj);
        return vals.length;
      }
    `;
    expect(await run(src)).toBe(2);
  });

  it("Object.entries excludes non-enumerable field (c)", async () => {
    const src = `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        Object.defineProperty(obj, 'c', { enumerable: false });
        const entries = Object.entries(obj);
        return entries.length;
      }
    `;
    expect(await run(src)).toBe(2);
  });
});

describe("#797 WI4: propertyIsEnumerable respects flags", () => {
  it("returns false after defineProperty enumerable:false", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 1, y: 2 };
        Object.defineProperty(obj, 'x', { enumerable: false });
        return obj.propertyIsEnumerable('x') ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(0);
  });

  it("returns true for default fields", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 1 };
        return obj.propertyIsEnumerable('x') ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("returns false for non-existent property", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 1 };
        return obj.propertyIsEnumerable('z') ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(0);
  });

  it("returns false for non-enumerable 2nd field", async () => {
    const src = `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        Object.defineProperty(obj, 'b', { enumerable: false });
        return obj.propertyIsEnumerable('b') ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(0);
  });

  it("non-enumerable field not visible to hasOwnProperty", async () => {
    // hasOwnProperty is unaffected by enumerability — should still return true
    const src = `
      export function test(): number {
        const obj = { x: 1 };
        Object.defineProperty(obj, 'x', { enumerable: false });
        return obj.hasOwnProperty('x') ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});

describe("#797 WI1: __getOwnPropertyDescriptor (runtime path)", () => {
  it("returns descriptor for struct field with default flags via runtime", async () => {
    // Use any-typed intermediate to force runtime path
    const src = `
      export function test(): number {
        const obj: any = { x: 42 };
        const desc = Object.getOwnPropertyDescriptor(obj, 'x');
        if (!desc) return 0;
        if (desc.value !== 42) return 2;
        if (!desc.writable) return 3;
        if (!desc.enumerable) return 4;
        if (!desc.configurable) return 5;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("returns undefined for non-existent property via runtime", async () => {
    const src = `
      export function test(): number {
        const obj: any = { x: 1 };
        const desc = Object.getOwnPropertyDescriptor(obj, 'z');
        return desc === undefined ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
