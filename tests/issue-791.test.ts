/**
 * Issue #791: SyntaxError detection gaps — code compiles when it should not.
 *
 * Tests that the compiler correctly rejects various ES-spec SyntaxError patterns.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

function expectError(source: string, description: string) {
  it(description, () => {
    const result = compile(source, { fileName: "test.ts", emitWat: false });
    const hasError = !result.success || result.errors.some(e => e.severity === "error");
    const hasWarning = result.errors.some(e => e.severity === "warning");
    expect(hasError || hasWarning).toBe(true);
  });
}

function expectSuccess(source: string, description: string) {
  it(description, () => {
    const result = compile(source, { fileName: "test.ts", emitWat: false });
    expect(result.success).toBe(true);
  });
}

describe("Issue #791: SyntaxError detection", () => {
  describe("use strict + non-simple parameters", () => {
    expectError(
      'function f(a = 0) { "use strict"; } export {}',
      "default parameter + use strict"
    );
    expectError(
      'function f([a, b]: number[]) { "use strict"; } export {}',
      "destructuring parameter + use strict"
    );
    expectError(
      'function f(...args: number[]) { "use strict"; } export {}',
      "rest parameter + use strict"
    );
    expectError(
      'var o = { m(a = 0) { "use strict"; } }; export {}',
      "object method with default + use strict"
    );
    expectError(
      'class C { m([x]: number[]) { "use strict"; } } export {}',
      "class method with destructuring + use strict"
    );
    expectSuccess(
      'function f(a: number) { "use strict"; return a; } export {}',
      "simple params + use strict is OK"
    );
  });

  describe("labeled declarations", () => {
    expectError("label: let x; export {}", "label: let");
    expectError("label: const x = 1; export {}", "label: const");
    expectError("label: class C {} export {}", "label: class");
    expectSuccess(
      "label: for (let i = 0; i < 10; i++) { break label; } export {}",
      "label: for (normal usage) is OK"
    );
  });

  describe("eval/arguments as binding in strict mode", () => {
    expectError(
      '"use strict"; var eval = 42; export {}',
      "var eval in strict mode"
    );
    expectError(
      '"use strict"; var arguments = 42; export {}',
      "var arguments in strict mode"
    );
    expectSuccess(
      "const o = { eval: 42 }; export {}",
      "eval as property name is OK"
    );
  });

  describe("switch case duplicate lexical declarations", () => {
    expectError(
      "switch (0) { case 1: let f; default: let f; } export {}",
      "duplicate let in switch"
    );
    expectError(
      "switch (0) { case 1: function f() {} default: async function f() {} } export {}",
      "duplicate function in switch"
    );
    expectSuccess(
      "switch (0) { case 0: { let x = 1; } case 1: { let x = 2; } } export {}",
      "let in separate blocks within switch is OK"
    );
  });

  describe("static prototype", () => {
    expectError(
      "class C { static prototype() {} } export {}",
      "static prototype method"
    );
    expectSuccess(
      "class C { prototype() {} } export {}",
      "non-static prototype method is OK"
    );
  });

  describe("duplicate private names", () => {
    expectError(
      "class C { #m; set #m(_: number) {} } export {}",
      "duplicate private: field + setter"
    );
    expectSuccess(
      "class C { get #x() { return 0; } set #x(v: number) {} } export {}",
      "getter + setter pair is OK"
    );
  });

  describe("let/const in single-statement positions", () => {
    expectError(
      "if (true) let x = 1; export {}",
      "let in if-body single statement"
    );
    expectError(
      "while (false) const x = 1; export {}",
      "const in while-body single statement"
    );
  });
});
