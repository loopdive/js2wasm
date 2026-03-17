import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../../src/runtime.js";

async function run(source: string): Promise<number> {
  const exports = await compileAndInstantiate(source);
  return (exports.main as Function)();
}

describe("Map basic operations", () => {
  it("new Map and set/get", async () => {
    const result = await run(`
      export function main(): number {
        const m = new Map<string, number>();
        m.set("a", 10);
        m.set("b", 20);
        return m.get("a")! + m.get("b")!;
      }
    `);
    expect(result).toBe(30);
  });

  it("Map has and delete", async () => {
    const result = await run(`
      export function main(): number {
        const m = new Map<string, number>();
        m.set("x", 5);
        const hasBefore = m.has("x") ? 1 : 0;
        m.delete("x");
        const hasAfter = m.has("x") ? 1 : 0;
        return hasBefore * 10 + hasAfter;
      }
    `);
    expect(result).toBe(10);
  });

  it("Map size", async () => {
    const result = await run(`
      export function main(): number {
        const m = new Map<string, number>();
        m.set("a", 1);
        m.set("b", 2);
        m.set("c", 3);
        return m.size;
      }
    `);
    expect(result).toBe(3);
  });

  it("Map clear", async () => {
    const result = await run(`
      export function main(): number {
        const m = new Map<string, number>();
        m.set("a", 1);
        m.set("b", 2);
        m.clear();
        return m.size;
      }
    `);
    expect(result).toBe(0);
  });

  it("Map overwrite existing key", async () => {
    const result = await run(`
      export function main(): number {
        const m = new Map<string, number>();
        m.set("a", 1);
        m.set("a", 42);
        return m.get("a")! + m.size;
      }
    `);
    expect(result).toBe(43); // 42 + 1
  });

  it("Map chained set calls", async () => {
    const result = await run(`
      export function main(): number {
        const m = new Map<string, number>();
        m.set("x", 10);
        m.set("y", 20);
        return m.size;
      }
    `);
    expect(result).toBe(2);
  });

  it("Map has returns false for missing key", async () => {
    const result = await run(`
      export function main(): number {
        const m = new Map<string, number>();
        m.set("a", 1);
        return m.has("missing") ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  it("Map with number keys", async () => {
    const result = await run(`
      export function main(): number {
        const m = new Map<number, number>();
        m.set(1, 100);
        m.set(2, 200);
        return m.get(1)! + m.get(2)!;
      }
    `);
    expect(result).toBe(300);
  });
});

describe("Set basic operations", () => {
  it("new Set and add/has", async () => {
    const result = await run(`
      export function main(): number {
        const s = new Set<number>();
        s.add(1);
        s.add(2);
        s.add(3);
        const has2 = s.has(2) ? 1 : 0;
        const has5 = s.has(5) ? 1 : 0;
        return has2 * 10 + has5;
      }
    `);
    expect(result).toBe(10);
  });

  it("Set delete and size", async () => {
    const result = await run(`
      export function main(): number {
        const s = new Set<number>();
        s.add(10);
        s.add(20);
        s.add(30);
        s.delete(20);
        return s.size;
      }
    `);
    expect(result).toBe(2);
  });

  it("Set clear", async () => {
    const result = await run(`
      export function main(): number {
        const s = new Set<number>();
        s.add(1);
        s.add(2);
        s.clear();
        return s.size;
      }
    `);
    expect(result).toBe(0);
  });

  it("Set deduplicates values", async () => {
    const result = await run(`
      export function main(): number {
        const s = new Set<number>();
        s.add(1);
        s.add(2);
        s.add(1);
        s.add(2);
        s.add(3);
        return s.size;
      }
    `);
    expect(result).toBe(3);
  });

  it("Set with string values", async () => {
    const result = await run(`
      export function main(): number {
        const s = new Set<string>();
        s.add("hello");
        s.add("world");
        const hasHello = s.has("hello") ? 1 : 0;
        const hasFoo = s.has("foo") ? 1 : 0;
        return hasHello * 10 + hasFoo;
      }
    `);
    expect(result).toBe(10);
  });

  it("Set delete returns boolean-like", async () => {
    const result = await run(`
      export function main(): number {
        const s = new Set<number>();
        s.add(42);
        const deleted1 = s.delete(42) ? 1 : 0;
        const deleted2 = s.delete(42) ? 1 : 0;
        return deleted1 * 10 + deleted2;
      }
    `);
    expect(result).toBe(10);
  });
});
