import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("Object.keys", () => {
  it("returns correct number of keys", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 1, y: 2, z: 3 };
        const keys = Object.keys(obj);
        return keys.length;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("keys can be accessed by index", async () => {
    const src = `
      export function test(): string {
        const obj = { x: 1, y: 2, z: 3 };
        const keys = Object.keys(obj);
        return keys[0];
      }
    `;
    expect(await run(src, "test")).toBe("x");
  });

  it("second key is correct", async () => {
    const src = `
      export function test(): string {
        const obj = { x: 1, y: 2, z: 3 };
        const keys = Object.keys(obj);
        return keys[1];
      }
    `;
    expect(await run(src, "test")).toBe("y");
  });

  it("last key is correct", async () => {
    const src = `
      export function test(): string {
        const obj = { x: 1, y: 2, z: 3 };
        const keys = Object.keys(obj);
        return keys[2];
      }
    `;
    expect(await run(src, "test")).toBe("z");
  });

  it("works with two-field object", async () => {
    const src = `
      export function test(): number {
        const obj = { name: "hello", age: 42 };
        return Object.keys(obj).length;
      }
    `;
    expect(await run(src, "test")).toBe(2);
  });

  it("works with interface-typed objects", async () => {
    const src = `
      interface Point { x: number; y: number }
      function makePoint(x: number, y: number): Point {
        return { x, y };
      }
      export function test(): number {
        const p = makePoint(3, 4);
        return Object.keys(p).length;
      }
    `;
    expect(await run(src, "test")).toBe(2);
  });

  it("keys match field names for interface type", async () => {
    const src = `
      interface Vec { a: number; b: number; c: number }
      function makeVec(): Vec {
        return { a: 1, b: 2, c: 3 };
      }
      export function test(): string {
        const v = makeVec();
        const keys = Object.keys(v);
        return keys[1];
      }
    `;
    expect(await run(src, "test")).toBe("b");
  });
});

describe("Object.values", () => {
  it("returns correct number of values", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 10, y: 20, z: 30 };
        const vals = Object.values(obj);
        return vals.length;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("values can be accessed by index", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 10, y: 20, z: 30 };
        const vals = Object.values(obj);
        return vals[0];
      }
    `;
    expect(await run(src, "test")).toBe(10);
  });

  it("second value is correct", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 10, y: 20, z: 30 };
        const vals = Object.values(obj);
        return vals[1];
      }
    `;
    expect(await run(src, "test")).toBe(20);
  });

  it("last value is correct", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 10, y: 20, z: 30 };
        const vals = Object.values(obj);
        return vals[2];
      }
    `;
    expect(await run(src, "test")).toBe(30);
  });

  it("string values work", async () => {
    const src = `
      export function test(): string {
        const obj = { first: "hello", second: "world" };
        const vals = Object.values(obj);
        return vals[0];
      }
    `;
    expect(await run(src, "test")).toBe("hello");
  });

  it("works with interface-typed objects", async () => {
    const src = `
      interface Point { x: number; y: number }
      function makePoint(x: number, y: number): Point {
        return { x, y };
      }
      export function test(): number {
        const p = makePoint(3, 4);
        const vals = Object.values(p);
        return vals[0] + vals[1];
      }
    `;
    expect(await run(src, "test")).toBe(7);
  });
});
