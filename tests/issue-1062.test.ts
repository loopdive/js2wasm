import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as any);
  return (instance.exports as any).run();
}

describe("#1062 tryExternClassMethodOnAny must require unambiguous match", () => {
  // Regression: for an `any`-typed receiver, a call like `value.slice(2)` used to
  // bind to the first extern class that happened to have a `.slice` method in
  // ctx.externClasses iteration order. When a regex literal elsewhere in the
  // module caused Uint8ClampedArray's extern class to get registered, the call
  // bound to Uint8ClampedArray_slice(externref, externref, externref) with a
  // stack layout incompatible with the subsequent parseInt, producing an
  // invalid Wasm module that failed validation with:
  //   call[N] expected type f64, found call of type externref
  it("regex literal in scope does not hijack .slice on any-typed param", async () => {
    const v = await compileAndRun(`
      var x = /abc/;
      function f(value) { return parseInt(value.slice(2), 2); }
      export function run(): number { return f("0b10"); }
    `);
    expect(v).toBe(2);
  });

  it("ambiguous methods on any receiver still work without regex trigger", async () => {
    const v = await compileAndRun(`
      function f(value) { return parseInt(value.slice(2), 2); }
      export function run(): number { return f("0b10"); }
    `);
    expect(v).toBe(2);
  });
});
