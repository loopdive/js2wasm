import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

// #1343 — Boolean(...) ToBoolean coercion + new Object() truthiness (slice 1).
//
// Two coordinated fixes:
//
// 1. `Boolean(externref)` previously emitted `ref.is_null + xor 1` which
//    returned 1 for JS `undefined` (an actual defined externref obtained
//    via `__get_undefined`, not a null reference). That made
//    `Boolean(undefined) === true` and broke every other ToBoolean edge
//    case (NaN, +/-0, "", 0n, wrapper objects). The fix routes externref
//    through a new `__to_boolean` host import that follows ECMA-262 §7.1.2.
//
// 2. The string-length fast-path (`Boolean("abc")` → length > 0) used
//    `isStringType()` which matched both PRIMITIVE strings and the
//    `String` wrapper-object type. `Boolean(new String(""))` therefore
//    returned `false` (length 0) — but spec says wrappers are always
//    truthy. The fast path is now restricted to primitive strings via a
//    direct `TypeFlags.String` check.
//
// 3. `new Object()` previously emitted `ref.null.extern` — making
//    `Boolean(new Object()) === false` (null is falsy). It now emits
//    `__object_create(null)` so the result is a fresh empty object,
//    which is truthy per spec.

describe("#1343 — Boolean ToBoolean coercion (slice 1)", () => {
  it("Boolean(undefined) === false (was returning true via ref.is_null)", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        return Boolean(undefined) ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(0);
  });

  it("Boolean(NaN) and Boolean(+/-0) return false", async () => {
    const exp = await compileToWasm(`
      export function nanFalse(): number { return Boolean(Number.NaN) ? 1 : 0; }
      export function posZeroFalse(): number { return Boolean(+0) ? 1 : 0; }
      export function negZeroFalse(): number { return Boolean(-0) ? 1 : 0; }
    `);
    expect(exp.nanFalse!()).toBe(0);
    expect(exp.posZeroFalse!()).toBe(0);
    expect(exp.negZeroFalse!()).toBe(0);
  });

  it("Boolean of object literal and new Object() is true", async () => {
    const exp = await compileToWasm(`
      export function literal(): number { return Boolean({}) ? 1 : 0; }
      export function constructed(): number { return Boolean(new Object()) ? 1 : 0; }
    `);
    expect(exp.literal!()).toBe(1);
    expect(exp.constructed!()).toBe(1);
  });

  it("Boolean of primitive strings respects length truthiness", async () => {
    const exp = await compileToWasm(`
      export function nonEmpty(): number { return Boolean("a") ? 1 : 0; }
      export function empty(): number { return Boolean("") ? 1 : 0; }
    `);
    expect(exp.nonEmpty!()).toBe(1);
    expect(exp.empty!()).toBe(0);
  });

  it("Boolean of numeric primitives", async () => {
    const exp = await compileToWasm(`
      export function nonZero(): number { return Boolean(1) ? 1 : 0; }
      export function zero(): number { return Boolean(0) ? 1 : 0; }
    `);
    expect(exp.nonZero!()).toBe(1);
    expect(exp.zero!()).toBe(0);
  });

  it("Boolean() with no args returns false", async () => {
    const exp = await compileToWasm(`
      export function test(): number { return Boolean() ? 1 : 0; }
    `);
    expect(exp.test!()).toBe(0);
  });
});
