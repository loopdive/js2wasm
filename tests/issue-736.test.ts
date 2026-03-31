import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

function shouldError(code: string, description: string) {
  it(`should detect SyntaxError: ${description}`, () => {
    const result = compile(code, { fileName: "test.ts" });
    expect(result.success).toBe(false);
  });
}

function shouldCompile(code: string, description: string) {
  it(`should compile: ${description}`, () => {
    const result = compile(code, { fileName: "test.ts" });
    expect(result.success).toBe(true);
  });
}

describe("Issue #736: SyntaxError detection at compile time", () => {
  describe("function declarations in statement position (sloppy mode)", () => {
    shouldError("for (var x in {}) function f() {}", "func decl in for-in body");
    shouldError("for (var x of []) function f() {}", "func decl in for-of body");
    shouldError("while (false) function f() {}", "func decl in while body");
    shouldError("do function f() {} while (false)", "func decl in do body");
    shouldError("for (;;) function f() {}", "func decl in for body");
    // Annex B: function decl in if body is allowed in sloppy mode
    shouldCompile("if (true) function f() {}", "func decl in if body (Annex B)");
    // In a block is always fine
    shouldCompile("for (;;) { function f() {} break; }", "func decl in block inside for");
  });

  describe("invalid assignment targets", () => {
    shouldError("this++;", "this++");
    shouldError("this--;", "this--");
    shouldError("++this;", "++this");
    shouldError("--this;", "--this");
    shouldError("function f() { new.target--; }", "new.target--");
    shouldError("function f() { ++new.target; }", "++new.target");
    shouldError("function f() { new.target = 1; }", "new.target = 1");
    // Valid targets should still work
    shouldCompile("var x = 1; x++;", "valid increment");
    shouldCompile("var o = {x: 1}; o.x++;", "valid property increment");
  });

  describe("const without initializer", () => {
    shouldError("const x;", "const without initializer");
    shouldCompile("const x = 1;", "const with initializer");
  });

  describe("let as binding name in lexical declaration", () => {
    shouldError("for (let let in {}) {}", "let let in for-in");
    shouldCompile("var let2 = 1;", "let2 is a valid name");
  });

  describe("duplicate parameters with destructuring", () => {
    shouldError("var af = (x, [x]) => 1;", "dup param in arrow with array destructuring");
    shouldError("var af = (x, {x}) => 1;", "dup param in arrow with object destructuring");
    shouldCompile("var f = (a, b) => a + b;", "non-duplicate arrow params");
  });

  describe("inner block var/lexical conflicts", () => {
    shouldError("{ { var f; } let f; }", "var in inner block vs let in outer");
    shouldCompile("{ var f; }", "var alone is fine");
    shouldCompile("{ let f = 1; }", "let alone is fine");
  });

  describe("switch case var/lexical conflicts", () => {
    shouldError("switch (0) { case 1: let f; default: var f }", "let vs var in switch");
    shouldCompile("switch (0) { case 1: var f; }", "var alone in switch is fine");
  });

  describe("catch clause early errors", () => {
    shouldError("try {} catch ([x, x]) {}", "duplicate catch param binding");
    shouldError("try {} catch (x) { let x; }", "catch param redecl with let");
    shouldCompile("try {} catch (x) {}", "valid catch clause");
  });

  describe("getter/setter parameter validation", () => {
    shouldError("var o = { get a(param) {} };", "getter with parameter");
    shouldCompile("var o = { get a() { return 1; } };", "valid getter");
    shouldCompile("var o = { set a(v) {} };", "valid setter");
  });

  describe("cover initialized name", () => {
    shouldError("({ a = 1 });", "cover initialized name in non-destructuring context");
    // Destructuring context should be fine
    shouldCompile("var a: number; ({ a = 1 } = { a: 2 });", "cover initialized name in destructuring");
  });

  describe("for-in with destructuring pattern initializer", () => {
    shouldError("for (var {a} = 0 in {});", "for-in with destructuring initializer");
    shouldError("for (var [a] = 0 in {});", "for-in with array destructuring initializer");
  });

  describe("non-octal decimal integer in strict mode", () => {
    shouldError('"use strict"; 08;', "08 in strict mode");
    shouldCompile("08;", "08 in sloppy mode is valid");
  });

  describe("for loop head lexical/var conflict", () => {
    shouldError("for (let x; false; ) { var x; }", "for-let body var conflict");
    shouldCompile("for (let x = 0; x < 1; x++) {}", "valid for-let");
  });
});
