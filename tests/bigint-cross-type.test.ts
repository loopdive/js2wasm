import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("bigint mixed type operations — stack balance", () => {
  it("mixed bigint/number closures compile to valid Wasm", () => {
    // Reproduces the pattern from test262 bigint-and-number.js that caused
    // "expected 0 elements on the stack for fallthru, found 2".
    // Root cause: addUnionImports did not shift func indices in parent
    // function bodies when triggered from within nested closure compilation.
    const result = compile(`
let __fail: number = 0;

function assert_throws(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    return;
  }
  __fail = 1;
}

export function test(): number {
  try {
    assert_throws(function() { 1n + 1; });
    assert_throws(function() { 1 + 1n; });
    assert_throws(function() { 1n + NaN; });
    assert_throws(function() { NaN + 1n; });
    assert_throws(function() { 1n + true; });
    assert_throws(function() { true + 1n; });
  } catch (e) {
    __fail = 1;
  }
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("mixed bigint - number also produces valid Wasm", () => {
    const result = compile(`
let __fail: number = 0;

function assert_throws(fn: () => void): void {
  try { fn(); } catch (e) { return; }
  __fail = 1;
}

export function test(): number {
  try {
    assert_throws(function() { 1n - 1; });
    assert_throws(function() { 1 - 1n; });
    assert_throws(function() { 1n - NaN; });
  } catch (e) {
    __fail = 1;
  }
  if (__fail) { return 0; }
  return 1;
}
    `);
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("closure triggering addUnionImports does not corrupt parent body", () => {
    // A closure that uses 'any' type triggers addUnionImports.
    // Earlier closures in the same parent function must have their
    // call indices properly shifted.
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
});
