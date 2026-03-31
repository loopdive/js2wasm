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
        const obj = { a: 10, b: 20 };
        const keys = Object.keys(obj);
        return keys[0];
      }
    `;
    expect(await run(src, "test")).toBe("a");
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
});

describe("Object.entries", () => {
  it("returns correct number of entries", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 1, y: 2, z: 3 };
        const entries = Object.entries(obj);
        return entries.length;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("entry key is correct", async () => {
    const src = `
      export function test(): string {
        const obj = { foo: 42, bar: 99 };
        const entries = Object.entries(obj);
        return entries[0][0];
      }
    `;
    expect(await run(src, "test")).toBe("foo");
  });

  it("entry value is correct", async () => {
    const src = `
      export function test(): number {
        const obj = { foo: 42, bar: 99 };
        const entries = Object.entries(obj);
        return entries[0][1];
      }
    `;
    expect(await run(src, "test")).toBe(42);
  });

  it("second entry is correct", async () => {
    const src = `
      export function test(): string {
        const obj = { foo: 42, bar: 99 };
        const entries = Object.entries(obj);
        return entries[1][0];
      }
    `;
    expect(await run(src, "test")).toBe("bar");
  });

  it("works with string values", async () => {
    const src = `
      export function test(): string {
        const obj = { name: "hello", greeting: "world" };
        const entries = Object.entries(obj);
        return entries[1][1];
      }
    `;
    expect(await run(src, "test")).toBe("world");
  });

  it("works with interface-typed objects", async () => {
    const src = `
      interface Point { x: number; y: number }
      function makePoint(a: number, b: number): Point {
        return { x: a, y: b };
      }
      export function test(): number {
        const p = makePoint(3, 4);
        const entries = Object.entries(p);
        return entries.length;
      }
    `;
    expect(await run(src, "test")).toBe(2);
  });
});
