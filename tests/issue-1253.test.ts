// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1253 — OrdinaryToPrimitive (§7.1.1.1) silent NaN instead of TypeError.
 *
 * The compiler's struct→f64 coercion path (`coerceType` in
 * `src/codegen/type-coercion.ts`) statically inlines `valueOf()` on object
 * literals when the struct's `valueOf` field is reachable. When the inlined
 * `valueOf` returned a non-primitive (object ref OR an externref that
 * happens to wrap a JS object at runtime), the codegen silently emitted
 * `drop` + `f64.const NaN`, bypassing both:
 *   - step 2.b.ii of OrdinaryToPrimitive (continue to the next method —
 *     `toString` — when valueOf returned non-primitive), and
 *   - step 3 (throw `TypeError` if neither method returns a primitive).
 *
 * Fix: at the inlined valueOf call site, when the closure's return type is
 * `externref` or any object ref kind, drop the bogus result, restore the
 * original struct ref, and route through the host `__to_primitive` runtime
 * helper. That helper re-runs valueOf, then tries toString, then throws
 * TypeError — exactly what the spec requires.
 *
 * The runtime helpers `_toPrimitive` / `_hostToPrimitive` already
 * implemented the spec-correct logic; only the static-inline fast path
 * needed fixing.
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

describe("#1253 OrdinaryToPrimitive throws TypeError when valueOf+toString both non-primitive", () => {
  it("`+{}` is NaN — Object.prototype.toString gives '[object Object]', a valid primitive (no throw)", async () => {
    // Sanity: with default Object.prototype methods, ToPrimitive succeeds via
    // toString. `+{}` should be NaN — NOT throw. Pre-fix and post-fix both
    // produce NaN; this test pins the spec-correct baseline so the fix
    // doesn't accidentally break the common case.
    const src = `
      export function test(): number {
        const o = {};
        try {
          const x: number = +o;
          return isNaN(x) ? 1 : 0;
        } catch (e) {
          return -1; // bug if we throw here
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("`+o` throws TypeError when both valueOf and toString return non-primitives (the headline bug)", async () => {
    // Pre-fix: silently produced NaN (the inlined valueOf returned an
    // externref pointing at a plain JS `{}`, then `__unbox_number({})`
    // fell through to Object.prototype.toString = "[object Object]" → NaN).
    // Post-fix: drops the inlined result, routes through host
    // __to_primitive on the original struct, which throws TypeError per
    // §7.1.1.1 step 3.
    const src = `
      export function test(): number {
        const o = {
          valueOf: function() { return {} as any; },
          toString: function() { return {} as any; },
        };
        try {
          const x: number = +o;
          // No throw — we got some value back; signal "did not throw".
          return isNaN(x) ? 100 : Math.floor(x);
        } catch (e) {
          return 1; // correct — TypeError thrown
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("valid valueOf returning a number still works (regression check)", async () => {
    // The fix must not break the common case of a numeric-returning valueOf.
    const src = `
      export function test(): number {
        const o = { valueOf: function() { return 42; } };
        return +o;
      }
    `;
    expect(await run(src)).toBe(42);
  });

  it("valueOf returning a string still works (Number(string) coercion path)", async () => {
    // Pre-fix this took the `__unbox_number` fast path. Post-fix it routes
    // through host __to_primitive, which still gives the same answer
    // because `_hostToPrimitive` returns the string and `Number("42")` = 42.
    const src = `
      export function test(): number {
        const o = { valueOf: function() { return "42"; } };
        return +o;
      }
    `;
    expect(await run(src)).toBe(42);
  });

  // NOTE: a user-thrown error from valueOf SHOULD propagate (per #983), but
  // the static-inline path's exception handling has separate complexities
  // tracked elsewhere. Not asserted here to keep #1253's regression scope
  // tight to the OrdinaryToPrimitive TypeError gap.
});
