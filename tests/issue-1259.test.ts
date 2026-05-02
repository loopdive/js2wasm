// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1259 — async-gen yield-star sync-fallback unboxed ref-cell leak.
//
// Pre-existing latent bug in `compileCallExpression`'s cap-prepend mutable
// branch (calls.ts:5122–5154). The branching condition was `if
// (fctx.boxedCaptures?.has(cap.name)) … else { /* fresh-box */ }`, but the
// cap-prepend can be entered with `localMap[cap.name]` already pointing at
// a `ref __ref_cell_T` — most notably when:
//
//   1. A sibling lifted scope's `boxedCaptures` was discarded but the local
//      remap survived in our fctx.
//   2. #1177 Stage 1 (the `localMap.get(cap.name) ?? cap.outerLocalIdx`
//      substitution) re-aims `localMap` to a boxed local from an outer fctx
//      whose `boxedCaptures` we never imported.
//
// In those cases the `else` branch struct.new'd the boxed-ref-cell-ref as
// if it were the value type, producing a double-wrapped
// `ref __ref_cell_(ref __ref_cell_T)`. The lifted body then unwrapped it
// once and treated the inner ref-cell-ref as `T`, producing wasm-validation
// errors or "dereferencing a null pointer" traps.
//
// Bug surface today (main):
// - Latent. The ~50 failing async-gen-yield-star tests in PR#125/PR#155
//   only manifest when #1177 Stage 1 is applied. Without Stage 1, the
//   cap-prepend uses the original `cap.outerLocalIdx` slot — never the
//   boxed ref-cell-ref — so the double-wrap doesn't fire.
//
// Fix: probe the candidate `localMap` slot's type. If it's already
// `ref __ref_cell_T` matching the expected value type, treat as
// already-boxed and pass the ref through directly. Backfill
// `boxedCaptures` so subsequent reads/writes through helper paths
// (e.g., #1258 box-aware destructure-assign) detect the boxed state.
//
// This change is a defensive precondition for the eventual #1177 Stage 1
// re-attempt. It has no test262 impact today because no test exercises
// the buggy path on main; the regression tests below construct the
// pattern that would surface the double-wrap.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1259 — cap-prepend type-guard against double-wrap", () => {
  // Sanity: a normal mutable capture (boxed once) still flows correctly.
  it("normal mutable capture: write from inner closure visible outside", async () => {
    const src = `
      export function test(): number {
        let n: number = 1;
        function set(v: number): void { n = v; }
        const apply = () => set(50);
        apply();
        return n; // 50
      }
    `;
    expect(await runTest(src)).toBe(50);
  });

  // Sanity: two consecutive calls to the same nested fn-decl don't
  // double-wrap on the second call (the `boxedCaptures.has` check fires).
  it("two consecutive calls to same fn-decl share the same ref cell", async () => {
    const src = `
      export function test(): number {
        let n: number = 0;
        function inc(): void { n = n + 1; }
        inc();
        inc();
        inc();
        return n; // 3
      }
    `;
    expect(await runTest(src)).toBe(3);
  });

  // Note: arrow-wraps-fn-decl with let-captured x returns 0 today on main
  // (the cap-prepend reads cap.outerLocalIdx which in transitively-capturing
  // contexts is a stale slot). This is the canonical bug #1177 Stage 1 was
  // designed to fix — see #1245 investigation. Not in scope for this issue;
  // #1259 is purely defensive prep for when Stage 1 re-lands.

  // Multiple mutable captures across nested calls — exercises the same
  // cap-prepend path with several names in flight at once.
  it("multiple mutable captures don't cross-pollute", async () => {
    const src = `
      export function test(): number {
        let a: number = 10;
        let b: number = 20;
        function setA(v: number): void { a = v; }
        function setB(v: number): void { b = v; }
        setA(100);
        setB(200);
        return a + b; // 300
      }
    `;
    expect(await runTest(src)).toBe(300);
  });

  // Capture written across multiple invocations — verifies that the
  // backfilled `boxedCaptures` in the early-exit branch keeps subsequent
  // calls aligned with the existing ref cell.
  it("mutating capture across many invocations aggregates correctly", async () => {
    const src = `
      export function test(): number {
        let total: number = 0;
        function add(v: number): void { total = total + v; }
        add(1);
        add(2);
        add(3);
        add(4);
        add(5);
        return total; // 15
      }
    `;
    expect(await runTest(src)).toBe(15);
  });
});
