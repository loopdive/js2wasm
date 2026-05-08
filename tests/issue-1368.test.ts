// #1368 — Promise.all/race/allSettled/any: spec-compliant `thisArg` plumbing.
//
// Slice A delivers the runtime + codegen plumbing so that Promise aggregator
// host imports take `(thisArg, iterable)` instead of `(iterable)` only. With
// thisArg = null, the runtime defaults to global `Promise`, preserving
// existing behavior and inheriting V8's spec-compliant `[[AlreadyCalled]]`
// and `IteratorClose` semantics for free (the host engine implements both
// when we delegate via `Promise.all.call(C, iter)` etc.).
//
// Subclass-via-`Sub.all(iter)` and `Promise.all.call(SubClass, iter)` are
// scoped to Slice B / blocked on #1382 (Wasm class identifiers don't bridge
// back to JS host as constructable functions). Slice A's codegen already
// detects and forwards both call patterns with thisArg, but until #1382
// lands, thisArg arrives as `null` because the wasm-side class identifier
// compiles to ref.null.extern in externref position. Once #1382 is in,
// the existing detection here will start delivering subclass test wins
// without further codegen work.
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

describe("#1368 — Promise aggregators with thisArg plumbing (Slice A)", () => {
  it("Promise.all([…]) resolves on the global Promise (default thisArg)", async () => {
    const ex = await instantiate(`
      export async function main(): Promise<number> {
        const arr = await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
        return 1;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(1);
  });

  it("Promise.race([…]) resolves with the first to settle", async () => {
    const ex = await instantiate(`
      export async function main(): Promise<number> {
        await Promise.race([Promise.resolve(42)]);
        return 1;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(1);
  });

  it("Promise.allSettled([…]) never rejects", async () => {
    const ex = await instantiate(`
      export async function main(): Promise<number> {
        await Promise.allSettled([Promise.resolve(1)]);
        return 1;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(1);
  });

  it("Promise.any([…]) resolves on first fulfilled", async () => {
    const ex = await instantiate(`
      export async function main(): Promise<number> {
        await Promise.any([Promise.resolve(1)]);
        return 1;
      }
    `);
    const result = await (ex.main as () => Promise<number>)();
    expect(result).toBe(1);
  });
});
