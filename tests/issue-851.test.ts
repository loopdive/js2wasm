import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { readFileSync } from "fs";
import { parseMeta, wrapTest } from "./test262-runner.ts";
import { buildImports } from "../src/runtime.ts";

/** Run a test262 for-of iterator-close test, return 1 for pass. */
async function runCloseTest(filename: string): Promise<number | string> {
  const src = readFileSync("/workspace/test262/test/language/statements/for-of/" + filename, "utf-8");
  const meta = parseMeta(src);
  const { source: w } = wrapTest(src, meta);
  const r = compile(w, { fileName: "test.ts" });
  if (!r.success) return "CE:" + r.errors[0]?.message;
  const imports = buildImports(r.imports, undefined, r.stringPool);
  try {
    const mod = await WebAssembly.instantiate(r.binary, imports);
    if (imports.setExports) imports.setExports(mod.instance.exports as any);
    return (mod.instance.exports as any).test?.() ?? -999;
  } catch (e: any) {
    return "ERR:" + e.message;
  }
}

/**
 * #851: Iterator close protocol — for-of should call iterator.return() on abrupt completion.
 *
 * Root causes fixed:
 * 1. getArrTypeIdxFromVec false-positive: closure structs misidentified as vec structs
 *    → __make_iterable converted next() closure to [] → iterator.next calls failed
 * 2. __call_fn_0 funcref dispatch: struct-type dispatch caused illegal cast via V8 type canonicalization
 * 3. try+finallyStack: compileForOfIterator now wraps block/loop in try/catch_all and uses
 *    finallyStack to inline iterator.return() on return/outer-break/outer-continue
 */
describe("iterator close protocol (#851)", () => {
  it("via break: iterator.return() called after break", async () => {
    expect(await runCloseTest("iterator-close-via-break.js")).toBe(1);
  });

  it("via continue (labeled outer loop): iterator.return() called", async () => {
    expect(await runCloseTest("iterator-close-via-continue.js")).toBe(1);
  });

  it("via throw: iterator.return() called when loop body throws", async () => {
    expect(await runCloseTest("iterator-close-via-throw.js")).toBe(1);
  });

  it("getArrTypeIdxFromVec: vec detection requires actual Wasm array element type", async () => {
    // Before fix: closure structs were falsely identified as vec structs because
    // both have field[1] of type ref_null. Fix: verify field[1] points to array type.
    // Use locals inside test() to match wrapTest pattern (module-level vars are separate issue)
    const code = `
export function test(): number {
  var startedCount = 0;
  var returnCount = 0;
  var iterable: any = {};

  (iterable as any)[Symbol.iterator] = function() {
    return {
      next: function() {
        startedCount += 1;
        return { done: false, value: null };
      },
      return: function() {
        returnCount += 1;
        return {};
      }
    };
  };

  for (var x of iterable) {
    if (startedCount !== 1) return -1;
    if (returnCount !== 0) return -2;
    break;
  }
  if (startedCount !== 1) return -3;
  if (returnCount !== 1) return -5;
  return 1;
}
`;
    const r = compile(code, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const mod = await WebAssembly.instantiate(r.binary!, imports);
    if (imports.setExports) imports.setExports(mod.instance.exports as any);
    expect((mod.instance.exports as any).test?.()).toBe(1);
  });

  it("more iterator-close tests: majority should pass", async () => {
    const tests = ["iterator-close-via-break.js", "iterator-close-via-continue.js", "iterator-close-via-throw.js"];
    let pass = 0;
    for (const t of tests) {
      const ret = await runCloseTest(t);
      if (ret === 1) pass++;
      else console.log("FAIL (" + ret + "): " + t);
    }
    expect(pass).toBe(3);
  });
});
