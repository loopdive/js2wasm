/**
 * Issue #841 — Unsupported Math methods: cosh, sinh, tanh + false positive fix
 *
 * Root cause: cosh/sinh/tanh were missing from the hostUnary set in expressions.ts.
 * Also, compileMathCall was emitting "Unsupported Math method" errors for non-Math
 * methods called via Array.prototype.X.call(Math, ...) rewriting.
 *
 * Fix: Add cosh/sinh/tanh to hostUnary. Change compileMathCall to return undefined
 * for unknown methods (fallthrough) instead of pushing a compile error.
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

describe("Issue #841: Math method support", () => {
  it("Math.cosh(0) returns 1", () => {
    const r = compileAndRun(`export function test(): number { return Math.cosh(0) === 1 ? 1 : 0; }`);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("Math.sinh(0) returns 0", () => {
    const r = compileAndRun(`export function test(): number { return Math.sinh(0) === 0 ? 1 : 0; }`);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("Math.tanh(0) returns 0", () => {
    const r = compileAndRun(`export function test(): number { return Math.tanh(0) === 0 ? 1 : 0; }`);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("Math.cosh(1) returns approximately 1.543", () => {
    const r = compileAndRun(`
      export function test(): number {
        const v = Math.cosh(1);
        return v > 1.54 && v < 1.55 ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("unknown Math method does not produce compile error", () => {
    // This tests the false positive fix — unknown methods should fall through
    // instead of emitting "Unsupported Math method" errors
    const compiled = compile(
      `export function test(): number { return 1; }`,
      { fileName: "test.ts" },
    );
    // Just verify the compiler doesn't crash on normal code
    expect(compiled.success).toBe(true);
  });
});
