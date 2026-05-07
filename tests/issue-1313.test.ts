// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1313 — await passthrough must not leave a Promise object on the wasm
// stack. The previous codegen wrapped every async-call result in
// `Promise.resolve(...)` regardless of consumer; await was a passthrough
// (`compileExpressionInner(expr.expression)`), so a Promise object stayed
// on the stack and consumers like string concatenation saw
// `[object Promise]`.
//
// Strategy 1 fix (asymmetric, per the issue's option list): at the call
// site, examine the parent expression. If it's an `AwaitExpression`
// (potentially through Paren / As / NonNull / TypeAssertion wrappers),
// skip the `wrapAsyncReturn` so the wasm function's raw `T` value flows
// straight through the await passthrough to the consumer. For non-await
// consumers (`asyncCall().then(...)`, `const p = asyncCall();`) the
// wrap still fires and produces a real Promise that JS host code can
// chain off — same shape as before.
//
// Tracked: blocks Hono Tier 6 compose, .then() chains on async results,
// any await over a Promise<T> that comes from an async call expression.

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const exports = await compileAndInstantiate(src);
  return await (exports as Record<string, () => Promise<unknown>>).test?.();
}

describe("#1313 — await unwraps async-call return values", () => {
  it("await asyncIdentifier() produces the raw value (acceptance #1)", async () => {
    expect(
      await runTest(`
        async function inner(): Promise<string> { return "x"; }
        export async function test(): Promise<string> {
          return "[" + await inner() + "]";
        }
      `),
    ).toBe("[x]");
  });

  it("await asyncMethodCall() produces the raw value", async () => {
    expect(
      await runTest(`
        class Box {
          async getX(): Promise<string> { return "x"; }
        }
        export async function test(): Promise<string> {
          const b = new Box();
          return "[" + await b.getX() + "]";
        }
      `),
    ).toBe("[x]");
  });

  it("two awaits in one expression — both unwrap independently", async () => {
    expect(
      await runTest(`
        async function a(): Promise<string> { return "A"; }
        async function b(): Promise<string> { return "B"; }
        export async function test(): Promise<string> {
          return (await a()) + (await b());
        }
      `),
    ).toBe("AB");
  });

  it("await with Paren / AsExpression wrapping the call still unwraps", async () => {
    expect(
      await runTest(`
        async function inner(): Promise<string> { return "z"; }
        export async function test(): Promise<string> {
          return "[" + (await (inner() as Promise<string>)) + "]";
        }
      `),
    ).toBe("[z]");
  });

  it("non-await consumer (.then()) still gets a real Promise", async () => {
    // Make sure the asymmetric wrap doesn't break the every-other consumer.
    expect(
      await runTest(`
        async function inner(): Promise<string> { return "y"; }
        export async function test(): Promise<string> {
          const p = inner();
          return p.then((v: string) => "(" + v + ")");
        }
      `),
    ).toBe("(y)");
  });

  it("returning the call directly still works (async fn auto-unwraps)", async () => {
    expect(
      await runTest(`
        async function inner(): Promise<string> { return "raw"; }
        export async function test(): Promise<string> {
          return inner();
        }
      `),
    ).toBe("raw");
  });

  it("await of a number-returning async call coerces correctly", async () => {
    expect(
      await runTest(`
        async function getN(): Promise<number> { return 42; }
        export async function test(): Promise<number> {
          return (await getN()) + 1;
        }
      `),
    ).toBe(43);
  });

  it("await of a boolean-returning async call coerces correctly", async () => {
    expect(
      await runTest(`
        async function getOk(): Promise<boolean> { return true; }
        export async function test(): Promise<string> {
          const b = await getOk();
          return b ? "yes" : "no";
        }
      `),
    ).toBe("yes");
  });
});
