import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

// #1383 — typeof-gated strict-equality fallback (follow-up to #1380 / closed PR #272).
//
// The strict-equality codegen for two externref operands had this shape:
//
//   if host_eq(a, b)        // JS ===
//     return true
//   else
//     return unbox(a) === unbox(b)   // <-- unsound for cross-type
//
// The fallback was load-bearing for V8's same-value-different-identity case
// (V8 sometimes returns different externref ids for numerically-equal JS
// numbers), but it incorrectly produced `true` for cross-type comparisons:
// `null === 0` became `unbox(null) === unbox(0)` → `0 === 0` → true.
// Spec §7.2.16 says strict equality between values of different types is
// always false.
//
// Earlier PR #272 dropped the fallback entirely and caused -12 net test262
// because the fallback was masking unrelated mismatches in non-numeric
// comparisons. This PR keeps the fallback but **gates it on a runtime typeof
// check** — the numeric-unbox path only fires when both operands are
// `typeof === "number"`. Otherwise host_eq's `false` is final.

describe("#1383 — typeof-gated strict equality fallback", () => {
  it("null === 0 returns false (cross-type)", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        let a: any = null;
        let b: any = 0;
        return (a === b) ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(0);
  });

  it("undefined === 0 returns false (cross-type)", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        let a: any = undefined;
        let b: any = 0;
        return (a === b) ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(0);
  });

  it("null !== 0 returns true", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        let a: any = null;
        let b: any = 0;
        return (a !== b) ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(1);
  });

  it("null === null returns true (same type)", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        let a: any = null;
        let b: any = null;
        return (a === b) ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(1);
  });

  it("regression: same-value-different-identity numbers compare equal (load-bearing fallback)", async () => {
    // The numeric-unbox fallback exists to handle V8 representing the same
    // numeric value as different externref ids (e.g. 0 boxed twice with
    // different boxes). The typeof gate must preserve this case.
    const exp = await compileToWasm(`
      export function test(): number {
        let a: any = 1 + 0;
        let b: any = 1.0;
        return (a === b) ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(1);
  });

  it("regression: 42 === 42 still works (same-type same-value)", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        let a: any = 42;
        let b: any = 42;
        return (a === b) ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(1);
  });

  it("undefined === undefined returns true", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        let a: any = undefined;
        let b: any = undefined;
        return (a === b) ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(1);
  });

  it("regression: null !== undefined for strict (despite loose ==)", async () => {
    const exp = await compileToWasm(`
      export function test(): number {
        let a: any = null;
        let b: any = undefined;
        return (a !== b) ? 1 : 0;
      }
    `);
    expect(exp.test!()).toBe(1);
  });
});
