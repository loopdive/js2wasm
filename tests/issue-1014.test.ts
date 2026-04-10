import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#1014 — async generator .next() returns Promise", () => {
  async function run(src: string): Promise<any> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as any).test?.();
  }

  it("async generator .next() returns a Promise", async () => {
    const ret = await run(`
      async function* gen() { yield 42; }
      export function test(): number {
        const g = gen();
        const result = g.next();
        return typeof (result as any).then === 'function' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("async generator .next() Promise resolves with {value, done}", async () => {
    const ret = await run(`
      async function* gen() { yield 42; }
      export function test(): number {
        const g = gen();
        const result = g.next();
        // The result should be a Promise — return 1 if it has .then
        if (typeof (result as any).then !== 'function') return 0;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("async generator with multiple yields — each .next() returns Promise", async () => {
    const ret = await run(`
      async function* gen() {
        yield 1;
        yield 2;
        yield 3;
      }
      export function test(): number {
        const g = gen();
        const r1 = g.next();
        const r2 = g.next();
        const r3 = g.next();
        const r4 = g.next();
        if (typeof (r1 as any).then !== 'function') return 0;
        if (typeof (r2 as any).then !== 'function') return 0;
        if (typeof (r3 as any).then !== 'function') return 0;
        if (typeof (r4 as any).then !== 'function') return 0;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("class async generator method .next() returns Promise", async () => {
    const ret = await run(`
      class C {
        async *gen() {
          yield 1;
          yield 2;
        }
      }
      export function test(): number {
        const c = new C();
        const g = c.gen();
        const result = g.next();
        return typeof (result as any).then === 'function' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("inline async generator function expression .next() returns Promise", async () => {
    const ret = await run(`
      export function test(): number {
        const gen = async function*() { yield 42; };
        const g = gen();
        const result = g.next();
        return typeof (result as any).then === 'function' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("async generator result has .done and .value properties (no-op await pattern)", async () => {
    const ret = await run(`
      async function* gen() { yield 42; }
      export function test(): number {
        const g = gen();
        const r1 = g.next() as any;
        // Must have .then (for Promise chaining) AND .done/.value (for no-op await)
        if (typeof r1.then !== 'function') return 0;
        if (r1.done !== false) return 0;
        if (r1.value !== 42) return 0;
        const t = (g as any).throw(new Error("x")); // marks generator done
        if (t && typeof t.then === "function") t.then(null, () => {}); // suppress unhandled rejection
        const r2 = g.next() as any;
        if (typeof r2.then !== 'function') return 0;
        if (r2.done !== true) return 0;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("sync generator .next() still returns plain object (no regression)", async () => {
    const ret = await run(`
      function* gen() { yield 1; yield 2; }
      export function test(): number {
        const g = gen();
        const r1 = g.next();
        const r2 = g.next();
        const r3 = g.next();
        // sync: r.then should NOT be a function (plain object)
        if (typeof (r1 as any).then === 'function') return 0; // regression!
        if (r1.value !== 1 || r1.done !== false) return 0;
        if (r2.value !== 2 || r2.done !== false) return 0;
        if (r3.done !== true) return 0;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });
});
