import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../../src/index.js";
import { wrapTest } from "../test262-runner.js";
import { readFileSync } from "node:fs";

function tryInstantiate(result: CompileResult): string | null {
  if (!result.binary || result.binary.byteLength === 0) {
    return "Empty binary";
  }
  try {
    new WebAssembly.Module(result.binary);
    return null;
  } catch (err: any) {
    return err.message;
  }
}

describe("new on non-constructor builtins (#432)", () => {
  it("new Math.ceil() in assert_throws does not cause stack underflow", () => {
    const result = compile(`
      function assert_throws(fn: () => void): void {
        try { fn(); } catch (e) { return; }
      }

      export function test(): number {
        assert_throws(() => {
          new Math.ceil();
        });
        return 0;
      }
    `, { fileName: "test.ts" });
    const err = tryInstantiate(result);
    expect(err).toBeNull();
  });

  it("not-a-constructor test262 pattern compiles without stack underflow", () => {
    // This is the exact pattern from test/built-ins/Math/*/not-a-constructor.js
    // The bug was that the __module_init guard preamble shared instruction objects
    // between exported functions, causing double-remapping during dead import
    // elimination when there were many preamble functions.
    const source = readFileSync(
      "/workspace/test262/test/built-ins/Math/ceil/not-a-constructor.js",
      "utf-8"
    );
    const { source: wrapped } = wrapTest(source);
    const result = compile(wrapped, { fileName: "test.ts" });
    const err = tryInstantiate(result);
    expect(err).toBeNull();
  });

  it("guard preamble with many exported functions does not double-remap", () => {
    // Regression test: when there are enough preamble functions that dead
    // import elimination removes several union imports, the guard preamble's
    // call to __module_init must not be double-remapped.
    const result = compile(`
let __fail: number = 0;
function f1(a: number, b: number): number { if (a === b) return 1; return 0; }
function f2(a: number, b: number): void { if (!f1(a, b)) { __fail = 1; } }
function f3(a: number, b: number): void { if (f1(a, b)) { __fail = 1; } }
function f4(value: number): void { if (!value) { __fail = 1; } }
function f5(fn: () => void): void { try { fn(); } catch (e) { return; } }
function f6(actual: boolean, expected: boolean): void { if (actual !== expected) { __fail = 1; } }
function f7(actual: boolean, expected: boolean): void { if (actual === expected) { __fail = 1; } }
function isConstructor(f: number): number { return 0; }

export function test(): number {
  try {
    f6(isConstructor(Math.ceil), false);
    f5(() => { new Math.ceil(); });
  } catch (e) {
    __fail = 1;
  }
  if (__fail) { return 0; }
  return 1;
}
`, { fileName: "test.ts" });
    const err = tryInstantiate(result);
    expect(err).toBeNull();
  });
});
