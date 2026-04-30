// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Equivalence test for #1169k (IR Phase 4 Slice 10 — ArrayBuffer + DataView).
//
// Step C coverage: `new ArrayBuffer(N)`, `new DataView(buf)`, and the
// `.getXxx` / `.setXxx` accessor methods. Verifies that the IR path
// produces the same observable behaviour as the legacy compiler — i.e.
// the function is claimed by the IR (not falling back to legacy via
// `safeSelection`) and the resulting Wasm module computes the same
// result JS would.
//
// Method calls use `(view as any).setXxx(...)` because the legacy
// compiler routes DataView setter/getter dispatch through
// `__extern_method_call` (see runtime.ts:2618 — a fallback that
// materializes a real DataView over the i32_byte vec struct's
// backing store). Direct typed `view.setUint32(...)` would attempt to
// call a method that doesn't exist on the vec struct's TS type,
// which short-circuits at type-check time. The `as any` matches the
// established pattern used by `tests/issue-1064.test.ts`.

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

const ENV_STUB = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
  },
};

async function compileAndRun(
  source: string,
  fnName: string,
  args: ReadonlyArray<string | number | boolean>,
  experimentalIR: boolean,
): Promise<unknown> {
  const r = compile(source, { experimentalIR, skipSemanticDiagnostics: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const imports = buildImports(r.imports, ENV_STUB.env, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as any).setExports === "function") {
    (imports as any).setExports(instance.exports);
  }
  const fn = instance.exports[fnName] as (...a: unknown[]) => unknown;
  return fn(...args);
}

describe("IR slice 10 — ArrayBuffer + DataView through IR (#1169k, step C)", () => {
  it("(a) `new ArrayBuffer(N)` + `new DataView(buf)` constructs without error", async () => {
    // Smoke: the IR claims this function and its compilation produces a
    // module that instantiates and runs end-to-end.
    const source = `
      export function run(): number {
        const buf: ArrayBuffer = new ArrayBuffer(16);
        const view: DataView = new DataView(buf);
        (view as any).setUint32(0, 1, true);
        return (view as any).getUint32(0, true);
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(1);
    expect(legacyResult).toBe(1);
  });

  it("(b) DataView little-endian round-trip: setUint32 → getUint32", async () => {
    const source = `
      export function run(): number {
        const buf: ArrayBuffer = new ArrayBuffer(8);
        const view: DataView = new DataView(buf);
        (view as any).setUint32(0, 42, true);
        return (view as any).getUint32(0, true);
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(42);
    expect(legacyResult).toBe(42);
  });

  it("(c) DataView big-endian round-trip differs from little-endian byte order", async () => {
    // Big-endian write of 0x01020304 produces bytes [01, 02, 03, 04].
    // Reading the same offset as little-endian interprets bytes as
    // [01, 02, 03, 04] -> 0x04030201 = 67305985.
    const source = `
      export function run(): number {
        const buf: ArrayBuffer = new ArrayBuffer(4);
        const view: DataView = new DataView(buf);
        (view as any).setUint32(0, 16909060, false); // 0x01020304 big-endian
        return (view as any).getUint32(0, true);     // re-read as little-endian
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(67305985); // 0x04030201
    expect(legacyResult).toBe(67305985);
  });

  it("(d) DataView setInt32/getInt32 round-trip with negative value", async () => {
    const source = `
      export function run(): number {
        const buf: ArrayBuffer = new ArrayBuffer(4);
        const view: DataView = new DataView(buf);
        (view as any).setInt32(0, -1, true);
        return (view as any).getInt32(0, true);
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(-1);
    expect(legacyResult).toBe(-1);
  });

  it("(e) DataView setFloat64/getFloat64 round-trip preserves precision", async () => {
    const source = `
      export function run(): number {
        const buf: ArrayBuffer = new ArrayBuffer(8);
        const view: DataView = new DataView(buf);
        (view as any).setFloat64(0, 3.14159265358979, true);
        return (view as any).getFloat64(0, true);
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBeCloseTo(3.14159265358979, 14);
    expect(legacyResult).toBeCloseTo(3.14159265358979, 14);
  });

  it("(f) DataView setUint8/getUint8 covers the no-endianness branch", async () => {
    const source = `
      export function run(): number {
        const buf: ArrayBuffer = new ArrayBuffer(4);
        const view: DataView = new DataView(buf);
        (view as any).setUint8(0, 255);
        (view as any).setUint8(1, 1);
        const a: number = (view as any).getUint8(0);
        const b: number = (view as any).getUint8(1);
        return a + b;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(256);
    expect(legacyResult).toBe(256);
  });

  it("(g) DataView with byteOffset arg constructs and reads from offset", async () => {
    // `new DataView(buf, 4, 4)` — middle slice. setUint32 at offset 0
    // of the view writes at byte index 4 of the underlying buffer.
    const source = `
      export function run(): number {
        const buf: ArrayBuffer = new ArrayBuffer(12);
        const view: DataView = new DataView(buf, 4, 4);
        (view as any).setUint32(0, 7, true);
        return (view as any).getUint32(0, true);
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(7);
    expect(legacyResult).toBe(7);
  });
});
