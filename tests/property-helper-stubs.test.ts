import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { wrapTest } from "./test262-runner.js";
import { buildImports } from "../src/runtime.js";

/**
 * Issue #129: propertyHelper.js stubs.
 *
 * Tests that the no-op stubs for verifyEnumerable, verifyNotEnumerable,
 * verifyWritable, verifyNotWritable, verifyConfigurable, verifyNotConfigurable
 * compile and run without crashing.  verifyProperty with value: is transformed
 * to assert_sameValue; without value: is stripped (#770).
 */

async function compileAndRun(source: string) {
  const result = compile(source);
  if (!result.success) {
    return { success: false, value: undefined, error: result.errors.map(e => e.message).join("; ") };
  }
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const test = (instance.exports as any).test;
    const value = test ? test() : undefined;
    return { success: true, value, error: null };
  } catch (e: any) {
    return { success: false, value: undefined, error: e.message };
  }
}

describe("Issue #129: propertyHelper.js stubs", () => {
  it("verifyWritable / verifyNotWritable stubs compile and run", async () => {
    // Simulate a test262 test that includes propertyHelper.js and uses
    // verifyWritable/verifyNotWritable (two-arg form, no object literal).
    const test262Source = `/*---
includes: [propertyHelper.js]
---*/
var obj = { x: 42 };
verifyWritable(obj, "x");
verifyNotWritable(obj, "x");
assert.sameValue(obj.x, 42);
`;
    const { source: wrapped } = wrapTest(test262Source);
    const result = await compileAndRun(wrapped);
    expect(result.success, `Failed: ${result.error}`).toBe(true);
    expect(result.value).toBe(1);
  });

  it("verifyEnumerable / verifyNotEnumerable stubs compile and run", async () => {
    const test262Source = `/*---
includes: [propertyHelper.js]
---*/
var obj = { y: 10 };
verifyEnumerable(obj, "y");
verifyNotEnumerable(obj, "y");
assert.sameValue(obj.y, 10);
`;
    const { source: wrapped } = wrapTest(test262Source);
    const result = await compileAndRun(wrapped);
    expect(result.success, `Failed: ${result.error}`).toBe(true);
    expect(result.value).toBe(1);
  });

  it("verifyConfigurable / verifyNotConfigurable stubs compile and run", async () => {
    const test262Source = `/*---
includes: [propertyHelper.js]
---*/
var obj = { z: 99 };
verifyConfigurable(obj, "z");
verifyNotConfigurable(obj, "z");
assert.sameValue(obj.z, 99);
`;
    const { source: wrapped } = wrapTest(test262Source);
    const result = await compileAndRun(wrapped);
    expect(result.success, `Failed: ${result.error}`).toBe(true);
    expect(result.value).toBe(1);
  });

  it("verifyProperty with value: is transformed to assert_sameValue", async () => {
    // verifyProperty(obj, name, {value: X}) is transformed to assert_sameValue(obj[name], X).
    // Calls without value: are stripped entirely.
    const test262Source = `/*---
includes: [propertyHelper.js]
---*/
var x = 1 + 2;
verifyProperty(x, "toString", {
  value: 42,
  writable: true,
  enumerable: false,
  configurable: true
});
assert.sameValue(x, 3);
`;
    const { source: wrapped } = wrapTest(test262Source);
    // The verifyProperty call should be transformed, not present as-is
    expect(wrapped).not.toContain("verifyProperty");
    // But it should contain an assert_sameValue for the value check
    expect(wrapped).toContain("assert_sameValue");
    const result = await compileAndRun(wrapped);
    expect(result.success, `Failed: ${result.error}`).toBe(true);
    // Test returns non-1 because x["toString"] !== 42
    // (x is a number, its toString is the built-in function, not 42)
  });

  it("verifyProperty without value: is stripped", async () => {
    const test262Source = `/*---
includes: [propertyHelper.js]
---*/
var obj = { x: 1 };
verifyProperty(obj, "x", {
  writable: true,
  enumerable: true,
  configurable: true
});
assert.sameValue(obj.x, 1);
`;
    const { source: wrapped } = wrapTest(test262Source);
    expect(wrapped).not.toContain("verifyProperty");
    const result = await compileAndRun(wrapped);
    expect(result.success, `Failed: ${result.error}`).toBe(true);
    expect(result.value).toBe(1);
  });
});
