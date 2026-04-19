import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(source: string): number {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  return (instance.exports as any).test();
}

describe("SameValue f64 in DefineProperty (#1127)", () => {
  it("NaN === NaN under SameValue — redefining frozen NaN with NaN should not throw", async () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: NaN };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: NaN });
          return 1; // Should succeed — SameValue(NaN, NaN) is true
        } catch (e) {
          return 0; // Should NOT throw
        }
      }
    `);
    expect(result).toBe(1);
  });

  // Note: +0 !== -0 under SameValue cannot be tested yet because
  // -0 literal compiles to +0 (pre-existing issue with unary negation of zero).
  // The SameValue comparison itself correctly uses copysign to distinguish signs.

  it("normal values still work — redefining frozen prop with same value succeeds", async () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: 42 };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: 42 });
          return 1; // Same value, should succeed
        } catch (e) {
          return 0;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("different values still throw — redefining frozen prop with different value throws", async () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: 42 };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: 99 });
          return 0; // Should throw
        } catch (e) {
          return 1; // TypeError expected
        }
      }
    `);
    expect(result).toBe(1);
  });
});
