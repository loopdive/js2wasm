import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

function compileAndCheck(source: string) {
  const result = compile(source);
  const unsupported = result.errors?.filter(
    (e) => e.message === "Unsupported call expression",
  );
  return { result, unsupported };
}

async function compileToWasm(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return instance.exports as Record<string, Function>;
}

describe("Issue #149: Additional unsupported call expression patterns", () => {
  it("conditional (ternary) function call: (flag ? a : b)()", async () => {
    const exports = await compileToWasm(`
      function a(): number { return 1; }
      function b(): number { return 2; }
      export function test(flag: number): number {
        return (flag ? a : b)();
      }
    `);
    expect(exports.test(1)).toBe(1);
    expect(exports.test(0)).toBe(2);
  });

  it("method call on array element: arr[0].get()", async () => {
    const exports = await compileToWasm(`
      class Foo {
        value: number;
        constructor(v: number) { this.value = v; }
        get(): number { return this.value; }
      }
      export function test(): number {
        const arr: Foo[] = [new Foo(42)];
        return arr[0].get();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("fn()() where fn returns a closure", async () => {
    const exports = await compileToWasm(`
      function makeAdder(a: number): (b: number) => number {
        return (b: number): number => a + b;
      }
      export function test(): number {
        return makeAdder(10)(32);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("method call on parenthesized expression: (x).get()", async () => {
    const exports = await compileToWasm(`
      class Foo {
        value: number;
        constructor(v: number) { this.value = v; }
        get(): number { return this.value; }
      }
      export function test(): number {
        const x = new Foo(55);
        return (x).get();
      }
    `);
    expect(exports.test()).toBe(55);
  });

  it("method call on new expression: new Foo(5).method()", async () => {
    const exports = await compileToWasm(`
      class Foo {
        value: number;
        constructor(v: number) { this.value = v; }
        double(): number { return this.value * 2; }
      }
      export function test(): number {
        return new Foo(5).double();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("method call on non-null assertion: x!.get()", async () => {
    const exports = await compileToWasm(`
      class Foo {
        value: number;
        constructor(v: number) { this.value = v; }
        get(): number { return this.value; }
      }
      export function test(): number {
        const x: Foo | null = new Foo(77);
        return x!.get();
      }
    `);
    expect(exports.test()).toBe(77);
  });

  it("conditional call with arguments: (flag ? add : sub)(a, b)", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number): number { return a + b; }
      function sub(a: number, b: number): number { return a - b; }
      export function test(flag: number): number {
        return (flag ? add : sub)(10, 3);
      }
    `);
    expect(exports.test(1)).toBe(13);
    expect(exports.test(0)).toBe(7);
  });

  it("nested conditional call: (a ? (b ? f1 : f2) : f3)()", async () => {
    const exports = await compileToWasm(`
      function f1(): number { return 1; }
      function f2(): number { return 2; }
      function f3(): number { return 3; }
      export function test(a: number, b: number): number {
        return (a ? (b ? f1 : f2) : f3)();
      }
    `);
    expect(exports.test(1, 1)).toBe(1);
    expect(exports.test(1, 0)).toBe(2);
    expect(exports.test(0, 1)).toBe(3);
    expect(exports.test(0, 0)).toBe(3);
  });

  it("conditional call with closure branches", async () => {
    const exports = await compileToWasm(`
      function makeAdder(n: number): (x: number) => number {
        return (x: number): number => x + n;
      }
      function makeMultiplier(n: number): (x: number) => number {
        return (x: number): number => x * n;
      }
      export function test(flag: number): number {
        const add5 = makeAdder(5);
        const mul3 = makeMultiplier(3);
        return (flag ? add5 : mul3)(10);
      }
    `);
    expect(exports.test(1)).toBe(15);
    expect(exports.test(0)).toBe(30);
  });
});
