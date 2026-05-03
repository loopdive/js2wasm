// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1300 — Closure capturing outer parameter inside an inline lambda passed as
// a Next callback null-derefs at call time.
//
// Root cause (in `src/codegen/closures.ts/isHostCallbackArgument`): when an
// inline arrow is the argument of a `Call(callee, ...)` and `callee` is a
// function-typed parameter or local (`a(() => "end")` where `a: Mw`), the
// callee is NOT in `funcMap` (it's a runtime closure value, not a
// user-defined top-level function). The old code fell through to
// `return true`, treating the arrow as a host callback and wrapping it via
// `__make_callback`. The receiving function (the user-passed Mw) then tries
// to invoke its `next` parameter via the wasm closure-struct call_ref path,
// but a __make_callback wrapper isn't a wasm struct — `ref.test` fails,
// `emitGuardedRefCast` produces null, and the subsequent `struct.get` on
// the null ref deref-crashes with "dereferencing a null pointer".
//
// Fix: treat function-typed callees that resolve to a parameter or
// variable declaration as user callables — return false so the arrow is
// compiled via `compileArrowAsClosure` (wasm closure struct) instead of
// via `compileArrowAsCallback` (host externref).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<unknown> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const built = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, built);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#1300 — inline arrow passed to function-typed parameter callee", () => {
  it("two-level compose: inner Mw can call its `next` parameter", async () => {
    // Original repro from the issue file.
    expect(
      await compileAndRun(`
        type Next = () => string;
        type Mw = (next: Next) => string;
        function compose2(a: Mw, b: Mw): string {
          return a(() => b(() => "end"));
        }
        export function test(): string {
          return compose2(
            (next: Next) => "<a>" + next() + "</a>",
            (next: Next) => "<b>" + next() + "</b>",
          );
        }
      `),
    ).toBe("<a><b>end</b></a>");
  });

  it("one-level compose: callee `a` is a parameter holding a wasm closure", async () => {
    // The minimal trigger.
    expect(
      await compileAndRun(`
        type Next = () => string;
        type Mw = (next: Next) => string;
        function compose1(a: Mw): string {
          return a(() => "end");
        }
        export function test(): string {
          return compose1((next: Next) => "<a>" + next() + "</a>");
        }
      `),
    ).toBe("<a>end</a>");
  });

  it("no type-aliases, parameter callee with inline-lambda arg", async () => {
    expect(
      await compileAndRun(`
        function callWithLambda(g: (cb: () => string) => string): string {
          return g(() => "end");
        }
        export function test(): string {
          return callWithLambda((cb) => "<a>" + cb() + "</a>");
        }
      `),
    ).toBe("<a>end</a>");
  });

  it("named Mw still works (regression guard for the existing user-fn path)", async () => {
    expect(
      await compileAndRun(`
        type Next = () => string;
        type Mw = (next: Next) => string;
        function compose1(a: Mw): string {
          return a(() => "end");
        }
        function namedMw(next: Next): string { return "<a>" + next() + "</a>"; }
        export function test(): string {
          return compose1(namedMw);
        }
      `),
    ).toBe("<a>end</a>");
  });

  it("inline Mw whose body does NOT call next still works", async () => {
    expect(
      await compileAndRun(`
        type Next = () => string;
        type Mw = (next: Next) => string;
        function compose1(a: Mw): string {
          return a(() => "end");
        }
        export function test(): string {
          return compose1((next: Next) => "no call");
        }
      `),
    ).toBe("no call");
  });

  it("inline Mw with named Next callback still works", async () => {
    expect(
      await compileAndRun(`
        type Next = () => string;
        type Mw = (next: Next) => string;
        function namedNext(): string { return "end"; }
        function compose1(a: Mw): string {
          return a(namedNext);
        }
        export function test(): string {
          return compose1((next: Next) => "<a>" + next() + "</a>");
        }
      `),
    ).toBe("<a>end</a>");
  });

  it("calling a Next param directly (no wrapping inline lambda) still works", async () => {
    expect(
      await compileAndRun(`
        type Next = () => string;
        function callIt(f: Next): string { return f(); }
        export function test(): string {
          return callIt(() => "hello");
        }
      `),
    ).toBe("hello");
  });

  it("variable-bound Mw callee uses wasm closure path", async () => {
    // Callee is a `let g: Mw = (next) => ...` local variable, not a parameter.
    // Same code path triggers — declaration is a VariableDeclaration.
    expect(
      await compileAndRun(`
        type Next = () => string;
        type Mw = (next: Next) => string;
        export function test(): string {
          const g: Mw = (next: Next) => "<a>" + next() + "</a>";
          return g(() => "end");
        }
      `),
    ).toBe("<a>end</a>");
  });
});
