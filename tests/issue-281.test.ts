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

describe("issue-281: object literal property patterns", () => {
  // === Shorthand properties ===

  it("shorthand property from local variable", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const x = 10;
          const y = 20;
          const obj = { x, y };
          return obj.x + obj.y;
        }
        `,
        "test",
      ),
    ).toBe(30);
  });

  it("shorthand property from function parameter", async () => {
    expect(
      await run(
        `
        export function test(x: number, y: number): number {
          const obj = { x, y };
          return obj.x + obj.y;
        }
        `,
        "test",
        [3, 7],
      ),
    ).toBe(10);
  });

  it("shorthand property from let variable", async () => {
    expect(
      await run(
        `
        export function test(): number {
          let x = 5;
          let y = 15;
          const obj = { x, y };
          return obj.x + obj.y;
        }
        `,
        "test",
      ),
    ).toBe(20);
  });

  it("mixed shorthand and regular properties", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const a = 1;
          const obj = { a, b: 2, c: 3 };
          return obj.a + obj.b + obj.c;
        }
        `,
        "test",
      ),
    ).toBe(6);
  });

  // === Spread in object literals ===

  it("spread copies all properties", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const a = { x: 1, y: 2 };
          const b = { ...a };
          return b.x + b.y;
        }
        `,
        "test",
      ),
    ).toBe(3);
  });

  it("spread with additional properties", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const a = { x: 1, y: 2 };
          const b = { ...a, z: 3 };
          return b.x + b.y + b.z;
        }
        `,
        "test",
      ),
    ).toBe(6);
  });

  it("spread with property override", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const a = { x: 1, y: 2 };
          const b = { ...a, x: 10 };
          return b.x + b.y;
        }
        `,
        "test",
      ),
    ).toBe(12);
  });

  it("spread from multiple sources", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const a = { x: 1 };
          const b = { y: 2 };
          const c = { ...a, ...b, z: 3 };
          return c.x + c.y + c.z;
        }
        `,
        "test",
      ),
    ).toBe(6);
  });

  // === Method definitions ===

  it("method definition with identifier name", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = {
            value: 5,
            getValue() { return this.value; }
          };
          return obj.getValue();
        }
        `,
        "test",
      ),
    ).toBe(5);
  });

  it("method with multiple parameters", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = {
            add(a: number, b: number, c: number) {
              return a + b + c;
            }
          };
          return obj.add(1, 2, 3);
        }
        `,
        "test",
      ),
    ).toBe(6);
  });

  it("method with string literal name", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = {
            "myMethod"() { return 99; }
          };
          return obj.myMethod();
        }
        `,
        "test",
      ),
    ).toBe(99);
  });

  it("method modifying object state", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = {
            v: 0,
            setV(x: number) { this.v = x; }
          };
          obj.setV(42);
          return obj.v;
        }
        `,
        "test",
      ),
    ).toBe(42);
  });

  it("method with default parameter", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = {
            add(a: number, b: number = 10) {
              return a + b;
            }
          };
          return obj.add(5);
        }
        `,
        "test",
      ),
    ).toBe(15);
  });

  // === Getter/Setter ===

  it("getter accessor", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = {
            _x: 10,
            get x() { return this._x * 2; }
          };
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(20);
  });

  it("getter and setter pair", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = {
            _x: 0,
            get x() { return this._x; },
            set x(v: number) { this._x = v; }
          };
          obj.x = 42;
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(42);
  });

  it("getter with string literal name", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = {
            _v: 5,
            get "value"() { return this._v; }
          };
          return obj.value;
        }
        `,
        "test",
      ),
    ).toBe(5);
  });

  it("setter with string literal name", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = {
            _v: 0,
            get "value"() { return this._v; },
            set "value"(v: number) { this._v = v; }
          };
          obj.value = 99;
          return obj.value;
        }
        `,
        "test",
      ),
    ).toBe(99);
  });

  it("getter with computed name", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const key = "value";
          const obj = {
            get [key]() { return 42; }
          };
          return obj.value;
        }
        `,
        "test",
      ),
    ).toBe(42);
  });

  // === Computed property names ===

  it("computed property name from const string", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const key = "val";
          const obj = { [key]: 42 };
          return obj.val;
        }
        `,
        "test",
      ),
    ).toBe(42);
  });

  // === Numeric properties ===

  it("numeric property keys with bracket access", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const obj = { 0: 10, 1: 20 };
          return obj[0] + obj[1];
        }
        `,
        "test",
      ),
    ).toBe(30);
  });

  // === Nested objects ===

  it("nested object with shorthand", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const x = 1;
          const inner = { x };
          const outer = { inner, y: 2 };
          return outer.inner.x + outer.y;
        }
        `,
        "test",
      ),
    ).toBe(3);
  });

  // === Combinations ===

  it("shorthand + method + getter", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const x = 10;
          const obj = {
            x,
            double() { return this.x * 2; },
            get tripled() { return this.x * 3; }
          };
          return obj.double() + obj.tripled;
        }
        `,
        "test",
      ),
    ).toBe(50);
  });

  it("spread + shorthand + method", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const base = { a: 1 };
          const b = 2;
          const obj = {
            ...base,
            b,
            sum() { return this.a + this.b; }
          };
          return obj.sum();
        }
        `,
        "test",
      ),
    ).toBe(3);
  });
});
