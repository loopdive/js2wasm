import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(src: string): Promise<{ result: any; errors: string[]; instantiateError?: string }> {
  const r = compile(src, { fileName: "test.ts" });
  const errors = r.errors.map((e) => e.message);
  if (!r.success) return { result: undefined, errors };
  try {
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return { result: (instance.exports as any).test(), errors };
  } catch (e: any) {
    return { result: undefined, errors, instantiateError: e.message?.slice(0, 200) };
  }
}

describe("#822 -- Wasm type mismatch compile errors", () => {
  it("return_call with mismatched types does not crash", async () => {
    // Previously, return_call optimization could cause "not enough arguments"
    // errors when the callee's signature didn't match the caller's.
    const { result, instantiateError } = await compileAndRun(`
      function helper(): number { return 42; }
      class C {
        method(): number {
          return helper();
        }
      }
      export function test(): number {
        const c = new C();
        return c.method();
      }
    `);
    expect(instantiateError).toBeUndefined();
    expect(result).toBe(42);
  });

  it("tail call with void callee in non-void function does not produce return_call", async () => {
    const { result, instantiateError } = await compileAndRun(`
      var count = 0;
      function inc(): void { count = count + 1; }
      function wrapper(): number {
        inc();
        return count;
      }
      export function test(): number {
        return wrapper();
      }
    `);
    expect(instantiateError).toBeUndefined();
    expect(result).toBe(1);
  });
});
