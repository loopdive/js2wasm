// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1322 — `Math.random()` has no standalone fallback.
 *
 * Pre-fix `Math.random` was always emitted as a `(import "env" "Math_random"
 * (func ... result f64))` host import. In `--target wasi` mode this either
 * crashed at instantiation (if the import was missing) or returned the
 * stub host's `0` (when a host did provide a default). Neither outcome is
 * spec-conformant.
 *
 * Fix: in `--target wasi` mode, emit a Wasm `Math_random` function that:
 *   1. calls `wasi_snapshot_preview1.random_get(ptr=64, len=8)` to fill 8
 *      bytes of linear memory with entropy
 *   2. reads the bytes back as a `(hi << 32) | lo` i64 pair
 *   3. shifts right 11 to keep the upper 53 significant bits
 *   4. multiplies by 2⁻⁵³ to land in `[0, 1)`
 *
 * The `random_get` import is registered EARLY (in `registerWasiImports`)
 * before any defined helper functions are emitted, so the late-import
 * shift bug (CLAUDE.md "addUnionImports" note) doesn't reorder
 * `__str_*` indices and break their `call N` instructions.
 *
 * JS-host mode (no `--target wasi`) is unchanged — `env.Math_random` is
 * still the host-import path.
 */

/**
 * Compile in WASI mode and instantiate with a Node-side `random_get`
 * implementation that fills the requested buffer with PRNG bytes derived
 * from `Math.random` (sufficient for spec-conformance — the JS-side PRNG
 * stands in for the OS entropy source a real WASI runtime would use).
 */
async function runWasi(src: string): Promise<{ exports: Record<string, unknown>; memory: WebAssembly.Memory }> {
  const r = compile(src, { fileName: "t.ts", target: "wasi" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // Allow the import callback to look up the exported memory after
  // instantiation (JS scope binding — the closure captures `state`,
  // not the not-yet-existent `instance.exports.memory`).
  const state: { memory: WebAssembly.Memory | null } = { memory: null };
  const imports = {
    wasi_snapshot_preview1: {
      random_get: (ptr: number, len: number): number => {
        const view = new Uint8Array(state.memory!.buffer);
        for (let i = 0; i < len; i++) view[ptr + i] = Math.floor(Math.random() * 256);
        return 0;
      },
    },
  };
  const m = await WebAssembly.compile(r.binary);
  const inst = await WebAssembly.instantiate(m, imports);
  state.memory = inst.exports.memory as WebAssembly.Memory;
  return { exports: inst.exports as Record<string, unknown>, memory: state.memory };
}

describe("#1322 — Math.random() in WASI mode uses random_get", () => {
  it("returns a float in [0, 1)", async () => {
    const { exports } = await runWasi(`
      export function r(): number { return Math.random(); }
    `);
    for (let i = 0; i < 50; i++) {
      const v = (exports.r as () => number)();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("repeated calls return different values (not constant 0)", async () => {
    const { exports } = await runWasi(`
      export function r(): number { return Math.random(); }
    `);
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) seen.add((exports.r as () => number)());
    // With ~53 bits of entropy each call, all 20 should be distinct
    expect(seen.size).toBeGreaterThan(15);
  });

  it("Math.floor(Math.random() * N) lands in [0, N)", async () => {
    const { exports } = await runWasi(`
      export function dice(): number { return Math.floor(Math.random() * 6); }
    `);
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 600; i++) {
      const v = (exports.dice as () => number)();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      expect(Number.isInteger(v)).toBe(true);
      counts[v]++;
    }
    // Each face should hit at least once over 600 trials (extremely
    // conservative; the expected hit count per face is ~100).
    for (const c of counts) expect(c).toBeGreaterThan(0);
  });

  it("WASI binary imports `wasi_snapshot_preview1.random_get` (not `env.Math_random`)", async () => {
    const r = compile(
      `
      export function r(): number { return Math.random(); }
    `,
      { fileName: "t.ts", target: "wasi" },
    );
    expect(r.success).toBe(true);
    const m = await WebAssembly.compile(r.binary);
    const decls = WebAssembly.Module.imports(m);
    const names = decls.map((d) => `${d.module}.${d.name}`);
    expect(names).toContain("wasi_snapshot_preview1.random_get");
    // The host import must NOT be present in WASI mode
    expect(names).not.toContain("env.Math_random");
  });

  it("JS-host mode regression guard: env.Math_random remains the path (no random_get)", async () => {
    // Default target (gc) keeps the host import. Don't instantiate — just
    // verify the import shape is unchanged from pre-fix behavior.
    const r = compile(
      `
      export function r(): number { return Math.random(); }
    `,
      { fileName: "t.ts" },
    );
    expect(r.success).toBe(true);
    const m = await WebAssembly.compile(r.binary);
    const decls = WebAssembly.Module.imports(m);
    const names = decls.map((d) => `${d.module}.${d.name}`);
    expect(names).toContain("env.Math_random");
    expect(names).not.toContain("wasi_snapshot_preview1.random_get");
  });

  it("Math.random alongside other Math methods (regression guard for shared registry)", async () => {
    // Verify that the shared `pendingMathMethods` collection is not
    // disturbed when `random` is added — sin/cos still inline correctly.
    const { exports } = await runWasi(`
      export function trig(x: number): number { return Math.sin(x) + Math.cos(x); }
      export function r(): number { return Math.random(); }
    `);
    // sin(0) + cos(0) = 0 + 1 = 1
    expect((exports.trig as (x: number) => number)(0)).toBeCloseTo(1, 10);
    const v = (exports.r as () => number)();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});
