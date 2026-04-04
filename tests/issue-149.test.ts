import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

async function compileToWasm(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
  return instance.exports as Record<string, Function>;
}

describe("Issue #149: Unsupported call expression patterns", () => {
  it("chained method calls on class instances", async () => {
    const exports = await compileToWasm(`
      class Builder {
        private value: number;
        constructor(v: number) { this.value = v; }
        add(n: number): Builder {
          return new Builder(this.value + n);
        }
        result(): number {
          return this.value;
        }
      }
      export function test(): number {
        const b = new Builder(10);
        return b.add(5).result();
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("method call on function return value", async () => {
    const exports = await compileToWasm(`
      class Counter {
        private count: number;
        constructor(n: number) { this.count = n; }
        getCount(): number { return this.count; }
      }
      function makeCounter(n: number): Counter {
        return new Counter(n);
      }
      export function test(): number {
        return makeCounter(42).getCount();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("fn.bind(null) immediate call strips bind and calls directly", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number): number {
        return a + b;
      }
      export function test(): number {
        return add.bind(null)(3, 4);
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("fn.bind(null, partialArg) immediate call with partial application", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number): number {
        return a + b;
      }
      export function test(): number {
        return add.bind(null, 10)(20);
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("multiple chained method calls", async () => {
    const exports = await compileToWasm(`
      class Num {
        private v: number;
        constructor(v: number) { this.v = v; }
        add(n: number): Num { return new Num(this.v + n); }
        mul(n: number): Num { return new Num(this.v * n); }
        val(): number { return this.v; }
      }
      export function test(): number {
        return new Num(2).add(3).mul(4).val();
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("method call on conditional (ternary) expression", async () => {
    const exports = await compileToWasm(`
      class Box {
        private n: number;
        constructor(n: number) { this.n = n; }
        get(): number { return this.n; }
      }
      export function test(flag: number): number {
        const a = new Box(10);
        const b = new Box(20);
        return (flag ? a : b).get();
      }
    `);
    expect(exports.test(1)).toBe(10);
    expect(exports.test(0)).toBe(20);
  });

  it("struct/object method call on function return value", async () => {
    const exports = await compileToWasm(`
      function makeObj(): { getValue(): number } {
        return {
          getValue(): number { return 99; }
        };
      }
      export function test(): number {
        return makeObj().getValue();
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("method on new expression", async () => {
    const exports = await compileToWasm(`
      class Pair {
        private a: number;
        private b: number;
        constructor(a: number, b: number) { this.a = a; this.b = b; }
        sum(): number { return this.a + this.b; }
      }
      export function test(): number {
        return new Pair(3, 7).sum();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("deeply chained method calls returning self", async () => {
    const exports = await compileToWasm(`
      class Chain {
        private v: number;
        constructor(v: number) { this.v = v; }
        inc(): Chain { return new Chain(this.v + 1); }
        get(): number { return this.v; }
      }
      export function test(): number {
        return new Chain(0).inc().inc().inc().inc().inc().get();
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("fn.call with no args after thisArg", async () => {
    const exports = await compileToWasm(`
      function getValue(): number { return 42; }
      export function test(): number {
        return getValue.call(null);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("fn.apply with array literal args", async () => {
    const exports = await compileToWasm(`
      function multiply(a: number, b: number): number { return a * b; }
      export function test(): number {
        return multiply.apply(null, [6, 7]);
      }
    `);
    expect(exports.test()).toBe(42);
  });

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
