/**
 * Issue #1069: Object literal → struct inference fails on bundled JS config objects
 *
 * Tests that object literals without explicit type annotations still compile
 * via auto-registered anonymous structs.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

function noStructErrors(source: string, description: string, allowJs = false) {
  const result = compile(source, { fileName: allowJs ? "test.js" : "test.ts", allowJs });
  const structErrors = result.errors?.filter(
    (e) => e.message.includes("Object literal type not mapped") || e.message.includes("Cannot determine struct type"),
  );
  expect(structErrors?.length ?? 0, `No struct errors: ${description}`).toBe(0);
}

describe("Issue #1069: Object literal struct inference", () => {
  it("compiles object literal passed to any-typed function", () => {
    noStructErrors(
      `
      function makeDoc(opts: any): any { return opts; }
      function test(): number {
        const doc = makeDoc({ type: "group", shouldBreak: true });
        return 1;
      }
      `,
      "object literal to any-typed param",
    );
  });

  it("compiles object literal returned from untyped function", () => {
    noStructErrors(
      `
      function createNode() {
        return { type: "concat", count: 42 };
      }
      function test(): number {
        const n = createNode();
        return 1;
      }
      `,
      "object literal return (no annotation)",
    );
  });

  it("compiles object literal assigned to untyped variable", () => {
    noStructErrors(
      `
      function test(): number {
        const opts = { indent: 2, tabWidth: 4, useTabs: false };
        return opts.indent;
      }
      `,
      "object literal to untyped variable",
    );
  });

  it("compiles inline object in ternary expression", () => {
    noStructErrors(
      `
      function test(): number {
        const x = true ? { a: 1, b: 2 } : { a: 3, b: 4 };
        return x.a;
      }
      `,
      "object literal in ternary",
    );
  });

  it("compiles typed object literal (regression check)", () => {
    noStructErrors(
      `
      interface Point { x: number; y: number; }
      function test(): number {
        const p: Point = { x: 1, y: 2 };
        return p.x + p.y;
      }
      `,
      "typed object literal with interface",
    );
  });
});

describe("Issue #1069: spread with null/undefined/any", () => {
  it("compiles {...null}", () => {
    noStructErrors(
      `
      function test(): number {
        const obj = {...null};
        return 1;
      }
      `,
      "spread null into object literal",
    );
  });

  it("compiles {...undefined}", () => {
    noStructErrors(
      `
      function test(): number {
        const obj = {...undefined};
        return 1;
      }
      `,
      "spread undefined into object literal",
    );
  });

  it("compiles object with mixed spread and properties", () => {
    noStructErrors(
      `
      function test(): number {
        const base = { x: 1 };
        const obj = { ...base, y: 2 };
        return obj.y;
      }
      `,
      "spread struct + extra properties",
    );
  });
});

describe("Issue #1069: allowJs mode object literals", () => {
  it("compiles plain JS config object (allowJs)", () => {
    noStructErrors(
      `
      function makeDoc(opts) { return opts; }
      function test() {
        var doc = makeDoc({ type: "group", shouldBreak: true, contents: "hello" });
        return 1;
      }
      `,
      "JS config object to untyped param",
      true,
    );
  });

  it("compiles JS object return (allowJs)", () => {
    noStructErrors(
      `
      function createNode() {
        return { type: "concat", parts: ["a", "b"] };
      }
      function test() {
        var n = createNode();
        return 1;
      }
      `,
      "JS object literal return",
      true,
    );
  });

  it("compiles JS object assigned to variable (allowJs)", () => {
    noStructErrors(
      `
      function test() {
        var opts = { indent: 2, tabWidth: 4, useTabs: false };
        return opts.indent;
      }
      `,
      "JS object literal to var",
      true,
    );
  });

  it("compiles JS inline objects in ternary (allowJs)", () => {
    noStructErrors(
      `
      function test() {
        var x = true ? { a: 1, b: 2 } : { a: 3, b: 4 };
        return x.a;
      }
      `,
      "JS ternary object literal",
      true,
    );
  });

  it("compiles JS factory pattern with type field (allowJs)", () => {
    noStructErrors(
      `
      function group(contents, opts) {
        return { type: "group", contents: contents, break: opts && opts.shouldBreak };
      }
      function test() {
        var g = group("hello", { shouldBreak: true });
        return 1;
      }
      `,
      "JS factory function with type discriminator",
      true,
    );
  });
});
