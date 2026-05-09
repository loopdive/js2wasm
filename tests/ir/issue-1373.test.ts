// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1373 Phase A — IR claim infrastructure for async functions.
//
// Phase A scope (this PR):
//   1. New IrFallbackReason `"async-function"` distinct from
//      `"async-generator"` (`async function*`) and from generic
//      `"non-export-modifier"` / `"deferred-feature"`.
//   2. Selector buckets async functions (no asterisk) into the new
//      reason. Async generators continue to land in `"async-generator"`.
//   3. New IrInstr kinds `await` / `async.return` / `async.throw` are
//      defined as types only — no lowering yet (Phase C / #1373b).
//
// Phase A is purely additive: async functions remain rejected by the IR
// (they fall back to legacy codegen), but their rejection reason is now
// distinct, which lets Phase C flip the gate from deferred → claimed
// without touching the bucket name.

import { describe, expect, it } from "vitest";
import { ts } from "../../src/ts-api.js";
import { planIrCompilation } from "../../src/ir/select.js";

function parseSource(src: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", src, ts.ScriptTarget.ES2022, true);
}

describe("#1373 Phase A — async-function fallback bucket", () => {
  it("plain `async function f() {}` lands in async-function (not non-export-modifier)", () => {
    const sf = parseSource(`
      async function f() { return 1; }
    `);
    const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
    const fb = sel.fallbacks?.find((f) => f.name === "f");
    expect(fb?.reason).toBe("async-function");
  });

  it("`export async function f() {}` lands in async-function (not non-export-modifier)", () => {
    const sf = parseSource(`
      export async function f() { return 1; }
    `);
    const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
    const fb = sel.fallbacks?.find((f) => f.name === "f");
    expect(fb?.reason).toBe("async-function");
  });

  it("`async function* g() {}` continues to land in async-generator (unchanged)", () => {
    const sf = parseSource(`
      async function* g() { yield 1; }
    `);
    const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
    const fb = sel.fallbacks?.find((f) => f.name === "g");
    expect(fb?.reason).toBe("async-generator");
  });

  it("non-async function unaffected by the new bucket", () => {
    const sf = parseSource(`
      export function f(): number { return 1; }
    `);
    const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
    // No fallback — the function should be IR-claimable.
    const fb = sel.fallbacks?.find((f) => f.name === "f");
    expect(fb).toBeUndefined();
  });

  it("async-function reason stays distinct from non-export-modifier", () => {
    // A function with BOTH `declare` (non-export) AND no `async` keyword
    // should still land in non-export-modifier, not async-function.
    // (Use a generator to make it a non-export-modifier candidate
    // distinct from async — `function*` without `async` is a sync
    // generator and lands in body-shape-rejected, not modifier-rejected.
    // So just verify that the new bucket only fires for async.)
    const sf = parseSource(`
      async function f() { return 1; }
      export async function g() { return 2; }
    `);
    const sel = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
    const fbF = sel.fallbacks?.find((fb) => fb.name === "f");
    const fbG = sel.fallbacks?.find((fb) => fb.name === "g");
    expect(fbF?.reason).toBe("async-function");
    expect(fbG?.reason).toBe("async-function");
  });
});
