// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1300 — Closure capturing outer parameter inside an inline lambda passed
// as a Next-typed callback null-derefs at call time.
//
// Root cause: `isHostCallbackArgument` in `src/codegen/closures.ts` only
// returns false (= use closure path) when the callee is a known top-level
// user function (`funcMap` entry). When the callee is a *function-typed
// parameter* (e.g. `a(callback)` where `a: Mw = (next: Next) => string`),
// it returns true and routes the inline arrow through
// `compileArrowAsCallback` (the host `__make_callback` path). The receiving
// function (the body of `a`) then tries to unwrap the externref as a
// `__fn_wrap_N_struct`, the cast yields null, and the subsequent
// `struct.get` null-derefs.
//
// Fix: when the callee is an identifier that resolves to a value with a
// function call signature (parameter, local, or any other non-funcMap
// callable), use the GC-struct closure path so the produced externref is
// shaped like the receiver's `ref.cast` expects.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunResult {
  exports: Record<string, Function>;
}

async function run(src: string): Promise<RunResult> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as never, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as never);
  if (typeof (importResult as { setExports?: Function }).setExports === "function") {
    (importResult as { setExports: Function }).setExports(inst.instance.exports);
  }
  return { exports: inst.instance.exports as Record<string, Function> };
}

describe("#1300 closure capturing outer param in Next-callback lambda", () => {
  /**
   * The canonical repro from the issue file. Two-layer middleware compose
   * where the outer lambda captures the second middleware parameter and
   * forwards a `Next` callback to it.
   */
  it("two-layer compose: inner lambda captures outer parameter", async () => {
    const { exports } = await run(`
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
    `);
    expect(exports.test!()).toBe("<a><b>end</b></a>");
  });

  /**
   * Single-layer baseline — calling a function-typed parameter directly
   * (without the inline-lambda capture) already works. This test exists
   * to guard against regressing the simpler path while fixing the
   * captured-lambda path.
   */
  it("single-layer: call function-typed param directly", async () => {
    const { exports } = await run(`
      type Next = () => string;
      function callIt(f: Next): string { return f(); }
      export function test(): string {
        return callIt(() => "hello");
      }
    `);
    expect(exports.test!()).toBe("hello");
  });

  /**
   * A lambda passed to a function-typed param that itself does NOT
   * capture from the outer scope. This should also work via the closure
   * path — but it's worth proving the fix doesn't regress no-capture
   * lambdas in the function-typed-param call site.
   */
  it("lambda with no captures passed to a fn-typed param", async () => {
    const { exports } = await run(`
      type Next = () => string;
      type Mw = (next: Next) => string;

      function compose1(a: Mw): string {
        return a(() => "end");
      }

      export function test(): string {
        return compose1((next: Next) => "<a>" + next() + "</a>");
      }
    `);
    expect(exports.test!()).toBe("<a>end</a>");
  });

  /**
   * Three-layer compose to verify the fix scales beyond two layers.
   * The middle lambda captures `b` AND `c`; the inner-most captures
   * `c`. Each layer wraps its output with a literal tag.
   */
  it("three-layer compose: chained captures", async () => {
    const { exports } = await run(`
      type Next = () => string;
      type Mw = (next: Next) => string;

      function compose3(a: Mw, b: Mw, c: Mw): string {
        return a(() => b(() => c(() => "end")));
      }

      export function test(): string {
        return compose3(
          (next: Next) => "<a>" + next() + "</a>",
          (next: Next) => "<b>" + next() + "</b>",
          (next: Next) => "<c>" + next() + "</c>",
        );
      }
    `);
    expect(exports.test!()).toBe("<a><b><c>end</c></b></a>");
  });
});
