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
 * Even with correct scope handling, a closure inside a `for (var i = 0;...)`
 * loop — without an inner `var i` shadowing — still legitimately captures
 * the outer `i` as mutable. Boxing the loop variable mid-iteration created
 * the same split-lifetime infinite loop: the for-condition `local.get i`
 * was emitted before the closure-creation site (test262
 * `Array/prototype/toSorted/comparefn-not-a-function.js` hit
 * compile_timeout for the same reason).
 *
 * Fix: at function entry, scan all nested closures for outer-scope variables
 * captured-as-mutable. Allocate the ref cell up front so every read and
 * write of the variable goes through the same cell from statement #1.
 */
describe("#995/#996 — closure capture analysis & pre-boxing", () => {
  async function run(src: string): Promise<unknown> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as { test?: () => unknown }).test?.();
  }

  // ── #995 — inner var shadows outer var ────────────────────────────────

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

  // ── #996 — closure inside loop without inner var ──────────────────────

  it("closure inside loop captures mutable outer var (counter terminates)", async () => {
    const ret = await run(`
      export function test(): number {
        var arr: number[] = [10, 20, 30, 40, 50];
        var sum: number = 0;
        var i: number = 0;
        for (i = 0; i < arr.length; i++) {
          var fn: (() => number) = function (): number {
            return arr[i];
          };
          sum = sum + fn();
        }
        return sum;
      }
    `);
    // 10+20+30+40+50 = 150 if loop terminates; before the pre-boxing fix,
    // this would be an infinite loop (or semantically wrong: arr[5] OOB,
    // depends on closure capture timing).
    expect(ret).toBe(150);
  });

  it("for(var i=0;...) with closure captures terminates", async () => {
    const ret = await run(`
      export function test(): number {
        var hits: number = 0;
        for (var i = 0; i < 10; i++) {
          var fn: () => void = function (): void {
            // Reads outer i — closure capture. Without pre-boxing, the
            // for-loop condition's i would never see i++'s update.
            hits = hits + i;
          };
          fn();
        }
        return hits;
      }
    `);
    // 0+1+2+...+9 = 45
    expect(ret).toBe(45);
  });

  it("two closures in loop body share the same captured outer var", async () => {
    const ret = await run(`
      export function test(): number {
        var s: number = 0;
        for (var i = 0; i < 4; i++) {
          var read: () => number = function (): number {
            return i;
          };
          var alsoRead: () => number = function (): number {
            return i + 100;
          };
          s = s + read() + alsoRead();
        }
        return s;
      }
    `);
    // i goes 0,1,2,3. each iter contributes i + (i+100) = 2i+100.
    // Sum = 0+102+104+106 + ... wait let me recompute:
    // i=0: 0 + 100 = 100; i=1: 1 + 101 = 102; i=2: 2+102 = 104; i=3: 3+103 = 106.
    // total = 100+102+104+106 = 412.
    expect(ret).toBe(412);
  });

  // ── Regression guard for the original reported pattern ────────────────

  it("loop+closure pattern from #996 (toSorted comparefn-not-a-function shape)", async () => {
    // Mirrors the test262 toSorted shape: for(var i=0;...) with two closures
    // that read invalidComparators[i]. Before the pre-box fix this hung.
    const ret = await run(`
      export function test(): number {
        var arr: number[] = [1, 2, 3, 4, 5];
        var sum: number = 0;
        for (var i = 0; i < arr.length; i++) {
          var f1: () => number = function (): number {
            return arr[i];
          };
          var f2: () => number = function (): number {
            return arr[i] * 10;
          };
          sum = sum + f1() + f2();
        }
        return sum;
      }
    `);
    // (1+10)+(2+20)+(3+30)+(4+40)+(5+50) = 11+22+33+44+55 = 165
    expect(ret).toBe(165);
  });
});
