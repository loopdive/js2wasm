// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1379 — `++` / `--` on null / undefined / string / object operands
 * must perform spec-correct ToNumeric coercion.
 *
 * UpdateExpression (ECMA-262 §13.4) is defined as:
 *   oldValue = ToNumeric(GetValue(operand))
 *   newValue = oldValue ± 1
 *   PutValue(operand, newValue)
 * The post-decrement / pre-increment value follows from the old/new pair.
 *
 * Before this fix the externref code path used `emitSafeExternrefToF64`,
 * which short-circuited every value whose `typeof` was not `"number"` to
 * NaN. That defeated the spec-required ToNumber chain for null (→ 0),
 * "1" (→ 1), { valueOf: () => "5" } (→ 5), etc. Test262 assertions like
 * `var x = null; ++x; x === 1` failed with `Actual: NaN`.
 *
 * The fix replaces the safe-NaN coercion with a direct `__unbox_number`
 * call. The runtime "unbox/number" intent (#1319) already performs the
 * full ToPrimitive → Number chain, including dispatch into WasmGC closure
 * structs for valueOf / toString / @@toPrimitive.
 *
 * Test262 cases driving the fix:
 *   language/expressions/postfix-decrement/S11.3.2_A4_T3.js (string)
 *   language/expressions/prefix-increment/S11.4.4_A3_T4.js  (null/undef)
 *   language/expressions/postfix-increment/S11.3.1_A4_T4.js (null/undef)
 *   language/expressions/prefix-decrement/S11.4.5_A3_T5.js  (object)
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1379 — ++/-- ToNumeric coercion on non-number operands", () => {
  it("++ on null local yields 1 (Number(null) = 0, then +1)", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = null;
        ++x;
        return x === 1 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("++ on undefined local yields NaN", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any;
        ++x;
        return Number.isNaN(x) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("postfix x-- on string '1' returns 1, leaves x = 0", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = "1";
        var y: any = x--;
        return y === 1 && x === 0 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("postfix x-- on string 'x' returns NaN", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = "x";
        var y: any = x--;
        return Number.isNaN(y) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("++ on empty string yields 1", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = "";
        ++x;
        return x === 1 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("postfix null++ returns 0, leaves x = 1", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = null;
        var y: any = x++;
        return y === 0 && x === 1 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("postfix undefined++ returns NaN", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any;
        var y: any = x++;
        return Number.isNaN(y) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("--{} yields NaN", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = {};
        --x;
        return Number.isNaN(x) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("--object with valueOf returning string '5' yields 4", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = { valueOf: function () { return "5"; } };
        var r: any = --x;
        return r === 4 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("--object with valueOf returning number yields valueOf()-1", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = { valueOf: function () { return 7; } };
        var r: any = --x;
        return r === 6 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("postfix true++ returns 1, leaves x = 2 (boolean ToNumber)", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = true;
        var y: any = x++;
        return y === 1 && x === 2 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("postfix false-- returns 0, leaves x = -1", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = false;
        var y: any = x--;
        return y === 0 && x === -1 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("++ on whitespace-padded numeric string trims and parses", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = "  42  ";
        ++x;
        return x === 43 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("++ on non-numeric string yields NaN", async () => {
    expect(
      await runWasm(`export function test(): number {
        var x: any = "abc";
        ++x;
        return Number.isNaN(x) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
