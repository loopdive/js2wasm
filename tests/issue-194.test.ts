import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return instance.exports as Record<string, Function>;
}

describe("Logical assignment operators (#194)", () => {
  it("||= assigns when LHS is falsy (0)", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        x ||= 42;
        return x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("||= keeps LHS when truthy", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 10;
        x ||= 42;
        return x;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("&&= assigns when LHS is truthy", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 10;
        x &&= 42;
        return x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("&&= keeps LHS when falsy (0)", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        x &&= 42;
        return x;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("??= assigns when LHS would be null (f64 short-circuits)", async () => {
    // For f64 variables, ??= is a no-op since numbers can't be null
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        x ??= 42;
        return x;
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("||= with property access on object", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let obj = { a: 0, b: 5 };
        obj.a ||= 99;
        obj.b ||= 99;
        return obj.a + obj.b;
      }
    `);
    // obj.a was 0 (falsy), so becomes 99. obj.b was 5 (truthy), stays 5.
    expect(exports.test()).toBe(104);
  });

  it("&&= with property access on object", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let obj = { a: 0, b: 5 };
        obj.a &&= 99;
        obj.b &&= 99;
        return obj.a + obj.b;
      }
    `);
    // obj.a was 0 (falsy), stays 0. obj.b was 5 (truthy), becomes 99.
    expect(exports.test()).toBe(99);
  });

  it("||= used as expression returns correct value", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        let y: number = x ||= 42;
        return y;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("&&= used as expression returns correct value", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 5;
        let y: number = x &&= 42;
        return y;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("chained logical assignments", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        let c: number = 1;
        a ||= 10;
        b ||= 20;
        c &&= 30;
        return a + b + c;
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("||= with boolean-like values", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        x ||= 1;
        return x;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("&&= preserves falsy NaN behavior", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = NaN;
        x &&= 42;
        return x;
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("||= with function parameter", async () => {
    const exports = await compileAndRun(`
      export function test(a: number): number {
        a ||= 42;
        return a;
      }
    `);
    expect(exports.test(0)).toBe(42);
    expect(exports.test(7)).toBe(7);
  });

  it("&&= with function parameter", async () => {
    const exports = await compileAndRun(`
      export function test(a: number): number {
        a &&= 99;
        return a;
      }
    `);
    expect(exports.test(0)).toBe(0);
    expect(exports.test(5)).toBe(99);
  });

  it("||= with module-level global", async () => {
    const exports = await compileAndRun(`
      let g: number = 0;
      export function test(): number {
        g ||= 42;
        return g;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("||= with function call on RHS", async () => {
    const exports = await compileAndRun(`
      function getDefault(): number { return 42; }
      export function test(): number {
        let x: number = 0;
        x ||= getDefault();
        return x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("||= result used in arithmetic", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        return (x ||= 42) + 1;
      }
    `);
    expect(exports.test()).toBe(43);
  });

  it("all three operators in sequence", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        x ??= 42;    // no-op for f64 (always non-null), x stays 0
        x ||= 10;    // x is 0 (falsy), becomes 10
        x &&= 99;    // x is 10 (truthy), becomes 99
        return x;
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("||= with array element", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let arr: number[] = [0, 5, 0];
        arr[0] ||= 99;
        arr[1] ||= 99;
        return arr[0] + arr[1];
      }
    `);
    expect(exports.test()).toBe(104);
  });
});
