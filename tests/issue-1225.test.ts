// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1225 — Nested destructuring from null/undefined: missing TypeError
 *
 * Three patterns where the compiler fails to throw a TypeError when a nested
 * destructuring pattern attempts to destructure null or undefined.
 *
 * Pattern 1: for-of assignment with nested null element (~126 tests)
 *   for ([{ x }] of [[null]]) {}
 *   The inner `{ x }` should destructure null → TypeError.
 *
 * Pattern 2: array assignment destructuring with nested null (~26 tests)
 *   [[ _ ]] = [null]
 *   Inner `[ _ ]` should iterate null → TypeError.
 *
 * Pattern 3: class method with initializer that evaluates to undefined (~92 tests)
 *   *method({ w: { x, y, z } = undefined } = {}) {}
 *   When `w` is undefined and the default `= undefined` is applied, the result
 *   is still undefined and `{ x, y, z }` should throw TypeError.
 *
 * Reference: ECMA-262
 *   §13.15.5.2 IteratorDestructuringAssignmentEvaluation
 *   §13.15.5.5 PropertyDestructuringAssignmentEvaluation
 *   §14.7.5.6 ForIn/OfBodyEvaluation
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1225 — Nested destructuring null/undefined throws TypeError", () => {
  it("Pattern 1: for-of with nested null inner element throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x: any;
        var threw: number = 0;
        try {
          for ([{ x }] of [[null]]) {}
        } catch (e) {
          if (e instanceof TypeError) threw = 1;
        }
        return threw;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Pattern 2: assignment [[_]] = [null] throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var _: any;
        var threw: number = 0;
        try {
          [[ _ ]] = [null];
        } catch (e) {
          if (e instanceof TypeError) threw = 1;
        }
        return threw;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Pattern 3: nested initializer evaluating to undefined throws TypeError", async () => {
    // class/dstr/meth-obj-ptrn-prop-obj-value-null.js pattern: when the inner
    // value is null (not undefined), the default does NOT apply, and nested
    // destructuring of null must throw TypeError.
    const exports = await compileToWasm(`
      class C {
        method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } }: any): any {
          return 1;
        }
      }
      export function test(): number {
        var threw: number = 0;
        try {
          var c: any = new C();
          c.method({ w: null });
        } catch (e) {
          if (e instanceof TypeError) threw = 1;
        }
        return threw;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Pattern 3b: param {} destructured from null throws TypeError", async () => {
    // class/dstr/meth-obj-init-null.js — empty pattern from null still throws
    // per spec §13.15.5.5 RequireObjectCoercible.
    const exports = await compileToWasm(`
      class C {
        method({ w }: any): any { return w; }
      }
      export function test(): number {
        var threw: number = 0;
        try {
          var c: any = new C();
          c.method(null);
        } catch (e) {
          if (e instanceof TypeError) threw = 1;
        }
        return threw;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Regression guards: these MUST keep passing.
  it("Regression: nested array destructure with vec source works", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x: number = 0;
        var vals: number[][] = [[42]];
        [[ x ]] = vals;
        return x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("Regression: for-of with nested non-null elements works", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x: number = 0;
        for ([{ x }] of [[{ x: 7 }]]) {}
        return x;
      }
    `);
    expect(exports.test()).toBe(7);
  });
});
