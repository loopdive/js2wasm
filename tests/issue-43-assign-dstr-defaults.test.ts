/**
 * #43 — Assignment destructuring (`{ x = 1 } = vals`) with defaults on
 * an externref / `any`-typed source previously skipped the binding
 * extraction entirely, leaving the target identifier at its initial
 * zero/null value:
 *
 *   var x;
 *   var vals = {};
 *   ({ x = 1 } = vals);
 *   // x stayed undefined/MISS instead of becoming 1
 *
 * The "no struct fields / unknown RHS type" branch in
 * `compileDestructuringAssignment` only allocated locals for new
 * identifiers and returned the RHS value as the expression result —
 * without ever reading properties off `vals` or applying default
 * initializers. This burned ~9 of the top "assert.sameValue(x, ...) /
 * assert.sameValue(result, vals)" failures in
 * `language/expressions/assignment/dstr/`.
 *
 * Fix: read each property via `__extern_get(rhs, "name")`, then check
 * `__extern_is_undefined` to decide whether to fire the default. Per
 * §13.15.5.3 step 8 / §13.3.3.7 SingleNameBinding step 6, defaults
 * fire ONLY on `undefined`, not on `null`/`0`/`false`/`''`. Supports
 * both local-bound and module-global targets.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { wrapTest } from "./test262-runner.js";

async function runWrappedJs(jsSource: string): Promise<unknown> {
  const wrapped = wrapTest(jsSource, {} as any);
  const r = compile(wrapped.source, { fileName: "test.ts", allowJs: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(r.imports, undefined, r.stringPool, { globalSandbox: {} });
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  importResult.setExports?.(instance.exports as any);
  return (instance.exports as any).test();
}

describe("#43 — assignment destructuring defaults on externref source", () => {
  // The slice covered by this PR is the "no struct fields / unknown RHS
  // type" branch — i.e. when the TS checker sees the RHS as `any` or as
  // an empty object literal type with no resolved struct. The typed
  // path (where TS knows the struct fields up front) is a separate
  // codepath with its own bugs (defaults fire on `null` due to
  // `ref.is_null` instead of `__extern_is_undefined`, etc.) and isn't
  // touched here.
  it("test262 obj-id-init-assignment-missing.js — `{ x = 1 } = {}` fires default", async () => {
    // `var x` is a module global; the destructuring writes into it.
    const js = `
      var x;
      var result;
      var vals = {};
      result = { x = 1 } = vals;
      assert.sameValue(x, 1);
      assert.sameValue(result, vals);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("default fires only on missing properties, not on present ones", async () => {
    // `vals` is `any`-typed (no struct fields), so the no-fields branch
    // covers all four bindings. Only `x` is supplied; the others should
    // fall through to their defaults.
    const js = `
      function getVals() { return { w: 100 }; }
      var w, x, y;
      var vals = getVals();
      ({ w = 1, x = 2, y = 3 } = vals);
      assert.sameValue(w, 100);
      assert.sameValue(x, 2);
      assert.sameValue(y, 3);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });
});
