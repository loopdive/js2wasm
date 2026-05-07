// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1303 — IR codegen path: bitwise ops on operands that lower to non-f64
// types (notably externref). Surfaced compiling lodash partial.js
// `mergeData` where module-level `var WRAP_BIND_FLAG = 1` references
// arrive as externref via `global.get`, then feed `&`/`|` whose
// emitJsToInt32 sequence starts with `f64.trunc` and rejects them.
//
// Initial IR-side fix in `src/ir/lower.ts` added a defensive
// `coerceToF64ForBitwise` helper for the `js.bit*` IR instructions.
//
// The legacy codegen path (binary-ops.ts) hit the same symptom for a
// DIFFERENT reason — see #1305. The buggy `compileBitwiseBinaryOp` site
// was emitting against an f64 global at compile time, but the global's
// absolute index was over-shifted at finalization by
// `fixupModuleGlobalIndices`: nested bodies reached via recursion (the
// `then`/`else` branches of an `if`) were not added to the per-call
// `shifted` set, so duplicate `savedBodies` entries left behind by
// `compileLogicalAnd` / `compileLogicalOr` (which restore via
// `fctx.body = saved` instead of `popBody`) re-shifted the same body
// once per leak. The over-shift drove the `global.get` past the last
// numeric global into the externref tail of the table, so f64.trunc
// validated against an externref operand at link time. The fix moves
// the `shifted.has` guard inside `shiftGlobalIndices`, so every Instr[]
// is shifted at most once per fixup call — see
// `src/codegen/registry/imports.ts`.

import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile, compileProject } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const lodashEsInstalled = existsSync("node_modules/lodash-es/partial.js");
const runIfInstalled = lodashEsInstalled ? it : it.skip;

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

describe("#1305 — legacy global-shift over-count regression", () => {
  /**
   * Direct reproducer: lodash partial.js. Pulls in `_mergeData.js`
   * whose `mergeData` is the canonical failure site. Validates the
   * compiled binary; pre-fix this threw with `f64.trunc[0] expected
   * type f64, found global.get of type externref @+36700`.
   */
  runIfInstalled("compileProject('node_modules/lodash-es/partial.js') validates", () => {
    const r = compileProject("node_modules/lodash-es/partial.js", { allowJs: true });
    expect(r.success).toBe(true);
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
  });

  /**
   * Sibling lodash entry point pulling the same `_mergeData.js` via
   * `_createWrap.js`. Same root cause; validates after the fix.
   */
  runIfInstalled("compileProject('node_modules/lodash-es/_createWrap.js') validates", () => {
    const r = compileProject("node_modules/lodash-es/_createWrap.js", { allowJs: true });
    expect(r.success).toBe(true);
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
  });

  /**
   * Self-contained shape that exercises the same shift-leak path:
   * many late-added string-constant imports (here the rich error
   * messages emitted for indexed access on a possibly-null value)
   * combined with an `||` chain whose RHS contains `srcBitmask ==
   * (FLAG_A | FLAG_B)`. Each clause's RHS pushes a fresh body via
   * `pushBody`, and the legacy `compileLogicalAnd / compileLogicalOr`
   * restores via `fctx.body = saved` without `popBody`, leaving
   * duplicate `savedBodies` entries behind. Those entries used to
   * re-shift the inner `global.get` over and over each time
   * `addStringConstantGlobal` fired during the rest of compilation.
   */
  it("logical-chain RHS with bitwise-of-globals does not over-shift global indices", () => {
    const src = `
      // Many string literals to pump up late string-constant imports:
      var msg1 = "one";
      var msg2 = "two";
      var msg3 = "three";
      var msg4 = "four";
      var msg5 = "five";

      var WRAP_BIND = 1, WRAP_BIND_KEY = 2, WRAP_ARY = 128, WRAP_REARG = 256;

      export function mergeDataLike(data: any, source: any): number {
        var bitmask = data[1];
        var srcBitmask = source[1];
        var newBitmask = bitmask | srcBitmask;
        var isCommon = newBitmask < (WRAP_BIND | WRAP_BIND_KEY | WRAP_ARY);
        var isCombo =
          ((srcBitmask == WRAP_ARY) && (bitmask == WRAP_REARG)) ||
          ((srcBitmask == (WRAP_ARY | WRAP_REARG)) && (data[7].length <= source[8]) && (bitmask == WRAP_BIND));
        if (!(isCommon || isCombo)) return 0;
        return newBitmask;
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
  });

  /**
   * #1303 acceptance criterion #2: sibling truncation ops
   * (`Math.floor`, `Math.ceil`) on values that are bitwise products of
   * any-typed locals. Exercises the legacy `compileBitwiseBinaryOp`
   * path's externref unbox without depending on lodash being present.
   */
  it("Math.floor / Math.ceil on bitwise-of-any-typed values", () => {
    const src = `
      export function f(x: any, y: any): number {
        return Math.floor((x | 0) + (y | 0));
      }
      export function g(x: any, y: any): number {
        return Math.ceil((x | 0) - (y | 0));
      }
    `;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
  });
});
