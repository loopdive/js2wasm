import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string = "test", args: unknown[] = []): Promise<unknown> {
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

describe("Issue #375: super property access", () => {
  it("super.method() calls parent class method", async () => {
    const result = await run(`
      class Parent {
        greet(): string { return "hello"; }
      }
      class Child extends Parent {
        greet(): string { return super.greet() + " world"; }
      }
      export function test(): string {
        const c = new Child();
        return c.greet();
      }
    `);
    expect(result).toBe("hello world");
  });

  it("super.method() with arguments", async () => {
    const result = await run(`
      class Base {
        add(a: number, b: number): number { return a + b; }
      }
      class Derived extends Base {
        add(a: number, b: number): number {
          return super.add(a, b) * 2;
        }
      }
      export function test(): number {
        const d = new Derived();
        return d.add(3, 4);
      }
    `);
    expect(result).toBe(14);
  });

  it("super.method() through multiple levels of inheritance", async () => {
    const result = await run(`
      class A {
        value(): number { return 1; }
      }
      class B extends A {
        value(): number { return super.value() + 10; }
      }
      class C extends B {
        value(): number { return super.value() + 100; }
      }
      export function test(): number {
        const c = new C();
        return c.value();
      }
    `);
    expect(result).toBe(111);
  });

  it("super.method() calls parent even when child overrides", async () => {
    const result = await run(`
      class Shape {
        area(): number { return 0; }
      }
      class Square extends Shape {
        side: number;
        constructor(side: number) {
          super();
          this.side = side;
        }
        area(): number { return this.side * this.side; }
        parentArea(): number { return super.area(); }
      }
      export function test(): number {
        const s = new Square(5);
        return s.parentArea();
      }
    `);
    expect(result).toBe(0);
  });

  it("super.method() returning string in override", async () => {
    const result = await run(`
      class Base {
        toString(): string { return "Base"; }
      }
      class Sub extends Base {
        toString(): string { return super.toString() + ":Sub"; }
      }
      export function test(): string {
        const s = new Sub();
        return s.toString();
      }
    `);
    expect(result).toBe("Base:Sub");
  });

  it("super.method() in non-constructor method accessing parent field", async () => {
    const result = await run(`
      class Parent {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
        describe(): string { return "I am " + this.name; }
      }
      class Child extends Parent {
        constructor(name: string) {
          super(name);
        }
        childDescribe(): string {
          return super.describe() + " (child)";
        }
      }
      export function test(): string {
        const c = new Child("Rex");
        return c.childDescribe();
      }
    `);
    expect(result).toBe("I am Rex (child)");
  });
});
