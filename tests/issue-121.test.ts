import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("Issue #121: Function.prototype.call/apply", () => {
  // --- .call() tests (existing feature, verify still working) ---

  it("fn.call(null, args...) on standalone function", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        return add.call(null, 3, 4);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call(undefined) with no extra args", async () => {
    await assertEquivalent(
      `
      function getVal(): number { return 99; }
      export function test(): number {
        return getVal.call(undefined);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.call() with multiple args", async () => {
    await assertEquivalent(
      `
      function sum3(a: number, b: number, c: number): number { return a + b + c; }
      export function test(): number {
        return sum3.call(null, 10, 20, 30);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- .apply() tests (new feature) ---

  it("fn.apply(null, [args...]) on standalone function", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        return add.apply(null, [5, 6]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.apply(undefined, [args...]) with multiple args", async () => {
    await assertEquivalent(
      `
      function multiply(a: number, b: number): number { return a * b; }
      export function test(): number {
        return multiply.apply(undefined, [7, 8]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.apply(null, []) with empty array", async () => {
    await assertEquivalent(
      `
      function getFortyTwo(): number { return 42; }
      export function test(): number {
        return getFortyTwo.apply(null, []);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fn.apply(null, [a, b, c]) with three args", async () => {
    await assertEquivalent(
      `
      function sum3(a: number, b: number, c: number): number { return a + b + c; }
      export function test(): number {
        return sum3.apply(null, [100, 200, 300]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- .call() on class methods ---

  it("obj.method.call(otherObj) on class method", async () => {
    await assertEquivalent(
      `
      class Foo {
        x: number;
        constructor(x: number) { this.x = x; }
        getX(): number { return this.x; }
      }
      export function test(): number {
        const a = new Foo(10);
        const b = new Foo(20);
        return a.getX.call(b);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.method.call(otherObj, arg) with args on class method", async () => {
    await assertEquivalent(
      `
      class Calc {
        base: number;
        constructor(base: number) { this.base = base; }
        addTo(n: number): number { return this.base + n; }
      }
      export function test(): number {
        const a = new Calc(10);
        const b = new Calc(100);
        return a.addTo.call(b, 5);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- .apply() on class methods ---

  it("obj.method.apply(otherObj, [args]) on class method", async () => {
    await assertEquivalent(
      `
      class Calc {
        base: number;
        constructor(base: number) { this.base = base; }
        addTo(n: number): number { return this.base + n; }
      }
      export function test(): number {
        const a = new Calc(10);
        const b = new Calc(100);
        return a.addTo.apply(b, [5]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- Compilation success tests ---

  it("compiles fn.call without errors", () => {
    const result = compile(`
      function greet(name: string): string { return name; }
      export function test(): string {
        return greet.call(null, "hello");
      }
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("compiles fn.apply without errors", () => {
    const result = compile(`
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        return add.apply(null, [1, 2]);
      }
    `);
    expect(result.errors).toHaveLength(0);
  });
});
