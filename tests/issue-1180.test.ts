// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1180 — `env::__unbox_number` and sibling boxing helpers leak as host
// imports on `--target wasi`.
//
// Regression suite: every helper that the legacy host-mode path imports
// from `env::*` (box/unbox/typeof/is_truthy) MUST NOT appear as an
// `env::*` import when compiling under `--target wasi`. The fix
// (`addUnionImportsAsNativeFuncs` in `src/codegen/index.ts`) emits
// Wasm-native implementations using a pair of WasmGC structs
// (`__box_number_struct`, `__box_boolean_struct`).
//
// Each test case picks a source that exercises the helper at codegen time
// (forces it into `funcMap`) and asserts:
//   1. Compilation succeeds.
//   2. `result.imports` contains no `env::*` entries.
//   3. The Wasm binary validates and instantiates with no imports object.
//
// JS-host-mode (default `--target gc`) is verified separately in the
// "host mode unchanged" suite — under host mode the imports SHOULD still
// appear (they're the fast path when a JS host is present).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

interface CompileResultMinimal {
  success: boolean;
  imports: { module: string; name: string }[];
  binary: Uint8Array;
  errors: { message: string }[];
}

function compileWasi(source: string): CompileResultMinimal {
  return compile(source, { fileName: "test.js", allowJs: true, target: "wasi" });
}

function envImports(result: CompileResultMinimal): string[] {
  return result.imports.filter((i) => i.module === "env").map((i) => i.name);
}

async function instantiateNoImports(binary: Uint8Array): Promise<WebAssembly.Instance> {
  const m = await WebAssembly.compile(binary);
  return await WebAssembly.instantiate(m, {});
}

describe("#1180 — boxing helpers do not leak as env::* imports under --target wasi", () => {
  // Each case shapes the source so the legacy codegen path on host mode
  // would call into the corresponding `env::__*` helper. Under wasi mode
  // we expect ZERO env imports.

  it("__unbox_number — typed callee receiving externref arg", () => {
    // Untyped param `x` defaults to externref under JS-frontend semantics.
    // The call `inner(x)` to a typed callee unboxes externref → f64.
    const source = `
      /** @param {number} n @returns {number} */
      function inner(n) { return n + 1; }
      export function outer(x) { return inner(x); }
    `;
    const r = compileWasi(source);
    expect(r.success).toBe(true);
    expect(envImports(r)).toEqual([]);
  });

  it("__box_number — f64 result stored into externref slot", () => {
    // `arr` defaults to externref; `arr[i] = f64` boxes the f64 to fit
    // the externref element slot.
    const source = `
      export function pack(n) {
        const arr = [];
        for (let i = 0; i < (n | 0); i++) {
          arr[i] = i * 2;
        }
        return arr;
      }
    `;
    const r = compileWasi(source);
    expect(r.success).toBe(true);
    expect(envImports(r)).toEqual([]);
  });

  it("__unbox_boolean — typed boolean callee receiving externref", () => {
    const source = `
      /** @param {boolean} b @returns {number} */
      function take(b) { return b ? 1 : 0; }
      export function f(x) { return take(x); }
    `;
    const r = compileWasi(source);
    expect(r.success).toBe(true);
    expect(envImports(r)).toEqual([]);
  });

  it("__is_truthy — if(externref)", () => {
    const source = `
      export function f(x) {
        if (x) return 1;
        return 0;
      }
    `;
    const r = compileWasi(source);
    expect(r.success).toBe(true);
    expect(envImports(r)).toEqual([]);
  });

  it("__typeof_* — typeof comparisons against literal tags", () => {
    const source = `
      export function f(x) {
        if (typeof x === "number") return 1;
        if (typeof x === "boolean") return 2;
        if (typeof x === "string") return 3;
        if (typeof x === "undefined") return 4;
        return 0;
      }
    `;
    const r = compileWasi(source);
    expect(r.success).toBe(true);
    expect(envImports(r)).toEqual([]);
  });

  it("array-sum bench shape — the original repro from #1180", () => {
    // The exact source the benchmark harness produces (createCompileSource
    // in benchmarks/compare-runtimes.ts) when wrapping array-sum.js.
    const source = `
/** @param {number} n @returns {number} */
export function run(n) {
  const values = [];
  for (let i = 0; i < n; i++) {
    values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
  }
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum = (sum + values[i]) | 0;
  }
  return sum | 0;
}

export function run_hot(iterations, input) {
  let result = run(input);
  for (let i = 0; i < iterations; i++) {
    result = run(input);
  }
  return result;
}
    `;
    const r = compileWasi(source);
    expect(r.success).toBe(true);
    expect(envImports(r)).toEqual([]);
  });
});

