/**
 * Issue #335: Parser comma errors (non-computed-property contexts)
 *
 * Tests that the wrapTest preprocessing in test262-runner correctly handles
 * commas inside array literals and object literals when stripping the 3rd
 * argument from assert calls. Previously, stripThirdArg and stripUndefinedAssert
 * only tracked parenthesis depth, causing commas inside [...] and {...} to be
 * miscounted as top-level argument separators.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Import wrapTest for direct preprocessing validation
import { wrapTest } from "./test262-runner.js";

describe("Issue #335: Parser comma errors in wrapTest preprocessing", () => {
  it("stripThirdArg preserves array literal commas inside assert_sameValue", () => {
    const source = `
/*---
description: test
---*/
var targetObj = {};
assert.sameValue([0, targetObj, 2].indexOf(targetObj, 2), -1, 'msg');
assert.sameValue([0, 1, targetObj].indexOf(targetObj, 2), 2, 'msg2');
`;
    const { source: wrapped } = wrapTest(source);
    // The array literals should be preserved intact
    expect(wrapped).toContain("[0, targetObj, 2].indexOf(targetObj, 2), -1)");
    expect(wrapped).toContain("[0, 1, targetObj].indexOf(targetObj, 2), 2)");
    // The third argument (message string) should be stripped
    expect(wrapped).not.toContain("'msg'");
  });

  it("stripThirdArg preserves array literal commas inside assert_compareArray", () => {
    const source = `
/*---
description: test
includes: [compareArray.js]
---*/
assert.compareArray(fn(1, 2, 3, 4), [3, 4], 'msg');
assert.compareArray(fn(1, 2, 3, 4, 5), [3, 4, 5], 'msg2');
`;
    const { source: wrapped } = wrapTest(source);
    expect(wrapped).toContain("assert_compareArray(fn(1, 2, 3, 4), [3, 4])");
    expect(wrapped).toContain("assert_compareArray(fn(1, 2, 3, 4, 5), [3, 4, 5])");
  });

  it("stripThirdArg preserves object literal commas inside assert_sameValue", () => {
    const source = `
/*---
description: test
---*/
assert.sameValue({a: 1, b: 2}.a, 1, 'msg');
`;
    const { source: wrapped } = wrapTest(source);
    expect(wrapped).toContain("{a: 1, b: 2}.a, 1)");
    expect(wrapped).not.toContain("'msg'");
  });

  it("stripThirdArg with no third argument leaves call intact", () => {
    const source = `
/*---
description: test
---*/
assert.sameValue([1, 2, 3].indexOf(2), 1);
`;
    const { source: wrapped } = wrapTest(source);
    expect(wrapped).toContain("assert_sameValue([1, 2, 3].indexOf(2), 1)");
  });

  it("stripThirdArg handles nested array in second argument", () => {
    const source = `
/*---
description: test
includes: [compareArray.js]
---*/
assert.compareArray(
  Object.getOwnPropertyNames(object),
  ['1', '2', 'a', 'c']
);
`;
    const { source: wrapped } = wrapTest(source);
    expect(wrapped).toContain("['1', '2', 'a', 'c']");
  });

  it("compiles wrapped test with array literal in assert call", () => {
    // This simulates what a wrapped test262 test looks like after wrapTest
    const code = `
let __fail: number = 0;

function assert_sameValue(actual: number, expected: number): void {
  if (actual !== expected) {
    __fail = 1;
  }
}

export function test(): number {
  let arr: number[] = [10, 20, 30];
  assert_sameValue(arr[0], 10);
  assert_sameValue(arr[2], 30);
  if (__fail) { return 0; }
  return 1;
}
`;
    const result = compile(code);
    expect(result.binary.length).toBeGreaterThan(0);

    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(result.binary),
      buildImports(result.imports, undefined, result.stringPool),
    );
    const testFn = (instance.exports as any).test as () => number;
    expect(testFn()).toBe(1);
  });

  it("renameYieldOutsideGenerators preserves yield in async generator methods", () => {
    // async *method() { yield [...yield]; } should keep yield as keyword
    const source = `
/*---
description: test
features: [async-iteration]
flags: [generated, async]
---*/
var gen = {
  async *method() {
    yield [...yield yield];
  }
}.method;
`;
    const { source: wrapped } = wrapTest(source);
    // yield inside async *method() must stay as 'yield', not '_yield'
    expect(wrapped).toContain("yield [...yield yield]");
    expect(wrapped).not.toContain("_yield");
  });

  it("renameYieldOutsideGenerators renames yield outside async generator but preserves inside", () => {
    // yield used as identifier outside generator should be renamed
    // yield used as keyword inside async generator should be preserved
    const source = `
/*---
description: test
features: [async-iteration]
---*/
var yield = 42;
var gen = {
  async *method() {
    yield {
      ...yield,
    };
  }
}.method;
`;
    const { source: wrapped } = wrapTest(source);
    // yield outside async gen should be renamed to _yield
    expect(wrapped).toContain("var _yield = 42");
    // yield inside async gen should stay as yield
    expect(wrapped).toMatch(/async \*method\(\)\s*\{[\s\S]*?yield \{[\s\S]*?\.\.\.yield,/);
  });

  it("compiles wrapped test with multiple commas in array literal argument", () => {
    // Simulates assert_sameValue([a, b, c].indexOf(b, 2), -1)
    // which previously broke due to commas in the array literal
    const code = `
let __fail: number = 0;

function assert_sameValue(actual: number, expected: number): void {
  if (actual !== expected) {
    __fail = 1;
  }
}

export function test(): number {
  let arr: number[] = [10, 20, 30];
  // indexOf with fromIndex=2 should not find 10
  let idx: number = -1;
  for (let i: number = 2; i < arr.length; i++) {
    if (arr[i] === 10) { idx = i; }
  }
  assert_sameValue(idx, -1);
  if (__fail) { return 0; }
  return 1;
}
`;
    const result = compile(code);
    expect(result.binary.length).toBeGreaterThan(0);

    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(result.binary),
      buildImports(result.imports, undefined, result.stringPool),
    );
    const testFn = (instance.exports as any).test as () => number;
    expect(testFn()).toBe(1);
  });
});
