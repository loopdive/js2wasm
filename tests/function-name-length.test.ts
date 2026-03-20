import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./helpers.js";

describe("Function .name property", () => {
  it("named function declaration", async () => {
    await assertEquivalent(
      `
      function foo(a: number, b: number) { return a + b; }
      export function test(): string { return foo.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function expression assigned to let variable", async () => {
    await assertEquivalent(
      `
      let bar = function myFunc() {};
      export function test(): string { return bar.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow function assigned to let variable", async () => {
    await assertEquivalent(
      `
      let greet = () => {};
      export function test(): string { return greet.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function expression assigned to const variable", async () => {
    await assertEquivalent(
      `
      const bar = function myFunc() {};
      export function test(): string { return bar.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow function assigned to const variable", async () => {
    await assertEquivalent(
      `
      const greet = () => {};
      export function test(): string { return greet.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function with multiple parameters - name", async () => {
    await assertEquivalent(
      `
      function calculate(x: number, y: number, z: number) { return x * y + z; }
      export function test(): string { return calculate.name; }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("Function .length property", () => {
  it("function with 2 params", async () => {
    await assertEquivalent(
      `
      function foo(a: number, b: number) { return a + b; }
      export function test(): number { return foo.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function with 0 params", async () => {
    await assertEquivalent(
      `
      function bar() { return 42; }
      export function test(): number { return bar.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function with 3 params", async () => {
    await assertEquivalent(
      `
      function baz(x: number, y: number, z: number) { return x + y + z; }
      export function test(): number { return baz.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow function length", async () => {
    await assertEquivalent(
      `
      let add = (a: number, b: number) => a + b;
      export function test(): number { return add.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function with rest parameter excludes rest from length", async () => {
    await assertEquivalent(
      `
      function withRest(a: number, ...rest: number[]) { return a; }
      export function test(): number { return withRest.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function length used in arithmetic", async () => {
    await assertEquivalent(
      `
      function twoArgs(a: number, b: number) { return a + b; }
      function threeArgs(x: number, y: number, z: number) { return x; }
      export function test(): number { return twoArgs.length + threeArgs.length; }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
