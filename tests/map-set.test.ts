import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, jsApi, domApi } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const imports = buildImports(result.stringPool, jsApi, domApi);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("Map collection", () => {
  it("creates a Map and sets/gets values", async () => {
    const src = `
      export function test(): number {
        const m = new Map<string, number>();
        m.set("a", 10);
        m.set("b", 20);
        return m.get("b");
      }
    `;
    expect(await run(src, "test")).toBe(20);
  });

  it("Map.has returns boolean", async () => {
    const src = `
      export function test(): boolean {
        const m = new Map<string, number>();
        m.set("x", 42);
        return m.has("x");
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("Map.has returns false for missing key", async () => {
    const src = `
      export function test(): boolean {
        const m = new Map<string, number>();
        return m.has("missing");
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("Map.delete removes entry", async () => {
    const src = `
      export function test(): boolean {
        const m = new Map<string, number>();
        m.set("k", 1);
        m.delete("k");
        return m.has("k");
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("Map.size returns count", async () => {
    const src = `
      export function test(): number {
        const m = new Map<string, number>();
        m.set("a", 1);
        m.set("b", 2);
        m.set("c", 3);
        return m.size;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("Map.clear empties the map", async () => {
    const src = `
      export function test(): number {
        const m = new Map<string, number>();
        m.set("a", 1);
        m.set("b", 2);
        m.clear();
        return m.size;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("Map overwrite existing key", async () => {
    const src = `
      export function test(): number {
        const m = new Map<string, number>();
        m.set("key", 10);
        m.set("key", 99);
        return m.get("key");
      }
    `;
    expect(await run(src, "test")).toBe(99);
  });

  it("Map used as function parameter and return", async () => {
    const src = `
      function addEntry(m: Map<string, number>, k: string, v: number): void {
        m.set(k, v);
      }
      function getEntry(m: Map<string, number>, k: string): number {
        return m.get(k);
      }
      export function test(): number {
        const m = new Map<string, number>();
        addEntry(m, "x", 42);
        return getEntry(m, "x");
      }
    `;
    expect(await run(src, "test")).toBe(42);
  });

  it("Map.delete returns boolean", async () => {
    const src = `
      export function test(): boolean {
        const m = new Map<string, number>();
        m.set("a", 1);
        return m.delete("a");
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("multiple Map instances are independent", async () => {
    const src = `
      export function test(): number {
        const m1 = new Map<string, number>();
        const m2 = new Map<string, number>();
        m1.set("a", 10);
        m2.set("a", 20);
        return m1.get("a") + m2.get("a");
      }
    `;
    expect(await run(src, "test")).toBe(30);
  });
});

describe("Set collection", () => {
  it("creates a Set and adds values", async () => {
    const src = `
      export function test(): boolean {
        const s = new Set<number>();
        s.add(42);
        return s.has(42);
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("Set.has returns false for missing value", async () => {
    const src = `
      export function test(): boolean {
        const s = new Set<string>();
        s.add("hello");
        return s.has("world");
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("Set.delete removes value", async () => {
    const src = `
      export function test(): boolean {
        const s = new Set<number>();
        s.add(10);
        s.delete(10);
        return s.has(10);
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("Set.size returns count", async () => {
    const src = `
      export function test(): number {
        const s = new Set<number>();
        s.add(1);
        s.add(2);
        s.add(3);
        s.add(2); // duplicate, should not increase size
        return s.size;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("Set.clear empties the set", async () => {
    const src = `
      export function test(): number {
        const s = new Set<number>();
        s.add(1);
        s.add(2);
        s.clear();
        return s.size;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("Set.delete returns boolean", async () => {
    const src = `
      export function test(): boolean {
        const s = new Set<number>();
        s.add(5);
        return s.delete(5);
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("Set used as function parameter", async () => {
    const src = `
      function populate(s: Set<number>): void {
        s.add(10);
        s.add(20);
        s.add(30);
      }
      export function test(): number {
        const s = new Set<number>();
        populate(s);
        return s.size;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("Set with string values", async () => {
    const src = `
      export function test(): boolean {
        const s = new Set<string>();
        s.add("hello");
        s.add("world");
        return s.has("hello");
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("multiple Set instances are independent", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        const s2 = new Set<number>();
        s1.add(1);
        s1.add(2);
        s2.add(10);
        return s1.size + s2.size;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });
});
