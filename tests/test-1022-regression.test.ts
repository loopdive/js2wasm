/**
 * Regression tests for the 26 regressions introduced by PR #68.
 * Tests match the actual CI regression report from 2026-04-11.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { parseMeta, wrapTest } from "../tests/test262-runner.js";
import { readFileSync } from "fs";

async function runTest262(file: string): Promise<string> {
  const src = readFileSync(file, "utf-8");
  const meta = parseMeta(src);
  const { source: w } = wrapTest(src, meta);
  try {
    const r = compile(w, { fileName: "test.ts" });
    if (!r.success) return `CE: ${r.errors[0]?.message}`;
    const importResult = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
    if (typeof (importResult as any).setExports === "function") (importResult as any).setExports(instance.exports);
    try {
      const ret = (instance.exports as any).test?.();
      return ret === 1 ? "PASS" : `FAIL (returned ${ret})`;
    } catch (e: any) {
      return `EXCEPTION: ${e.message}`;
    }
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

describe("Regression fixes for PR #68 regressions (#1022)", () => {
  // Fix A: map/filter/reduce removed from ARRAY_LIKE_METHOD_SET
  it("map timeout: map with length=Infinity falls back to __proto_method_call (Fix A)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/map/15.4.4.19-3-14.js");
    expect(r).toBe("PASS");
  });

  it("filter getter: filter falls back to __proto_method_call (Fix A)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/filter/15.4.4.20-9-c-i-30.js");
    expect(r).toBe("PASS");
  });

  it("filter call-with-boolean: filter falls back (Fix A)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/filter/call-with-boolean.js");
    expect(r).toBe("PASS");
  });

  it("map call-with-boolean: map falls back (Fix A)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/map/call-with-boolean.js");
    expect(r).toBe("PASS");
  });

  it("reduce call-with-boolean: reduce falls back (Fix A)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/reduce/call-with-boolean.js");
    expect(r).toBe("PASS");
  });

  it("reduce length-getter throws: reduce falls back (Fix A)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/reduce/15.4.4.21-5-12.js");
    expect(r).toBe("PASS");
  });

  // Fix B + D: void callback (0 params, no return) — every/some/findIndex call-with-boolean
  it("every call-with-boolean: void arrow () => {} on boolean receiver (Fix B+D)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/every/call-with-boolean.js");
    expect(r).toBe("PASS");
  });

  it("some call-with-boolean: void arrow () => {} on boolean receiver (Fix B+D)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/some/call-with-boolean.js");
    expect(r).toBe("PASS");
  });

  it("findIndex call-with-boolean: void arrow () => {} on boolean receiver (Fix B+D)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/findIndex/call-with-boolean.js");
    expect(r).toBe("PASS");
  });

  // Fix C: null/undefined receiver → fall back to __proto_method_call
  it("find return-abrupt-from-this: null receiver throws TypeError (Fix C)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/find/return-abrupt-from-this.js");
    expect(r).toBe("PASS");
  });

  it("findIndex return-abrupt-from-this: null receiver throws TypeError (Fix C)", async () => {
    const r = await runTest262(
      "/workspace/test262/test/built-ins/Array/prototype/findIndex/return-abrupt-from-this.js",
    );
    expect(r).toBe("PASS");
  });

  // Previously passing tests should still pass
  it("every.call with 3-param callback (regression guard)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/every/15.4.4.16-3-24.js");
    expect(r).toBe("PASS");
  });

  it("every.call with 3-param named function (regression guard)", async () => {
    const r = await runTest262("/workspace/test262/test/built-ins/Array/prototype/every/15.4.4.16-3-1.js");
    expect(r).toBe("PASS");
  });
});
