import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string = "test"): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn]();
}

describe("null dereference guards", () => {
  it("nested class instance access (ref field in struct)", async () => {
    // Regression: struct.new for Outer would fail because Inner field was typed
    // as non-null (ref $Inner) but initialized with ref.null. Fix: widen struct
    // fields from ref to ref_null.
    const result = await run(`
      class Inner {
        value: number;
        constructor(v: number) { this.value = v; }
      }
      class Outer {
        inner: Inner;
        constructor(v: number) { this.inner = new Inner(v); }
      }
      export function test(): number {
        const o = new Outer(42);
        return o.inner.value;
      }
    `);
    expect(result).toBe(42);
  });

  it("class with ref_null field accessed after assignment", async () => {
    const result = await run(`
      class Node {
        val: number;
        constructor(v: number) { this.val = v; }
      }
      export function test(): number {
        let n: Node | null = null;
        n = new Node(42);
        return n.val;
      }
    `);
    expect(result).toBe(42);
  });

  it("method call on possibly-null reference uses null guard", async () => {
    const result = await run(`
      class Counter {
        count: number;
        constructor() { this.count = 0; }
        increment(): void { this.count = this.count + 1; }
        getCount(): number { return this.count; }
      }
      export function test(): number {
        const c: Counter | null = new Counter();
        if (c) {
          c.increment();
          c.increment();
          c.increment();
          return c.getCount();
        }
        return -1;
      }
    `);
    expect(result).toBe(3);
  });

  it("class expression with methods works", async () => {
    const result = await run(`
      const C = class {
        v: number;
        constructor(v: number) { this.v = v; }
        get(): number { return this.v; }
      };
      export function test(): number {
        const c = new C(77);
        return c.get();
      }
    `);
    expect(result).toBe(77);
  });

  it("class with property initializer and no explicit constructor", async () => {
    const result = await run(`
      class Config {
        maxRetries: number = 3;
        timeout: number = 1000;
      }
      export function test(): number {
        const c = new Config();
        return c.maxRetries + c.timeout;
      }
    `);
    expect(result).toBe(1003);
  });

  it("struct.set on class property assignment", async () => {
    const result = await run(`
      class Box {
        val: number;
        constructor() { this.val = 0; }
      }
      export function test(): number {
        const b = new Box();
        b.val = 99;
        return b.val;
      }
    `);
    expect(result).toBe(99);
  });

  it("class with method calling another method via this", async () => {
    const result = await run(`
      class Calc {
        x: number;
        constructor(x: number) { this.x = x; }
        double(): number { return this.x * 2; }
        quadruple(): number { return this.double() * 2; }
      }
      export function test(): number {
        const c = new Calc(5);
        return c.quadruple();
      }
    `);
    expect(result).toBe(20);
  });

  it("accessing property on function return (possibly null)", async () => {
    const result = await run(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      function makePoint(): Point | null {
        return new Point(1, 2);
      }
      export function test(): number {
        const p = makePoint();
        if (p !== null) {
          return p.x + p.y;
        }
        return -1;
      }
    `);
    expect(result).toBe(3);
  });

  it("doubly nested class references", async () => {
    const result = await run(`
      class A {
        v: number;
        constructor(v: number) { this.v = v; }
      }
      class B {
        a: A;
        constructor(v: number) { this.a = new A(v); }
      }
      class C {
        b: B;
        constructor(v: number) { this.b = new B(v); }
      }
      export function test(): number {
        const c = new C(99);
        return c.b.a.v;
      }
    `);
    expect(result).toBe(99);
  });
});
