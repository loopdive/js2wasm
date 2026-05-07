// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1315 — `import.defer(...)` and `import.source(...)` early error detection.
//
// Pre-fix bugs:
//   1. `import.defer(...)` in codegen-reachable positions caused the TypeScript
//      checker to throw `Debug Failure. False expression: Trying to get the
//      type of import.defer in import.defer(...)`. Compileexpressions wrapped
//      this in `Internal error compiling expression: ...` rather than a clean
//      unsupported-feature error. (~27 test262 tests)
//   2. `import.defer(...)` / `import.source(...)` inside dead code (e.g. an
//      unreferenced async arrow function used by 157 negative parse-phase
//      test262 tests) emitted no compile error at all — the test262 driver
//      saw "compile succeeded" and recorded a fail because the negative test
//      expected a SyntaxError.
//
// Fix:
//   - codegen (src/codegen/expressions/calls.ts): detect
//     `MetaProperty(ImportKeyword, "defer"|"source")` as the callee of a
//     CallExpression and emit a clean SyntaxError reportError.
//   - dispatcher (src/codegen/expressions.ts): bypass the async-call
//     detection's `getResolvedSignature` query for these patterns to avoid
//     re-triggering the TypeScript Debug.assert.
//   - early-error pass (src/compiler/validation.ts): walk the AST and emit
//     a SyntaxError for any `import.defer(...)` or `import.source(...)`
//     CallExpression — runs even on dead code so negative tests count as
//     pass via "compile rejected the source".

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

function compileAndCollect(src: string): {
  success: boolean;
  errors: { severity: string; message: string }[];
} {
  const r = compile(src, { fileName: "test.ts", emitWat: false });
  return {
    success: r.success,
    errors: r.errors.map((e) => ({ severity: e.severity, message: e.message })),
  };
}

function hasErrorMatching(errors: { severity: string; message: string }[], pattern: RegExp): boolean {
  return errors.some((e) => e.severity === "error" && pattern.test(e.message));
}

describe("#1315 import.defer / import.source early error detection", () => {
  describe("graceful handling (no Debug Failure crash)", () => {
    it("emits a clean SyntaxError instead of TS Debug Failure for import.defer(...)", () => {
      const { errors } = compileAndCollect(`async function f() { import.defer('./x.js'); }\nexport {};\n`);
      expect(hasErrorMatching(errors, /SyntaxError: import\.defer\(\.\.\.\) is not supported/)).toBe(true);
      // Crucially the original "Debug Failure" / "Internal error compiling expression" must NOT leak through
      expect(errors.some((e) => /Debug Failure/.test(e.message))).toBe(false);
      expect(errors.some((e) => /Internal error compiling expression/.test(e.message))).toBe(false);
    });

    it("emits a clean SyntaxError for import.source(...) in await context", () => {
      const { errors } = compileAndCollect(`async function f() { await import.source('./x.js'); }\nexport {};\n`);
      expect(hasErrorMatching(errors, /SyntaxError: import\.source\(\.\.\.\) is not supported/)).toBe(true);
      expect(errors.some((e) => /Debug Failure/.test(e.message))).toBe(false);
      expect(errors.some((e) => /Internal error compiling expression/.test(e.message))).toBe(false);
    });

    it("does not crash on import.defer with no arguments", () => {
      const { errors } = compileAndCollect(`async function f() { return await import.defer(); }\nexport {};\n`);
      expect(hasErrorMatching(errors, /SyntaxError: import\.defer\(\.\.\.\) is not supported/)).toBe(true);
      expect(errors.some((e) => /Debug Failure/.test(e.message))).toBe(false);
    });
  });

  describe("early-error detection (catches dead code)", () => {
    it("flags import.defer() inside an unreferenced async arrow function (test262 negative-test pattern)", () => {
      // This is the exact shape of test262 invalid/...-import-defer-assignment-expr-not-optional.js
      // The arrow function is never invoked, so without an early-error pass the codegen never visits
      // the body — but the test262 driver still expects compilation to reject the source as a SyntaxError.
      const { errors } = compileAndCollect(`(async () => {\n  await import.defer()\n});\nexport {};\n`);
      expect(hasErrorMatching(errors, /SyntaxError: import\.defer\(\.\.\.\) is not supported/)).toBe(true);
    });

    it("flags import.source() inside an unreferenced async arrow function", () => {
      const { errors } = compileAndCollect(`(async () => await import.source());\nexport {};\n`);
      expect(hasErrorMatching(errors, /SyntaxError: import\.source\(\.\.\.\) is not supported/)).toBe(true);
    });

    it("flags both forms when nested in unreachable conditional blocks", () => {
      const a = compileAndCollect(`if (false) { import.defer('x'); }\nexport {};\n`);
      expect(hasErrorMatching(a.errors, /SyntaxError: import\.defer/)).toBe(true);
      const b = compileAndCollect(`if (false) { import.source('x'); }\nexport {};\n`);
      expect(hasErrorMatching(b.errors, /SyntaxError: import\.source/)).toBe(true);
    });
  });

  describe("regressions: legitimate import forms keep working", () => {
    it("plain dynamic import() compiles without error", () => {
      const { errors } = compileAndCollect(`async function f() { await import('./x.js'); }\nexport {};\n`);
      expect(errors.filter((e) => e.severity === "error")).toHaveLength(0);
    });

    it("import.meta access compiles without error", () => {
      const { errors } = compileAndCollect(`function f() { return import.meta; }\nexport {};\n`);
      expect(errors.filter((e) => e.severity === "error")).toHaveLength(0);
    });

    it("import.meta.url access compiles without error", () => {
      const { errors } = compileAndCollect(`function f() { return (import.meta as any).url; }\nexport {};\n`);
      expect(errors.filter((e) => e.severity === "error")).toHaveLength(0);
    });
  });
});
