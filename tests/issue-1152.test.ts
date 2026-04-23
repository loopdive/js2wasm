// #1152 — Array.prototype higher-order methods applied to string primitive
// receivers must use the in-Wasm array-like loop, not bridge through
// __proto_method_call.
//
// Background (regression from PR #195, then narrowed by #1140's successor):
// After PR #195 changed `BuiltinCtor.prototype` access to go through
// `__get_builtin` + `__extern_get` (both returning externref), calls like
//   Array.prototype.map.call("abc", cb)
// fell through `compileArrayLikePrototypeCall` because its primitive-receiver
// bailout blanket-rejected `StringLiteral` / `NoSubstitutionTemplateLiteral`.
// The legacy `__proto_method_call` path then passed the Wasm closure callback
// across the host boundary as a non-callable externref, producing a runtime
// `TypeError: object is not a function` from V8's native Array.prototype.map.
//
// The fix is to keep string primitive literals in the Wasm-native array-like
// loop — they compile to externref (via `string_constants` globals), so
// `__extern_length` + `__extern_get_idx` walks the code units directly and
// the callback stays a Wasm closure invoked via `call_ref`. Numeric and
// boolean primitive literals still bail out because they compile to
// i32/f64, which can't flow through `extern.convert_any`.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<any> {
  const result = compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    const msg = result.errors
      .filter((e) => e.severity === "error")
      .map((e) => `L${e.line}:${e.column} ${e.message}`)
      .join("; ");
    throw new Error(`Compile failed: ${msg}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (typeof (imports as any).setExports === "function") {
    (imports as any).setExports(instance.exports);
  }
  return (instance.exports as any).test();
}

describe("#1152 — Array.prototype methods on string primitive receivers", () => {
  it("Array.prototype.map.call('abc', cb) walks codepoints in Wasm", async () => {
    const source = `
      export function test(): number {
        let count = 0;
        function cb(val: any, idx: any, obj: any): number {
          count = count + 1;
          return 1;
        }
        Array.prototype.map.call("abc", cb);
        return count === 3 ? 1 : 0;
      }
    `;
    const ret = await runTest(source);
    expect(ret).toBe(1);
  });

  it("Array.prototype.forEach.call('abc', cb) visits each character", async () => {
    const source = `
      export function test(): number {
        let count = 0;
        function cb(val: any, idx: any, obj: any): void {
          count = count + 1;
        }
        Array.prototype.forEach.call("abc", cb);
        return count === 3 ? 1 : 0;
      }
    `;
    const ret = await runTest(source);
    expect(ret).toBe(1);
  });

  it("Array.prototype.every.call('abc', cb) invokes callback without 'object is not a function'", async () => {
    // This is the bug from #1152 — before the fix, the callback was passed
    // across the host boundary as a Wasm closure externref, and V8's native
    // Array.prototype.every tried to invoke it and threw.
    const source = `
      export function test(): number {
        function cb(val: any, idx: any, obj: any): number {
          return 1;
        }
        const result: any = Array.prototype.every.call("abc", cb);
        return result ? 1 : 0;
      }
    `;
    const ret = await runTest(source);
    expect(ret).toBe(1);
  });

  it("Array.prototype.some.call with no-substitution template literal receiver", async () => {
    const source = `
      export function test(): number {
        let hit = 0;
        function cb(val: any, idx: any, obj: any): number {
          hit = 1;
          return 1;
        }
        Array.prototype.some.call(\`abc\`, cb);
        return hit === 1 ? 1 : 0;
      }
    `;
    const ret = await runTest(source);
    expect(ret).toBe(1);
  });
});
