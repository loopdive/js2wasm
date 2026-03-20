import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Function reference stored in variable", () => {
  it("simple function assigned to var and called", async () => {
    const exports = await compileToWasm(`
      function foo(): number { return 42; }
      export function test(): number {
        var fn = foo;
        return fn();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("function assigned to var with arguments", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        var fn = add;
        return fn(10, 20);
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("closure assigned to var and called", async () => {
    const exports = await compileToWasm(`
      function makeAdder(x: number): (y: number) => number {
        return (y: number): number => x + y;
      }
      export function test(): number {
        var fn = makeAdder(10);
        return fn(32);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("function reassigned multiple times and called", async () => {
    const exports = await compileToWasm(`
      function foo(): number { return 1; }
      function bar(): number { return 2; }
      export function test(): number {
        var fn = foo;
        var result: number = fn();
        fn = bar;
        result = result + fn();
        return result;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("closure returned from function and called later", async () => {
    const exports = await compileToWasm(`
      function counter(): () => number {
        var count: number = 0;
        return (): number => {
          count = count + 1;
          return count;
        };
      }
      export function test(): number {
        var inc = counter();
        inc();
        inc();
        return inc();
      }
    `);
    expect(exports.test()).toBe(3);
  });
});
