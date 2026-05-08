// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1379 — prefix/postfix ++/-- on null/undefined/string operands must run the
// spec's ToNumeric coercion (§13.4 + §7.1.4 ToNumber). Before the fix, the
// codegen called `emitSafeExternrefToF64` which gated `__unbox_number` behind
// a `__typeof_number` check and went to `f64.const NaN` for any non-Number
// externref — so `var x = null; ++x` produced NaN (expected 1) and `var x =
// "1"; x--` produced NaN (expected 0).
//
// Fix (src/codegen/type-coercion.ts): drop the typeof guard and always call
// `__unbox_number` directly. The host import is `Number(v)` which implements
// ToNumber per spec: null→0, undefined→NaN, "1"→1, true→1, etc. With #1319's
// `_hostToPrimitive` fallback already in place, plain wasm-structs without
// conversion methods route through "[object Object]" → NaN instead of
// throwing TypeError, so the simplification is safe.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunResult {
  exports: Record<string, Function>;
}

async function run(source: string): Promise<RunResult> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  new WebAssembly.Module(r.binary);
  const imports: any = buildImports(r.imports as never, undefined, r.stringPool);
  const inst = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(inst.instance.exports);
  return { exports: inst.instance.exports as Record<string, Function> };
}

describe("#1379 — prefix/postfix ++/-- ToNumeric coercion", () => {
  /**
   * Spec test pattern from `language/expressions/prefix-increment/S11.4.4_A3_T4.js`:
   * `var x = null; ++x` is `1` per ToNumber(null) = +0 then +1.
   */
  it("++null is 1 (ToNumber(null) = +0)", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: any = null;
        ++x;
        return x as number;
      }
    `);
    expect(exports.test!()).toBe(1);
  });

  /**
   * `language/expressions/postfix-decrement/S11.3.2_A4_T3.js`:
   * `var x = "1"; var y = x--; y === 1` per ToNumber("1") = 1.
   */
  it("postfix x-- on string '1' returns 1, leaves x at 0", async () => {
    const { exports } = await run(`
      export function test_y(): number {
        let x: any = "1";
        const y = x--;
        return y as number;
      }
      export function test_x(): number {
        let x: any = "1";
        x--;
        return x as number;
      }
      export function test(): number { return 1; }
    `);
    expect(exports.test_y!()).toBe(1);
    expect(exports.test_x!()).toBe(0);
  });

  /**
   * `language/expressions/postfix-increment/S11.3.1_A4_T4.js`:
   * `var x = null; var y = x++; y === 0` per ToNumber(null) = 0.
   */
  it("postfix x++ on null returns 0, leaves x at 1", async () => {
    const { exports } = await run(`
      export function test_y(): number {
        let x: any = null;
        const y = x++;
        return y as number;
      }
      export function test_x(): number {
        let x: any = null;
        x++;
        return x as number;
      }
      export function test(): number { return 1; }
    `);
    expect(exports.test_y!()).toBe(0);
    expect(exports.test_x!()).toBe(1);
  });

  /**
   * Empty string coerces to 0 per ToNumber("") = 0.
   */
  it("empty string ++x is 1", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: any = "";
        ++x;
        return x as number;
      }
    `);
    expect(exports.test!()).toBe(1);
  });

  /**
   * Number-shaped string coerces correctly with whitespace trim.
   * `Number(" 42 ")` is 42 per spec.
   */
  it("' 42 ' ++ becomes 43", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: any = " 42 ";
        ++x;
        return x as number;
      }
    `);
    expect(exports.test!()).toBe(43);
  });

  /**
   * Non-numeric string remains NaN — `Number("abc")` is NaN, NaN+1 is NaN.
   * Spec-conforming but worth pinning to catch regressions.
   */
  it("'abc' ++x is NaN", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: any = "abc";
        ++x;
        return x as number;
      }
    `);
    expect(Number.isNaN(exports.test!() as number)).toBe(true);
  });

  /**
   * Already-number path must keep working — regression guard.
   */
  it("regression guard: ++x on a number-typed local works", async () => {
    const { exports } = await run(`
      export function test(): number {
        let x: number = 5;
        ++x;
        return x;
      }
    `);
    expect(exports.test!()).toBe(6);
  });

  /**
   * Boolean coercion: `Number(true) === 1`, `Number(false) === 0`.
   */
  it("++true is 2, ++false is 1", async () => {
    const { exports } = await run(`
      export function test_t(): number {
        let x: any = true;
        ++x;
        return x as number;
      }
      export function test_f(): number {
        let x: any = false;
        ++x;
        return x as number;
      }
      export function test(): number { return 1; }
    `);
    expect(exports.test_t!()).toBe(2);
    expect(exports.test_f!()).toBe(1);
  });
});