describe("#1180 — wasi binaries validate and instantiate without an imports object", () => {
  it("array-sum bench shape — instantiates and run(n) returns the correct sum", async () => {
    const source = `
/** @param {number} n @returns {number} */
export function run(n) {
  const values = [];
  for (let i = 0; i < n; i++) {
    values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
  }
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum = (sum + values[i]) | 0;
  }
  return sum | 0;
}

export function run_hot(iterations, input) {
  let result = run(input);
  for (let i = 0; i < iterations; i++) {
    result = run(input);
  }
  return result;
}
    `;
    const r = compileWasi(source);
    expect(r.success).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const instance = await instantiateNoImports(r.binary);
    const run = instance.exports.run as (n: number) => number;
    // Pure-JS reference: ((i * 17) ^ (i >>> 3)) & 1023, summed for i=0..n-1
    let expected = 0;
    for (let i = 0; i < 50; i++) {
      expected = (expected + (((i * 17) ^ (i >>> 3)) & 1023)) | 0;
    }
    expect(run(50)).toBe(expected);
  });

  it("__unbox_number(null) — Number(null) === 0", async () => {
    // run_hot(null, null) inside wasi: __unbox_number(null) returns 0
    // (matches `Number(null)`), so run(0) returns 0.
    const source = `
      /** @param {number} n @returns {number} */
      export function run(n) {
        let s = 0;
        for (let i = 0; i < n; i++) s = (s + i) | 0;
        return s | 0;
      }
      export function run_hot(iterations, input) {
        let result = run(input);
        for (let i = 0; i < iterations; i++) {
          result = run(input);
        }
        return result;
      }
    `;
    const r = compileWasi(source);
    expect(r.success).toBe(true);
    const instance = await instantiateNoImports(r.binary);
    const runHot = instance.exports.run_hot as (a: unknown, b: unknown) => number;
    // null externref input → __unbox_number returns 0 → run(0) returns 0.
    expect(runHot(null, null)).toBe(0);
  });

  it("typed `run(n: number)` direct call works under wasi", async () => {
    const source = `
      /** @param {number} n @returns {number} */
      export function run(n) {
        let s = 0;
        for (let i = 0; i < n; i++) s = (s + i) | 0;
        return s | 0;
      }
    `;
    const r = compileWasi(source);
    expect(r.success).toBe(true);
    const instance = await instantiateNoImports(r.binary);
    const run = instance.exports.run as (n: number) => number;
    expect(run(10)).toBe(45); // 0+1+2+...+9
    expect(run(0)).toBe(0);
    expect(run(1)).toBe(0);
  });
});

describe("#1180 — host mode (default --target gc) still uses env::* imports as the fast path", () => {
  // Ensure the dual-mode pattern is preserved: under JS-host mode the
  // helpers come from `env::*` (where the host has fast native impls);
  // only wasi mode uses the Wasm-native fallback.

  it("host mode keeps env::__is_truthy import for if(externref)", () => {
    const source = `
      export function f(x) {
        if (x) return 1;
        return 0;
      }
    `;
    const r = compile(source); // no target → host gc mode
    expect(r.success).toBe(true);
    expect(envImports(r as CompileResultMinimal)).toContain("__is_truthy");
  });

  it("host mode keeps env::__typeof import for bare `typeof x`", () => {
    const source = `
      export function f(x) { return typeof x; }
    `;
    const r = compile(source);
    expect(r.success).toBe(true);
    expect(envImports(r as CompileResultMinimal)).toContain("__typeof");
  });
});
