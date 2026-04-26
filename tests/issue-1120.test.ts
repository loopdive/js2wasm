// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1120: int32 fast path for bitwise-coerced numeric loops.
 * #1121: numeric recursive fast path inferred without JSDoc hints.
 *
 * Verifies (a) the optimized WAT no longer emits the heavy ToInt32
 * round-trip in the iterative-Fibonacci hot loop, (b) recursive `fib`
 * compiles to the lean (f64) -> f64 path even when the JS source has
 * no JSDoc annotations, and (c) all benchmarks still produce the
 * correct values (i32-overflow semantics for the iterative path).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, fn: string, args: number[] = []): Promise<number> {
  const r = compile(src, { fileName: "t.js" });
  if (!r.success) {
    throw new Error(`Compile failed: ${r.errors.map((e) => e.message).join(", ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports[fn] as (...a: number[]) => number)(...args);
}

function compileWat(src: string): string {
  const r = compile(src, { fileName: "t.js" });
  if (!r.success) {
    throw new Error(`Compile failed: ${r.errors.map((e) => e.message).join(", ")}`);
  }
  return r.wat ?? "";
}

describe("#1120 — int32 fast path for bitwise-coerced numeric loops", () => {
  it("iterative fib(10) returns 55", async () => {
    const src = `
      export function run(n) {
        let a = 0;
        let b = 1;
        for (let i = 0; i < n; i++) {
          const next = (a + b) | 0;
          a = b;
          b = next;
        }
        return a | 0;
      }
    `;
    expect(await run(src, "run", [10])).toBe(55);
  });

  it("iterative fib(20) returns 6765", async () => {
    const src = `
      export function run(n) {
        let a = 0;
        let b = 1;
        for (let i = 0; i < n; i++) {
          const next = (a + b) | 0;
          a = b;
          b = next;
        }
        return a | 0;
      }
    `;
    expect(await run(src, "run", [20])).toBe(6765);
  });

  it("iterative fib(50) wraps modulo 2^32 (matches V8 |0 semantics)", async () => {
    const src = `
      export function run(n) {
        let a = 0;
        let b = 1;
        for (let i = 0; i < n; i++) {
          const next = (a + b) | 0;
          a = b;
          b = next;
        }
        return a | 0;
      }
    `;
    // Match V8: the same loop with `(a + b) | 0` on each iteration produces
    // exactly this i32 value at n = 50 (Fibonacci wraps in int32 well before
    // n = 50 because F(48) ≈ 4.8e9 > 2^31).
    let a = 0;
    let b = 1;
    for (let i = 0; i < 50; i++) {
      const next = (a + b) | 0;
      a = b;
      b = next;
    }
    expect(await run(src, "run", [50])).toBe(a | 0);
  });

  it("hot loop emits native i32 arithmetic, no ToInt32 round-trip", () => {
    const src = `
      export function run(n) {
        let a = 0;
        let b = 1;
        for (let i = 0; i < n; i++) {
          const next = (a + b) | 0;
          a = b;
          b = next;
        }
        return a | 0;
      }
    `;
    const wat = compileWat(src);
    // Locals must be i32, not f64.
    expect(wat).toMatch(/\(local \$a i32\)/);
    expect(wat).toMatch(/\(local \$b i32\)/);
    expect(wat).toMatch(/\(local \$next i32\)/);
    // Hot body must use i32.add, not f64.add + f64.const 4294967296 + ToInt32 dance.
    expect(wat).toMatch(/i32\.add/);
    // The heavy modular reduction (×4294967296) MUST be gone from the loop.
    expect(wat).not.toContain("4294967296");
  });
});

describe("#1121 — numeric recursive fast path without JSDoc hints", () => {
  it("recursive fib(10) returns 55 without JSDoc", async () => {
    const src = `
      function fib(n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      export function run(n) {
        return fib(n);
      }
    `;
    expect(await run(src, "run", [10])).toBe(55);
  });

  it("recursive fib(20) returns 6765 without JSDoc", async () => {
    const src = `
      function fib(n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      export function run(n) {
        return fib(n);
      }
    `;
    expect(await run(src, "run", [20])).toBe(6765);
  });

  it("fib lowers to the lean numeric path (no externref boxing)", () => {
    const src = `
      function fib(n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      export function run(n) {
        return fib(n);
      }
    `;
    const wat = compileWat(src);
    // The fib_type declaration must be (param f64) (result f64) — i.e. no
    // externref boxing on either side. The compiler emits this both as
    // `(func $fib_type (func (param f64) (result f64)))` (named type alias)
    // and as `(func $fib (type N))` referring to it. We check the type
    // declaration plus the absence of any __box_number / __unbox_number
    // helper imports (the boxing helpers used on the externref path).
    expect(wat).toMatch(/\(func \(param f64\) \(result f64\)\)/);
    expect(wat).not.toContain("__box_number");
    expect(wat).not.toContain("__unbox_number");
    // The fib body must contain a direct numeric f64.add (no host calls).
    expect(wat).toMatch(/\(func \$fib[\s\S]*?f64\.add/);
  });

  it("run's signature is propagated to (f64) → f64 from body usage", () => {
    const src = `
      function fib(n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
      export function run(n) {
        return fib(n);
      }
    `;
    const wat = compileWat(src);
    // run shares fib's (f64) → f64 type. There must be no externref param
    // anywhere in the public exports — that would force boxing at the
    // boundary. Specifically, run must NOT have an externref param.
    expect(wat).not.toMatch(/\(func \$run \(param externref\)/);
  });
});
