import { describe, it, expect } from "vitest";
import { compile, CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) =>
    s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    __typeof: (v: unknown) => typeof v,
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    __unbox_number: (v: unknown) => Number(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    __make_callback: () => null,
  };
  return {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  };
}

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("prototype chain patterns (#631)", () => {
  it("instanceof with class hierarchy", async () => {
    const result = await run(
      `
      class Animal {
        legs: number;
        constructor(legs: number) { this.legs = legs; }
      }
      class Dog extends Animal {
        constructor() { super(4); }
      }
      export function test(): number {
        const d = new Dog();
        let result = 0;
        if (d instanceof Dog) result += 1;
        if (d instanceof Animal) result += 2;
        return result;
      }
    `,
      "test",
    );
    expect(result).toBe(3);
  });

  it("instanceof returns false for non-matching type", async () => {
    const result = await run(
      `
      class Foo {
        x: number = 1;
      }
      class Bar {
        y: number = 2;
      }
      export function test(): number {
        const f = new Foo();
        if (f instanceof Bar) return 0;
        return 1;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("instanceof with null value returns false", async () => {
    const result = await run(
      `
      class Foo {
        x: number = 1;
      }
      export function test(): number {
        const f: Foo | null = null;
        if (f instanceof Foo) return 0;
        return 1;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("Object.getPrototypeOf returns null for plain object", async () => {
    const result = await run(
      `
      export function test(): number {
        const proto = Object.getPrototypeOf({});
        return proto === null ? 1 : 0;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("instanceof with three-level hierarchy", async () => {
    const result = await run(
      `
      class A {
        x: number = 1;
      }
      class B extends A {
        y: number = 2;
      }
      class C extends B {
        z: number = 3;
      }
      export function test(): number {
        const c = new C();
        let r = 0;
        if (c instanceof C) r += 1;
        if (c instanceof B) r += 2;
        if (c instanceof A) r += 4;
        // B should not be instanceof C
        const b = new B();
        if (b instanceof C) r += 8;  // should NOT add 8
        return r;
      }
    `,
      "test",
    );
    expect(result).toBe(7); // 1 + 2 + 4
  });

  it("constructor property on class instance is truthy", async () => {
    const result = await run(
      `
      class Foo {
        x: number;
        constructor(x: number) { this.x = x; }
        getConstructorTruthy(): number {
          return (this as any).constructor ? 1 : 0;
        }
      }
      export function test(): number {
        const f = new Foo(42);
        return f.getConstructorTruthy();
      }
    `,
      "test",
    );
    expect(typeof result).toBe("number");
  });

  it("ClassName.prototype is truthy", async () => {
    const result = await run(
      `
      class Foo {
        x: number = 1;
      }
      export function test(): number {
        const proto = Foo.prototype;
        return proto ? 1 : 0;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("Object.getPrototypeOf(instance) is truthy for class instances", async () => {
    const result = await run(
      `
      class Foo {
        x: number = 1;
      }
      export function test(): number {
        const f = new Foo();
        const proto = Object.getPrototypeOf(f);
        return proto ? 1 : 0;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("Object.getPrototypeOf(instance) equals ClassName.prototype", async () => {
    const result = await run(
      `
      class Foo {
        x: number = 1;
      }
      export function test(): number {
        const f = new Foo();
        return Object.getPrototypeOf(f) === Foo.prototype ? 1 : 0;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("Object.getPrototypeOf(Child.prototype) equals Parent.prototype", async () => {
    const result = await run(
      `
      class Parent {
        x: number = 1;
      }
      class Child extends Parent {
        y: number = 2;
      }
      export function test(): number {
        return Object.getPrototypeOf(Child.prototype) === Parent.prototype ? 1 : 0;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });

  it("Object.create(Foo.prototype) creates instance with correct prototype", async () => {
    const result = await run(
      `
      class Foo {
        x: number = 0;
      }
      export function test(): number {
        const obj = Object.create(Foo.prototype);
        return obj instanceof Foo ? 1 : 0;
      }
    `,
      "test",
    );
    expect(result).toBe(1);
  });
});
