import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("issue-852: var + closure assignment (no type mutation)", () => {
  it("var f; f = function; f() inside function body", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var f: () => number;
        f = function(): number { return 42; };
        return f() === 42 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("var f; f = arrow; f() inside function body", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var f: () => number;
        f = (): number => 42;
        return f() === 42 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("destructuring parameter in arrow assigned to var", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var f = ({x}: {x: number}): number => x;
        return f({x: 42}) === 42 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("arrow with destructuring called multiple times", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var sum = 0;
        var f = ({a, b}: {a: number, b: number}): number => a + b;
        sum += f({a: 10, b: 20});
        sum += f({a: 5, b: 7});
        return sum === 42 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("var f; f = arrow with destructuring; f()", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var f: (obj: {x: number}) => number;
        f = ({x}: {x: number}): number => x * 2;
        return f({x: 21}) === 42 ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
