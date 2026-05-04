// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1179-followup — i32 multiplication fast path is only spec-faithful when the
 * true product stays within 2^53.
 *
 * The #1179 fix generalised the i32 fast path so any arithmetic op nested
 * inside a bitwise / `| 0` context stays in i32. For `+` and `-` this is
 * provably correct (|a±b| ≤ 2^32 < 2^53, so f64 add/sub of two i32-
 * representable values is exact). For `*`, however, the true integer
 * product of two i32 values can reach 2^62 — well past f64's 53-bit
 * mantissa. When the f64 product loses precision, ToInt32 of the
 * rounded f64 differs from i32.mul of the inputs.
 *
 * Concrete divergence: `(0x7FFFFFFF * 0x7FFFFFFF) | 0`
 *   - JS spec: f64.mul → rounds 2^62 − 2^32 + 1 to 2^62 − 2^32 (low bit lost),
 *              then ToInt32 of a value that's a multiple of 2^32 = 0.
 *   - i32.mul: low 32 bits of true product = 1.
 * V8 follows the spec here (gives 0); `Math.imul(a, b)` gives 1.
 *
 * The followup fix guards the `*` arm of `isI32PureExpr` (and the top-level
 * fire condition when `op === AsteriskToken`) with `isI32MulSafe`, which
 * requires at least one operand to be an integer literal of magnitude
 * strictly below 2^21. That bounds the true product at 2^52 < 2^53, so
 * f64.mul is exact and the i32 path matches the spec exactly.
 *
 * This test asserts:
 *   1. Spec-conformance — `(0x7FFFFFFF * 0x7FFFFFFF) | 0 === 0`.
 *   2. Preservation — `((i*17) ^ (i>>>3)) & 1023` still hits the i32
 *      fast path (no `f64.const 4294967296` ToInt32 dance, and the body
 *      contains `i32.mul`).
 *   3. Other LCG / hash patterns with bare-local multiplication ops keep
 *      spec-faithful semantics.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

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

describe("#1179-followup — i32 multiplication fast path is spec-conformant", () => {
  it("(MAX_I32 * MAX_I32) | 0 returns the spec value (0), not Math.imul (1)", async () => {
    // Two bare i32 locals with no small-literal multiplier — predicate must
    // NOT fire the i32 path; the f64 + ToInt32 dance produces 0.
    const src = `
      export function run() {
        const a = 0x7FFFFFFF;
        const b = 0x7FFFFFFF;
        return (a * b) | 0;
      }
    `;
    // JS spec value (also what V8 gives):
    const expected = (0x7fffffff * 0x7fffffff) | 0;
    expect(expected).toBe(0); // sanity check on the test itself
    expect(await compileAndRun(src, "run")).toBe(expected);
  });

  it("LCG-style: `(seed * 1103515245 + 12345) | 0` matches spec for seed near i32 max", async () => {
    // Standard LCG constants — both factors are large literals (> 2^21),
    // so the i32 fast path must NOT fire. The body should compile in f64
    // and then ToInt32 the final result.
    const src = `
      export function lcg(seed) {
        return (seed * 1103515245 + 12345) | 0;
      }
    `;
    // Test against several seeds — at least one near i32 max where the
    // true product overflows 2^53.
    for (const seed of [1, 12345, 0x40000000, 0x7fffffff, -0x80000000]) {
      const expected = (seed * 1103515245 + 12345) | 0;
      expect(await compileAndRun(src, "lcg", [seed])).toBe(expected);
    }
  });

  it("(MAX_I32 * 17) | 0 returns the spec value — small literal makes the i32 path safe", async () => {
    // 17 is a small literal (|17| < 2^21), so the i32 fast path IS allowed.
    // The true product is 17 * (2^31 - 1) < 2^36 — well within f64 exactness,
    // so the i32 path gives the spec value bit-for-bit.
    const src = `
      export function run() {
        const a = 0x7FFFFFFF;
        return (a * 17) | 0;
      }
    `;
    const expected = (0x7fffffff * 17) | 0;
    expect(await compileAndRun(src, "run")).toBe(expected);
  });

  it("array-sum hot loop still hits the i32 fast path (no perf regression)", () => {
    // The original #1179 workload — `((i*17) ^ (i>>>3)) & 1023`. Both
    // multiplications have a small literal (17), so isI32MulSafe returns
    // true and the i32 path fires. The WAT must still contain `i32.mul`
    // and must NOT contain the `f64.const 4294967296` ToInt32 dance for
    // the bitwise expression.
    const src = `
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
    const wat = compileWat(src);
    expect(wat).toMatch(/i32\.mul/);
    expect(wat).toMatch(/i32\.xor/);
    expect(wat).toMatch(/i32\.and/);
    // The fill-loop bitwise body must NOT contain the `f64.const 4294967296`
    // dance. Anchor on `i32.const 17` and check the next ~400 chars.
    const fillBody = wat.match(/i32\.const 17[\s\S]{0,400}?i32\.const 1023[\s\S]{0,80}?i32\.and/);
    expect(fillBody, `fill-loop bitwise body not found in WAT:\n${wat}`).not.toBeNull();
    expect(fillBody![0]).not.toMatch(/4294967296/);
  });

  it("WAT-shape: bare-local `*` does NOT use i32.mul (falls back to f64)", () => {
    // Negative shape assertion — when both operands are bare i32 locals
    // with no small literal, the multiplication should compile in f64
    // (with the ToInt32 dance), NOT i32. This is the core fix.
    const src = `
      export function run(a, b) {
        return (a * b) | 0;
      }
    `;
    const wat = compileWat(src);
    // The body must contain f64.mul (the safe path), not i32.mul, for the
    // `a * b` op when both are bare locals. We can't easily anchor without
    // a unique nearby string, so check that f64.mul appears AND that the
    // ToInt32 dance (`f64.const 4294967296` etc.) is present — both
    // are smoking guns for the f64 path.
    expect(wat).toMatch(/f64\.mul/);
    expect(wat).toContain("4294967296");
  });

  it("nested chain: `((a*b) ^ (i*17)) & 0xFFFF` falls back to f64 because of the unsafe inner `*`", async () => {
    // When ANY sub-expression contains an unsafe `*` (bare locals on
    // both sides), the whole chain must fall back to the f64 path. The
    // safe `i*17` doesn't rescue it — without per-subtree mixing logic,
    // the whole expression compiles in f64 + ToInt32. Behavioural test
    // only — verifies the result matches the JS oracle.
    const src = `
      export function run(a, b, i) {
        return ((a * b) ^ (i * 17)) & 0xFFFF;
      }
    `;
    const cases: [number, number, number][] = [
      [0x7fffffff, 0x7fffffff, 5],
      [0x40000000, 0x40000000, 999],
      [3, 5, 17],
    ];
    for (const [a, b, i] of cases) {
      const expected = ((a * b) ^ (i * 17)) & 0xffff;
      expect(await compileAndRun(src, "run", [a, b, i])).toBe(expected);
    }
  });
});
