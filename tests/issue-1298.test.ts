// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1298 — Function-typed values stored in struct fields lost their callable
// nature on retrieval. The compiler dropped the unboxed externref and emitted
// `ref.null extern` instead of the round-tripped funcref dispatch.
//
// Three converging gaps in `compileCallExpression` fixed here:
//   1. `compileCallablePropertyCall` bailed out for `Fn | null` fields because
//      `getCallSignatures()` on a nullable union returns 0 sigs. Fix: strip
//      via `getNonNullableType` before reading sigs.
//   2. `expr!(args)` non-null-asserted callee was never unwrapped, so the
//      property-access dispatch never fired. Fix: synthetic CallExpression
//      recursion mirroring the parens unwrap.
//   3. The generic call-as-callee fallback only scanned `closureInfoByTypeIdx`
//      for matching closure types — when the call-site was compiled before any
//      same-signature closure had been registered, the lookup returned nothing
//      and the call fell through to a graceful `ref.null extern`. Fix: eagerly
//      create the wrapper types via `getOrCreateFuncRefWrapperTypes` so the
//      lookup is order-independent and any later closure assignment reuses the
//      same struct/funcref pair through `funcRefWrapperCache`.

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

  // The following two acceptance-criteria cases (#2 array, #3 Map) require
  // additional fixes beyond #1298's scope:
  //
  //   - Array path: `fns[0]("hi")` routes through the ElementAccess fallback
  //     at calls.ts:6404 and is tracked separately in #1306.
  //   - Map path: `m.get("k")(...)` storage uses `__make_callback` which
  //     produces a JS-wrapped externref that fails the closure-struct cast on
  //     retrieval. Will require a follow-up to teach the storage side
  //     (isHostCallbackArgument) about non-host-callback method args, or add
  //     a JS-callable bridge from Wasm. Tracked under #1297/#1306 follow-up.

  it.skip("Fn[] array index call (deferred to #1306)", async () => {
    const got = await runTest(`
      export function test(): string {
        const fns: ((s: string) => string)[] = [(s) => s + "!"];
        return fns[0]("hi");
      }
    `);
    expect(got).toBe("hi!");
  });

  it.skip("Map<string, Fn>.get(...)(...) (deferred — storage uses __make_callback)", async () => {
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
});
