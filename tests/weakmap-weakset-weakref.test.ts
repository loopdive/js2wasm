import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const exports = await compileAndInstantiate(source);
  return (exports.main as Function)();
}

describe("WeakMap basic operations", () => {
  it("new WeakMap and set/get/has", async () => {
    const result = await run(`
      export function main(): number {
        const wm = new WeakMap<object, number>();
        const key = {};
        wm.set(key, 42);
        const hasIt = wm.has(key) ? 1 : 0;
        const val = wm.get(key)!;
        return hasIt * 100 + val;
      }
    `);
    expect(result).toBe(142); // 1*100 + 42
  });

  it("WeakMap delete", async () => {
    const result = await run(`
      export function main(): number {
        const wm = new WeakMap<object, number>();
        const key = {};
        wm.set(key, 10);
        const hasBefore = wm.has(key) ? 1 : 0;
        wm.delete(key);
        const hasAfter = wm.has(key) ? 1 : 0;
        return hasBefore * 10 + hasAfter;
      }
    `);
    expect(result).toBe(10);
  });
});

describe("WeakSet basic operations", () => {
  it("new WeakSet and add/has", async () => {
    const result = await run(`
      export function main(): number {
        const ws = new WeakSet<object>();
        const obj = {};
        ws.add(obj);
        return ws.has(obj) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("WeakSet delete", async () => {
    const result = await run(`
      export function main(): number {
        const ws = new WeakSet<object>();
        const obj = {};
        ws.add(obj);
        const hasBefore = ws.has(obj) ? 1 : 0;
        ws.delete(obj);
        const hasAfter = ws.has(obj) ? 1 : 0;
        return hasBefore * 10 + hasAfter;
      }
    `);
    expect(result).toBe(10);
  });
});

describe("WeakRef basic operations", () => {
  it("new WeakRef and deref", async () => {
    const result = await run(`
      export function main(): number {
        const obj = { value: 99 };
        const wr = new WeakRef(obj);
        const derefed = wr.deref();
        return derefed !== undefined ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});
