import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// Exploratory test: which TypeScript patterns used by the real TypeScript
// compiler does js2wasm handle? Each test tries to compile a pattern
// found in the TypeScript compiler source.

describe("TypeScript Compiler Pattern Compatibility", () => {
  it("large enum (SyntaxKind equivalent)", () => {
    const r = compile(`
      enum SyntaxKind {
        Unknown = 0,
        EndOfFileToken = 1,
        NumericLiteral = 8,
        StringLiteral = 10,
        Identifier = 80,
        IfStatement = 243,
        WhileStatement = 245,
        ForStatement = 246,
        ReturnStatement = 251,
        FunctionDeclaration = 261,
        ClassDeclaration = 262
      }
      export function test(): number { return SyntaxKind.Identifier; }
    `);
    expect(r.success).toBe(true);
  });

  it("interface with fields", () => {
    const r = compile(`
      interface Node {
        kind: number;
        pos: number;
        end: number;
      }
      function getKind(n: Node): number { return n.kind; }
      export function test(): number { return 1; }
    `);
    if (!r.success)
      console.log(
        "Interface errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    expect(r.success).toBe(true);
  });

  it("class methods (TextRange pattern)", () => {
    const r = compile(`
      class TextRange {
        _pos: number;
        _end: number;
        constructor(pos: number, end: number) {
          this._pos = pos;
          this._end = end;
        }
        getWidth(): number {
          return this._end - this._pos;
        }
      }
      export function test(): number {
        let r: TextRange = new TextRange(5, 15);
        return r.getWidth();
      }
    `);
    expect(r.success).toBe(true);
  });

  it("string equality comparison", () => {
    const r = compile(`
      function isKeyword(s: string): number {
        if (s === "if") return 1;
        if (s === "else") return 2;
        if (s === "while") return 3;
        if (s === "return") return 4;
        return 0;
      }
      export function test(): number { return isKeyword("if"); }
    `);
    if (!r.success)
      console.log(
        "String eq errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    expect(r.success).toBe(true);
  });

  it("union type: number | string", () => {
    const r = compile(`
      function test(x: number | string): number {
        if (typeof x === "number") return 1;
        return 0;
      }
      export function main(): number { return test(42); }
    `);
    if (!r.success)
      console.log(
        "Union errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    // Record whether this passes or fails
    console.log("Union type support:", r.success ? "YES" : "NO");
  });

  it("optional parameters", () => {
    const r = compile(`
      function foo(a: number, b?: number): number {
        if (b !== undefined) return a + 1;
        return a;
      }
      export function test(): number { return foo(1); }
    `);
    if (!r.success)
      console.log(
        "Optional param errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Optional params support:", r.success ? "YES" : "NO");
  });

  it("array of class instances", () => {
    const r = compile(`
      class Token {
        kind: number;
        start: number;
        constructor(kind: number, start: number) {
          this.kind = kind;
          this.start = start;
        }
      }
      let tokens: Token[] = [];
      function addToken(kind: number, start: number): void {
        tokens[tokens.length] = new Token(kind, start);
      }
      export function test(): number {
        tokens = [];
        addToken(1, 0);
        addToken(2, 5);
        return tokens.length;
      }
    `);
    if (!r.success)
      console.log(
        "Array of objects errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Array of class instances:", r.success ? "YES" : "NO");
  });

  it("type assertion", () => {
    const r = compile(`
      function test(x: number): number {
        let y: number = x as number;
        return y;
      }
      export function main(): number { return test(42); }
    `);
    if (!r.success)
      console.log(
        "Type assertion errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Type assertion:", r.success ? "YES" : "NO");
  });

  it("recursive/self-referencing class", () => {
    const r = compile(`
      class ListNode {
        value: number;
        next: ListNode;
        constructor(value: number) {
          this.value = value;
          this.next = this;
        }
      }
      export function test(): number { return 1; }
    `);
    if (!r.success)
      console.log(
        "Recursive type errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Recursive/self-ref class:", r.success ? "YES" : "NO");
  });

  it("null union types", () => {
    const r = compile(`
      class Box {
        value: number;
        constructor(v: number) { this.value = v; }
      }
      function getOrDefault(b: Box | null): number {
        if (b === null) return 0;
        return b.value;
      }
      export function test(): number {
        let b: Box = new Box(42);
        return getOrDefault(b);
      }
    `);
    if (!r.success)
      console.log(
        "Null union errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Null union types:", r.success ? "YES" : "NO");
  });

  it("for loop", () => {
    const r = compile(`
      export function test(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 10; i = i + 1) {
          sum = sum + i;
        }
        return sum;
      }
    `);
    if (!r.success)
      console.log(
        "For loop errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("For loop:", r.success ? "YES" : "NO");
  });

  it("switch statement", () => {
    const r = compile(`
      function classify(kind: number): number {
        switch (kind) {
          case 1: return 10;
          case 2: return 20;
          case 3: return 30;
          default: return 0;
        }
      }
      export function test(): number { return classify(2); }
    `);
    if (!r.success)
      console.log(
        "Switch errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Switch statement:", r.success ? "YES" : "NO");
  });

  it("try-catch", () => {
    const r = compile(`
      export function test(): number {
        try {
          return 42;
        } catch (e) {
          return 0;
        }
      }
    `);
    if (!r.success)
      console.log(
        "Try-catch errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Try-catch:", r.success ? "YES" : "NO");
  });

  it("spread operator", () => {
    const r = compile(`
      export function test(): number {
        let a: number[] = [1, 2, 3];
        let b: number[] = [...a, 4, 5];
        return b.length;
      }
    `);
    if (!r.success)
      console.log(
        "Spread errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Spread operator:", r.success ? "YES" : "NO");
  });

  it("Map object", () => {
    const r = compile(`
      export function test(): number {
        let m: Map<string, number> = new Map();
        m.set("a", 1);
        return m.get("a") || 0;
      }
    `);
    if (!r.success)
      console.log(
        "Map errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Map:", r.success ? "YES" : "NO");
  });

  it("closure capturing variable", () => {
    const r = compile(`
      function makeAdder(x: number): (y: number) => number {
        return (y: number): number => x + y;
      }
      export function test(): number {
        let add5 = makeAdder(5);
        return add5(3);
      }
    `);
    if (!r.success)
      console.log(
        "Closure errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Closure:", r.success ? "YES" : "NO");
  });

  it("class inheritance", () => {
    const r = compile(`
      class Base {
        x: number;
        constructor(x: number) { this.x = x; }
        getValue(): number { return this.x; }
      }
      class Derived extends Base {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
        getSum(): number { return this.x + this.y; }
      }
      export function test(): number {
        let d: Derived = new Derived(10, 20);
        return d.getSum();
      }
    `);
    if (!r.success)
      console.log(
        "Inheritance errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Class inheritance:", r.success ? "YES" : "NO");
  });

  it("generic function", () => {
    const r = compile(`
      function identity<T>(x: T): T { return x; }
      export function test(): number { return identity(42); }
    `);
    if (!r.success)
      console.log(
        "Generic errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Generics:", r.success ? "YES" : "NO");
  });

  it("rest parameters", () => {
    const r = compile(`
      function sum(...args: number[]): number {
        let total: number = 0;
        let i: number = 0;
        while (i < args.length) {
          total = total + args[i];
          i = i + 1;
        }
        return total;
      }
      export function test(): number { return sum(1, 2, 3); }
    `);
    if (!r.success)
      console.log(
        "Rest params errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Rest parameters:", r.success ? "YES" : "NO");
  });

  it("template literals", () => {
    const r = compile(`
      export function test(): string {
        let x: number = 42;
        return \\\`value is \\\${x}\\\`;
      }
    `);
    if (!r.success)
      console.log(
        "Template literal errors:",
        r.errors.slice(0, 3).map((e) => e.message),
      );
    console.log("Template literals:", r.success ? "YES" : "NO");
  });
});
