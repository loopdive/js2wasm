import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("issue-334: Private class fields and methods", () => {
  it("private field read via this.#field", async () => {
    const val = await run(`
      class Counter {
        #count: number = 0;
        getCount(): number { return this.#count; }
      }
      export function test(): number {
        const c = new Counter();
        return c.getCount();
      }
    `, "test");
    expect(val).toBe(0);
  });

  it("private field write via this.#field = value", async () => {
    const val = await run(`
      class Box {
        #value: number = 0;
        setValue(v: number): void { this.#value = v; }
        getValue(): number { return this.#value; }
      }
      export function test(): number {
        const b = new Box();
        b.setValue(42);
        return b.getValue();
      }
    `, "test");
    expect(val).toBe(42);
  });

  it("private field compound assignment (this.#count += 1)", async () => {
    const val = await run(`
      class Counter {
        #count: number = 0;
        increment(): void { this.#count += 1; }
        getCount(): number { return this.#count; }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        c.increment();
        return c.getCount();
      }
    `, "test");
    expect(val).toBe(3);
  });

  it("private field postfix increment (this.#count++)", async () => {
    const val = await run(`
      class Counter {
        #count: number = 0;
        increment(): number { return this.#count++; }
        getCount(): number { return this.#count; }
      }
      export function test(): number {
        const c = new Counter();
        const old = c.increment();
        c.increment();
        return old * 100 + c.getCount();
      }
    `, "test");
    // old=0, after two increments count=2, result = 0*100+2 = 2
    expect(val).toBe(2);
  });

  it("private field prefix increment (++this.#count)", async () => {
    const val = await run(`
      class Counter {
        #count: number = 0;
        increment(): number { return ++this.#count; }
        getCount(): number { return this.#count; }
      }
      export function test(): number {
        const c = new Counter();
        const v = c.increment();
        return v * 100 + c.getCount();
      }
    `, "test");
    // v=1, count=1, result = 1*100+1 = 101
    expect(val).toBe(101);
  });

  it("private method call (this.#method())", async () => {
    const val = await run(`
      class Calculator {
        #value: number;
        constructor(v: number) { this.#value = v; }
        #double(): number { return this.#value * 2; }
        getDouble(): number { return this.#double(); }
      }
      export function test(): number {
        const c = new Calculator(21);
        return c.getDouble();
      }
    `, "test");
    expect(val).toBe(42);
  });

  it("multiple private fields", async () => {
    const val = await run(`
      class Point {
        #x: number;
        #y: number;
        constructor(x: number, y: number) {
          this.#x = x;
          this.#y = y;
        }
        sum(): number { return this.#x + this.#y; }
      }
      export function test(): number {
        const p = new Point(10, 20);
        return p.sum();
      }
    `, "test");
    expect(val).toBe(30);
  });

  it("private field with initializer", async () => {
    const val = await run(`
      class Config {
        #defaultValue: number = 99;
        getDefault(): number { return this.#defaultValue; }
      }
      export function test(): number {
        const c = new Config();
        return c.getDefault();
      }
    `, "test");
    expect(val).toBe(99);
  });

  it("compound assignment on accessor property (get/set)", async () => {
    const val = await run(`
      class C {
        _value: number = 10;
        get value(): number { return this._value; }
        set value(v: number) { this._value = v; }
        addToValue(n: number): void { this.value += n; }
        getValue(): number { return this.value; }
      }
      export function test(): number {
        const c = new C();
        c.addToValue(5);
        return c.getValue();
      }
    `, "test");
    expect(val).toBe(15);
  });

  it("increment/decrement on accessor property", async () => {
    const val = await run(`
      class C {
        _count: number = 0;
        get count(): number { return this._count; }
        set count(v: number) { this._count = v; }
        inc(): number { return ++this.count; }
        dec(): number { return --this.count; }
        getCount(): number { return this.count; }
      }
      export function test(): number {
        const c = new C();
        c.inc();
        c.inc();
        c.inc();
        const v = c.dec();
        return v * 100 + c.getCount();
      }
    `, "test");
    // inc 3 times: count=3, dec: returns 2, count=2. Result: 2*100+2=202
    expect(val).toBe(202);
  });

  it("postfix increment on accessor property", async () => {
    const val = await run(`
      class C {
        _count: number = 5;
        get count(): number { return this._count; }
        set count(v: number) { this._count = v; }
        postInc(): number { return this.count++; }
        getCount(): number { return this.count; }
      }
      export function test(): number {
        const c = new C();
        const old = c.postInc();
        return old * 100 + c.getCount();
      }
    `, "test");
    // old=5, count after=6, result: 5*100+6=506
    expect(val).toBe(506);
  });
});
