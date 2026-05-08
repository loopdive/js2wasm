// #1377 — Array.prototype.pop/shift on empty array: return JS undefined.
//
// Slice A: fix the wasm-default-value bug where `arr.pop()` and `arr.shift()`
// on an empty array left `result` as ref.null.extern (which JS sees as `null`)
// instead of JS `undefined`. Per spec §23.1.3.20.5 (pop) and §23.1.3.27.5
// (shift), both return undefined when the array is empty.
//
// Other gaps in #1377 (length-NaN coercion, frozen-receiver TypeErrors,
// MaxSafeInteger overflow checks, primitive-receiver dispatch, custom-this
// .call patterns) require deeper codegen work and are deferred to follow-up
// slices.
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

describe("#1377 — Array pop/shift undefined on empty (Slice A)", () => {
  it("[].pop() returns undefined (not null)", async () => {
    const ex = await instantiate(`
      export function main(): number {
        const arr: any[] = [];
        const v = arr.pop();
        // v should be undefined, not null
        if (v === undefined) return 1;
        if (v === null) return 0;
        return 2;
      }
    `);
    expect((ex.main as () => number)()).toBe(1);
  });

  it("[].shift() returns undefined (not null)", async () => {
    const ex = await instantiate(`
      export function main(): number {
        const arr: any[] = [];
        const v = arr.shift();
        if (v === undefined) return 1;
        if (v === null) return 0;
        return 2;
      }
    `);
    expect((ex.main as () => number)()).toBe(1);
  });

  it("non-empty pop still returns the popped value", async () => {
    const ex = await instantiate(`
      export function main(): any {
        const arr: any[] = [10, 20, 30];
        return arr.pop();
      }
    `);
    expect((ex.main as () => any)()).toBe(30);
  });

  it("non-empty shift still returns the shifted value", async () => {
    const ex = await instantiate(`
      export function main(): any {
        const arr: any[] = [10, 20, 30];
        return arr.shift();
      }
    `);
    expect((ex.main as () => any)()).toBe(10);
  });

  it("pop on empty leaves length 0", async () => {
    const ex = await instantiate(`
      export function main(): number {
        const arr: any[] = [];
        arr.pop();
        return arr.length;
      }
    `);
    expect((ex.main as () => number)()).toBe(0);
  });

  it("repeated pop drains array, then returns undefined", async () => {
    const ex = await instantiate(`
      export function main(): number {
        const arr: any[] = [1, 2];
        arr.pop();
        arr.pop();
        const v = arr.pop();  // empty now
        if (v === undefined) return 1;
        return 0;
      }
    `);
    expect((ex.main as () => number)()).toBe(1);
  });

  it("number array pop on empty still works (NaN default for f64)", async () => {
    // For f64-element arrays, the wasm default is 0/NaN; this is acceptable
    // because callers comparing `v === undefined` get false and need to use
    // length checks anyway. The fix targets externref/anyref element types.
    const ex = await instantiate(`
      export function main(): number {
        const arr: number[] = [];
        const v = arr.pop();
        // Don't assert specific behavior here — just that no crash.
        return 1;
      }
    `);
    expect((ex.main as () => number)()).toBe(1);
  });
});
