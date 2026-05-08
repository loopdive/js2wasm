// #1367 — Iterator.prototype helpers: bridge to host Iterator.prototype.
//
// Synthesized iterators (vec/array fallback in __iterator and generator
// objects in __create_generator) now inherit from `Iterator.prototype`, so
// helpers like .drop, .take, .map, .filter, .some, .every, .find, .reduce,
// .toArray, .forEach, .flatMap dispatch to the host engine's spec-compliant
// implementations — including AlreadyCalled / IteratorClose / non-
// constructible / argument-validation invariants.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(src: string): Promise<WebAssembly.Exports> {
  const r = compile(src);
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const m = await WebAssembly.instantiate(r.binary, imports);
  const setExports = (imports as any).setExports;
  if (typeof setExports === "function") setExports(m.instance.exports);
  return m.instance.exports;
}

describe("#1367 — Iterator helpers via Iterator.prototype bridge", () => {
  it("array-iterator drop(2) drops first 2 elements", async () => {
    const ex = await instantiate(`
      export function main(): number {
        const arr = [1, 2, 3, 4, 5] as any[];
        const it = arr[Symbol.iterator]();
        const dropped = (it as any).drop(2);
        let count = 0;
        for (const _ of dropped) count++;
        return count;
      }
    `);
    expect((ex.main as () => number)()).toBe(3);
  });

  it("generator drop(2) drops first 2 elements", async () => {
    const ex = await instantiate(`
      function* g(): Generator<number> {
        yield 1; yield 2; yield 3; yield 4; yield 5;
      }
      export function main(): number {
        const it = g() as any;
        const dropped = it.drop(2);
        let count = 0;
        for (const _ of dropped) count++;
        return count;
      }
    `);
    expect((ex.main as () => number)()).toBe(3);
  });

  it("array-iterator take(-1) throws RangeError (spec arg validation)", async () => {
    const ex = await instantiate(`
      export function main(): number {
        const arr = [1, 2, 3] as any[];
        const it = arr[Symbol.iterator]();
        try {
          (it as any).take(-1);
          return 0;
        } catch (e: any) {
          if (e && e.constructor && e.constructor.name === "RangeError") return 1;
          return 2;
        }
      }
    `);
    expect((ex.main as () => number)()).toBe(1);
  });

  it("generator some() short-circuits on first truthy match", async () => {
    const ex = await instantiate(`
      function* g(): Generator<number> { yield 1; yield 2; yield 3; }
      export function main(): number {
        const it = g() as any;
        const result = (it as any).some((x: number) => x === 2);
        return result ? 1 : 0;
      }
    `);
    expect((ex.main as () => number)()).toBe(1);
  });

  it("generator every() returns true for all matching", async () => {
    const ex = await instantiate(`
      function* g(): Generator<number> { yield 1; yield 2; yield 3; }
      export function main(): number {
        const it = g() as any;
        const result = (it as any).every((x: number) => x > 0);
        return result ? 1 : 0;
      }
    `);
    expect((ex.main as () => number)()).toBe(1);
  });

  it("generator find() returns first matching value", async () => {
    const ex = await instantiate(`
      function* g(): Generator<number> { yield 1; yield 2; yield 3; }
      export function main(): number {
        const it = g() as any;
        const result = (it as any).find((x: number) => x === 2);
        return result;
      }
    `);
    expect((ex.main as () => number)()).toBe(2);
  });

  it("array-iterator map() and toArray() chain", async () => {
    const ex = await instantiate(`
      export function main(): number {
        const arr = [1, 2, 3] as any[];
        const it = arr[Symbol.iterator]();
        const mapped = (it as any).map((x: number) => x * 2);
        const result = (mapped as any).toArray();
        return result.length;
      }
    `);
    expect((ex.main as () => number)()).toBe(3);
  });
});
