import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(code: string): Promise<unknown> {
  const result = compile(code, { fileName: "test.ts" });
  if (!result.success) throw new Error(`CE: ${result.errors[0]?.message}`);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).main();
}

describe("#1016a — class method param array destructuring defaults", () => {
  it("fires default when array element is missing (exhausted iterator)", { timeout: 30000 }, async () => {
    const result = await run(`
      class C {
        method([x = 23]: any) { return x; }
      }
      export function main(): f64 { return new C().method([]); }
    `);
    expect(result).toBe(23);
  });

  it("does NOT fire default when array element is present", async () => {
    const result = await run(`
      class C {
        method([x = 23]: any) { return x; }
      }
      export function main(): f64 { return new C().method([42]); }
    `);
    expect(result).toBe(42);
  });

  it("fires default for second element when array has only one", async () => {
    const result = await run(`
      class C {
        method([a, b = 99]: any) { return b; }
      }
      export function main(): f64 { return new C().method([1]); }
    `);
    expect(result).toBe(99);
  });

  it("does NOT fire default for null array element (null !== undefined)", async () => {
    const result = await run(`
      class C {
        method([x = 23]: any) { return x; }
      }
      export function main(): f64 { return new C().method([null]) ? 1 : 0; }
    `);
    // null is not undefined, so default should NOT fire; x should be null (falsy → 0)
    expect(result).toBe(0);
  });
});

// #1016c — Parameter-default closure capture suite.
//
// The original `b3318d618` commit scanned parameter-default initializers in
// `compileArrowAsClosure` / `compileNestedFunctionDeclaration` so that
// `function f([] = iter)` would capture `iter`. That scan exposed a latent
// bug at nested-call sites in `expressions/calls.ts` — `cap.outerLocalIdx`
// is read in the wrong fctx, forwarding `__self_cast` instead of the
// captured value. The `__self_cast` then becomes the destructure source,
// silently dropping spec-mandated getter / iterator throws on 24
// dstr/*-get-value-err / *-iter-*-err test262 cases.
//
// The scan has been reverted pending a safe landing of the calls.ts
// capture-index correction (#1177). The empty-pattern early-return in
// `destructureParamArray` and the `__array_from_iter` wasm-closure
// invocation in `runtime.ts` remain — those produce the empty-pattern
// improvements in test262 without depending on the scan.
//
// Tests that require the param-default capture scan are deferred until
// #1177 lands. They exercised behaviour that turned out to require a
// matching call-site fix; landing them as expectations would block the
// PR while the call-site fix is being designed.
