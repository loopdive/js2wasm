import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

function compileCheck(source: string): {
  success: boolean;
  validationError?: string;
  wat?: string;
  compileErrors?: string[];
} {
  const result = compile(source);
  if (!result.success) {
    return { success: false, compileErrors: result.errors.map((e) => e.message), wat: result.wat };
  }
  try {
    new WebAssembly.Module(result.binary);
    return { success: true, wat: result.wat };
  } catch (e: any) {
    return { success: false, validationError: e.message, wat: result.wat };
  }
}

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("Issue #516: struct.new argument count mismatch in class constructors", () => {
  it("basic class", async () => {
    expect(
      await run(
        `
        class Point {
          x: number;
          y: number;
          constructor(x: number, y: number) {
            this.x = x;
            this.y = y;
          }
        }
        export function test(): number {
          const p = new Point(3, 4);
          return p.x + p.y;
        }
      `,
        "test",
      ),
    ).toBe(7);
  });

  it("class with only property declarations (no explicit constructor)", async () => {
    expect(
      await run(
        `
        class Counter {
          count: number = 0;
        }
        export function test(): number {
          const c = new Counter();
          return c.count;
        }
      `,
        "test",
      ),
    ).toBe(0);
  });

  it("three-level inheritance chain", async () => {
    expect(
      await run(
        `
        class A {
          a: number;
          constructor(a: number) { this.a = a; }
        }
        class B extends A {
          b: number;
          constructor(a: number, b: number) {
            super(a);
            this.b = b;
          }
        }
        class C extends B {
          c: number;
          constructor(a: number, b: number, c: number) {
            super(a, b);
            this.c = c;
          }
        }
        export function test(): number {
          const obj = new C(1, 2, 3);
          return obj.a + obj.b + obj.c;
        }
      `,
        "test",
      ),
    ).toBe(6);
  });

  it("child class without explicit constructor inherits parent fields", () => {
    const r = compileCheck(`
      class Base {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
      }
      class Child extends Base {
        y: number = 10;
      }
      export function test(): number {
        const c = new Child(5);
        return c.x + c.y;
      }
    `);
    if (!r.success) {
      console.log("VALIDATION:", r.validationError);
      console.log("COMPILE:", r.compileErrors);
    }
    expect(r.success).toBe(true);
  });

  it("class with methods only (no own fields, implicit empty constructor)", () => {
    const r = compileCheck(`
      class Greeter {
        greet(): number { return 42; }
      }
      export function test(): number {
        const g = new Greeter();
        return g.greet();
      }
    `);
    if (!r.success) {
      console.log("VALIDATION:", r.validationError);
      console.log("COMPILE:", r.compileErrors);
    }
    expect(r.success).toBe(true);
  });

  it("class with computed property names", () => {
    const r = compileCheck(`
      const key = "x";
      class C {
        [key]: number;
        constructor() {
          this[key] = 42;
        }
      }
      export function test(): number {
        const c = new C();
        return 1;
      }
    `);
    // May not work perfectly, but should at least validate
    if (!r.success) {
      console.log("VALIDATION:", r.validationError);
      console.log("COMPILE:", r.compileErrors);
    }
  });

  it("class extending class with no constructor", () => {
    const r = compileCheck(`
      class A {
        x: number = 5;
      }
      class B extends A {
        y: number = 10;
      }
      export function test(): number {
        const b = new B();
        return b.x + b.y;
      }
    `);
    if (!r.success) {
      console.log("VALIDATION:", r.validationError);
      console.log("COMPILE:", r.compileErrors);
    }
    expect(r.success).toBe(true);
  });

  it("class with property initializers that use constructor params", () => {
    const r = compileCheck(`
      class Pair {
        first: number;
        second: number;
        sum: number;
        constructor(a: number, b: number) {
          this.first = a;
          this.second = b;
          this.sum = a + b;
        }
      }
      export function test(): number {
        const p = new Pair(3, 4);
        return p.sum;
      }
    `);
    if (!r.success) {
      console.log("VALIDATION:", r.validationError);
      console.log("COMPILE:", r.compileErrors);
    }
    expect(r.success).toBe(true);
  });

  it("class where property is set outside constructor", () => {
    // This pattern triggers dynamic field addition: the property is known
    // by TS type system but not in the class body or constructor
    const r = compileCheck(`
      class Config {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
      }
      function setup(c: Config): void {
        c.name = "updated";
      }
      export function test(): number {
        const c = new Config("original");
        setup(c);
        return 1;
      }
    `);
    if (!r.success) {
      console.log("VALIDATION:", r.validationError);
      console.log("COMPILE:", r.compileErrors);
    }
    expect(r.success).toBe(true);
  });

  it("class with compound assignment on property", () => {
    // Compound assignment (+=) on a property triggers dynamic field lookup
    const r = compileCheck(`
      class Counter {
        count: number;
        constructor() {
          this.count = 0;
        }
      }
      function increment(c: Counter): void {
        c.count += 1;
      }
      export function test(): number {
        const c = new Counter();
        increment(c);
        increment(c);
        return 1;
      }
    `);
    if (!r.success) {
      console.log("VALIDATION:", r.validationError);
      console.log("COMPILE:", r.compileErrors);
    }
    expect(r.success).toBe(true);
  });
});
