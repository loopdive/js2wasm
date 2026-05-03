// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1253: When `OrdinaryToPrimitive` is invoked on an object whose `valueOf` and
// `toString` both return non-primitives (objects/arrays), ECMA-262 §7.1.1.1 step
// 6 requires throwing a TypeError. The compiler's `tryStaticToNumber` static
// folder used to compute `+o` to NaN in that case, which silently swallowed the
// spec-required exception. Two fixes:
//
//   1. `tryStaticToNumber` now unwraps `ParenthesizedExpression` when checking
//      whether a function returns a non-primitive — `() => ({})` parses with
//      the body wrapped in parens, which the previous check missed and treated
//      as `() => NaN`.
//
//   2. The toString branch now mirrors the valueOf branch: if toString also
//      returns a non-primitive, bail out to runtime so the runtime
//      `_hostToPrimitive` throws TypeError per spec.
//
//   3. The const-identifier trace no longer folds through object/array literal
//      initializers — `const o = {}; o.valueOf = () => ({}); o.toString =
//      () => ({}); +o` would otherwise statically resolve `o` to `{}` and
//      fold to NaN, missing the post-init mutations.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runFn(source: string, exportName: string): Promise<unknown> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    const msgs = result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
    throw new Error(`compile failed:\n${msgs}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[exportName]!();
}

async function expectThrows(source: string, exportName: string, message: RegExp): Promise<void> {
  await expect(runFn(source, exportName)).rejects.toThrow(message);
}

describe("issue-1253: OrdinaryToPrimitive throws TypeError when valueOf and toString both return non-primitives", () => {
  describe("acceptance criteria", () => {
    it("AC1a: const-bound object literal with both methods returning {} throws TypeError on +o", async () => {
      await expectThrows(
        `
export function run(): number {
  const o: any = { valueOf: () => ({}), toString: () => ({}) };
  return +o;
}`,
        "run",
        /Cannot convert object to primitive/i,
      );
    });

    it("AC1b: const-bound empty object with sidecar mutation throws TypeError on +o", async () => {
      // `const o = {}` then `o.valueOf = ...` is the canonical test262 shape
      // for spec §7.1.1.1 step 6. Before the fix, `tryStaticToNumber` traced
      // `o` to its initializer `{}` and folded to NaN, missing the sidecar.
      await expectThrows(
        `
export function run(): number {
  const o: any = {};
  o.valueOf = () => ({});
  o.toString = () => ({});
  return +o;
}`,
        "run",
        /Cannot convert object to primitive/i,
      );
    });

    it("AC1c: function-returned object with bad methods throws TypeError on +call()", async () => {
      // No static fold path — runtime-only. Was already correct on main; this
      // test guards against regression.
      await expectThrows(
        `
function make(): any { return { valueOf: () => ({}), toString: () => ({}) }; }
export function run(): number {
  return +make();
}`,
        "run",
        /Cannot convert object to primitive/i,
      );
    });
  });

  describe("regression guard — positive ToNumber cases must still fold or run correctly", () => {
    it("+{} returns NaN (default Object.prototype.toString → '[object Object]' → NaN)", async () => {
      const ret = await runFn(
        `
export function run(): number {
  return +{};
}`,
        "run",
      );
      expect(ret).toBeNaN();
    });

    it("+{ valueOf: () => 42 } returns 42 (static fold survives the fix)", async () => {
      const ret = await runFn(
        `
export function run(): number {
  return +{ valueOf: () => 42 };
}`,
        "run",
      );
      expect(ret).toBe(42);
    });

    it("+o where const o = { valueOf: () => 42 } returns 42 (runtime path now)", async () => {
      const ret = await runFn(
        `
export function run(): number {
  const o = { valueOf: () => 42 };
  return +o;
}`,
        "run",
      );
      expect(ret).toBe(42);
    });

    it("+x where const x = 5 still folds to 5 (non-object const trace preserved)", async () => {
      const ret = await runFn(
        `
export function run(): number {
  const x = 5;
  return +x;
}`,
        "run",
      );
      expect(ret).toBe(5);
    });

    it("const s = 'hello'; +s returns NaN (string trace preserved)", async () => {
      const ret = await runFn(
        `
export function run(): number {
  const s = "hello";
  return +s;
}`,
        "run",
      );
      expect(ret).toBeNaN();
    });

    it("const s = '42'; +s returns 42 (string-to-number trace preserved)", async () => {
      const ret = await runFn(
        `
export function run(): number {
  const s = "42";
  return +s;
}`,
        "run",
      );
      expect(ret).toBe(42);
    });
  });

  describe("regression guard — valueOf returning object falls back to toString", () => {
    it("+{ valueOf: () => ({}), toString: () => 'hello' } follows toString → NaN", async () => {
      // Spec: valueOf returns non-primitive → fall back to toString. toString
      // returns 'hello' (primitive). ToNumber('hello') = NaN. No TypeError.
      const ret = await runFn(
        `
export function run(): number {
  return +{ valueOf: () => ({}), toString: () => "hello" };
}`,
        "run",
      );
      expect(ret).toBeNaN();
    });

    it("+{ valueOf: () => ({}), toString: () => '42' } follows toString → 42", async () => {
      const ret = await runFn(
        `
export function run(): number {
  return +{ valueOf: () => ({}), toString: () => "42" };
}`,
        "run",
      );
      expect(ret).toBe(42);
    });
  });
});
