// #1016b — Iterator protocol element-access dispatch
//
// `obj[Symbol.iterator]()` and `obj[Symbol.asyncIterator]()` are first-class
// language patterns for kicking off the iterator protocol. Before the fix,
// these calls fell through the resolved-element-access fallback and silently
// returned `null`, which then surfaced as
//   "TypeError: Cannot read properties of null (reading 'next')"
// from the next chained `.next()` invocation — the dominant failure mode in
// dozens of test262 ArrayIteratorPrototype/MapIteratorPrototype/etc. tests.
//
// This file exercises the dispatch through __iterator / __async_iterator host
// imports, which know how to:
//   * call a real Symbol.iterator on JS objects
//   * read sidecar `@@iterator` on WasmGC structs
//   * invoke a WasmGC closure via __call_fn_0
//   * synthesize an iterator from __vec_len/__vec_get on Wasm vec structs
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports as buildRuntimeImports } from "../src/runtime.ts";

async function runIt(source: string): Promise<unknown> {
  const r = compile(source, { skipSemanticDiagnostics: true });
  if (!r.success) throw new Error(`CE: ${r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`);
  const { env, setExports, string_constants } = buildRuntimeImports(r.imports || [], undefined, r.stringPool);
  const imports: WebAssembly.Imports = { env, ...(string_constants ? { string_constants } : {}) };
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (setExports) setExports(instance.exports as Record<string, Function>);
  return (instance.exports.test as Function)();
}

describe("#1016b — obj[Symbol.iterator]() element-access call", () => {
  it("[1,2,3][Symbol.iterator]() returns a non-null iterator and yields the right value", async () => {
    const r = await runIt(`
      export function test(): number {
        const arr = [1, 2, 3];
        const iter = arr[Symbol.iterator]();
        if (iter == null) return 0;
        const r1 = (iter as any).next();
        if (r1.value !== 1) return 2;
        if (r1.done !== false) return 3;
        return 1;
      }
    `);
    expect(r).toBe(1);
  });

  it("Map[Symbol.iterator]() returns a JS map iterator", async () => {
    const r = await runIt(`
      export function test(): number {
        const m = new Map<number, number>();
        m.set(1, 11);
        const iter = m[Symbol.iterator]();
        if (iter == null) return 0;
        return 1;
      }
    `);
    expect(r).toBe(1);
  });

  it("string[Symbol.iterator]() drives string iteration", async () => {
    const r = await runIt(`
      export function test(): number {
        const s = "abc";
        const iter = s[Symbol.iterator]();
        if (iter == null) return 0;
        const v = (iter as any).next().value;
        if (v !== "a") return 2;
        return 1;
      }
    `);
    expect(r).toBe(1);
  });
});

describe("#1016b — class expression generator method dispatch", () => {
  it("var C = class { *method() {} } returns a working generator", async () => {
    const r = await runIt(`
      var C = class {
        *method() {
          yield 1;
          yield 2;
        }
      };
      export function test(): number {
        const gen = new C().method();
        if (gen == null) return 0;
        const r1 = (gen as any).next();
        if (r1.value !== 1) return 2;
        return 1;
      }
    `);
    expect(r).toBe(1);
  });
});
