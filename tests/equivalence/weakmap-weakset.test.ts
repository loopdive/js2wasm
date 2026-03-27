import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

async function run(source: string, fn: string = "main"): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as WebAssembly.Imports,
  );
  return (instance.exports as any)[fn]();
}

describe("WeakMap equivalence", () => {
  it("WeakMap set and get", async () => {
    expect(await run(`
      export function main(): number {
        const wm = new WeakMap<object, number>();
        const key = {};
        wm.set(key, 42);
        return wm.get(key)!;
      }
    `)).toBe(42);
  });

  it("WeakMap has returns true for existing key", async () => {
    expect(await run(`
      export function main(): number {
        const wm = new WeakMap<object, number>();
        const key = {};
        wm.set(key, 10);
        return wm.has(key) ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("WeakMap has returns false for missing key", async () => {
    expect(await run(`
      export function main(): number {
        const wm = new WeakMap<object, number>();
        const key1 = {};
        const key2 = {};
        wm.set(key1, 10);
        return wm.has(key2) ? 1 : 0;
      }
    `)).toBe(0);
  });

  it("WeakMap delete removes key", async () => {
    expect(await run(`
      export function main(): number {
        const wm = new WeakMap<object, number>();
        const key = {};
        wm.set(key, 10);
        const hasBefore = wm.has(key) ? 1 : 0;
        wm.delete(key);
        const hasAfter = wm.has(key) ? 1 : 0;
        return hasBefore * 10 + hasAfter;
      }
    `)).toBe(10);
  });

  it("WeakMap set overwrites existing value", async () => {
    expect(await run(`
      export function main(): number {
        const wm = new WeakMap<object, number>();
        const key = {};
        wm.set(key, 10);
        wm.set(key, 99);
        return wm.get(key)!;
      }
    `)).toBe(99);
  });

  it("WeakMap with multiple keys", async () => {
    expect(await run(`
      export function main(): number {
        const wm = new WeakMap<object, number>();
        const k1 = {};
        const k2 = {};
        const k3 = {};
        wm.set(k1, 1);
        wm.set(k2, 2);
        wm.set(k3, 3);
        return wm.get(k1)! + wm.get(k2)! + wm.get(k3)!;
      }
    `)).toBe(6);
  });
});

describe("WeakSet equivalence", () => {
  it("WeakSet add and has", async () => {
    expect(await run(`
      export function main(): number {
        const ws = new WeakSet<object>();
        const obj = {};
        ws.add(obj);
        return ws.has(obj) ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("WeakSet has returns false for non-member", async () => {
    expect(await run(`
      export function main(): number {
        const ws = new WeakSet<object>();
        const obj1 = {};
        const obj2 = {};
        ws.add(obj1);
        return ws.has(obj2) ? 1 : 0;
      }
    `)).toBe(0);
  });

  it("WeakSet delete removes member", async () => {
    expect(await run(`
      export function main(): number {
        const ws = new WeakSet<object>();
        const obj = {};
        ws.add(obj);
        const hasBefore = ws.has(obj) ? 1 : 0;
        ws.delete(obj);
        const hasAfter = ws.has(obj) ? 1 : 0;
        return hasBefore * 10 + hasAfter;
      }
    `)).toBe(10);
  });

  it("WeakSet add is idempotent", async () => {
    expect(await run(`
      export function main(): number {
        const ws = new WeakSet<object>();
        const obj = {};
        ws.add(obj);
        ws.add(obj);
        ws.add(obj);
        return ws.has(obj) ? 1 : 0;
      }
    `)).toBe(1);
  });

  it("WeakSet with multiple objects", async () => {
    expect(await run(`
      export function main(): number {
        const ws = new WeakSet<object>();
        const a = {};
        const b = {};
        const c = {};
        ws.add(a);
        ws.add(c);
        const hasA = ws.has(a) ? 1 : 0;
        const hasB = ws.has(b) ? 1 : 0;
        const hasC = ws.has(c) ? 1 : 0;
        return hasA * 100 + hasB * 10 + hasC;
      }
    `)).toBe(101);
  });
});
