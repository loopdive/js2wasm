import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

/**
 * #1156 — void callback in Array.prototype.{reduce,reduceRight,map}.call(arrayLike, cb)
 *
 * Before the fix, the `*ResultToExternref` coercion block fell through to `[]`
 * for both `externref` return type and `null` (void) return type. The externref
 * case is fine (call_ref leaves a value on the stack). The void case produced
 * invalid Wasm: `call_ref` left nothing on the stack, and the following
 * `local.set accTmp` needed 1 value → "not enough arguments on the stack for
 * local.set (need 1, got 0)" during instantiation.
 *
 * This surfaced via test262 cases like `Array.prototype.reduce.call(obj, cb)`
 * where `cb` has a `void` return (statements-only body).
 */

async function runTest(src: string) {
  const r = compile(src, { fileName: "test.ts" });
  expect(r.success, `compile: ${r.errors[0]?.message}`).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as any).setExports === "function") (imports as any).setExports(instance.exports);
  return (instance.exports as any).test();
}

describe("#1156 — void-callback on Array.prototype.{reduce,reduceRight,map}.call", () => {
  it("reduce.call(arrayLike, voidCb, init) does not fail Wasm validation", async () => {
    const src = `
      export function test(): number {
        let calls = 0;
        function cb(acc: any, val: any, idx: number): void {
          calls = calls + 1;
        }
        const obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
        Array.prototype.reduce.call(obj, cb, "seed");
        return calls === 3 ? 1 : 0;
      }
    `;
    const ret = await runTest(src);
    expect(ret).toBe(1);
  });

  it("reduceRight.call(arrayLike, voidCb, init) does not fail Wasm validation", async () => {
    const src = `
      export function test(): number {
        let calls = 0;
        function cb(acc: any, val: any): void {
          calls = calls + 1;
        }
        const obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
        Array.prototype.reduceRight.call(obj, cb, "seed");
        return calls === 3 ? 1 : 0;
      }
    `;
    const ret = await runTest(src);
    expect(ret).toBe(1);
  });

  it("map.call(arrayLike, voidCb) does not fail Wasm validation", async () => {
    const src = `
      export function test(): number {
        let calls = 0;
        function cb(val: any): void {
          calls = calls + 1;
        }
        const obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
        const out: any = Array.prototype.map.call(obj, cb);
        return calls === 3 && out.length === 3 ? 1 : 0;
      }
    `;
    const ret = await runTest(src);
    expect(ret).toBe(1);
  });
});
