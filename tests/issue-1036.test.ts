/**
 * Issue #1036 — DisposableStack/AsyncDisposableStack property-chain access null trap
 *
 * Root cause: `lib.esnext.disposable.d.ts` was not included in the composite
 * lib.d.ts assembled by src/checker/index.ts, so the TypeScript checker had no
 * type information for DisposableStack/AsyncDisposableStack. Without type info,
 * `staticTypeofForType` could not resolve `DisposableStack.prototype.method`
 * and `compileIdentifier` fell through to the "unknown global" path, emitting
 * `ref.null extern` + throw — which killed the rest of the test body as dead code.
 *
 * Fix: Added `lib.esnext.disposable.d.ts` to the libNames array in
 * src/checker/index.ts so the checker picks up DisposableStackConstructor.
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

describe("Issue #1036: DisposableStack property-chain access", () => {
  it("typeof DisposableStack.prototype.defer === 'function'", () => {
    const r = compileAndRun(`
      export function test(): number {
        return typeof DisposableStack.prototype.defer === "function" ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("DisposableStack.prototype.adopt.name === 'adopt'", () => {
    const r = compileAndRun(`
      export function test(): number {
        return DisposableStack.prototype.adopt.name === "adopt" ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("DisposableStack.prototype.adopt.length === 2", () => {
    const r = compileAndRun(`
      export function test(): number {
        return DisposableStack.prototype.adopt.length === 2 ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("AsyncDisposableStack.prototype.defer.name === 'defer'", () => {
    const r = compileAndRun(`
      export function test(): number {
        return AsyncDisposableStack.prototype.defer.name === "defer" ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });
});
