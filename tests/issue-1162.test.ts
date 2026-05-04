// #1162 — static-generator-method and private-method-from-static-method
// patterns no longer crash the compiler with "unexpected undefined AST node
// in compileExpression".
//
// The 161-test cluster had two independent contributors:
//
// 1. `tests/test262-runner.ts#renameYieldOutsideGenerators` didn't recognize
//    PRIVATE generator methods like `static async *#gen()` as generators,
//    because the identifier regex `[\w$]+` excluded `#`. `yield` inside the
//    body was then rewritten to `_yield`, producing `_yield* obj;` which
//    parses as multiplication and crashed the compiler while processing
//    surrounding code.
//
// 2. `compileGetterCallable` in `src/codegen/expressions/calls-closures.ts`
//    assumed the resolved candidate method was an instance method (with a
//    self parameter). For a STATIC private method reached via a getter
//    chain (`static get gen() { return this.#gen; }`, where `#gen` is
//    static), paramTypes = [] and `paramTypes.length - 1 = -1`, so the
//    argument-padding loop read `expr.arguments[-1]` = undefined.
//
// 3. The same "clamp length − 1 to ≥ 0" fix is applied to the Non-nullable
//    receiver path in `compileCallExpression` for defence against parallel
//    funcMap drift.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function expectCompiles(source: string): void {
  const result = compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    const msg = result.errors
      .filter((e) => e.severity === "error")
      .map((e) => `L${e.line}:${e.column} ${e.message}`)
      .join("; ");
    throw new Error("Compile failed: " + msg);
  }
}

async function runTest(source: string): Promise<any> {
  const result = compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    const msg = result.errors
      .filter((e) => e.severity === "error")
      .map((e) => `L${e.line}:${e.column} ${e.message}`)
      .join("; ");
    throw new Error("Compile failed: " + msg);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (typeof (imports as any).setExports === "function") {
    (imports as any).setExports(instance.exports);
  }
  return (instance.exports as any).test();
}

describe("#1162 — yield* async / private-method-from-static codegen crashes", () => {
  it("compiles static async private generator methods without crashing", () => {
    // Original failure from yield-star-async tests: the parent test262 runner
    // renamed `yield` inside the private generator body because `#gen` wasn't
    // recognized as a method name. After the fix, this body compiles cleanly.
    expectCompiles(`
      var C = class {
        static async *#gen() {
          yield 1;
          yield 2;
        }
        static get gen() { return this.#gen; }
      }
      var iter: any = C.gen();
    `);
  });

  it("compiles static getter returning a static private method", () => {
    // Static method reached via a getter — compileGetterCallable previously
    // assumed instance-method param layout and read arguments[-1].
    expectCompiles(`
      class C {
        static #gen() { return 1; }
        static get gen() { return this.#gen; }
      }
      var iter: any = C.gen();
    `);
  });

  it("compiles private method called from static method (this.#f() in static)", () => {
    // this.#f() inside a static method — the Non-nullable receiver path
    // in compileCallExpression previously crashed when funcMap lookup
    // produced an unexpected zero-param paramTypes.
    expectCompiles(`
      class C {
        #f() { return 42; }
        static g() {
          return this.#f();
        }
      }
    `);
  });

  it("compiles yield-star inside static async private generator method body", () => {
    // This is the exact pattern that procedurally-generated test262
    // yield-star-async cases emit (static async generator private method
    // with a yield* delegation). Before the fix, the yield keyword was
    // renamed to `_yield` inside the body, producing `_yield* obj;` which
    // parsed as multiplication and crashed the compiler when compiling
    // surrounding code.
    expectCompiles(`
      var obj: any = { [Symbol.asyncIterator]: () => ({ next: () => ({ value: 1, done: true }) }) };
      var C = class {
        static async *#gen() {
          yield* obj;
        }
        static get gen() { return this.#gen; }
      }
    `);
  });
});
