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

describe("Object.keys extended (#355)", () => {
  it("works with numeric-string keys", async () => {
    const src = `
      export function test(): number {
        const obj = { "0": "a", "1": "b", "2": "c" };
        return Object.keys(obj).length;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("returns numeric-string keys as strings", async () => {
    const src = `
      export function test(): string {
        const obj = { "0": "a", "1": "b" };
        const keys = Object.keys(obj);
        return keys[0];
      }
    `;
    expect(await run(src, "test")).toBe("0");
  });

  it("works with mixed string and number values", async () => {
    const src = `
      export function test(): number {
        const obj = { name: "alice", age: 30 };
        return Object.keys(obj).length;
      }
    `;
    expect(await run(src, "test")).toBe(2);
  });

  it("works with boolean values", async () => {
    const src = `
      export function test(): number {
        const obj = { active: true, visible: false };
        return Object.keys(obj).length;
      }
    `;
    expect(await run(src, "test")).toBe(2);
  });

  it("works with single-property object", async () => {
    const src = `
      export function test(): string {
        const obj = { only: 42 };
        const keys = Object.keys(obj);
        return keys[0];
      }
    `;
    expect(await run(src, "test")).toBe("only");
  });

  it("works with empty-like object that has no user fields", async () => {
    const src = `
      export function test(): number {
        const obj = { a: 1 };
        return Object.keys(obj).length;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });
});

describe("Object.values extended (#355)", () => {
  it("works with string values", async () => {
    const src = `
      export function test(): string {
        const obj = { greeting: "hello", name: "world" };
        const vals = Object.values(obj);
        return vals[0];
      }
    `;
    expect(await run(src, "test")).toBe("hello");
  });

  it("works with mixed number and string values", async () => {
    const src = `
      export function test(): number {
        const obj = { name: "alice", age: 30 };
        const vals = Object.values(obj);
        return vals.length;
      }
    `;
    expect(await run(src, "test")).toBe(2);
  });

  it("works with boolean values", async () => {
    const src = `
      export function test(): number {
        const obj = { a: true, b: false, c: true };
        const vals = Object.values(obj);
        return vals.length;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("values from interface-typed object are correct", async () => {
    const src = `
      interface Config { width: number; height: number; depth: number }
      export function test(): number {
        const c: Config = { width: 10, height: 20, depth: 30 };
        const vals = Object.values(c);
        return vals[0] + vals[1] + vals[2];
      }
    `;
    expect(await run(src, "test")).toBe(60);
  });

  it("ref field values are correctly boxed", async () => {
    const src = `
      export function test(): string {
        const obj = { x: "hello", y: "world" };
        const vals = Object.values(obj);
        return vals[1];
      }
    `;
    expect(await run(src, "test")).toBe("world");
  });
});

describe("Object.entries extended (#355)", () => {
  it("entries length is correct for multi-field object", async () => {
    const src = `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3, d: 4 };
        return Object.entries(obj).length;
      }
    `;
    expect(await run(src, "test")).toBe(4);
  });

  it("entries key ordering matches insertion order", async () => {
    const src = `
      export function test(): string {
        const obj = { z: 1, a: 2, m: 3 };
        const entries = Object.entries(obj);
        return entries[0][0] + entries[1][0] + entries[2][0];
      }
    `;
    expect(await run(src, "test")).toBe("zam");
  });

  it("entries work with interface type", async () => {
    const src = `
      interface Pair { first: number; second: number }
      export function test(): number {
        const p: Pair = { first: 10, second: 20 };
        const entries = Object.entries(p);
        return entries[0][1] + entries[1][1];
      }
    `;
    expect(await run(src, "test")).toBe(30);
  });

  it("entries work with string values", async () => {
    const src = `
      export function test(): string {
        const obj = { x: "hello", y: "world" };
        const entries = Object.entries(obj);
        return entries[0][1];
      }
    `;
    expect(await run(src, "test")).toBe("hello");
  });

  it("entries work with mixed types", async () => {
    const src = `
      export function test(): number {
        const obj = { name: "test", value: 42 };
        const entries = Object.entries(obj);
        return entries.length;
      }
    `;
    expect(await run(src, "test")).toBe(2);
  });

  it("entries second element value correct", async () => {
    const src = `
      export function test(): number {
        const obj = { a: 100, b: 200, c: 300 };
        const entries = Object.entries(obj);
        return entries[1][1];
      }
    `;
    expect(await run(src, "test")).toBe(200);
  });
});

describe("Object.keys/values/entries with for-of (#355)", () => {
  it("for-of over Object.keys", async () => {
    const src = `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        let count = 0;
        for (const key of Object.keys(obj)) {
          count++;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("for-of over Object.values summing", async () => {
    const src = `
      export function test(): number {
        const obj = { x: 10, y: 20, z: 30 };
        let sum = 0;
        for (const val of Object.values(obj)) {
          sum += val;
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(60);
  });
});
