/**
 * #1260 — Destructuring null/undefined must throw TypeError per
 * ECMA-262 §13.15.5.5 (RequireObjectCoercible) / §8.4.2 (GetIterator).
 *
 * Two bugs were fixed in `src/codegen/expressions/assignment.ts`:
 *
 * 1. `emitObjectDestructureFromLocal` (typed-array path) — when the source
 *    of an object destructure is a struct field statically typed `ref T`
 *    (non-nullable), the runtime value can still be null (e.g.
 *    `[{x}] = [null]` types the inner element as `ref null T` but the
 *    static field type may be widened to `ref`). Pre-fix, the null guard
 *    was gated on `srcType.kind === "ref_null"` and silently skipped for
 *    `ref`, causing struct.get on a null reference and a Wasm null_deref
 *    instead of the spec-required TypeError. The fix widens the local to
 *    nullable and always emits the guard for non-empty patterns.
 *
 * 2. `compileDestructuringAssignment` no-struct fallback — when the RHS
 *    is externref (e.g. `({x} = anyExpr)`) and the type-checker can't
 *    resolve a struct, the fallback only checked `ref.is_null` and
 *    silently allowed JS undefined sentinels through. The fix routes
 *    through `emitExternrefAssignDestructureGuard` which checks BOTH
 *    `ref.is_null` AND `__extern_is_undefined`.
 *
 * The test262 case `array-elem-nested-obj-null.js` (assignment expression
 * variant) now passes — previously failed with `dereferencing a null
 * pointer` instead of TypeError.
 *
 * Out-of-scope (deferred follow-ups identified during this PR):
 * - `emitNestedBindingDefault` cannot distinguish null from undefined in
 *   ref/ref_null struct-field encoding, so `function f({w: {x} = D})`
 *   called with `{w: null}` incorrectly applies the default instead of
 *   throwing. Requires runtime undefined-vs-null distinction.
 * - `for ({x: [x]} of [{x: undefined}])` — the typed-struct for-of path
 *   doesn't dispatch on nested array/object property targets.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<{ exports: Record<string, Function> }> {
  const result = compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as any, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as any);
  if (typeof (importResult as any).setExports === "function") {
    (importResult as any).setExports(inst.instance.exports as any);
  }
  return { exports: inst.instance.exports as Record<string, Function> };
}

describe("Issue #1260 — destructuring null/undefined throws TypeError", () => {
  it("[{x}] = [null] throws TypeError (typed-array nested object)", async () => {
    // test262: language/expressions/assignment/dstr/array-elem-nested-obj-null.js
    // Pre-fix: dereferencing a null pointer (Wasm trap, not TypeError).
    const { exports } = await run(`
      export function test(): number {
        let x: any;
        try { [{x}] = [null]; return 0; } catch (e) { return 1; }
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("[{x}] = [null] explicit any[] (externref path) throws", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: any;
        let arr: any[] = [null];
        try { [{x}] = arr; return 0; } catch (e) { return 1; }
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("[[a]] = [null] throws TypeError (regression: still works)", async () => {
    // test262: language/expressions/assignment/dstr/array-elem-nested-array-null.js
    const { exports } = await run(`
      export function test(): number {
        let a: any;
        try { [[a]] = [null]; return 0; } catch (e) { return 1; }
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("[[_]] = [,] (sparse hole) throws TypeError", async () => {
    // test262: language/expressions/assignment/dstr/array-elem-nested-array-undefined-hole.js
    const { exports } = await run(`
      export function test(): number {
        let _: any;
        try { [[_]] = [,]; return 0; } catch (e) { return 1; }
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("({x: [x]} = {x: undefined}) throws TypeError (object source extracts undefined)", async () => {
    // test262: language/expressions/assignment/dstr/obj-prop-nested-array-undefined-own.js
    const { exports } = await run(`
      export function test(): number {
        let x: any;
        try { ({ x: [x] } = { x: undefined }); return 0; } catch (e) { return 1; }
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("non-null sources still destructure normally (regression sanity)", async () => {
    const { exports } = await run(`
      export function test(): number {
        let a: any;
        let b: any;
        [a, b] = [10, 20];
        if (a !== 10 || b !== 20) return 0;
        let c: any;
        ({ x: c } = { x: 42 });
        return c === 42 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("nested non-null sources destructure correctly (regression sanity)", async () => {
    const { exports } = await run(`
      export function test(): number {
        let a: any, b: any;
        [{x: a}, {y: b}] = [{x: 1}, {y: 2}];
        return a === 1 && b === 2 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });
});
