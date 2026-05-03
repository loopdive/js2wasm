import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1301 — Closure environment field-type mismatch in array-of-arrow-middleware
 * patterns.
 *
 * The bug: when an inline arrow function has a parameter whose name shadows a
 * function declaration in an enclosing scope, calls to that name inside the
 * arrow body were resolving to the outer function via `funcMap` BEFORE the
 * arrow's own param/local was checked. The outer-function call path then
 * prepended the outer's nested captures using local indices that pointed to
 * unrelated locals in the arrow's own frame, producing struct.new validation
 * errors:
 *
 *   struct.new[0] expected type f64, found local.get of type anyref
 *
 * The fix (`src/codegen/expressions/calls.ts`): in `compileCallExpression` the
 * regular-function-call path now checks `fctx.localMap.has(funcName)` first.
 * If true, the local lexically shadows any outer function/closure of the same
 * name; we skip funcMap/closureMap and fall through to the local-callable
 * dispatch path (call_ref through the local).
 */
describe("#1301 closure environment field-type mismatch (param shadowing outer fn name)", () => {
  it("two arrow middlewares each calling param `next` (same name as outer fn) compile + validate", () => {
    const src = `
      type Next = () => string;
      type Middleware = (c: Context, next: Next) => string;

      class Context { path: string; constructor(p: string) { this.path = p; } }

      function compose(middlewares: Middleware[]): (c: Context) => string {
        return (c: Context) => {
          let i = 0;
          function next(): string {
            const idx = i;
            i = i + 1;
            if (idx >= middlewares.length) return "end";
            return middlewares[idx](c, next);
          }
          return next();
        };
      }

      export function test(): string {
        const mws: Middleware[] = [
          (c: Context, next: Next) => "[A]" + next(),
          (c: Context, next: Next) => "[B]" + next(),
        ];
        return compose(mws)(new Context("/x"));
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    // The literal bug: `WebAssembly.Module(...)` rejected the binary with
    // "struct.new[0] expected type f64, found local.get of type anyref".
    // The fix lands when validation succeeds.
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
  });

  it("single-mw recursive compose with arrow `next` param compiles + validates (regression guard)", () => {
    // Minimal repro that triggers the same shadow path with one arrow.
    const src = `
      type N = () => string;
      type Mw = (c: number, next: N) => string;

      function compose(mws: Mw[]): (c: number) => string {
        return (c: number) => {
          let i = 0;
          function next(): string {
            const idx = i;
            i = i + 1;
            if (idx >= mws.length) return "end";
            return mws[idx](c, next);
          }
          return next();
        };
      }

      export function test(): string {
        const mws: Mw[] = [
          (c: number, next: N) => "[A]" + next(),
        ];
        return compose(mws)(0);
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
  });

  it("non-shadowing case still compiles + executes correctly (no regression)", async () => {
    // When the arrow's param name does NOT shadow an outer function, behavior
    // must be unchanged. This locks in that the localMap-first check doesn't
    // accidentally divert direct calls when there's no actual shadow.
    const src = `
      function helper(x: number): number { return x + 1; }

      function outer(): number {
        const f = (n: number) => helper(n) + helper(n + 1);
        return f(10);
      }

      export function test(): number {
        return outer();
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    // helper(10) + helper(11) = 11 + 12 = 23
    expect((instance.exports.test as () => number)()).toBe(23);
  });

  it("local shadowing outer fn with same name dispatches via call_ref through local", async () => {
    // The fix is observable end-to-end here: calling `f()` inside the arrow
    // refers to the arrow's own `f` param (the closure), not the outer `f` fn.
    const src = `
      type F = () => number;

      function f(): number { return 100; }  // outer f

      function caller(callback: F): number {
        const wrap = (f: F) => f();  // inner f shadows outer f
        return wrap(callback);
      }

      export function test(): number {
        return caller(() => 42);
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    // Without the fix, `f()` inside `wrap` would resolve to the outer `f`
    // returning 100. With the fix, it resolves to the param `f` returning 42.
    expect((instance.exports.test as () => number)()).toBe(42);
  });
});
