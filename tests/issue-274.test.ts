import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("Issue #274: Property access on function type", () => {
  it("fn.length returns parameter count", async () => {
    await assertEquivalent(
      `
      function foo(a: number, b: number, c: number): number { return a + b + c; }
      export function test(): number { return foo.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.length returns 0 for no-arg function", async () => {
    await assertEquivalent(
      `
      function bar(): number { return 42; }
      export function test(): number { return bar.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.length returns 1 for single-arg function", async () => {
    await assertEquivalent(
      `
      function inc(x: number): number { return x + 1; }
      export function test(): number { return inc.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.name returns the function name as a string", async () => {
    await assertEquivalent(
      `
      function myFunc(): number { return 1; }
      export function test(): string { return myFunc.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.name returns correct name for multi-param function", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): string { return add.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call() works for standalone functions", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): number { return add.call(null, 3, 4); }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call() works with single argument", async () => {
    await assertEquivalent(
      `
      function double(x: number): number { return x * 2; }
      export function test(): number { return double.call(null, 5); }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.length in arithmetic expression", async () => {
    await assertEquivalent(
      `
      function f(a: number, b: number): number { return a + b; }
      export function test(): number { return f.length + 10; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.length with arrow function assigned to variable", async () => {
    await assertEquivalent(
      `
      const triple = (x: number): number => x * 3;
      export function test(): number { return triple.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.name for arrow function assigned to variable", async () => {
    await assertEquivalent(
      `
      const myArrow = (x: number): number => x * 2;
      export function test(): string { return myArrow.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("bar.length returns 2 for two-param function", async () => {
    await assertEquivalent(
      `
      function bar(a: number, b: number) { return a + b; }
      export function test(): number { return bar.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
