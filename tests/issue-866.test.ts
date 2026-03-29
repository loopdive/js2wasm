import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

describe("Issue #866: NaN sentinel regression", () => {
  it("toString fallback in ToPrimitive for + operator", async () => {
    const src = `
      export function test(): number {
        const obj: any = {toString: function(): number { return 1; }};
        return 1 + obj;
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error("Compile error: " + r.errors[0]?.message);
    const runtimeImports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, runtimeImports);
    // Set exports so runtime can access __call_toString, __sget_toString, etc.
    if (runtimeImports.setExports) {
      (runtimeImports as any).setExports(instance.exports);
    }
    const result = (instance.exports as any).test();
    expect(result).toBe(2);
  });

  it("explicit NaN argument does not trigger default", async () => {
    const src = `
      function f(x: number = 42): number {
        return x;
      }
      export function test(): number {
        return f(NaN);
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error("Compile error: " + r.errors[0]?.message);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const result = (instance.exports as any).test();
    expect(result).toBeNaN();
  });

  it("explicit 0 argument does not trigger default", async () => {
    const src = `
      function f(x: number = 42): number {
        return x;
      }
      export function test(): number {
        return f(0);
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error("Compile error: " + r.errors[0]?.message);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const result = (instance.exports as any).test();
    expect(result).toBe(0);
  });

  it("missing argument triggers default", async () => {
    const src = `
      function f(x: number = 42): number {
        return x;
      }
      export function test(): number {
        return f();
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error("Compile error: " + r.errors[0]?.message);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const result = (instance.exports as any).test();
    expect(result).toBe(42);
  });
});
