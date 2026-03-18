import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Illegal cast - assert_throws pattern", () => {
  it("calling a closure passed as argument should not illegal-cast", async () => {
    const exports = await compileToWasm(`
      function callIt(fn: () => void): number {
        try {
          fn();
          return 0;
        } catch (e) {
          return 1;
        }
      }
      export function test(): number {
        return callIt(function() { throw new Error("boom"); });
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("assert_throws pattern from test262", async () => {
    const exports = await compileToWasm(`
      var __fail: number = 0;

      function assert_throws(fn: () => void): void {
        try {
          fn();
        } catch (e) {
          return;
        }
        __fail = 1;
      }

      var callCount: number = 0;
      var f: any;
      f = function() {
        callCount = callCount + 1;
      };

      assert_throws(function() {
        throw new Error("test");
      });

      export function test(): number {
        return __fail === 0 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("closure with captures passed as callable param should not illegal-cast", async () => {
    const exports = await compileToWasm(`
      function callIt(fn: () => number): number {
        return fn();
      }
      export function test(): number {
        var x: number = 42;
        return callIt(function() { return x; });
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("multiple closures with different captures passed to same function", async () => {
    const exports = await compileToWasm(`
      function callIt(fn: () => number): number {
        return fn();
      }
      export function test(): number {
        var a: number = 10;
        var b: number = 20;
        var r1: number = callIt(function() { return a; });
        var r2: number = callIt(function() { return b; });
        return r1 + r2;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("closure with mutable capture passed as callable param (single call)", async () => {
    const exports = await compileToWasm(`
      function callIt(fn: () => void): void {
        fn();
      }
      export function test(): number {
        var count: number = 0;
        callIt(function() { count = count + 1; });
        return count;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("two closures with mutable captures passed to same function", async () => {
    const exports = await compileToWasm(`
      function callIt(fn: () => void): void {
        fn();
      }
      export function test(): number {
        var count: number = 0;
        callIt(function() { count = count + 1; });
        callIt(function() { count = count + 1; });
        return count;
      }
    `);
    expect(exports.test()).toBe(2);
  });
});
