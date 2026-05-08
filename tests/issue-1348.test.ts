/**
 * #1348 — for-of IteratorClose on abrupt body completion (return path).
 *
 * Spec §14.7.5 requires `IteratorClose(iterator, abrupt)` to be called
 * when a for-of body throws / breaks / continues / returns to a label
 * outside the loop.  Most paths were already wired in #851; this issue
 * fixes the `return` path inside a *void* IIFE, where the IIFE body was
 * being inlined into the caller without wrapping its body in a block.
 * That meant `return;` inside the IIFE became a Wasm `return` from the
 * enclosing function, skipping the rest of the test (and the
 * post-IIFE asserts that check `returnCount === 1`).
 *
 * Repro shape (lifted from
 * `test262/test/language/statements/for-of/iterator-close-via-return.js`):
 *
 *   (function () {
 *     for (var x of iterable) { iterationCount += 1; return; }
 *   }());
 *   // post-IIFE asserts must still run
 *
 * Fix lives in `src/codegen/expressions/calls.ts` (void-IIFE inlining).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runWasm(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts", allowJs: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const importResult = buildImports(r.imports, undefined, r.stringPool, { globalSandbox: {} });
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  if (typeof importResult.setExports === "function") {
    importResult.setExports(instance.exports as any);
  }
  return (instance.exports as any).test();
}

describe("#1348 — void IIFE return", () => {
  it("return inside void IIFE exits ONLY the IIFE, not the caller", async () => {
    // The IIFE returns void; its `return;` must not leak through to the
    // outer function. Without the fix, this returned 0 instead of 42.
    const src = `
      export function test(): number {
        let sentinel: number = 0;
        (function (): void {
          for (let i: number = 0; i < 1; i++) {
            sentinel = 1;
            return;
          }
          sentinel = 99;
        }());
        if (sentinel !== 1) return -1;
        return 42;
      }
    `;
    expect(await runWasm(src)).toBe(42);
  });

  it("return inside void IIFE inside for-of preserves post-IIFE statements", async () => {
    // Mirrors iterator-close-via-return.js (without host iterables).
    const src = `
      export function test(): number {
        let iterCount: number = 0;
        let postIife: number = 0;
        (function (): void {
          for (let i: number = 0; i < 5; i++) {
            iterCount = iterCount + 1;
            return;
          }
        }());
        postIife = 1;
        if (iterCount !== 1) return -1;
        if (postIife !== 1) return -2;
        return 1;
      }
    `;
    expect(await runWasm(src)).toBe(1);
  });

  it("bare return in void IIFE — no expression — falls through to post-IIFE code", async () => {
    const src = `
      export function test(): number {
        let after: number = 0;
        (function (): void {
          return;
        }());
        after = 1;
        return after;
      }
    `;
    expect(await runWasm(src)).toBe(1);
  });

  it("nested void IIFEs — inner return only exits inner", async () => {
    const src = `
      export function test(): number {
        let outerRan: number = 0;
        let innerRan: number = 0;
        (function (): void {
          (function (): void {
            innerRan = 1;
            return;
          }());
          outerRan = 1;
        }());
        if (innerRan !== 1) return -1;
        if (outerRan !== 1) return -2;
        return 7;
      }
    `;
    expect(await runWasm(src)).toBe(7);
  });

  it("void arrow IIFE — return; exits only the arrow", async () => {
    const src = `
      export function test(): number {
        let x: number = 0;
        ((): void => {
          for (let i: number = 0; i < 3; i++) {
            x = i + 1;
            return;
          }
          x = 999;
        })();
        return x;
      }
    `;
    // Inner return after first iteration → x === 1, post-arrow code in outer
    // function runs normally (no-op here since the return is the last statement).
    expect(await runWasm(src)).toBe(1);
  });
});
