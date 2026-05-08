// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1380 — Strict equality cross-type comparisons must not coerce.
 *
 * IsStrictlyEqual (ECMA-262 §7.2.14) returns false whenever the operands
 * have different runtime types. The previous codegen for two-externref
 * `===` / `!==` had a numeric-unboxing fallback (added in #1065) that
 * fired whenever `__host_eq` returned false — turning `null === 0` into
 * `Number(null) === Number(0)` → `0 === 0` → true.
 *
 * For boxed Number primitives __host_eq and the unbox path agree, so
 * the fallback was redundant for the cases it was meant to cover, and
 * unsound for every cross-type comparison.
 *
 * The fix in src/codegen/binary-ops.ts trusts __host_eq's result as
 * definitive for strict equality, matching JS spec behaviour byte-for-byte.
 *
 * Test262 case driving the fix:
 *   language/expressions/strict-equals/S11.9.4_A8_T4.js
 *   language/expressions/strict-does-not-equals/S11.9.5_A8_T4.js (mirror)
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1380 — strict equality cross-type returns false (no numeric coercion)", () => {
  describe("S11.9.4_A8_T4 — null/undefined vs other types via ===", () => {
    it("undefined === null → false", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any; var b: any = null;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("null === undefined → false", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("null === 0 → false (was returning true)", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any = 0;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("0 === null → false", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = 0; var b: any = null;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("null === false → false (was returning true)", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any = false;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("false === null → false", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = false; var b: any = null;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("undefined === false → false", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any; var b: any = false;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("null === new Object() → false", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any = {};
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("new Object() === null → false", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = {}; var b: any = null;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it('null === "null" → false (was returning true)', async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any = "null";
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it('"null" === null → false', async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = "null"; var b: any = null;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it('undefined === "undefined" → false', async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any; var b: any = "undefined";
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it('null === "" → false (empty string ToNumber would be 0)', async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any = "";
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });
  });

  describe("strict !== mirror behaviour (S11.9.5)", () => {
    it("null !== 0 → true", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any = 0;
          return a !== b ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("null !== false → true", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any = false;
          return a !== b ? 1 : 0;
        }`),
      ).toBe(1);
    });
  });

  describe("regression coverage — equality paths that were already correct", () => {
    it("null === null → true", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any = null;
          return a === b ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("undefined === undefined → true", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any; var b: any;
          return a === b ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("Number primitive 5 === 5 → true (boxed externref)", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = 5; var b: any = 5;
          return a === b ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("Number primitive 5 === 6 → false", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = 5; var b: any = 6;
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("string 'x' === 'x' → true", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = "x"; var b: any = "x";
          return a === b ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("object identity {} === same {} → true (ref.eq path)", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = {}; var b: any = a;
          return a === b ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("object identity {} === different {} → false", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = {}; var b: any = {};
          return a === b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("loose null == 0 → false (no regression in §7.2.15)", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any = 0;
          return a == b ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("loose null == undefined → true", async () => {
      expect(
        await runWasm(`export function test(): number {
          var a: any = null; var b: any;
          return a == b ? 1 : 0;
        }`),
      ).toBe(1);
    });
  });
});
