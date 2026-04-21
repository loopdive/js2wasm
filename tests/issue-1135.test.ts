// Issue #1135: rest-destructuring of Wasm-constructed arrays after setExports.
// See plan/issues/ready/1135.md for the root cause.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(code: string, opts: { skipSemanticDiagnostics?: boolean } = {}): Promise<number> {
  const r = compile(code, { fileName: "t.ts", ...opts });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  const ret = (instance.exports as { main: () => unknown }).main();
  return Number(ret);
}

describe("#1135 rest-destructuring survives setExports", () => {
  it("simple [...r] after setExports", async () => {
    const code = `function f([...r]) { return r.length; } export function main() { return f([1,2,3]); }`;
    expect(await run(code)).toBe(3);
  });

  it("[a,b,...r] after setExports", async () => {
    const code = `function f([a,b,...r]) { return a + b + r.length; } export function main() { return f([10,20,1,2,3]); }`;
    expect(await run(code)).toBe(33);
  });

  it("regression guard: plain array param still works", async () => {
    const code = `function f(a: number[]) { return a.length; } export function main() { return f([1,2,3]); }`;
    expect(await run(code)).toBe(3);
  });

  it("regression guard: new Map from literal entries", async () => {
    const code = `export function main() { const m = new Map([["a", 1], ["b", 2]]); return m.size; }`;
    expect(await run(code)).toBe(2);
  });

  it("regression guard: for-of over vec literal", async () => {
    const code = `export function main() { let s = 0; for (const x of [1,2,3]) s += x; return s; }`;
    expect(await run(code)).toBe(6);
  });

  it("iter-val-err: a throwing next() propagates out of rest-destructure", async () => {
    // ES §8.5.3 IteratorBindingInitialization — a throwing iterator must propagate
    // out of the rest-destructure fallback path (buildVecFromExternref). Tests
    // language/**/dstr/ary-ptrn-rest-id-iter-val-err.js enforce throw-forwarding
    // on the .value getter; here we use a throwing next() which exercises the
    // same Array.from(iterable) → iterator-protocol path that __array_from uses.
    const code = `
      class Iter {
        [Symbol.iterator]() { return this; }
        next(): { value: number; done: boolean } { throw new Error("ITER_THROW"); }
      }
      function f([...x]: number[]): number { return x.length; }
      export function main(): number {
        try { f(new Iter() as any); return 0; }
        catch (e: any) { return 1; }
      }
    `;
    expect(await run(code)).toBe(1);
  });
});
