// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1252 — SameValue f64 for `Object.defineProperty` on a frozen
 * object got the operand order of `f64.copysign` reversed.
 *
 * The codegen already emitted the documented SameValue formula
 * `(x == y && copysign(1, x) == copysign(1, y)) || (x != x && y != y)`
 * (added under #1127), but the Wasm stack pushes were in the wrong order:
 *
 *   ;; intended: copysign(1, value) — magnitude 1, sign of value
 *   local.get $value     ;; pushed FIRST → becomes z1
 *   f64.const 1          ;; pushed SECOND → becomes z2
 *   f64.copysign         ;; result = z1 with sign of z2 = |value|  ❌
 *
 * Wasm `f64.copysign(z1, z2)` returns z1 with the sign of z2. The
 * magnitude must be pushed first (as z1), then the sign source. The
 * reversed order silently produced `|value|` (always positive), so
 * SameValue(+0, -0) and SameValue(-0, +0) returned true and the
 * Object.defineProperty call did not throw — the frozen-object guarantee
 * was broken for ±0.
 *
 * The ECMA-262 §9.1.6.3 step 7 rule: when DefineOwnProperty is called on
 * a non-writable non-configurable data property with a value that is not
 * SameValue to the current one, throw a TypeError.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("#1252 SameValue f64 in Object.defineProperty on frozen objects", () => {
  it("redefining a frozen NaN property to NaN does NOT throw (NaN === NaN under SameValue)", async () => {
    const src = `
      export function test(): number {
        const o: { x: number } = { x: NaN };
        Object.freeze(o);
        try {
          Object.defineProperty(o, "x", { value: NaN });
          return 1; // SameValue(NaN, NaN) is true → no throw
        } catch (e) {
          return 0;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("redefining a frozen +0 property to -0 throws (+0 !== -0 under SameValue)", async () => {
    // This is the bug #1252 was filed about. Pre-fix, copysign-operand-order
    // was reversed and SameValue(+0, -0) silently returned true.
    const src = `
      export function test(): number {
        const o: { x: number } = { x: 0.0 };
        Object.freeze(o);
        try {
          Object.defineProperty(o, "x", { value: -0.0 });
          return 0; // pre-fix: silently succeeded — bug
        } catch (e) {
          return 1; // post-fix: throws — correct
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("redefining a frozen -0 property to +0 also throws (symmetric)", async () => {
    const src = `
      export function test(): number {
        const o: { x: number } = { x: -0.0 };
        Object.freeze(o);
        try {
          Object.defineProperty(o, "x", { value: 0.0 });
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("redefining a frozen 1 property to 1 does NOT throw (sanity — same value)", async () => {
    const src = `
      export function test(): number {
        const o: { x: number } = { x: 1.0 };
        Object.freeze(o);
        try {
          Object.defineProperty(o, "x", { value: 1.0 });
          return 1;
        } catch (e) {
          return 0;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("redefining a frozen 1 property to 2 throws (sanity — different value)", async () => {
    const src = `
      export function test(): number {
        const o: { x: number } = { x: 1.0 };
        Object.freeze(o);
        try {
          Object.defineProperty(o, "x", { value: 2.0 });
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("redefining a non-writable non-configurable +0 to -0 via defineProperty throws", async () => {
    // Non-frozen object, but the property descriptor is writable:false /
    // configurable:false. ES spec §9.1.6.3 step 7 still requires SameValue;
    // the f64.copysign-operand-order bug bit this code path too.
    const src = `
      export function test(): number {
        const o: { x: number } = { x: 0.0 };
        Object.defineProperty(o, "x", {
          value: 0.0,
          writable: false,
          configurable: false,
        });
        try {
          Object.defineProperty(o, "x", { value: -0.0 });
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  // Note: a separate bug exists where Object.defineProperties on a frozen
  // object skips the SameValue check entirely (the codegen path's
  // needsValueCompare doesn't consult `frozenVars`). That's distinct from
  // the f64.copysign operand-order bug fixed here and would be filed as a
  // follow-up issue. The shared `emitSameValueF64` helper introduced by
  // this fix is wired into both paths so when that follow-up lands, the
  // ±0/NaN semantics will already be correct.
});
