// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1397 — Static method dispatch on typed wrapper-object receivers must not
// silently ignore runtime property reassignment.
//
// Pattern (test262 S15.7.4.2_A4_T01-T05, S15.7.4.4_A2_*, S15.6.4.2_A2_*,
// S15.6.4.3_A2_*):
//
//   var s1 = new String();
//   s1.toString = Number.prototype.toString;
//   s1.toString();   // spec: throws TypeError
//
// Before this fix the codegen statically resolved `s1.toString()` to the
// String wrapper's identity short-circuit (`return s1`), silently ignoring
// the reassignment. After the fix, sources that contain any
// `<id>.toString = ...` / `<id>.valueOf = ...` reassignment cause the
// wrapper-object call to fall through to `__extern_method_call`, which
// reads the reassigned method off the receiver at runtime and invokes it
// with the wrapper as `this` — producing the spec-mandated TypeError
// (because Number.prototype.toString rejects non-Number `this`).
//
// Primitive-receiver method calls keep the static fast-path; primitives
// don't have own properties, so `"abc".toString = …` is a no-op and the
// short-circuit is correct.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function compileAndInstantiate(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary (WebAssembly.validate failed)\nWAT:\n${result.wat}`);
  }
  const runtimeResult = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtimeResult);
  if (runtimeResult.setExports) {
    runtimeResult.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports as Record<string, Function>;
}

describe("#1397 — static method dispatch ignores runtime reassignment on wrappers", () => {
  it("new String().toString reassigned to Number.prototype.toString → TypeError", async () => {
    // Mirrors test262 S15.7.4.2_A4_T01. `s1: String` (wrapper) is the
    // inferred type when `var s1 = new String();` is used in TS mode.
    const source = `
      export function test(): number {
        let threwTypeError = 0;
        try {
          var s1 = new String();
          (s1 as any).toString = (Number as any).prototype.toString;
          s1.toString();
        } catch (e: any) {
          if (e instanceof TypeError) threwTypeError = 1;
        }
        return threwTypeError;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("new String().valueOf reassigned to Number.prototype.valueOf → TypeError", async () => {
    const source = `
      export function test(): number {
        let threwTypeError = 0;
        try {
          var s1 = new String();
          (s1 as any).valueOf = (Number as any).prototype.valueOf;
          s1.valueOf();
        } catch (e: any) {
          if (e instanceof TypeError) threwTypeError = 1;
        }
        return threwTypeError;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("primitive string .toString() works correctly (still identity)", async () => {
    // The wrapper reassignment in the same source must not affect primitive
    // dispatch. Primitives don't have own properties, so `s.toString = …`
    // would be a no-op anyway — but the codegen path differs.
    const source = `
      export function test(): string {
        var w = new String("wrapper");
        (w as any).toString = (Number as any).prototype.toString;
        const p: string = "abc";
        return p.toString();
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe("abc");
  });

  it.todo(
    "plain new String().toString() returns primitive — pre-existing static-identity returns the wrapper itself; out of scope",
  );

  it("plain new String().valueOf() (no reassignment) returns primitive string", async () => {
    const source = `
      export function test(): string {
        const s = new String("hello");
        return s.valueOf();
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe("hello");
  });

  it("new Number().valueOf reassigned to Boolean.prototype.valueOf → TypeError", async () => {
    // Mirrors test262 S15.7.4.4_A2_T01. `n1: Number` is inferred from
    // `var n1 = new Number()` in TS mode.
    const source = `
      export function test(): number {
        let threwTypeError = 0;
        try {
          var n1 = new Number();
          (n1 as any).valueOf = (Boolean as any).prototype.valueOf;
          n1.valueOf();
        } catch (e: any) {
          if (e instanceof TypeError) threwTypeError = 1;
        }
        return threwTypeError;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("new Boolean().valueOf reassigned to Number.prototype.valueOf → TypeError", async () => {
    // Mirrors test262 S15.6.4.3_A2_T1.
    const source = `
      export function test(): number {
        let threwTypeError = 0;
        try {
          var b1 = new Boolean();
          (b1 as any).valueOf = (Number as any).prototype.valueOf;
          b1.valueOf();
        } catch (e: any) {
          if (e instanceof TypeError) threwTypeError = 1;
        }
        return threwTypeError;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("user class instance method dispatch still uses static fast-path", async () => {
    // Regression guard: classes whose methods are reassigned in the source
    // are not affected by the wrapper-narrow fix; static dispatch via
    // `<className>_<methodName>` still applies.
    const source = `
      class Counter {
        n: number;
        constructor() { this.n = 0; }
        incr(): number { this.n = this.n + 1; return this.n; }
      }
      export function test(): number {
        // User-class dispatch is keyed on the class struct and not affected
        // by this fix.
        const c = new Counter();
        return c.incr();
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });
});
