import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Tests for #650: addUnionImports double-shift causing Wasm validation errors.
 *
 * Root cause: addUnionImports tracked shifted body arrays in two separate Sets
 * (`shifted` and a local `done`). parentBodiesStack entries overlapped with
 * funcStack[i].body (same reference), so bodies were shifted twice — producing
 * out-of-bounds function indices or type mismatches.
 *
 * Fix: use the same `shifted` Set for both funcStack and parentBodiesStack.
 */
describe("addUnionImports double-shift (#650)", () => {
  it("closure triggering addUnionImports does not corrupt parent body", () => {
    // A closure that uses 'any' type triggers addUnionImports.
    // Earlier closures in the same parent function must have their
    // call indices properly shifted — not double-shifted.
    const result = compile(`
function foo(): number { return 42; }
function bar(fn: () => void): void { fn(); }

export function test(): number {
  bar(function() { foo(); });
  bar(function() { foo(); });
  bar(function() { const x: any = 42; });
  return 1;
}
    `);
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("mixed bigint closures with Object() do not double-shift", () => {
    // Object(1n) compiles to an unknown call returning externref.
    // When used in arithmetic (externref + f64), coercion triggers
    // addUnionImports via __unbox_number. A preceding closure that
    // also triggers addUnionImports causes double-shifting.
    const result = compile(`
let __fail: number = 0;
function assert_throws(fn: () => void): void {
  try { fn(); } catch (e) { return; }
  __fail = 1;
}
export function test(): number {
  try {
    assert_throws(function() { 1n + 1; });
    assert_throws(function() { Object(1n) + 1; });
    assert_throws(function() { 1n + Object(1); });
  } catch (e) { __fail = 1; }
  return __fail;
}
    `);
    expect(result.success).toBe(true);
    if (result.binary) {
      expect(WebAssembly.validate(result.binary)).toBe(true);
    }
  });

  it("all 18 bigint-and-number closures produce valid Wasm", () => {
    // Full reproduction of test262 bigint-and-number.js pattern
    const result = compile(`
let __fail: number = 0;
function assert_throws(fn: () => void): void {
  try { fn(); } catch (e) { return; }
  __fail = 1;
}
export function test(): number {
  try {
    assert_throws(function() { 1n + 1; });
    assert_throws(function() { 1 + 1n; });
    assert_throws(function() { Object(1n) + 1; });
    assert_throws(function() { 1 + Object(1n); });
    assert_throws(function() { 1n + Object(1); });
    assert_throws(function() { Object(1) + 1n; });
    assert_throws(function() { Object(1n) + Object(1); });
    assert_throws(function() { Object(1) + Object(1n); });
    assert_throws(function() { 1n + NaN; });
    assert_throws(function() { NaN + 1n; });
    assert_throws(function() { 1n + Infinity; });
    assert_throws(function() { Infinity + 1n; });
    assert_throws(function() { 1n + true; });
    assert_throws(function() { true + 1n; });
    assert_throws(function() { 1n + null; });
    assert_throws(function() { null + 1n; });
    assert_throws(function() { 1n + undefined; });
    assert_throws(function() { undefined + 1n; });
  } catch (e) { __fail = 1; }
  return __fail;
}
    `);
    expect(result.success).toBe(true);
    if (result.binary) {
      expect(WebAssembly.validate(result.binary)).toBe(true);
    }
  });
});
