// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1157 — RegExp constructor called with `flags='undefinedy'` from
 * String.prototype method paths.
 *
 * Root-cause hypothesis (per the issue file): a String→RegExp desugaring
 * path stringified `undefined` and concatenated `"y"` (sticky flag),
 * yielding `"undefinedy"` which RegExp rejects. 288 test262 tests were
 * affected — most of them String.prototype methods that should not
 * construct a RegExp at all (`repeat`, `padStart`, `normalize`, `replace`
 * with string args).
 *
 * **Status (verified 2026-05-01):** all 288 reported failing tests now
 * pass on current main. Zero `undefinedy` occurrences in the committed
 * baseline JSONL. The 5 sample tests cited in the issue file all show
 * `status: pass`. The bug appears to have been fixed by the recent
 * String/RegExp/closure runtime changes (likely #679 dual-string backend
 * + #682 dual-RegExp backend rolling forward through subsequent fixes).
 *
 * This file captures the spec-correct behaviour for the specific
 * String.prototype paths that were vulnerable so the fix doesn't silently
 * regress.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1157 — String.prototype methods do not construct RegExp", () => {
  it("''.repeat(n) returns the empty string regardless of n", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        const a = "".repeat(1);
        const b = "".repeat(3);
        const c = "".repeat(2147483647);
        return [a, b, c];
      }
    `);
    expect(exports.test()).toEqual(["", "", ""]);
  });

  it("'abc'.repeat(0) returns empty; .repeat(N) returns abc concat N times", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        return ["abc".repeat(0), "abc".repeat(1), "abc".repeat(3)];
      }
    `);
    expect(exports.test()).toEqual(["", "abc", "abcabcabc"]);
  });

  it("'x'.padStart(5, ' ') pads to length 5 with spaces", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        return "x".padStart(5, " ");
      }
    `);
    expect(exports.test()).toBe("    x");
  });

  it("'x'.padEnd(5, '*') pads to length 5 with asterisks", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        return "x".padEnd(5, "*");
      }
    `);
    expect(exports.test()).toBe("x****");
  });

  it("'abc'.replace(string, string) does NOT involve RegExp", async () => {
    // Per ECMA-262 §22.1.3.18, when the search arg is NOT a RegExp,
    // it's coerced to string and replaced as a literal substring.
    // Our compiler must not desugar this through RegExp.
    const exports = await compileToWasm(`
      export function test(): any {
        return "abcabc".replace("b", "B");
      }
    `);
    // Spec: replaces only the FIRST occurrence
    expect(exports.test()).toBe("aBcabc");
  });

  it("simulates test262 wrapped harness: assert_sameValue chain doesn't fail at instantiate time", async () => {
    // Re-creates the test262 wrapper output for a String.prototype test.
    // Pre-fix, this would throw `Invalid flags supplied to RegExp 'undefinedy'`
    // during module instantiation.
    const exports = await compileToWasm(`
      let __fail: number = 0;
      let __assert_count: number = 1;
      function isSameValue(a: any, b: any): number {
        if (a === b) return 1;
        if (a !== a && b !== b) return 1;
        return 0;
      }
      function assert_sameValue(actual: any, expected: any): void {
        __assert_count = __assert_count + 1;
        if (!isSameValue(actual, expected)) {
          if (!__fail) __fail = __assert_count;
        }
      }
      export function test(): number {
        try {
          assert_sameValue("".repeat(1), "");
          assert_sameValue("".repeat(3), "");
          var maxSafe32bitInt = 2147483647;
          assert_sameValue("".repeat(maxSafe32bitInt), "");
        } catch (e) {
          if (!__fail) __fail = -1;
          throw e;
        }
        if (__fail) return __fail;
        return 1;
      }
    `);
    // Should pass all 3 assert_sameValue checks → return 1
    expect(exports.test()).toBe(1);
  });
});
