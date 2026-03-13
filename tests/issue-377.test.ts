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

function compileOnly(source: string) {
  return compile(source);
}

describe("Issue #377: Getter/setter accessor edge cases", () => {
  it("getter without explicit return compiles successfully", () => {
    const result = compileOnly(`
      class Foo {
        get value(): number {
          // no return statement - should compile (returns 0 by default)
        }
      }
      export function test(): number {
        const f = new Foo();
        return f.value;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("getter without explicit return returns default value", async () => {
    const result = await run(`
      class Foo {
        get value(): number {
          // no return
        }
      }
      export function test(): number {
        const f = new Foo();
        return f.value;
      }
    `);
    expect(result).toBe(0);
  });

  it("object literal getter without explicit return compiles", () => {
    const result = compileOnly(`
      export function test(): number {
        var obj = {
          get prop(): number {
            // no return
          }
        };
        return obj.prop;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("object literal getter without return returns default", async () => {
    const result = await run(`
      export function test(): number {
        var obj = {
          get prop(): number {
            // implicit undefined return -> 0 for f64
          }
        };
        return obj.prop;
      }
    `);
    expect(result).toBe(0);
  });

  it("setter with parameter default compiles in class", () => {
    const result = compileOnly(`
      class Foo {
        _val: number = 0;
        set value(v: number = 42) {
          this._val = v;
        }
        get value(): number {
          return this._val;
        }
      }
      export function test(): number {
        const f = new Foo();
        f.value = 10;
        return f.value;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("setter with parameter default works at runtime (class)", async () => {
    const result = await run(`
      class Foo {
        _val: number = 0;
        set value(v: number = 42) {
          this._val = v;
        }
        get value(): number {
          return this._val;
        }
      }
      export function test(): number {
        const f = new Foo();
        f.value = 10;
        return f.value;
      }
    `);
    expect(result).toBe(10);
  });

  it("setter with parameter default compiles in object literal", () => {
    const result = compileOnly(`
      export function test(): number {
        var val = 0;
        var obj = {
          set prop(v: number = 42) {
            val = v;
          },
          get prop(): number {
            return val;
          }
        };
        obj.prop = 5;
        return obj.prop;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("setter with parameter default works at runtime (object literal)", async () => {
    const result = await run(`
      export function test(): number {
        var obj = {
          _val: 0,
          set prop(v: number = 42) {
            this._val = v;
          },
          get prop(): number {
            return this._val;
          }
        };
        obj.prop = 5;
        return obj.prop;
      }
    `);
    expect(result).toBe(5);
  });

  it("getter with conditional return compiles", async () => {
    const result = await run(`
      class Foo {
        x: number = 10;
        get value(): number {
          if (this.x > 5) {
            return this.x;
          }
          // implicit return undefined on else path -> 0
        }
      }
      export function test(): number {
        const f = new Foo();
        return f.value;
      }
    `);
    expect(result).toBe(10);
  });

  it("getter returning string without explicit return compiles", () => {
    const result = compileOnly(`
      class Foo {
        get label(): string {
          // no return
        }
      }
      export function test(): string {
        const f = new Foo();
        return f.label;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("multiple accessors on same object compile", async () => {
    const result = await run(`
      class Counter {
        _count: number = 0;
        get count(): number { return this._count; }
        set count(v: number = 0) { this._count = v; }
        get doubled(): number { return this._count * 2; }
      }
      export function test(): number {
        const c = new Counter();
        c.count = 5;
        return c.doubled;
      }
    `);
    expect(result).toBe(10);
  });
});
