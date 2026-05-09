/**
 * #43 — Function-expression object destructuring on `any`/externref-typed
 * params previously dropped the binding extraction entirely, so the
 * destructured locals stayed at their default zero/null value:
 *
 *   const f: any = function ({ w, x }: any) { return w; };
 *   f({ w: 42, x: 99 });   // returned 0/null/undefined, not 42
 *
 * `closures.ts` only routed externref array-pattern params through
 * `destructureParamArray`; the parallel object-pattern branch was missing.
 * This affected ~64 test262 tests in
 * `language/expressions/{function,async-generator,object}/dstr/` whose
 * harness wraps generic `function ({...})` test bodies, plus the
 * `*-init-skipped` family that verifies defaults DON'T fire when a
 * non-undefined value (e.g. `null`, `0`, `false`) is supplied.
 *
 * Tests use the test262-style harness (wrapTest) because untyped `f({...})`
 * calls go through a separate (pre-existing) any-call path that traps with
 * "illegal cast" — unrelated to the dstr fix. The test262 wrap routes the
 * call through assert harness functions that side-step that bug.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { wrapTest } from "./test262-runner.js";

async function runWrappedJs(jsSource: string): Promise<unknown> {
  const wrapped = wrapTest(jsSource, {} as any);
  const r = compile(wrapped.source, { fileName: "test.ts", allowJs: true });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message ?? "?"}`);
  const importResult = buildImports(r.imports, undefined, r.stringPool, { globalSandbox: {} });
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  importResult.setExports?.(instance.exports as any);
  return (instance.exports as any).test();
}

describe("#43 — function expression with object destructuring on `any` param", () => {
  it("extracts a single named property from a JS-passed object", async () => {
    // `var f` mirrors the test262 default/func-expr template.
    const js = `
      var captured = 999;
      var f = function ({ w }) { captured = w; };
      f({ w: 42, x: 99 });
      assert.sameValue(captured, 42);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("extracts multiple named properties", async () => {
    const js = `
      var cw = 0, cx = 0;
      var f = function ({ w, x }) { cw = w; cx = x; };
      f({ w: 1, x: 2 });
      assert.sameValue(cw, 1);
      assert.sameValue(cx, 2);
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("test262 dstr/obj-ptrn-id-init-skipped.js (function-expression form) passes", async () => {
    // Direct copy of the test262 default/func-expr.template body. Pre-fix
    // this returned 2 (assert #1 failed: w !== null). After the fix the
    // closure body actually extracts properties and matches the spec
    // semantics — the default `counter()` doesn't fire when `null` is
    // explicitly supplied (per §13.3.3.7 SingleNameBinding step 6: only
    // `undefined` triggers the initializer).
    const js = `
      var initCount = 0;
      function counter() {
        initCount += 1;
      }
      var callCount = 0;
      var f;
      f = function({ w = counter(), x = counter(), y = counter(), z = counter() }) {
        assert.sameValue(w, null);
        assert.sameValue(x, 0);
        assert.sameValue(y, false);
        assert.sameValue(z, '');
        assert.sameValue(initCount, 0);
        callCount = callCount + 1;
      };
      f({ w: null, x: 0, y: false, z: '' });
      assert.sameValue(callCount, 1, 'function invoked exactly once');
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });

  it("renamed property binding works (`{ w: alias }`)", async () => {
    const js = `
      var f = function ({ w: alias }) {
        assert.sameValue(alias, 7);
      };
      f({ w: 7 });
    `;
    expect(await runWrappedJs(js)).toBe(1);
  });
});
