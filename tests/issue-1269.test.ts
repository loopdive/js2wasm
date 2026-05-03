// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1269 — struct field inference Phase 3: consumer-side direct struct.get
// (no box→unbox roundtrip).
//
// Phase 1+2 (#1231) inferred typed struct fields (e.g. `f64` for
// `{x: number, y: number}` literals). Phase 3 teaches the consumer-
// side property-access dispatch in `src/codegen/property-access.ts` to
// use the typed struct.get directly when the receiver is `any`-typed
// but every Phase-1 struct candidate for `propName` agrees on a
// primitive field type. Without Phase 3, the dispatch boxed the
// f64/i32 result via `__box_number` so the externref-fallback path
// could fit a uniform externref result type, only to unbox again at
// the consumer's first f64 use.
//
// The fix (in `compilePropertyAccess`'s externref-receiver branch):
// when accessWasm is externref and all struct candidates for the
// field share a primitive type, narrow `resultWasm` to that type;
// the struct-then arm reads the field unboxed; the extern_get-else
// arm calls `__unbox_number` once.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: Function }).setExports === "function") {
    (imps as { setExports: Function }).setExports(instance.exports);
  }
  return (instance.exports as { test: () => unknown }).test();
}

function watFor(src: string): string {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const dir = join(tmpdir(), `issue-1269-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const wasmPath = join(dir, "module.wasm");
  writeFileSync(wasmPath, r.binary);
  return execSync(`/workspace/node_modules/.bin/wasm-dis ${wasmPath}`, { encoding: "utf-8" });
}

/** Count actual `call $X` occurrences (not import declarations). */
function countCalls(wat: string, importName: string): number {
  return (wat.match(new RegExp(`call \\$${importName}\\b`, "g")) ?? []).length;
}

describe("#1269 — struct field inference Phase 3 — consumer-side direct struct.get", () => {
  // ---------------------------------------------------------------------
  // Behavioural correctness
  // ---------------------------------------------------------------------

  it("explicit `{x: number, y: number}` param: distance({3,4}) === 5", async () => {
    expect(
      await run(`
        export function distance(p: { x: number; y: number }): number {
          return Math.sqrt(p.x * p.x + p.y * p.y);
        }
        export function test(): number {
          return distance({ x: 3, y: 4 });
        }
      `),
    ).toBe(5);
  });

  it("createPoint inferred return: distance(createPoint(3,4)) === 5", async () => {
    expect(
      await run(`
        function createPoint(x: number, y: number) { return { x, y }; }
        function distance(p: { x: number; y: number }): number {
          return Math.sqrt(p.x * p.x + p.y * p.y);
        }
        export function test(): number {
          return distance(createPoint(3, 4));
        }
      `),
    ).toBe(5);
  });

  it("any-typed local + addition: createPoint(3,4) → p.x + p.y === 7", async () => {
    expect(
      await run(`
        function createPoint(x: number, y: number) { return { x, y }; }
        export function test(): number {
          const p: any = createPoint(3, 4);
          return p.x + p.y;
        }
      `),
    ).toBe(7);
  });

  it("any-typed local + multiplication: createPoint(3,4) → p.x * p.y === 12", async () => {
    expect(
      await run(`
        function createPoint(x: number, y: number) { return { x, y }; }
        export function test(): number {
          const p: any = createPoint(3, 4);
          return p.x * p.y;
        }
      `),
    ).toBe(12);
  });

  it("any-typed local + sqrt(p.x² + p.y²) === 5", async () => {
    expect(
      await run(`
        function createPoint(x: number, y: number) { return { x, y }; }
        export function test(): number {
          const p: any = createPoint(3, 4);
          return Math.sqrt(p.x * p.x + p.y * p.y);
        }
      `),
    ).toBe(5);
  });

  // ---------------------------------------------------------------------
  // Structural assertions — no box → unbox roundtrip
  // ---------------------------------------------------------------------

  it("issue example — `distance(createPoint(3,4))` emits zero `__unbox_number` calls", () => {
    const wat = watFor(`
      function createPoint(x: number, y: number) { return { x, y }; }
      export function distance(p: { x: number; y: number }): number {
        return Math.sqrt(p.x * p.x + p.y * p.y);
      }
      export function test(): number { return distance(createPoint(3, 4)); }
    `);
    expect(countCalls(wat, "__unbox_number")).toBe(0);
    expect(countCalls(wat, "__box_number")).toBe(0);
  });

  it("any-typed local: `__box_number` is NOT called on struct.get result (Phase 3 fix)", () => {
    // The struct-then path should emit `struct.get` directly (no boxing).
    // The extern_get-else fallback may still call `__unbox_number` once
    // per field access, but the box→unbox roundtrip is gone.
    const wat = watFor(`
      function createPoint(x: number, y: number) { return { x, y }; }
      export function test(): number {
        const p: any = createPoint(3, 4);
        return p.x + p.y;
      }
    `);
    // No __box_number anywhere — the struct path no longer boxes its
    // f64 field for the dispatch result.
    expect(countCalls(wat, "__box_number")).toBe(0);
  });

  it("any-typed local: `struct.get` reads field directly without intermediate box", () => {
    const wat = watFor(`
      function createPoint(x: number, y: number) { return { x, y }; }
      export function test(): number {
        const p: any = createPoint(3, 4);
        return p.x * p.y;
      }
    `);
    // Two struct.get reads (one per field) appear in the WAT.
    expect(wat).toMatch(/struct\.get \$0 0/);
    expect(wat).toMatch(/struct\.get \$0 1/);
  });
});
