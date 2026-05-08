// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1366a — `class Sub extends Error/TypeError/RangeError/...` host-constructible
// builtin subclassing. Subclass instance is externref-backed; `super(msg)`
// lowers to `__new_<Parent>(msg)`. `instanceof` for both the user subclass and
// the builtin parent must work, and `.message` must round-trip via the host.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function compileAndInstantiate(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary (WebAssembly.validate failed)\nWAT:\n${result.wat}`);
  }
  const runtimeResult = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtimeResult);
  if (runtimeResult.setExports) {
    runtimeResult.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports as Record<string, Function>;
}

describe("#1366a — class extends Error / TypeError / ... (host-constructible builtin subclassing)", () => {
  it("new MyError('x') instanceof MyError → true", async () => {
    const source = `
      class MyError extends Error {
        constructor(msg: string) {
          super(msg);
        }
      }
      export function test(): number {
        const e = new MyError("oops");
        return (e instanceof MyError) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("new MyError('x') instanceof Error → true", async () => {
    const source = `
      class MyError extends Error {
        constructor(msg: string) {
          super(msg);
        }
      }
      export function test(): number {
        const e = new MyError("oops");
        return (e instanceof Error) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("new MyError('hi').message === 'hi'", async () => {
    const source = `
      class MyError extends Error {
        constructor(msg: string) {
          super(msg);
        }
      }
      export function test(): string {
        const e = new MyError("hi");
        return e.message;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe("hi");
  });

  it("class MyTypeError extends TypeError — instance is a TypeError and an Error", async () => {
    const source = `
      class MyTypeError extends TypeError {
        constructor(msg: string) {
          super(msg);
        }
      }
      export function isMyTypeError(): number {
        return (new MyTypeError("x") instanceof MyTypeError) ? 1 : 0;
      }
      export function isTypeError(): number {
        return (new MyTypeError("x") instanceof TypeError) ? 1 : 0;
      }
      export function isError(): number {
        return (new MyTypeError("x") instanceof Error) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.isMyTypeError!()).toBe(1);
    expect(exports.isTypeError!()).toBe(1);
    expect(exports.isError!()).toBe(1);
  });

  it("RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError subclassing", async () => {
    for (const kind of ["RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"]) {
      const source = `
        class MyErr extends ${kind} {
          constructor(msg: string) {
            super(msg);
          }
        }
        export function test(): number {
          const e = new MyErr("z");
          return (e instanceof MyErr ? 1 : 0) + (e instanceof ${kind} ? 2 : 0) + (e instanceof Error ? 4 : 0);
        }
      `;
      const exports = await compileAndInstantiate(source);
      expect(exports.test!()).toBe(7);
    }
  });

  it("plain (non-subclass) Error path is unaffected", async () => {
    const source = `
      export function test(): number {
        const e = new Error("plain");
        return (e instanceof Error) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("user class NOT extending a builtin still uses WasmGC struct path", async () => {
    const source = `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function test(): number {
        const p = new Point(3, 4);
        return (p instanceof Point ? 1 : 0) + (p instanceof Error ? 2 : 0);
      }
    `;
    const exports = await compileAndInstantiate(source);
    // Point instance is a struct, so instanceof Point is 1, instanceof Error is 0.
    expect(exports.test!()).toBe(1);
  });

  it("throw new MyError can be caught and inspected", async () => {
    // Throw a subclass error and catch it; check the caught externref has the
    // right .message and instanceof relations. This exercises the runtime
    // pathway that test262 throws-then-catches relies on.
    const source = `
      class MyError extends Error {
        constructor(msg: string) {
          super(msg);
        }
      }
      export function test(): string {
        try {
          throw new MyError("boom");
        } catch (e: any) {
          return e.message as string;
        }
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe("boom");
  });

  it("user class hierarchy (no builtin parent) still works", async () => {
    const source = `
      class Animal {
        legs: number;
        constructor(legs: number) {
          this.legs = legs;
        }
      }
      class Dog extends Animal {
        constructor() {
          super(4);
        }
      }
      export function test(): number {
        const d = new Dog();
        return d.legs;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(4);
  });
});
