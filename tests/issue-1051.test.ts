/**
 * Issue #1051 — Static private field assignment used the raw identifier text
 * ("#a") instead of the "__priv_" prefixed name, so `C.#field = value` missed
 * the staticProps global lookup and silently fell through. Subsequent reads
 * returned the default null initializer, producing the "returned 5" pattern
 * (actually returning `null` from the public static wrapper).
 *
 * Fix: `compilePropertyAssignment` now applies the same private-name transform
 * as the read side in property-access.ts and the compound-assign site at
 * assignment.ts:3607.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function run(source: string): { ok: boolean; result?: any; error?: string } {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) return { ok: false, error: r.errors[0]?.message };
  try {
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const mod = new WebAssembly.Module(r.binary);
    const inst = new WebAssembly.Instance(mod, imports);
    const ret = (inst.exports as any).test?.();
    return { ok: true, result: ret };
  } catch (e: any) {
    return { ok: false, error: `${e?.constructor?.name}: ${e?.message ?? e}` };
  }
}

describe("Issue #1051: static private field round-trip", () => {
  it("C.#field = x; return C.#field — returns x", () => {
    const r = run(`
      class C {
        static #a: any;
        static put(value: any): any {
          C.#a = value;
          return C.#a;
        }
      }
      export function test(): number {
        const v: any = (C as any).put(42);
        return v === 42 ? 1 : 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.result).toBe(1);
  });

  it("multiple distinct static private fields stay distinct", () => {
    const r = run(`
      class C {
        static #a: any;
        static #b: any;
        static setA(v: any): any { C.#a = v; return C.#a; }
        static setB(v: any): any { C.#b = v; return C.#b; }
        static getA(): any { return C.#a; }
        static getB(): any { return C.#b; }
      }
      export function test(): number {
        (C as any).setA(1);
        (C as any).setB(2);
        if ((C as any).getA() !== 1) return 0;
        if ((C as any).getB() !== 2) return 0;
        return 1;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.result).toBe(1);
  });

  it("overwriting a static private field reflects on next read", () => {
    const r = run(`
      class C {
        static #x: any;
        static set(v: any): any { C.#x = v; return C.#x; }
      }
      export function test(): number {
        (C as any).set(10);
        const v: any = (C as any).set(20);
        return v === 20 ? 1 : 0;
      }
    `);
    expect(r.ok).toBe(true);
    expect(r.result).toBe(1);
  });
});
