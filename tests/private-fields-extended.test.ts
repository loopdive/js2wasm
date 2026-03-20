import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("Private fields extended", () => {
  it("simple private field with initializer", async () => {
    const exports = await compileToWasm(`
      class C {
        #x = 42;
        get() { return this.#x; }
      }
      export function test(): number {
        const c = new C();
        return c.get();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("mixed public and private fields", async () => {
    const exports = await compileToWasm(`
      class C {
        pub = 10;
        #priv = 20;
        getPub(): number { return this.pub; }
        getPriv(): number { return this.#priv; }
        getSum(): number { return this.pub + this.#priv; }
      }
      export function test(): number {
        const c = new C();
        return c.getSum();
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("private field before public field", async () => {
    const exports = await compileToWasm(`
      class C {
        #a = 100;
        b = 200;
        getA(): number { return this.#a; }
        getB(): number { return this.b; }
      }
      export function test(): number {
        const c = new C();
        return c.getA() + c.getB();
      }
    `);
    expect(exports.test()).toBe(300);
  });

  it("multiple private and public fields interleaved", async () => {
    const exports = await compileToWasm(`
      class C {
        #a = 1;
        b = 2;
        #c = 3;
        d = 4;
        getA(): number { return this.#a; }
        getB(): number { return this.b; }
        getC(): number { return this.#c; }
        getD(): number { return this.d; }
      }
      export function test(): number {
        const c = new C();
        return c.getA() * 1000 + c.getB() * 100 + c.getC() * 10 + c.getD();
      }
    `);
    expect(exports.test()).toBe(1234);
  });

  it("private field set in constructor param", async () => {
    const exports = await compileToWasm(`
      class C {
        #x: number;
        constructor(x: number) {
          this.#x = x;
        }
        get(): number { return this.#x; }
      }
      export function test(): number {
        const c = new C(99);
        return c.get();
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("private method returning value", async () => {
    const exports = await compileToWasm(`
      class C {
        #x = 5;
        #double(): number { return this.#x * 2; }
        result(): number { return this.#double(); }
      }
      export function test(): number {
        const c = new C();
        return c.result();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("private field with inheritance", async () => {
    const exports = await compileToWasm(`
      class Base {
        #x = 10;
        getX(): number { return this.#x; }
      }
      class Child extends Base {
        #y = 20;
        getY(): number { return this.#y; }
        getSum(): number { return this.getX() + this.#y; }
      }
      export function test(): number {
        const c = new Child();
        return c.getSum();
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("private field update and read", async () => {
    const exports = await compileToWasm(`
      class C {
        #val = 0;
        set(v: number): void { this.#val = v; }
        get(): number { return this.#val; }
      }
      export function test(): number {
        const c = new C();
        c.set(42);
        return c.get();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("inherited public method accesses parent field (no ctor)", async () => {
    const exports = await compileToWasm(`
      class Base {
        x: number = 10;
        getX(): number { return this.x; }
      }
      class Child extends Base {
        y: number = 20;
      }
      export function test(): number {
        const c = new Child();
        return c.getX();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("child calls inherited method combined with own field", async () => {
    const exports = await compileToWasm(`
      class Base {
        val: number = 55;
        getVal(): number { return this.val; }
      }
      class Child extends Base {
        extra: number = 99;
        getBoth(): number { return this.getVal() + this.extra; }
      }
      export function test(): number {
        const c = new Child();
        return c.getBoth();
      }
    `);
    expect(exports.test()).toBe(154);
  });

  it("three-level inheritance field initializers", async () => {
    const exports = await compileToWasm(`
      class A {
        a: number = 1;
        getA(): number { return this.a; }
      }
      class B extends A {
        b: number = 2;
        getB(): number { return this.b; }
      }
      class C extends B {
        c: number = 3;
        getAll(): number { return this.getA() + this.getB() + this.c; }
      }
      export function test(): number {
        const c = new C();
        return c.getAll();
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("private field with both declaration initializer and constructor override", async () => {
    const exports = await compileToWasm(`
      class C {
        #x: number = 10;
        constructor(x: number) {
          this.#x = x;
        }
        get(): number { return this.#x; }
      }
      export function test(): number {
        const c = new C(42);
        return c.get();
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
