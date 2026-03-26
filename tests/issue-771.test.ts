import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Arguments object (#771)", () => {
  it("arguments.length returns correct count", async () => {
    const exports = await compileToWasm(`
      function foo(a: number, b: number, c: number): number {
        return arguments.length;
      }
      export function test(): number {
        return foo(1, 2, 3) === 3 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("arguments[i] returns the ith parameter", async () => {
    const exports = await compileToWasm(`
      function foo(a: number, b: number): number {
        return arguments[0] + arguments[1];
      }
      export function test(): number {
        return foo(10, 20) === 30 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("arguments.length with zero params", async () => {
    const exports = await compileToWasm(`
      function foo(): number {
        return arguments.length;
      }
      export function test(): number {
        return foo() === 0 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("arguments in function expression", async () => {
    const exports = await compileToWasm(`
      const foo = function(a: number, b: number): number {
        return arguments.length;
      };
      export function test(): number {
        return foo(1, 2) === 2 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("arguments with string params (externref backing)", async () => {
    const exports = await compileToWasm(`
      function foo(a: any, b: any, c: any): number {
        return arguments.length;
      }
      export function test(): number {
        return foo("hello", "world", 42) === 3 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("arguments strict mode: does not alias params", async () => {
    const exports = await compileToWasm(`
      function foo(a: number, b: number): number {
        a = 99;
        return arguments[0];
      }
      export function test(): number {
        return foo(10, 20) === 10 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
