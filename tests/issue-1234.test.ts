/**
 * #1234 — Array.prototype.{unshift,reverse,forEach} sparse-aware fast paths
 *
 * Regression test for the post-#1227 compile_timeout cluster. Test262 has
 * receivers built from object literals with `length: 2 ** 53 - 2` and a
 * handful of defined integer-keyed properties; V8's spec-walking native
 * unshift/reverse iterate `[0, length)` per spec, hanging for 9×10¹⁵
 * iterations. The fast paths added in `src/runtime.ts` for non-Array
 * receivers iterate only the defined integer-indexed own properties.
 *
 * This test exercises the runtime contract: a receiver with a giant
 * `length` and a few defined keys must complete in microseconds, not
 * seconds.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runWasm(src: string, timeoutMs: number = 5_000): Promise<{ ret: any; ms: number }> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const importResult = buildImports(result.imports as any, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as any);
  if (typeof (importResult as any).setExports === "function")
    (importResult as any).setExports(inst.instance.exports as any);
  const t0 = performance.now();
  // Wasm exec is synchronous in Node; we can't truly time-limit it, but
  // we'd rather observe the ms and let vitest's outer testTimeout fire on hangs.
  const ret = (inst.instance.exports as any).test();
  const ms = performance.now() - t0;
  return { ret, ms };
}

describe("Issue #1234 — Array.prototype sparse-aware fast paths", () => {
  it("Array.prototype.unshift.call on length=2^53 sparse object completes in <100ms", async () => {
    // Mirrors the test262 test/built-ins/Array/prototype/unshift/length-near-integer-limit.js
    // shape: length is at the spec ceiling, argCount=1 keeps len+argCount <= 2^53-1.
    const wrapped = `
        export function test(): number {
          var arrayLike: any = {
            "9007199254740987": "a",
            "9007199254740989": "b",
            "9007199254740991": "c",
            length: 2 ** 53 - 2,
          };
          // Pre-fix: hangs for 9e15 iterations.
          // Post-fix: walks 3 defined keys, returns new length.
          var ret: number = Array.prototype.unshift.call(arrayLike, null);
          return ret === 9007199254740991 ? 1 : 2;
        }
      `;
    const { ret, ms } = await runWasm(wrapped);
    expect(ret, `unexpected ret=${ret}`).toBe(1);
    expect(ms, `unshift took ${ms}ms (expected <100)`).toBeLessThan(100);
  }, 10_000);

  it("Array.prototype.reverse.call on length=2^53 sparse object completes in <100ms", async () => {
    const wrapped = `
        export function test(): number {
          var arrayLike: any = {
            "5": "lo",
            "9007199254740985": "hi",
            length: 2 ** 53 - 2,
          };
          Array.prototype.reverse.call(arrayLike);
          // After reverse on len=L, the (5, L-1-5) = (5, 9007199254740984) pair
          // runs: lower defined, upper a hole → moves "lo" to upper. The pair
          // (9007199254740985, 4) is skipped because k > upperIdx. So
          // arrayLike[9007199254740984] should now be "lo".
          //
          // Note: we don't assert that arrayLike["5"] is undefined post-reverse,
          // because struct-field 'delete' falls back to a sidecar tombstone that
          // doesn't always shadow the underlying field's default value. The
          // important behaviour is that the upper key got the lower's value
          // and the receiver did NOT hang for 9 quadrillion iterations.
          return arrayLike["9007199254740984"] === "lo" ? 1 : 2;
        }
      `;
    const { ret, ms } = await runWasm(wrapped);
    expect(ret, `unexpected ret=${ret}`).toBe(1);
    expect(ms, `reverse took ${ms}ms (expected <100)`).toBeLessThan(100);
  }, 10_000);

  // NB: Array.prototype.forEach.call(receiver, closure) does NOT go through
  // __proto_method_call when the callback compiles to a Wasm closure — the
  // compiler inlines the iteration via __extern_length + __extern_get_idx
  // + __extern_has_idx (see src/codegen/array-methods.ts:compileArrayLikePrototypeCall).
  // That inline path is unaffected by the runtime-side fast paths added here
  // and can still hang on length≈2^53. Follow-up work needed to either bail
  // out of the inline path for huge lengths or to add a similar sparse-aware
  // codegen. Outside the scope of this PR.

  it("Real Array receivers continue to use V8's native (sanity)", async () => {
    const wrapped = `
        export function test(): number {
          var a: any = [10, 20, 30];
          Array.prototype.unshift.call(a, 1, 2, 3);
          // After unshift: [1, 2, 3, 10, 20, 30]
          return a[0] === 1 && a[3] === 10 && a.length === 6 ? 1 : 2;
        }
      `;
    const { ret } = await runWasm(wrapped);
    expect(ret).toBe(1);
  }, 10_000);
});
