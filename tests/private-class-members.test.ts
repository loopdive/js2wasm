import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Private class members", () => {
  it("private field access", async () => {
    const exports = await compileToWasm(`
      class Counter {
        #count: number = 0;
        increment(): void { this.#count = this.#count + 1; }
        getCount(): number { return this.#count; }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        c.increment();
        return c.getCount();
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("private method call", async () => {
    const exports = await compileToWasm(`
      class Adder {
        #value: number = 0;
        #add(n: number): void { this.#value = this.#value + n; }
        addTwice(n: number): void { this.#add(n); this.#add(n); }
        get(): number { return this.#value; }
      }
      export function test(): number {
        const a = new Adder();
        a.addTwice(5);
        return a.get();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("private field assignment in constructor", async () => {
    const exports = await compileToWasm(`
      class Box {
        #val: number;
        constructor(v: number) { this.#val = v; }
        getVal(): number { return this.#val; }
      }
      export function test(): number {
        const b = new Box(42);
        return b.getVal();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("private field mutation in method", async () => {
    const exports = await compileToWasm(`
      class Acc {
        #total: number = 0;
        add(n: number): void { this.#total = this.#total + n; }
        reset(): void { this.#total = 0; }
        getTotal(): number { return this.#total; }
      }
      export function test(): number {
        const a = new Acc();
        a.add(10);
        a.add(20);
        a.add(30);
        a.reset();
        a.add(7);
        return a.getTotal();
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("multiple private fields", async () => {
    const exports = await compileToWasm(`
      class Point {
        #x: number;
        #y: number;
        constructor(x: number, y: number) { this.#x = x; this.#y = y; }
        sum(): number { return this.#x + this.#y; }
      }
      export function test(): number {
        const p = new Point(3, 4);
        return p.sum();
      }
    `);
    expect(exports.test()).toBe(7);
  });
});
