// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1270 — struct field inference Phase 3b: eliminate `ref.as_non_null` on
// `(ref null $T)` struct receivers.
//
// The issue file's `## Problem` section described an older codegen state
// where `ref.as_non_null` was emitted before each `struct.get` on a
// nullable struct local. Subsequent commits
// (`526f5863f` "guard ref.as_non_null with null-check-throw" and
// `ce79a8668` "convert ref.as_non_null traps to TypeError throws")
// refactored the codegen to use an **explicit** null-check + `throw
// $exn` pattern instead of `ref.as_non_null` (which would trap with an
// uncatchable Wasm error rather than a JS-throwable TypeError).
//
// Net effect: the acceptance criterion is already met on `main`. This
// test is a regression sentinel — it locks in the property that
// `ref.as_non_null` is NOT emitted for the canonical pattern, so a
// future codegen change that re-introduces it gets caught at PR time.
//
// The remaining `ref.is_null` checks (the new TypeError-throwing
// pattern) are kept — they preserve correct JS null-deref semantics
// and V8's JIT efficiently dedups repeated checks on the same local
// at runtime (see #1200 / `plan/notes/wasm-opt-coverage.md` for the
// related LICM analysis).

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

function watFor(src: string): string {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const dir = join(tmpdir(), `issue-1270-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const wasmPath = join(dir, "module.wasm");
  writeFileSync(wasmPath, r.binary);
  return execSync(`/workspace/node_modules/.bin/wasm-dis ${wasmPath}`, { encoding: "utf-8" });
}

describe("#1270 — `ref.as_non_null` elimination on `(ref null $T)` struct receivers", () => {
  it("issue canonical: `distance(createPoint(3, 4))` emits zero `ref.as_non_null`", () => {
    const wat = watFor(`
      function createPoint(x: number, y: number) { return { x, y }; }
      export function distance(p: { x: number; y: number }): number {
        return Math.sqrt(p.x * p.x + p.y * p.y);
      }
      export function test(): number { return distance(createPoint(3, 4)); }
    `);
    expect((wat.match(/ref\.as_non_null/g) ?? []).length).toBe(0);
  });

  it("class instance method receiver: zero `ref.as_non_null`", () => {
    const wat = watFor(`
      class Counter {
        count: number = 0;
        inc(): void { this.count++; }
        get(): number { return this.count; }
      }
      export function test(): number {
        const c = new Counter();
        c.inc(); c.inc(); c.inc();
        return c.get();
      }
    `);
    expect((wat.match(/ref\.as_non_null/g) ?? []).length).toBe(0);
  });

  it("nested struct property reads: zero `ref.as_non_null`", () => {
    const wat = watFor(`
      function makeBox() { return { p: { x: 1, y: 2 } }; }
      export function test(): number {
        const b = makeBox();
        return b.p.x + b.p.y;
      }
    `);
    expect((wat.match(/ref\.as_non_null/g) ?? []).length).toBe(0);
  });

  it("class param + multiple field accesses: zero `ref.as_non_null`", () => {
    const wat = watFor(`
      class Foo { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
      export function read(f: Foo): number { return f.x + f.y + f.x; }
      export function test(): number { return read(new Foo(3, 4)); }
    `);
    expect((wat.match(/ref\.as_non_null/g) ?? []).length).toBe(0);
  });

  it("struct field mutation + read: zero `ref.as_non_null`", () => {
    const wat = watFor(`
      function makeBox() { return { x: 1, y: 2 }; }
      export function test(): number {
        const b = makeBox();
        b.x = 10;
        b.y = 20;
        return b.x + b.y;
      }
    `);
    expect((wat.match(/ref\.as_non_null/g) ?? []).length).toBe(0);
  });
});

describe("#1270 — null-deref semantics preserved (TypeError throw, not Wasm trap)", () => {
  it("nullable `(ref null $T)` receiver path uses explicit null-check + `throw $exn` (NOT `ref.as_non_null`)", () => {
    // The canonical case where the receiver flows through a function
    // boundary that returns `(ref null $T)` (createPoint's return is
    // nullable because struct.new's result widens to `ref null` to
    // accept default-init refs in the struct's nested fields).
    // distance reads p.x and p.y, each requires a null-check; the
    // codegen emits `ref.is_null` + `throw` rather than
    // `ref.as_non_null` so the semantics match JS TypeError.
    const wat = watFor(`
      function createPoint(x: number, y: number) { return { x, y }; }
      export function distance(p: { x: number; y: number }): number {
        return Math.sqrt(p.x * p.x + p.y * p.y);
      }
      export function test(): number { return distance(createPoint(3, 4)); }
    `);
    // ref.as_non_null is NOT emitted.
    expect((wat.match(/ref\.as_non_null/g) ?? []).length).toBe(0);
    // ref.is_null IS emitted (>= 1 — the JS-throwable null-check pattern).
    expect((wat.match(/ref\.is_null/g) ?? []).length).toBeGreaterThanOrEqual(1);
    // The throw idiom is preserved.
    expect(wat).toMatch(/throw \$tag\$0/);
  });
});
