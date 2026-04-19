import { describe, test, expect } from "vitest";
import { compile } from "../src/index.ts";

/**
 * Tests for #1091 — Early error detection gap
 * Each test verifies that the compiler rejects code that is a SyntaxError per ES spec.
 */

function expectCompileError(source: string, description: string) {
  const result = compile(source + "\nexport {};\n", { fileName: "test.ts" });
  const hasError = !result.success || result.errors.some((e) => e.severity === "error" || e.severity === "warning");
  expect(hasError, `Expected compile error for: ${description}`).toBe(true);
}

function expectCompileSuccess(source: string, description: string) {
  const result = compile(source + "\nexport {};\n", { fileName: "test.ts" });
  expect(result.success, `Expected compile success for: ${description}`).toBe(true);
}

describe("#1091 — Early error detection", () => {
  describe("Strict mode reserved words as assignment targets", () => {
    test("public = 42 in strict mode getter body", () => {
      expectCompileError(`void { get x() { "use strict"; public = 42; } };`, "public = 42 in strict getter");
    });

    test("public = 42 in strict mode setter body", () => {
      expectCompileError(`void { set x(value) { "use strict"; public = 42; } };`, "public = 42 in strict setter");
    });

    test("public = 42 in onlyStrict mode", () => {
      expectCompileError(`"use strict"; void { get x() { public = 42; } };`, "public = 42 in strict mode");
    });

    test("public is valid as assignment target in sloppy mode", () => {
      // In sloppy mode, public is NOT a reserved word — should compile fine
      expectCompileSuccess(`var public; public = 42;`, "public = 42 in sloppy mode");
    });
  });

  describe("Duplicate private names across static/non-static", () => {
    test("instance setter + static getter with same private name", () => {
      expectCompileError(`class C { set #f(v) {} static get #f() {} }`, "instance setter + static getter");
    });

    test("static setter + non-static getter with same private name", () => {
      expectCompileError(`class C { static set #f(v) {} get #f() {} }`, "static setter + non-static getter");
    });

    test("instance getter + instance setter is valid", () => {
      expectCompileSuccess(`class C { get #f() { return 1; } set #f(v) {} }`, "instance get+set pair");
    });

    test("static getter + static setter is valid", () => {
      expectCompileSuccess(`class C { static get #f() { return 1; } static set #f(v) {} }`, "static get+set pair");
    });
  });

  describe("Yield in generator default parameters", () => {
    test("function* g(x = yield) {} is SyntaxError", () => {
      expectCompileError(`function* g(x = yield) {}`, "yield in generator default param");
    });

    test("async function* g(x = await 1) {} is SyntaxError", () => {
      expectCompileError(`async function* g(x = await 1) {}`, "await in async generator default param");
    });
  });

  describe("yield * with newline before *", () => {
    test("yield\\n*1 is SyntaxError", () => {
      expectCompileError(`function* g() { yield\n* 1 }`, "yield newline * 1");
    });
  });

  describe("Static field named 'constructor'", () => {
    test("static 'constructor' field is SyntaxError", () => {
      expectCompileError(`class C { static 'constructor'; }`, "static string constructor field");
    });

    test("non-static 'constructor' field is also SyntaxError", () => {
      expectCompileError(`class C { 'constructor'; }`, "non-static string constructor field");
    });
  });

  describe("return in class static block", () => {
    test("return inside static block inside function is SyntaxError", () => {
      expectCompileError(`function f() { class C { static { return; } } }`, "return in static block");
    });
  });

  describe("await in class static block", () => {
    test("await 0 inside static block inside async function is SyntaxError", () => {
      expectCompileError(
        `async function f() { class C { static { await 0; } } }`,
        "await in static block inside async",
      );
    });
  });

  describe("arguments in class static block", () => {
    test("arguments in static block is SyntaxError", () => {
      expectCompileError(`class C { static { (class { [arguments]() {} }); } }`, "arguments in static block");
    });
  });

  describe("super.#private is SyntaxError", () => {
    test("super.#m access is SyntaxError", () => {
      expectCompileError(`class B {} class C extends B { #m = 1; method() { return super.#m; } }`, "super.#m access");
    });
  });

  describe("Postfix ++/-- with Unicode line terminators", () => {
    test("x U+2029 ++ is SyntaxError", () => {
      expectCompileError(`var x = 0; x\u2029++`, "paragraph separator before ++");
    });

    test("x U+2028 -- is SyntaxError", () => {
      expectCompileError(`var x = 0; x\u2028--`, "line separator before --");
    });
  });
});
