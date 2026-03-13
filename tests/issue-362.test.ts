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

describe("issue-362: typeof on member expressions", () => {
  it("typeof obj.prop returns 'number' for numeric property", async () => {
    expect(await run(`
      export function test(): string {
        const obj = { x: 42 };
        return typeof obj.x;
      }
    `)).toBe("number");
  });

  it("typeof obj.prop returns 'string' for string property", async () => {
    expect(await run(`
      export function test(): string {
        const obj = { name: "hello" };
        return typeof obj.name;
      }
    `)).toBe("string");
  });

  it("typeof obj.prop returns 'boolean' for boolean property", async () => {
    expect(await run(`
      export function test(): string {
        const obj = { flag: true };
        return typeof obj.flag;
      }
    `)).toBe("boolean");
  });

  it("typeof obj.prop returns 'function' for function property", async () => {
    expect(await run(`
      function myFn(): number { return 1; }
      export function test(): string {
        const obj = { fn: myFn };
        return typeof obj.fn;
      }
    `)).toBe("function");
  });

  it("typeof obj.prop returns 'object' for object property", async () => {
    expect(await run(`
      export function test(): string {
        const obj = { inner: { a: 1 } };
        return typeof obj.inner;
      }
    `)).toBe("object");
  });

  it("typeof with nested property access", async () => {
    expect(await run(`
      export function test(): string {
        const obj = { inner: { x: 42 } };
        return typeof obj.inner.x;
      }
    `)).toBe("number");
  });

  it("typeof in comparison with member expression", async () => {
    expect(await run(`
      export function test(): number {
        const obj = { x: 42 };
        return typeof obj.x === "number" ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("typeof member expression in inequality comparison", async () => {
    expect(await run(`
      export function test(): number {
        const obj = { x: 42 };
        return typeof obj.x !== "string" ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("typeof arr[i] returns correct type for array element", async () => {
    expect(await run(`
      export function test(): string {
        const arr = [1, 2, 3];
        return typeof arr[0];
      }
    `)).toBe("number");
  });

  it("typeof on function property used in conditional", async () => {
    expect(await run(`
      function myFn(): number { return 1; }
      export function test(): number {
        const obj = { fn: myFn };
        return typeof obj.fn === "function" ? 1 : 0;
      }
    `)).toBe(1);
  });
});
