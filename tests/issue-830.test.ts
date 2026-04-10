/**
 * Issue #830 — DisposableStack extern class missing (38 wasm_compile failures)
 *
 * Root cause: DisposableStack (TC39 Explicit Resource Management, stage 3)
 * was not in the builtinCtors map in runtime.ts, so WebAssembly instantiation
 * failed with "No dependency provided for extern class 'DisposableStack'".
 *
 * Fix: Added DisposableStack, AsyncDisposableStack, and SuppressedError to
 * builtinCtors with a conditional check (typeof X !== "undefined") so the
 * runtime works gracefully on older Node.js that may not have them.
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
    const ret = (inst.exports as any).test?.();
    return { success: true, result: ret };
  } catch (e: any) {
    return { success: false, error: `${e.constructor.name}: ${e.message}` };
  }
}

describe("Issue #830: DisposableStack host import", () => {
  it("DisposableStack can be constructed (no CE)", () => {
    const r = compileAndRun(`
      export function test(): number {
        const stack = new DisposableStack();
        return 1;
      }
    `);
    if (r.error) expect(r.error).not.toMatch(/No dependency provided/);
    expect(r.success).toBe(true);
  });

  it("DisposableStack.disposed starts false", () => {
    const r = compileAndRun(`
      export function test(): number {
        const stack = new DisposableStack();
        return stack.disposed === false ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("DisposableStack.disposed is true after dispose()", () => {
    const r = compileAndRun(`
      export function test(): number {
        const stack = new DisposableStack();
        stack.dispose();
        return stack.disposed === true ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("SuppressedError can be constructed (no CE)", () => {
    const r = compileAndRun(`
      export function test(): number {
        const e = new SuppressedError(new Error("a"), new Error("b"));
        return e instanceof SuppressedError ? 1 : 0;
      }
    `);
    if (r.error) expect(r.error).not.toMatch(/No dependency provided/);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });
});
