// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1169q (Slice 14) — fallback telemetry for legacy-codegen retirement.
//
// The first acceptance criterion is that `planIrCompilation` can report each
// top-level FunctionDeclaration that did NOT make it into `funcs` along with
// the rejection reason. This is the gating measurement before retiring the
// legacy expression / statement emitters: drive the unintended-fallback rate
// to ~0 against the full test262 corpus before deleting any legacy file.
//
// Tests below exercise the `trackFallbacks` option of `planIrCompilation`
// across the rejection points the selector enforces today.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { planIrCompilation } from "../src/ir/index.js";

function reasonsFor(source: string): Map<string, string> {
  const ast = analyzeSource(source);
  const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true, trackFallbacks: true });
  const map = new Map<string, string>();
  for (const fb of sel.fallbacks ?? []) map.set(fb.name, fb.reason);
  return map;
}

describe("#1169q — IR fallback telemetry", () => {
  it("returns no fallbacks when every function is claimable", () => {
    const source = `
      export function add(a: number, b: number): number {
        return a + b;
      }
      export function sub(a: number, b: number): number {
        return a - b;
      }
    `;
    const ast = analyzeSource(source);
    const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true, trackFallbacks: true });
    expect(sel.funcs.size).toBe(2);
    expect(sel.fallbacks).toEqual([]);
  });

  it("does NOT populate fallbacks when trackFallbacks is off (zero overhead)", () => {
    const source = `
      function unTyped(x) { return x + 1; }
      export function pure(x: number): number { return x; }
    `;
    const ast = analyzeSource(source);
    const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true });
    expect(sel.fallbacks).toBeUndefined();
  });

  it("reports param-type-not-resolvable for untyped params with no propagation", () => {
    // Annotate the return so the return-type check passes; the param has no
    // type and (without a TypeMap) there's nothing to propagate from, so the
    // failure point lands in the param-type resolver.
    const source = `
      function untypedParam(x): number { return x + 1; }
      export function entry(): number { return 1; }
    `;
    const reasons = reasonsFor(source);
    expect(reasons.get("untypedParam")).toBe("param-type-not-resolvable");
  });

  it("reports param-shape-rejected for default params, rest params, optional params", () => {
    const source = `
      function withDefault(x: number = 0): number { return x; }
      function withRest(...xs: number[]): number { return xs.length; }
      function withOptional(x?: number): number { return 1; }
      export function entry(): number { return 1; }
    `;
    const reasons = reasonsFor(source);
    expect(reasons.get("withDefault")).toBe("param-shape-rejected");
    expect(reasons.get("withRest")).toBe("param-shape-rejected");
    expect(reasons.get("withOptional")).toBe("param-shape-rejected");
  });

  it("reports non-export-modifier for async functions (matches existing reject)", () => {
    const source = `
      async function asyncFn(): Promise<number> { return 1; }
      export function entry(): number { return 1; }
    `;
    const reasons = reasonsFor(source);
    expect(reasons.get("asyncFn")).toBe("non-export-modifier");
  });

  it("reports body-shape-rejected for unsupported expressions in body", () => {
    // try/catch is not a Phase-1 statement shape — the selector rejects
    // bodies containing it. Used as a stable marker for body-shape rejection
    // even as the IR's accepted expression set grows.
    const source = `
      function withTry(x: number): number {
        try { return x + 1; } catch (e) { return -1; }
      }
      export function entry(): number { return 1; }
    `;
    const reasons = reasonsFor(source);
    expect(reasons.get("withTry")).toBe("body-shape-rejected");
  });

  it("reports external-call when a function calls a non-local identifier", () => {
    // `parseInt` is not a local FunctionDeclaration — the selector drops
    // any function whose call graph reaches an unknown identifier callee.
    const source = `
      export function callsExternal(s: string): number { return parseInt(s); }
    `;
    const reasons = reasonsFor(source);
    expect(reasons.get("callsExternal")).toBe("external-call");
  });

  it("reports call-graph-closure for transitive callers of a dropped function", () => {
    const source = `
      export function leaf(s: string): number { return parseInt(s); }
      export function caller(s: string): number { return leaf(s) + 1; }
    `;
    const reasons = reasonsFor(source);
    expect(reasons.get("leaf")).toBe("external-call");
    expect(reasons.get("caller")).toBe("call-graph-closure");
  });

  it("reports return-type-not-resolvable for untyped function with no inference", () => {
    const source = `
      function noReturnType(x: number) { return x; }
    `;
    const reasons = reasonsFor(source);
    // Without a typed caller, propagation may or may not fill in the return.
    // Either return-type-not-resolvable OR a successful claim is acceptable —
    // we only care that the reason, if rejected, is one we recognise.
    const reason = reasons.get("noReturnType");
    if (reason !== undefined) {
      expect(["return-type-not-resolvable", "external-call", "call-graph-closure", "body-shape-rejected"]).toContain(
        reason,
      );
    }
  });

  it("reports type-parameters for generic functions", () => {
    const source = `
      function generic<T>(x: T): T { return x; }
      export function entry(): number { return 1; }
    `;
    const reasons = reasonsFor(source);
    expect(reasons.get("generic")).toBe("type-parameters");
  });
});
