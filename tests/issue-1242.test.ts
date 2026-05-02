// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1242 — WeakMap / WeakSet backed by strong references.
//
// Investigation finding (2026-05-02): split scope.
//
// **WeakSet works on main today** — all 4 documented patterns pass:
//   - new WeakSet() + add/has + delete
//   - add returns the WeakSet (chainable)
//
// **WeakMap FAILS** with wasm validation errors at instantiation for
// every documented set/get/has/delete pattern:
//   - `wm.set(k, 42); wm.get(k)` → "call[0] expected externref, found f64"
//   - `wm.set(k, v); wm.has(k)` → "call[2] expected f64, found externref"
//
// Tech lead approved a partial test PR landing the WeakSet portion,
// with WeakMap deferred to a dedicated follow-up issue (#1283 in
// sprint 48). The WeakMap host-import dispatch needs proper
// investigation that wasn't feasible at end-of-sprint.
//
// This file therefore covers WeakSet only. WeakMap tests are in
// `tests/issue-1283.test.ts` once that fix lands.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true, allowJs: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1242 — WeakSet (WeakMap deferred to #1283)", () => {
  it("WeakSet basic add + has on object value", async () => {
    const src = `
      export function test(): number {
        const ws: any = new WeakSet();
        const v: any = { id: 1 };
        ws.add(v);
        return ws.has(v) ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  it("WeakSet has returns false for object never added", async () => {
    const src = `
      export function test(): number {
        const ws: any = new WeakSet();
        const v: any = { id: 1 };
        return ws.has(v) ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("WeakSet delete removes the value", async () => {
    const src = `
      export function test(): number {
        const ws: any = new WeakSet();
        const v: any = { id: 1 };
        ws.add(v);
        ws.delete(v);
        return ws.has(v) ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("WeakSet handles multiple distinct objects", async () => {
    const src = `
      export function test(): number {
        const ws: any = new WeakSet();
        const a: any = { id: 1 };
        const b: any = { id: 2 };
        ws.add(a);
        ws.add(b);
        // Both must be present
        return (ws.has(a) ? 1 : 0) + (ws.has(b) ? 10 : 0);
      }
    `;
    expect(await runTest(src)).toBe(11);
  });

  it("WeakSet new instance is empty", async () => {
    const src = `
      export function test(): number {
        const ws: any = new WeakSet();
        const v: any = { id: 1 };
        return ws.has(v) ? 99 : 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });
});
