import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string = "test", args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("class method patterns", () => {
  it("basic method returning this.property", async () => {
    expect(await run(`
      class A { x: number; constructor() { this.x = 42; } getX(): number { return this.x; } }
      export function test(): number { return new A().getX(); }
    `)).toBe(42);
  });

  it("method modifying this property", async () => {
    expect(await run(`
      class A { x: number; constructor() { this.x = 0; } inc(): void { this.x = this.x + 1; } }
      export function test(): number { const a = new A(); a.inc(); a.inc(); return a.x; }
    `)).toBe(2);
  });

  it("static method", async () => {
    expect(await run(`
      class A { static double(n: number): number { return n * 2; } }
      export function test(): number { return A.double(21); }
    `)).toBe(42);
  });

  it("method chaining returning this", async () => {
    expect(await run(`
      class Builder { val: number; constructor() { this.val = 0; } add(n: number): Builder { this.val = this.val + n; return this; } }
      export function test(): number { return new Builder().add(3).add(4).val; }
    `)).toBe(7);
  });

  it("field initializer without constructor", async () => {
    expect(await run(`
      class A { x: number = 5; }
      export function test(): number { return new A().x; }
    `)).toBe(5);
  });

  it("method calling another method on this", async () => {
    expect(await run(`
      class A { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; }
        getX(): number { return this.x; }
        getY(): number { return this.y; }
        sum(): number { return this.getX() + this.getY(); }
      }
      export function test(): number { return new A(3, 4).sum(); }
    `)).toBe(7);
  });

  it("getter property", async () => {
    expect(await run(`
      class A { _v: number; constructor(v: number) { this._v = v; } get value(): number { return this._v; } }
      export function test(): number { return new A(99).value; }
    `)).toBe(99);
  });

  it("method called from standalone function", async () => {
    expect(await run(`
      class A { v: number; constructor(v: number) { this.v = v; } getValue(): number { return this.v; } }
      function extract(a: A): number { return a.getValue(); }
      export function test(): number { return extract(new A(77)); }
    `)).toBe(77);
  });

  it("constructor with default parameter", async () => {
    expect(await run(`
      class A { x: number; constructor(x: number = 10) { this.x = x; } }
      export function test(): number { return new A().x; }
    `)).toBe(10);
  });

  it("multiple instances with separate state", async () => {
    expect(await run(`
      class Counter { count: number; constructor() { this.count = 0; } inc(): void { this.count = this.count + 1; } }
      export function test(): number {
        const a = new Counter();
        const b = new Counter();
        a.inc(); a.inc(); a.inc();
        b.inc();
        return a.count + b.count;
      }
    `)).toBe(4);
  });

  it("inheritance with method from base class", async () => {
    expect(await run(`
      class Base { x: number; constructor(x: number) { this.x = x; } getX(): number { return this.x; } }
      class Sub extends Base { constructor() { super(20); } }
      export function test(): number { return new Sub().getX(); }
    `)).toBe(20);
  });

  it("field initializer with constructor body", async () => {
    expect(await run(`
      class A { x: number = 5; y: number; constructor(y: number) { this.y = y; } }
      export function test(): number { return new A(3).x + new A(3).y; }
    `)).toBe(8);
  });

  it("method with multiple parameters", async () => {
    expect(await run(`
      class Calc {
        result: number;
        constructor() { this.result = 0; }
        addMul(a: number, b: number): number {
          this.result = a + b;
          return this.result;
        }
      }
      export function test(): number { const c = new Calc(); return c.addMul(3, 4); }
    `)).toBe(7);
  });

  it("method returning boolean condition", async () => {
    expect(await run(`
      class Range {
        lo: number; hi: number;
        constructor(lo: number, hi: number) { this.lo = lo; this.hi = hi; }
        contains(v: number): boolean { return v >= this.lo && v <= this.hi; }
      }
      export function test(): number { return new Range(1, 10).contains(5) ? 1 : 0; }
    `)).toBe(1);
  });

  it("method with default parameter", async () => {
    expect(await run(`
      class Adder {
        base: number;
        constructor(base: number) { this.base = base; }
        add(n: number = 5): number { return this.base + n; }
      }
      export function test(): number { return new Adder(10).add(); }
    `)).toBe(15);
  });

  it("constructor with multiple default parameters", async () => {
    expect(await run(`
      class Point {
        x: number; y: number;
        constructor(x: number = 1, y: number = 2) { this.x = x; this.y = y; }
      }
      export function test(): number { return new Point().x + new Point().y; }
    `)).toBe(3);
  });

  it("constructor with partial default parameters", async () => {
    expect(await run(`
      class Point {
        x: number; y: number;
        constructor(x: number, y: number = 100) { this.x = x; this.y = y; }
      }
      export function test(): number { return new Point(5).y; }
    `)).toBe(100);
  });
});
