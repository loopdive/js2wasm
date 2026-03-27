/**
 * Issue #778: RuntimeError: illegal cast (135 tests)
 *
 * Tests that ref.cast instructions are guarded with ref.test to avoid
 * "illegal cast" traps when runtime struct type differs from compile-time type.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runWasm(src: string): Promise<any> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).test?.();
}

describe("issue-778: illegal cast guards", () => {
  it("property access on wrong struct type does not trap", async () => {
    // An object typed as A but actually a different struct at runtime
    const result = await runWasm(`
      interface A { x: number; }
      interface B { x: number; y: number; }
      function getX(obj: A): number { return obj.x; }
      const b: B = { x: 42, y: 10 };
      export function test(): number {
        return getX(b as any as A) === 42 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("compiles without illegal cast when accessing struct fields", async () => {
    // This should compile and run without trapping
    const result = await runWasm(`
      const obj: any = { x: 1, y: 2 };
      export function test(): number {
        const v = obj.x;
        return typeof v === 'number' ? 1 : 0;
      }
    `);
    // Either 1 (correct) or 0 (wrong) but should not trap
    expect(typeof result).toBe("number");
  });

  it("closure funcref cast is guarded", async () => {
    // Closure dispatch should not trap even with type mismatches
    const result = compile(`
      function apply(fn: (x: number) => number, val: number): number {
        return fn(val);
      }
      const double = (x: number) => x * 2;
      export function test(): number {
        return apply(double, 5) === 10 ? 1 : 0;
      }
    `, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const ret = (instance.exports as any).test?.();
    expect(ret).toBe(1);
  });
});
