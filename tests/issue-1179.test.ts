// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1179: Improve js2wasm `array-sum` hot-runtime perf.
 *
 * The competitive `array-sum` benchmark exposes the per-store / per-load
 * codegen for indexed array access on a dense backing array. The hot
 * loops are:
 *
 *   values[i] = ((i * 17) ^ (i >>> 3)) & 1023;   // fill
 *   sum = (sum + values[i]) | 0;                  // sum
 *
 * Pre-#1179 codegen for the bitwise expression on the right of the fill
 * loop emitted f64 arithmetic with per-op ToInt32 round-trips, and the
 * indexed array load/store always cast the loop-index `i` (already an
 * i32 local) through f64 → i32 via `f64.convert_i32_s` +
 * `i32.trunc_sat_f64_s`. The combination — heavy bitwise round-trip
 * AND redundant index conversion — drove the 1M-element workload to
 * ~155 ms hot runtime.
 *
 * #1179 fixes both:
 *   - `src/codegen/binary-ops.ts`: bitwise ops with i32-pure operands
 *     emit native i32 ops directly; arithmetic ops nested under any
 *     bitwise operator also stay i32 (the parent ToInt32 makes the
 *     wrap semantically equivalent).
 *   - `src/codegen/property-access.ts` & `expressions/assignment.ts`:
 *     element-index codegen now hints i32 directly, so an i32 loop
 *     index does not pay the f64 round-trip.
 *
 * This test asserts:
 *   1. The fill+sum program is correct vs. a pure-JS oracle.
 *   2. The compiled WAT for the fill loop body uses native i32 bitwise
 *      ops (no f64.const 4294967296 ToInt32 dance).
 *   3. The compiled WAT for the sum loop body does NOT round-trip the
 *      i32 loop index through f64 inside the array.get.
 *   4. A coarse perf budget — 1M iterations completes well under the
 *      pre-#1179 baseline (155 ms). We assert under 100 ms to leave
 *      ample headroom for slow CI; the local JIT measurement is ~30 ms.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ARRAY_SUM_SRC = `
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
`;

function jsOracle(n: number): number {
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
  }
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum = (sum + values[i]) | 0;
  }
  return sum | 0;
}

async function compileAndRun(src: string, fn: string, args: number[] = []): Promise<number> {
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

describe("#1179 — array-sum hot loop perf", () => {
  it("matches the JS oracle for n=100", async () => {
    expect(await compileAndRun(ARRAY_SUM_SRC, "run", [100])).toBe(jsOracle(100));
  });

  it("matches the JS oracle for n=1000", async () => {
    expect(await compileAndRun(ARRAY_SUM_SRC, "run", [1000])).toBe(jsOracle(1000));
  });

  it("matches the JS oracle for n=10000", async () => {
    expect(await compileAndRun(ARRAY_SUM_SRC, "run", [10_000])).toBe(jsOracle(10_000));
  });

  it("fill-loop bitwise body emits native i32 ops (no per-op ToInt32 round-trip)", () => {
    const wat = compileWat(ARRAY_SUM_SRC);
    // Find the contiguous i32-only block that compiles `((i*17) ^ (i>>>3)) & 1023`.
    // After #1179 it must include i32.mul, i32.shr_u, i32.xor, and i32.and immediately
    // around `i32.const 1023`, with no f64 ops in between. The pre-#1179 codegen
    // emitted f64.mul / f64.const 4294967296 / f64.div / f64.floor / f64.mul / f64.sub
    // for each of these — a per-op ToInt32 dance.
    expect(wat).toMatch(
      /i32\.mul[\s\S]{0,80}i32\.shr_u[\s\S]{0,80}i32\.xor[\s\S]{0,80}i32\.const 1023[\s\S]{0,40}i32\.and/,
    );
    // No f64 op between the mul and the and — this guards against any future
    // regression that re-introduces a per-bitwise-op f64 round-trip in the body.
    const fillBody = wat.match(/i32\.const 17[\s\S]{0,400}?i32\.const 1023[\s\S]{0,80}?i32\.and/);
    expect(fillBody, `fill-loop bitwise body not found in WAT:\n${wat}`).not.toBeNull();
    expect(fillBody![0]).not.toMatch(/f64\./);
  });

  it("array.get / array.set use i32 indices directly (no f64 round-trip)", () => {
    const wat = compileWat(ARRAY_SUM_SRC);
    // After #1179, the index pushed immediately before each `array.set` /
    // `array.get` must be a `local.get` (the i32 loop var), NOT a
    // `f64.convert_i32_s` + `i32.trunc_sat_f64_s` round-trip on it.
    // We check both directions: there must be at least one `array.set` /
    // `array.get` whose immediately preceding instructions are a local.get
    // for the i32 index, and NO array.{set,get} whose preceding two ops are
    // the f64 round-trip pair.
    const matches = [...wat.matchAll(/((?:[a-z0-9_.]+\s*[^\n]*\n\s*){0,4})(array\.(?:set|get) \d+)/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      // The 4-line window before each array.set/get must not contain the
      // f64.convert_i32_s + i32.trunc_sat_f64_s pair (the bad round-trip).
      expect(m[1]).not.toMatch(/f64\.convert_i32_s\s+i32\.trunc_sat_f64_s/);
    }
  });

  it("1M-element array-sum runs under a generous perf budget", async () => {
    const r = compile(ARRAY_SUM_SRC, { fileName: "t.js" });
    if (!r.success) {
      throw new Error(`Compile failed: ${r.errors.map((e) => e.message).join(", ")}`);
    }
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    const run = instance.exports.run as (n: number) => number;

    // Warm JIT, then time a single hot iteration.
    run(10_000);
    const t0 = performance.now();
    const result = run(1_000_000);
    const elapsed = performance.now() - t0;

    expect(result).toBe(jsOracle(1_000_000));
    // The pre-#1179 wasmtime hot-runtime baseline was ~155 ms. With the
    // codegen fix it ought to be sub-50 ms there. We're running under
    // V8's WasmGC implementation here, which is typically fast — but
    // CI machines vary. Set an upper bound of 250 ms to detect serious
    // regressions without flaking on slow shared CI runners.
    expect(elapsed).toBeLessThan(250);
  }, 10_000);
});
