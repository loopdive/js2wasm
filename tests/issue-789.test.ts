import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(source: string): Promise<any> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).test();
}

describe("Issue #789: null guard should only throw on genuine null", () => {
  it("property access on valid struct works", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const obj = { x: 42 };
        return obj.x;
      }
    `);
    expect(result).toBe(42);
  });

  it("property access on null throws TypeError (caught)", async () => {
    const result = await compileAndRun(`
      interface Obj { x: number; }
      export function test(): number {
        const obj: Obj | null = null;
        try {
          const v = obj!.x;
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("method call on valid object works", async () => {
    const result = await compileAndRun(`
      class Adder {
        base: number;
        constructor(b: number) { this.base = b; }
        add(n: number): number { return this.base + n; }
      }
      export function test(): number {
        const a = new Adder(10);
        return a.add(5);
      }
    `);
    expect(result).toBe(15);
  });

  it("method call on null throws TypeError (caught)", async () => {
    const result = await compileAndRun(`
      class Foo {
        val: number;
        constructor(v: number) { this.val = v; }
        getVal(): number { return this.val; }
      }
      export function test(): number {
        const f: Foo | null = null;
        try {
          f!.getVal();
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("chained class method calls work", async () => {
    const result = await compileAndRun(`
      class Counter {
        count: number;
        constructor() { this.count = 0; }
        increment(): number { this.count = this.count + 1; return this.count; }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        return c.increment();
      }
    `);
    expect(result).toBe(3);
  });
});
