/**
 * Issue #864 — WeakMap/WeakSet invalid key errors with Symbol keys
 *
 * Root cause: Symbols are represented as i32 counters internally. When passed
 * to extern APIs (like WeakMap.set), the i32 was coerced to externref via
 * __box_number, producing a primitive number — which V8 rejects as a WeakMap key.
 *
 * Fix: Added __box_symbol host import that maps i32 symbol IDs to real JS Symbols
 * (cached by ID for identity preservation). When an i32 with TS type ESSymbolLike
 * is coerced to externref, __box_symbol is used instead of __box_number.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(source: string): { success: boolean; result?: number; error?: string } {
  const compiled = compile(source, { fileName: "test.ts" });
  if (!compiled.success) return { success: false, error: compiled.errors[0]?.message };
  try {
    const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
    const mod = new WebAssembly.Module(compiled.binary);
    const inst = new WebAssembly.Instance(mod, imports);
    const ret = (inst.exports as any).test();
    return { success: true, result: ret };
  } catch (e: any) {
    return { success: false, error: `${e.constructor.name}: ${e.message}` };
  }
}

describe("Issue #864: WeakMap/WeakSet Symbol keys", () => {
  it("Symbol as WeakMap key", () => {
    const r = compileAndRun(`
      export function test(): number {
        const map = new WeakMap();
        const key = Symbol('test');
        map.set(key, 1);
        return map.get(key) === 1 ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("Symbol as WeakSet element", () => {
    const r = compileAndRun(`
      export function test(): number {
        const set = new WeakSet();
        const key = Symbol('test');
        set.add(key);
        return set.has(key) ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("two different Symbols have distinct identities", () => {
    const r = compileAndRun(`
      export function test(): number {
        const map = new WeakMap();
        const a = Symbol('a');
        const b = Symbol('b');
        map.set(a, 1);
        map.set(b, 2);
        return map.get(a) === 1 && map.get(b) === 2 ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("object keys still work after Symbol fix", () => {
    const r = compileAndRun(`
      export function test(): number {
        const map = new WeakMap();
        const key = {};
        map.set(key, 42);
        return map.get(key) === 42 ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });
});
