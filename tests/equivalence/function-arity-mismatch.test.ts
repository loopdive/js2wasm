import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Function arity mismatch (#184)", () => {
  it("calling function with fewer args than params", async () => {
    // Missing f64 args use NaN sentinel (matches JS: undefined coerces to NaN).
    // f(5) => 5 + NaN = NaN
    const exports = await compileToWasm(`
      function f(a: number, b: number): number {
        return a + b;
      }
      export function test(): number {
        return f(5);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("calling function with zero args when it expects two", async () => {
    // Missing f64 args use NaN sentinel (matches JS: undefined coerces to NaN).
    // f() => NaN + NaN = NaN
    const exports = await compileToWasm(`
      function f(a: number, b: number): number {
        return a + b;
      }
      export function test(): number {
        return f();
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("class constructor with fewer args than params", async () => {
    const exports = await compileToWasm(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
        getX(): number { return this.x; }
        getY(): number { return this.y; }
      }
      export function test(): number {
        const p = new Point(42);
        return p.getX();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("class constructor with no args when it expects params", async () => {
    // Missing f64 args use NaN sentinel (matches JS: undefined coerces to NaN).
    // new Pair() => a=NaN, b=NaN, sum()=NaN
    const exports = await compileToWasm(`
      class Pair {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
        sum(): number { return this.a + this.b; }
      }
      export function test(): number {
        const p = new Pair();
        return p.sum();
      }
    `);
    expect(exports.test()).toBeNaN();
  });
});
