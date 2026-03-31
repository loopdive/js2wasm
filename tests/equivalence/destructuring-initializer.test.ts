import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "./helpers.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  expect(result.success, `CE: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("Destructuring initializer evaluation (#823)", () => {
  it("object destructuring default is used when property missing", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const { x = 42 } = {} as { x?: number };
        return x;
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("object destructuring default is NOT used when property present", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const { x = 42 } = { x: 10 };
        return x;
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("array destructuring default for undefined element", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const [a = 100, b = 200] = [1] as number[];
        return a + b;
      }
    `);
    // a should be 1, b should be 200 (default)
    expect(e.test()).toBe(201);
  });

  it("default initializer with side effect should be evaluated", async () => {
    const e = await compileAndRun(`
      let counter: number = 0;
      function getValue(): number {
        counter = counter + 1;
        return 99;
      }
      export function test(): number {
        const { x = getValue() } = {} as { x?: number };
        return x + counter;
      }
    `);
    // getValue() should be called once: x=99, counter=1
    expect(e.test()).toBe(100);
  });

  it("default initializer NOT evaluated when value present", async () => {
    const e = await compileAndRun(`
      let counter: number = 0;
      function getValue(): number {
        counter = counter + 1;
        return 99;
      }
      export function test(): number {
        const { x = getValue() } = { x: 5 };
        return x + counter;
      }
    `);
    // getValue() should NOT be called: x=5, counter=0
    expect(e.test()).toBe(5);
  });

  it("function param with destructuring default", async () => {
    const e = await compileAndRun(`
      function f({ x = 10, y = 20 }: { x?: number; y?: number }): number {
        return x + y;
      }
      export function test(): number {
        return f({ x: 5 });
      }
    `);
    // x=5, y=20 (default)
    expect(e.test()).toBe(25);
  });

  it("nested destructuring with defaults", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const { a: { x = 1 } = { x: 1 } } = { a: { x: 42 } };
        return x;
      }
    `);
    expect(e.test()).toBe(42);
  });
});
