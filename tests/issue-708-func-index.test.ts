import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

describe("Issue #708: function index out of bounds", () => {
  it("union type function with typeof check compiles and runs", async () => {
    const exports = await compileToWasm(`
export function test(x: number | string): number {
  if (typeof x === "number") {
    return x + 1;
  }
  return 0;
}
`);
    expect(exports.test(5)).toBe(6);
  });

  it("object literal method closure with late imports (main repro)", async () => {
    // This pattern triggers the double-shift bug: a closure inside an object
    // literal that captures outer variables AND triggers addUnionImports
    // during nested compilation. The funcStack.body and parentBodiesStack
    // would contain the same body array, causing ref.func indices to be
    // shifted twice.
    const source = `
let __fail: number = 0;
let __assert_count: number = 1;

function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}

function assert_sameValue(actual: number, expected: number): void {
  __assert_count = __assert_count + 1;
  if (!isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_true(value: number): void {
  __assert_count = __assert_count + 1;
  if (!value) {
    if (!__fail) __fail = __assert_count;
  }
}

export function test(): number {
  try {
    var arr = { length: 30 };
    var targetObj = function() {};
    var fromIndex = {
      valueOf: function() {
        arr[4] = targetObj;
        return 10;
      }
    };
    assert_sameValue(Array.prototype.lastIndexOf.call(arr, targetObj, fromIndex), 4);
  } catch (e) {
    if (!__fail) __fail = -1;
  }
  if (__fail) { return __fail; }
  return 1;
}
`;
    const result = compile(source);
    expect(result.success).toBe(true);

    // The key assertion: instantiation must not throw "function index out of bounds"
    const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
    const test = (instance.exports as any).test;
    // The test may not return the right value (complex runtime semantics),
    // but it must not crash with a validation error.
    expect(typeof test()).toBe("number");
  });

  it("nested closures with late import shifts", async () => {
    const exports = await compileToWasm(`
export function test(): number {
  function outer(x: number | string): number {
    function inner(): number {
      if (typeof x === "number") return x;
      return 0;
    }
    return inner();
  }
  return outer(42);
}
`);
    expect(exports.test()).toBe(42);
  });

  it("callback with union types in closure", async () => {
    const exports = await compileToWasm(`
export function test(): number {
  const arr = [1, 2, 3];
  const result = arr.every((x) => x > 0);
  return result ? 1 : 0;
}
`);
    expect(exports.test()).toBe(1);
  });
});
