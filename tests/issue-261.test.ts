import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { compileToWasm, assertEquivalent, buildImports } from "./equivalence/helpers.js";

describe("Issue #261: ClassDeclaration + new expression", () => {
  it("should support new C() for top-level class", async () => {
    await assertEquivalent(
      `
      class C {
        x: number;
        constructor() { this.x = 42; }
      }
      export function test(): number {
        const c = new C();
        return c.x;
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });

  it("should support class with constructor args", async () => {
    await assertEquivalent(
      `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) { this.x = x; this.y = y; }
      }
      export function test(): number {
        const p = new Point(3, 4);
        return p.x + p.y;
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });

  it("should support class with methods instantiated via new", async () => {
    await assertEquivalent(
      `
      class Adder {
        val: number;
        constructor(v: number) { this.val = v; }
        get(): number { return this.val; }
      }
      export function test(): number {
        const a = new Adder(10);
        return a.get();
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });

  it("should support class declared in function body", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        class Inner {
          v: number;
          constructor(v: number) { this.v = v; }
        }
        const i = new Inner(99);
        return i.v;
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });

  it("should support class with extends (inheritance)", async () => {
    await assertEquivalent(
      `
      class Base {
        x: number;
        constructor(x: number) { this.x = x; }
      }
      class Child extends Base {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
      }
      export function test(): number {
        const c = new Child(10, 20);
        return c.x + c.y;
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });

  it("should support class used via variable alias (const C = class)", async () => {
    await assertEquivalent(
      `
      const MyClass = class {
        value: number;
        constructor(v: number) { this.value = v; }
      };
      export function test(): number {
        const obj = new MyClass(55);
        return obj.value;
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });

  it("should compile class in function body without errors", () => {
    const result = compile(`
      export function test(): number {
        class C {
          x: number;
          constructor() { this.x = 1; }
        }
        const c = new C();
        return c.x;
      }
    `);
    const classErrors = result.errors.filter(
      (e) => e.message.includes("Unsupported new expression") || e.message.includes("Missing constructor"),
    );
    expect(classErrors).toEqual([]);
  });

  it("should support class declared in if-block", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let val = 0;
        if (true) {
          class C {
            x: number;
            constructor() { this.x = 7; }
          }
          const c = new C();
          val = c.x;
        }
        return val;
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });

  it("should support class factory pattern (class inside function)", () => {
    // This pattern triggers the __class symbol name issue
    const result = compile(`
      function makeClass() {
        const C = class {
          x: number;
          constructor() { this.x = 42; }
        };
        return new C();
      }
      export function test(): number {
        const obj = makeClass();
        return obj.x;
      }
    `);
    const classErrors = result.errors.filter(
      (e) => e.message.includes("Unsupported new expression") || e.message.includes("Missing constructor"),
    );
    expect(classErrors).toEqual([]);
  });

  it("should handle new expression when checker resolves unknown class name gracefully", () => {
    // When the checker resolves a class name that isn't in classSet,
    // and it's not a built-in, it should not produce an error if the
    // identifier text matches a class in classSet
    const result = compile(`
      class Foo {
        x: number;
        constructor() { this.x = 5; }
      }
      export function test(): number {
        const c = new Foo();
        return c.x;
      }
    `);
    const classErrors = result.errors.filter(
      (e) => e.message.includes("Unsupported new expression") || e.message.includes("Missing constructor"),
    );
    expect(classErrors).toEqual([]);
  });

  it("should handle new for class expression inside nested function", () => {
    const result = compile(`
      export function test(): number {
        function factory() {
          const C = class {
            val: number;
            constructor(v: number) { this.val = v; }
          };
          return new C(10);
        }
        const obj = factory();
        return obj.val;
      }
    `);
    const classErrors = result.errors.filter(
      (e) => e.message.includes("Unsupported new expression") || e.message.includes("Missing constructor"),
    );
    expect(classErrors).toEqual([]);
  });

  it("should not error for built-in constructors like new Number()", () => {
    // Built-in JS constructors should not produce "Unsupported new expression" errors
    const result = compile(`
      export function test(): number {
        const n = new Number(42);
        return 1;
      }
    `);
    const newExprErrors = result.errors.filter((e) => e.message.includes("Unsupported new expression"));
    expect(newExprErrors).toEqual([]);
  });

  it("should not error for new RangeError()", () => {
    const result = compile(`
      export function test(): number {
        const e = new RangeError("out of range");
        return 1;
      }
    `);
    const newExprErrors = result.errors.filter((e) => e.message.includes("Unsupported new expression"));
    expect(newExprErrors).toEqual([]);
  });
});
