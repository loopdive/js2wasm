/**
 * Issue #457: WeakMap/WeakSet support via host imports
 *
 * Tests that new WeakMap() / new WeakSet() and their methods (set, get, has,
 * delete, add) compile and execute correctly through the extern_class import
 * mechanism.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`Compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("WeakMap support (#457)", () => {
  it("should create a WeakMap and use set/get", async () => {
    const result = await run(`
      const obj: any = {};
      const wm = new WeakMap();
      wm.set(obj, 42);
      export function test(): number {
        const val: number = wm.get(obj);
        return val === 42 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("should support WeakMap.has and delete", async () => {
    const result = await run(`
      const obj: any = {};
      const wm = new WeakMap();
      wm.set(obj, 99);
      export function test(): number {
        if (!wm.has(obj)) return 0;
        wm.delete(obj);
        if (wm.has(obj)) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("should support WeakMap with multiple keys", async () => {
    const result = await run(`
      const a: any = {};
      const b: any = {};
      const wm = new WeakMap();
      wm.set(a, 10);
      wm.set(b, 20);
      export function test(): number {
        const va: number = wm.get(a);
        const vb: number = wm.get(b);
        return va + vb === 30 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("WeakSet support (#457)", () => {
  it("should create a WeakSet and use add/has", async () => {
    const result = await run(`
      const obj: any = {};
      const ws = new WeakSet();
      ws.add(obj);
      export function test(): number {
        return ws.has(obj) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("should support WeakSet.delete", async () => {
    const result = await run(`
      const obj: any = {};
      const ws = new WeakSet();
      ws.add(obj);
      export function test(): number {
        if (!ws.has(obj)) return 0;
        ws.delete(obj);
        if (ws.has(obj)) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("should support WeakSet with multiple values", async () => {
    const result = await run(`
      const a: any = {};
      const b: any = {};
      const c: any = {};
      const ws = new WeakSet();
      ws.add(a);
      ws.add(b);
      export function test(): number {
        if (!ws.has(a)) return 0;
        if (!ws.has(b)) return 0;
        if (ws.has(c)) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });
});

describe("Map/Set support (lib fix)", () => {
  it("should compile and run Map operations", async () => {
    const result = await run(`
      const m = new Map();
      m.set("x", 1);
      export function test(): number {
        const val: number = m.get("x");
        return val === 1 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("should compile and run Set operations", async () => {
    const result = await run(`
      const s = new Set();
      s.add(42);
      export function test(): number {
        return s.has(42) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});
