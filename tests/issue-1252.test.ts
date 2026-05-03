// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1252 — SameValue f64 comparison in DefineProperty: copysign operands
// were reversed, collapsing +0/-0 to the same sign and silently allowing
// Object.defineProperty to mutate frozen-property sign.
//
// PR #182 (#1127) introduced the SameValue scaffold but with the wrong
// argument order on `f64.copysign`. The Wasm op `f64.copysign(x, y)` returns
// `x` with the sign of `y`. To extract the SIGN of a value (without its
// magnitude) we need `copysign(1, value)`. In stack order: push 1, then push
// value, then copysign pops y=value first and x=1 second. The original code
// pushed value first, then 1 — computing `copysign(value, 1) = abs(value)`
// which collapsed +0 and -0 to the same positive sign.
//
// Effect of the bug: a frozen object with value `+0` would silently accept
// `Object.defineProperty(obj, "x", { value: -0 })` instead of throwing
// TypeError per ECMA-262 §9.1.6.3 step 7 (SameValue check).
//
// The fix swaps the two `f64.copysign` operand pushes in
// `src/codegen/object-ops.ts:emitDefinePropertyValueCheck`. The NaN === NaN
// path was already correct (that branch tests for self-NaN via `f64.ne`,
// independent of the copysign branch).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function compileAndRun(source: string): number {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1252 — SameValue +0/-0 distinction in DefineProperty", () => {
  // ── The new gap closed by this commit ──────────────────────────────
  it("frozen { x: +0 } rejects defineProperty value -0 via 0 * -1", () => {
    // SameValue(+0, -0) is false per ECMA-262 §7.2.10. Under the old
    // copysign(value, 1) bug both sides had positive sign and the
    // comparison returned true, silently allowing the redefinition.
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: 0 };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: 0 * -1 });
          return 0; // SHOULD throw
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("frozen { x: +0 } rejects defineProperty value -0 via 1 / -Infinity", () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: 0 };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: 1 / -Infinity });
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("frozen { x: -0 } rejects defineProperty value +0", () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: 0 * -1 };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: 0 });
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });

  // ── Regression guards: the existing #1127 cases ────────────────────
  it("regression: SameValue(NaN, NaN) = true — redefine NaN with NaN succeeds", () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: NaN };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: NaN });
          return 1;
        } catch (e) {
          return 0;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("regression: same +0 -> +0 succeeds (not all sign-equal-1 paths throw)", () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: 0 };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: 0 });
          return 1;
        } catch (e) {
          return 0;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("regression: same -0 -> -0 succeeds", () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: 0 * -1 };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: 0 * -1 });
          return 1;
        } catch (e) {
          return 0;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("regression: distinct positives still throw — 42 -> 99", () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: 42 };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: 99 });
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });

  it("regression: distinct sign 1 vs -1 throws", () => {
    const result = compileAndRun(`
      export function test(): number {
        const obj: any = { x: 1 };
        Object.freeze(obj);
        try {
          Object.defineProperty(obj, "x", { value: -1 });
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(result).toBe(1);
  });
});
