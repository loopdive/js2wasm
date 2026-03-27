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

describe("Function constructor pattern: new FuncDecl()", () => {
  it("basic function constructor with this.x = value", async () => {
    const val = await run(`
      function Foo() {
        this.x = 42;
      }
      const obj = new Foo();
      export function test(): number {
        return obj.x;
      }
    `, "test");
    expect(val).toBe(42);
  });

  it("function constructor with multiple properties", async () => {
    const val = await run(`
      function Foo() {
        this.x = 1;
        this.y = 2;
      }
      const f = new Foo();
      export function test(): number {
        return f.x + f.y;
      }
    `, "test");
    expect(val).toBe(3);
  });

  it("function constructor with parameters", async () => {
    const val = await run(`
      function Point(x: number, y: number) {
        this.x = x;
        this.y = y;
      }
      const p = new Point(3, 4);
      export function test(): number {
        return p.x + p.y;
      }
    `, "test");
    expect(val).toBe(7);
  });

  it("multiple instances of same constructor", async () => {
    const val = await run(`
      function Counter(start: number) {
        this.val = start;
      }
      export function test(): number {
        const a = new Counter(10);
        const b = new Counter(20);
        return a.val + b.val;
      }
    `, "test");
    expect(val).toBe(30);
  });

  it("function constructor called inside exported function", async () => {
    const val = await run(`
      function Box(v: number) {
        this.value = v;
      }
      export function test(): number {
        const b = new Box(99);
        return b.value;
      }
    `, "test");
    expect(val).toBe(99);
  });
});
