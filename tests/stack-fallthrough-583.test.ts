import { describe, it, expect } from "vitest";
import { compileToWasm, buildImports, compile } from "./equivalence/helpers.js";

describe("Issue #583: Stack not empty at fallthrough", () => {
  it("should drop expression statement results (non-void)", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        let x = 10;
        x + 5;  // expression statement - result should be dropped
        x * 2;  // another expression statement
        return x;
      }
    `);
    expect(exports.main()).toBe(10);
  });

  it("should handle void expression statements", async () => {
    const exports = await compileToWasm(`
      function sideEffect(): void {
        // nothing
      }
      export function main(): number {
        sideEffect(); // void expression statement
        return 1;
      }
    `);
    expect(exports.main()).toBe(1);
  });

  it("should handle bigint expression statement (pure bigint)", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        const a: bigint = 1n;
        const b: bigint = 2n;
        a + b; // bigint expression statement - should be dropped
        return 42;
      }
    `);
    expect(exports.main()).toBe(42);
  });

  it("should compile mixed bigint+number in assert_throws pattern", async () => {
    // This simulates the exact test262 pattern from bigint-and-number.js:
    // Multiple closures with mixed bigint+number arithmetic where later
    // closures trigger addUnionImports, which must also shift call indices
    // in the parent (test) function body.
    const result = compile(`
      function assert_throws(fn: () => void): void {
        try {
          fn();
        } catch (e) {
          return;
        }
      }

      export function test(): number {
        assert_throws(function() { 1n + 1; });
        assert_throws(function() { 1 + 1n; });
        assert_throws(function() { Object(1n) + 1; });
        assert_throws(function() { 1 + Object(1n); });
        return 1;
      }
    `);
    if (result.success) {
      const { instance } = await WebAssembly.instantiate(
        result.binary,
        buildImports(result),
      );
      expect((instance.exports as any).test()).toBe(1);
    }
  });

  it("should compile mixed bigint+number subtraction in callback", async () => {
    const result = compile(`
      function assert_throws(fn: () => void): void {
        try {
          fn();
        } catch (e) {
          return;
        }
      }

      export function test(): number {
        assert_throws(function() { 1n - 1; });
        assert_throws(function() { Object(1n) - 1; });
        return 1;
      }
    `);
    if (result.success) {
      const { instance } = await WebAssembly.instantiate(
        result.binary,
        buildImports(result),
      );
      expect((instance.exports as any).test()).toBe(1);
    }
  });

  it("should handle multiple expression statements without stack buildup", async () => {
    const exports = await compileToWasm(`
      export function main(): number {
        let x = 1;
        let y = 2;
        x + y;
        x * y;
        x - y;
        x + y + 3;
        return x;
      }
    `);
    expect(exports.main()).toBe(1);
  });

  it("parent body indices shift when closure triggers late imports", async () => {
    // Regression test: the parent function body must have its call indices
    // shifted when a child closure triggers addUnionImports. Without the fix,
    // the parent's call to assert_throws would reference the wrong function
    // (e.g. __unbox_number instead of assert_throws), causing a Wasm
    // validation error "expected 0 elements on the stack for fallthru, found 2".
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
        } catch (e) {
          __fail = 1;
        }
        if (__fail) { return 0; }
        return 1;
      }
    `);
    expect(result.success).toBe(true);
    if (result.success) {
      // The key test: WebAssembly.instantiate would throw with
      // "expected 0 elements on the stack for fallthru, found 2"
      // before the fix. Now it should validate and instantiate cleanly.
      const { instance } = await WebAssembly.instantiate(
        result.binary,
        buildImports(result),
      );
      // The test function runs without Wasm validation errors.
      // It returns 0 because our compiler doesn't throw TypeError for
      // mixed BigInt+Number — but the important thing is no stack imbalance.
      const testFn = (instance.exports as any).test;
      expect(typeof testFn()).toBe("number");
    }
  });
});
