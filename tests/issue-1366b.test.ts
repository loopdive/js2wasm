// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1366b — `class Sub extends Array/Map/Set/Promise/RegExp/ArrayBuffer/...`
// host-constructible builtin subclassing. Mirrors #1366a's pattern: subclass
// instance is externref-backed, `super(...)` lowers to `__new_<Parent>(...)`,
// runtime resolves through the existing `extern_class new` import resolver.
//
// Limitations (deferred to slice 2 / #1366c / #1366d):
//   - `subInst instanceof Sub` for non-Error subclasses resolves via the
//     compile-time static reasoning path (`expressions.ts:714`), not via
//     prototype-chain walking. The runtime-side instance has the parent's
//     prototype, NOT Sub.prototype, because `__new_<Parent>(...)` is
//     `new Parent(...)` without `Reflect.construct`'s newTarget threading.
//     Tests covering `instanceof Sub` are .todo for now.
//   - `Symbol.species` for Array.prototype.slice / Map iterators / etc. that
//     return a "new instance of the same kind" still returns the parent type,
//     because the host method delegates to the parent's prototype. Deferred
//     to #1366d.
//   - Multi-arg `super(a, b)` only forwards the first arg today; the existing
//     #1366a `compileSuperCall` builtin branch is single-arg by design.
//     RegExp's two-arg form (`super(pattern, flags)`) only honours `pattern`.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function compileAndInstantiate(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary (WebAssembly.validate failed)\nWAT:\n${result.wat}`);
  }
  const runtimeResult = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtimeResult);
  if (runtimeResult.setExports) {
    runtimeResult.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports as Record<string, Function>;
}

describe("#1366b — class extends Array / Map / Set / Promise / RegExp / ArrayBuffer", () => {
  it("class MyArray extends Array — compiles, instance is a real Array", async () => {
    const source = `
      class MyArray extends Array {
        constructor(len: number) {
          super(len);
        }
      }
      export function isArray(): number {
        const a = new MyArray(3);
        return (a instanceof Array) ? 1 : 0;
      }
      export function getLength(): number {
        const a = new MyArray(7);
        return (a as any).length as number;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isArray!()).toBe(1);
    expect(exports.getLength!()).toBe(7);
  });

  it("class MyMap extends Map — Map operations work", async () => {
    const source = `
      class MyMap extends Map {
        constructor() {
          super();
        }
      }
      export function isMap(): number {
        const m = new MyMap();
        return (m instanceof Map) ? 1 : 0;
      }
      export function setAndGet(): number {
        const m: any = new MyMap();
        m.set("k", 42);
        return m.get("k") as number;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isMap!()).toBe(1);
    expect(exports.setAndGet!()).toBe(42);
  });

  it("class MySet extends Set — Set operations work", async () => {
    const source = `
      class MySet extends Set {
        constructor() {
          super();
        }
      }
      export function isSet(): number {
        const s = new MySet();
        return (s instanceof Set) ? 1 : 0;
      }
      export function addAndCheck(): number {
        const s: any = new MySet();
        s.add("hello");
        return s.has("hello") ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isSet!()).toBe(1);
    expect(exports.addAndCheck!()).toBe(1);
  });

  it("class MyRegExp extends RegExp — pattern match works", async () => {
    const source = `
      class MyRegExp extends RegExp {
        constructor(pat: string) {
          super(pat);
        }
      }
      export function testMatch(): number {
        const r: any = new MyRegExp("abc");
        return r.test("zzabczz") ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.testMatch!()).toBe(1);
  });

  it("class MyArrayBuffer extends ArrayBuffer — byteLength works", async () => {
    const source = `
      class MyArrayBuffer extends ArrayBuffer {
        constructor(len: number) {
          super(len);
        }
      }
      export function getByteLength(): number {
        const ab: any = new MyArrayBuffer(16);
        return ab.byteLength as number;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.getByteLength!()).toBe(16);
  });

  it("class MyWeakMap extends WeakMap — instanceof WeakMap holds", async () => {
    const source = `
      class MyWeakMap extends WeakMap {
        constructor() {
          super();
        }
      }
      export function isWeakMap(): number {
        const m = new MyWeakMap();
        return (m instanceof WeakMap) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isWeakMap!()).toBe(1);
  });

  // Note: a full Promise extends test requires unwrapping the executor closure
  // (which arrives at the host as an externref-wrapped WasmGC struct) into a
  // real JS function so `new Promise(executor)` can invoke it. The
  // `extern_class new` resolver does not do this today, so the host throws
  // `TypeError: Promise resolver [object Object] is not a function`. The
  // class compiles, but executor unwrap is a separate concern; deferred.
  it.todo("class MyPromise extends Promise — needs executor unwrap (slice 2)");

  // Slice 2 deferrals — these need newTarget threading via Reflect.construct
  // so the host instance's [[Prototype]] is Sub.prototype rather than the
  // builtin parent's prototype. Without that, `subInst instanceof Sub` cannot
  // be answered by the host's prototype-chain walk; we'd need a synthetic
  // host-side Sub class registered up-front for `instanceof` to look like
  // it's chasing the user's class. Tracked under #1366c.
  it.todo("subInst instanceof MyArray — needs newTarget threading (#1366c)");
  it.todo("subInst.method() returns Sub instance via Symbol.species (#1366d)");
  it.todo("multi-arg super(pattern, flags) — needs arity pre-scan (slice 2)");
});
