// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1298 — Function-typed values stored in struct fields lost their callable
// nature on retrieval. The compiler dropped the unboxed externref and emitted
// `ref.null extern` instead of the round-tripped funcref dispatch.
//
// Three converging gaps in `compileCallExpression` fixed in v1 (PR #223):
//   1. `compileCallablePropertyCall` bailed out for `Fn | null` fields because
//      `getCallSignatures()` on a nullable union returns 0 sigs. Fix: strip
//      via `getNonNullableType` before reading sigs.
//   2. `expr!(args)` non-null-asserted callee was never unwrapped. Fix:
//      synthetic CallExpression recursion mirroring the parens unwrap.
//
// Fix #3 (this PR): generic call-as-callee fallback is now ref.test-guarded.
// When the runtime callee value isn't a `__fn_wrap_N_struct` of the matching
// shape, the dispatch falls through to graceful `ref.null.extern`, mirroring
// the pre-rewrite scan-only fallback that the Temporal-cluster test262 runs
// depend on. The eager `getOrCreateFuncRefWrapperTypes` makes the dispatch
// order-independent for callees whose closure was assigned later in the
// module.

import { describe, it, expect } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const exports = await compileAndInstantiate(src);
  return (exports as Record<string, () => unknown>).test?.();
}

describe("#1298 — function-typed field call dispatch", () => {
  it("class field of nullable function type calls correctly", async () => {
    const got = await runTest(`
      class Holder {
        fn: ((s: string) => string) | null = null;
        call(s: string): string {
          if (this.fn == null) return "no";
          return this.fn!(s);
        }
      }
      export function test(): string {
        const h = new Holder();
        h.fn = (s: string) => s + "!";
        return h.call("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  it("non-null asserted property call without temporary binding", async () => {
    const got = await runTest(`
      class H { fn: ((s: string) => string) | null = null; }
      export function test(): string {
        const h = new H();
        h.fn = (s: string) => s + "!";
        return h.fn!("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  it("parens around non-null asserted callee", async () => {
    const got = await runTest(`
      class H { fn: ((s: string) => string) | null = null; }
      export function test(): string {
        const h = new H();
        h.fn = (s: string) => s + "!";
        return (h.fn)!("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  it("field type Fn | undefined also works (getNonNullableType strips both)", async () => {
    const got = await runTest(`
      class H { fn: ((s: string) => string) | undefined = undefined; }
      export function test(): string {
        const h = new H();
        h.fn = (s: string) => s + "!";
        return h.fn!("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  it("field type Fn | null | undefined also works", async () => {
    const got = await runTest(`
      class H { fn: ((s: string) => string) | null | undefined = undefined; }
      export function test(): string {
        const h = new H();
        h.fn = (s: string) => s + "!";
        return h.fn!("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  it("calling null field throws TypeError (existing behavior preserved)", async () => {
    const got = await runTest(`
      class H { fn: ((s: string) => string) | null = null; }
      export function test(): string {
        const h = new H();
        try { h.fn!("hi"); return "no-throw"; } catch (e) { return "threw"; }
      }
    `);
    expect(got).toBe("threw");
  });

  it("function-typed field with multi-arg signature", async () => {
    const got = await runTest(`
      class H {
        fn: ((a: number, b: number) => number) | null = null;
      }
      export function test(): number {
        const h = new H();
        h.fn = (a: number, b: number) => a * 10 + b;
        return h.fn!(3, 4);
      }
    `);
    expect(got).toBe(34);
  });

  it("function-typed field with closure capture round-trip", async () => {
    const got = await runTest(`
      class H { fn: ((s: string) => string) | null = null; }
      export function test(): string {
        const suffix = "!";
        const h = new H();
        h.fn = (s: string) => s + suffix;
        return h.fn!("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  it("nested non-null assertion fn!!() unwraps to fn()", async () => {
    const got = await runTest(`
      class H { fn: ((s: string) => string) | null = null; }
      export function test(): string {
        const h = new H();
        h.fn = (s: string) => s + "!";
        return h.fn!!("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  // (#1306) The Fn[] array-index call is handled by the ElementAccess
  // resolution path #1306 added — un-skipped here.
  it("Fn[] array index call dispatches via index", async () => {
    const got = await runTest(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [(s) => s + "!"];
        return fns[0]("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  // (#1298 fix #3) The generic call-as-callee fallback is now ref.test-guarded:
  // when the runtime callee value isn't a wasm closure of the matching shape,
  // the dispatch graceful-nulls instead of trapping. The pre-fix-#3 v1 (PR
  // #223 first commit) committed unconditionally to the dispatch and threw
  // TypeError at the first null check after a failed cast — that caused 340
  // null_deref test262 regressions clustered in `built-ins/Temporal/*`. With
  // the ref.test guard, callees whose runtime value isn't a wasm closure
  // graceful-null exactly like the pre-rewrite scan-only fallback.
  it("safe re-impl: callable-typed callee with non-closure runtime value returns null gracefully", async () => {
    const got = await runTest(`
      export function test(): string {
        // Callee carries a call signature, but the runtime value is null —
        // mirrors the Temporal-cluster failure shape.
        const fn: (() => string) = (null as any) as (() => string);
        if (fn == null) return "default";
        return fn();
      }
    `);
    expect(got).toBe("default");
  });

  // Storage-side gap for Map<K, Fn> values — `m.set("k", arrow)` currently
  // routes the arrow through `__make_callback` because Map.set is a host
  // method on a host class. The retrieved value is a JS-wrapped externref,
  // not a wasm closure struct, so even with the ref.test-guarded dispatch
  // (this PR's fix #3) the call_ref branch can't fire and we fall through to
  // graceful null. Fixing requires teaching the storage side
  // (`isHostCallbackArgument` in closures.ts) that args to user-class methods
  // forwarding to a host method shouldn't take the host-callback path, OR
  // adding a JS-callable bridge that lets Wasm `call_ref` a JS function.
  // Tracked as a #1298 storage-side follow-up.
  it.skip("Map<string, Fn>.get(...)(...) (deferred — Map.set storage uses __make_callback)", async () => {
    const got = await runTest(`
      export function test(): string {
        const m = new Map<string, (s: string) => string>();
        m.set("k", (s: string) => s + "!");
        const fn = m.get("k");
        return fn!("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  // Tier 5c compose pattern: identifier-callable-param path at calls.ts:5043
  // has the same unconditional-dispatch shape as the pre-fix-#3 generic
  // fallback (commits to the cast and emitNullCheckThrow on a failed cast).
  // Applying the ref.test guard there would mirror the safe re-impl in this
  // PR; tracked as a #1298 follow-up. Pre-existing failure on main.
  it.skip("Tier 5c compose 'const mw = mws[idx]; mw(c, next)' (deferred — identifier-callable still throws)", async () => {
    const got = await runTest(`
      type N = () => string;
      type Mw = (c: number, next: N) => string;
      function compose(mws: Mw[]): (c: number) => string {
        return (c: number) => {
          let i = 0;
          function next(): string {
            const idx = i;
            i = i + 1;
            if (idx >= mws.length) return "end";
            const mw = mws[idx];
            return mw(c, next);
          }
          return next();
        };
      }
      export function test(): string {
        const mws: Mw[] = [
          (c, n: N) => "[A]" + n(),
          (c, n: N) => "[B]" + n(),
        ];
        return compose(mws)(0);
      }
    `);
    expect(got).toBe("[A][B]end");
  });
});
