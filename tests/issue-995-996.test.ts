import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #995 — `var` shadowing in nested function bodies must not be treated as a
 * mutable closure capture of the outer variable.
 *
 * The closure capture analysis (`collectReferencedIdentifiers` /
 * `collectWrittenIdentifiers`) walked nested function bodies blindly, adding
 * every identifier to the captures set without honouring scope. So a function
 * with `var i;` in its OWN body and a `for (i = 0; ...)` loop using that
 * inner `i` was treated as capturing — and writing to — the OUTER `i`. The
 * compiler then boxed the outer `i` into a ref cell at the FIRST CALL SITE
 * to the nested function, mid-loop. The for-loop's condition was already
 * compiled to read the unboxed local, while `i++` wrote to the new ref
 * cell — so the loop ran forever (test262
 * `String/prototype/localeCompare/15.5.4.9_CE.js` hit the 30 s
 * compile_timeout via runtime hang).
 *
 * Fix: scope-aware `collectReferencedIdentifiers` /
 * `collectWrittenIdentifiers` honour the function's own params, body `var`
 * declarations and top-level `function`/`class` declarations as shadows.
 *
 * #996 — closure-capture-loop pre-boxing.
 *
 * The remaining `for (var i = 0; ...) { fn(function() { ... i ... }); }`
 * shape (closure inside loop, no inner `var i` shadowing) still hangs
 * because lazy boxing happens AT the closure-creation site (mid-loop) and
 * the for-condition's `local.get i` was emitted earlier, reading the
 * unboxed local. A naive pre-pass (box every captured-as-mutable variable
 * up front) regressed ~329 test262 tests; a more targeted approach is
 * tracked separately. The CLOSURE-CAPTURES-OUTER-MUTABLE patterns covered
 * here continue to work via the existing lazy-boxing path.
 */
describe("#995 — closure capture analysis is scope-aware", () => {
  async function run(src: string): Promise<unknown> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as { test?: () => unknown }).test?.();
  }

  it("inner `var i` in nested function shadows outer `var i` (no infinite loop)", async () => {
    const ret = await run(`
      export function test(): number {
        var i: number;
        var sum: number = 0;
        for (i = 0; i < 5; i++) {
          sum = sum + i;
        }

        // Nested function with its own \`var i;\` — must NOT be treated as
        // capturing outer i. Before #995 fix, this caused outer i to be
        // boxed mid-loop, making the for-loop's condition stale.
        function inner(s: number): number {
          var i: number;
          var r: number = 0;
          for (i = 0; i < s; i++) {
            r = r + i;
          }
          return r;
        }
        return sum + inner(3);
      }
    `);
    // Outer loop sums 0..4 = 10. inner(3) sums 0..2 = 3. Total = 13.
    expect(ret).toBe(13);
  });

  it("nested function param shadows outer var", async () => {
    const ret = await run(`
      export function test(): number {
        var x: number = 0;
        for (x = 0; x < 4; x++) {}
        // Inner param 'x' shadows outer x — no capture of outer x.
        function dbl(x: number): number {
          return x * 2;
        }
        return x + dbl(5);
      }
    `);
    // outer x = 4, dbl(5) = 10, total = 14
    expect(ret).toBe(14);
  });

  it("deeply nested var shadows outer var (multi-level)", async () => {
    const ret = await run(`
      export function test(): number {
        var i: number = 100;
        function outer(): number {
          var i: number = 0;
          for (i = 0; i < 3; i++) {}
          return i;
        }
        return outer() + i;
      }
    `);
    expect(ret).toBe(103);
  });

  it("toU pattern from #995 (localeCompare 15.5.4.9_CE shape)", async () => {
    // Mirrors the localeCompare test: outer var i, function toU(s) with its
    // own var i, both using for-loops on i. Without scope-aware analysis,
    // outer i would be boxed mid-loop, hanging.
    const ret = await run(`
      export function test(): number {
        var pairs: string[][] = [["a", "a"], ["b", "b"], ["c", "c"]];
        var i: number;
        for (i = 0; i < pairs.length; i++) {
          var pair: string[] = pairs[i];
          if (pair[0] !== pair[1]) {
            return 2;
          }
        }
        // toU has its own var i — must not be treated as capturing outer i.
        function toU(s: string): number {
          var result: number = 0;
          var i: number;
          for (i = 0; i < s.length; i++) {
            result = result + s.charCodeAt(i);
          }
          return result;
        }
        return toU("ab") > 0 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });
});
