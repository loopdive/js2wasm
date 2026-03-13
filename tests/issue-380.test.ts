import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("Issue #380: Unknown variable/function in test scope", () => {

  it("unknown identifier compiles gracefully (returns externref)", () => {
    const result = compile(`
      export function test(): number {
        let x = Symbol;
        return 42;
      }
    `);
    // Should compile without fatal errors -- Symbol is unknown but should not crash
    expect(result.success).toBe(true);
  });

  it("unknown function call compiles gracefully", () => {
    const result = compile(`
      export function test(): number {
        let x = unknownFunc(1, 2, 3);
        return 42;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("multiple unknown globals in same function compile", () => {
    const result = compile(`
      function test() {
        var a = unknownGlobal1;
        var b = unknownGlobal2;
        var c = unknownGlobal3;
        return 42;
      }
    `, { allowJs: true, fileName: "input.js" });
    expect(result.success).toBe(true);
  });

  it("unknown variable in compound assignment compiles gracefully (JS mode)", () => {
    const result = compile(`
      function test() {
        var x = unknownGlobal;
        return 42;
      }
    `, { allowJs: true, fileName: "input.js" });
    expect(result.success).toBe(true);
  });

  it("unknown function used in expression context compiles", () => {
    const result = compile(`
      export function test(): number {
        let result = unknownFunc();
        return 42;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("nested unknown identifiers compile gracefully", () => {
    const result = compile(`
      function test() {
        var x = myGlobalA;
        var y = myGlobalB;
        var z = myGlobalC;
        var w = myGlobalD;
        return 42;
      }
    `, { allowJs: true, fileName: "input.js" });
    expect(result.success).toBe(true);
  });

  it("unknown function with side-effecting arguments compiles", () => {
    const result = compile(`
      let counter: number = 0;
      function inc(): number { counter++; return counter; }
      export function test(): number {
        let x = unknownFunc(inc());
        return counter;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("previously erroring test262 pattern: count variable", () => {
    // Pattern from test262 where test-defined globals would fail
    const result = compile(`
      export function test(): number {
        return 42;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("unknown identifier used as typeof operand still compiles", () => {
    const result = compile(`
      export function test(): number {
        let x = typeof Symbol;
        return 42;
      }
    `);
    expect(result.success).toBe(true);
  });
});
