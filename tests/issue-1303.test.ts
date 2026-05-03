// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1303 — IR codegen path: bitwise ops on operands that lower to non-f64
// types (notably externref). Surfaced compiling lodash partial.js
// `mergeData` where module-level `var WRAP_BIND_FLAG = 1` references
// arrive as externref via `global.get`, then feed `&`/`|` whose
// emitJsToInt32 sequence starts with `f64.trunc` and rejects them.
//
// The fix in `src/ir/lower.ts` adds a defensive `coerceToF64ForBitwise`
// helper invoked only for `js.bitand|bitor|bitxor|shl|shr_s|shr_u` IR
// instructions. If `typeOf(operand).val.kind` isn't `"f64"`, it emits
// `call __unbox_number` to coerce externref → f64 before the trunc.
//
// The legacy codegen path (binary-ops.ts) is NOT covered by this fix —
// see #1305 for the legacy / root-cause follow-up. That's why
// `lodash-es/partial.js` still fails validation after this fix.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<unknown> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  // Validate the binary up-front — surface validator errors here rather
  // than during instantiation so the assertion error message is clean.
  new WebAssembly.Module(r.binary);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as { setExports?: Function }).setExports === "function") {
    (imports as { setExports: Function }).setExports(instance.exports);
  }
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#1303 — IR bitwise ops coerce non-f64 operands to f64 defensively", () => {
  /**
   * Baseline: bitwise op on f64 typed parameters compiles and runs.
   * The `coerceToF64ForBitwise` helper must be a no-op for already-f64
   * operands — codegen should be byte-identical to before the fix.
   */
  it("bitwise op on f64 operands still works (no-op coercion)", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const x: number = 5;
        const y: number = 3;
        return x & y;  // 5 & 3 = 1
      }
    `);
    expect(result).toBe(1);
  });

  /**
   * Bitwise OR composition matching mergeData's pattern (chained `|`).
   * Each intermediate result is f64; both operands are f64. This
   * verifies the helper doesn't break composed bitwise expressions.
   */
  it("chained bitwise ORs (mergeData WRAP_*_FLAG pattern) compose correctly", async () => {
    const result = await compileAndRun(`
      const FLAG_BIND = 1;
      const FLAG_KEY = 2;
      const FLAG_ARY = 128;
      export function test(): number {
        return FLAG_BIND | FLAG_KEY | FLAG_ARY;  // 1 | 2 | 128 = 131
      }
    `);
    expect(result).toBe(131);
  });

  /**
   * Bitwise AND combined with comparison — mergeData's pattern of
   * `srcBitmask & WRAP_BIND_FLAG ? 0 : WRAP_CURRY_BOUND_FLAG`.
   */
  it("bitwise AND used as ternary condition (mergeData branch pattern)", async () => {
    const result = await compileAndRun(`
      const FLAG_BIND = 1;
      const FLAG_CURRY_BOUND = 4;
      export function test(): number {
        const srcBitmask = 5;  // BIND | (4) — has FLAG_BIND set
        return (srcBitmask & FLAG_BIND) ? 0 : FLAG_CURRY_BOUND;
      }
    `);
    expect(result).toBe(0);
  });

  /**
   * Comparison of bitwise-OR result with a bitwise-OR constant, the
   * exact shape from mergeData line 39:
   *   `newBitmask < (WRAP_BIND_FLAG | WRAP_BIND_KEY_FLAG | WRAP_ARY_FLAG)`.
   * The right-hand side composes 3 ORs into a constant, then `<`
   * against the accumulated bitmask. Validates that bitwise-then-compare
   * works correctly (both operands stay numeric).
   */
  it("bitmask < (FLAG | FLAG | FLAG) composes correctly", async () => {
    const result = await compileAndRun(`
      const F1 = 1;
      const F2 = 2;
      const F3 = 128;
      export function test(): number {
        const newBitmask = 5;  // < 131
        return newBitmask < (F1 | F2 | F3) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  /**
   * Shift ops also go through emitJsToInt32 + the per-op scratch
   * coercion. Verify shifts on f64 operands still work after the
   * helper landed.
   */
  it("shift ops (>>, <<, >>>) still work on f64 operands", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const a = 256;
        const b = 3;
        return (a >> b) + (b << 2) + (a >>> 1);  // 32 + 12 + 128 = 172
      }
    `);
    expect(result).toBe(172);
  });

  /**
   * XOR on f64 operands — sibling to AND/OR coverage above.
   */
  it("xor on f64 operands still works", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const a = 0xAA;
        const b = 0x55;
        return a ^ b;  // 0xFF = 255
      }
    `);
    expect(result).toBe(255);
  });
});
