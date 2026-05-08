// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1358 — Array.prototype callback methods (every/some/forEach/find/findIndex/filter/map)
// on array-like receivers — drop the assert_throws bailout from
// `compileArrayLikePrototypeCall` per the architect's plan.
//
// Pre-fix bailout: when `Array.prototype.every.call(obj, cb)` (etc.) was syntactically
// inside an `assert_throws(...)` wrapper, the Wasm-native loop bailed out and routed
// to the legacy `__proto_method_call` bridge — even when the receiver was a fine
// array-like that the Wasm-native loop would handle correctly. This silently lost
// the architect-spec'd behaviour for a subset of test262 negative tests.
//
// This change is minimal: it drops the syntactic bailout. The existing rejection
// of `__vec_*`/`__arr_*` types and the receiver-shape sanity checks are preserved.
// The HasProperty (`__extern_has_idx`) gating per spec §23.1.3.{12,7,28,11,21,24} is
// already in place from prior work.
//
// Larger work (thisArg threading, Wasm-closure-as-JS-callable bridge) is tracked
// in #1382 and remains out of scope for this PR.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndCall<T = unknown>(src: string, fnName: string): Promise<T> {
  const r = compile(src, { fileName: "test.ts" });
  const errs = r.errors.filter((e) => e.severity === "error");
  if (errs.length) {
    throw new Error(`compile failed: ${errs.map((e) => `L${e.line}:${e.column} ${e.message}`).join(" | ")}`);
  }
  const env = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, env);
  const fn = (instance.exports as Record<string, () => T>)[fnName];
  return fn?.();
}

describe("#1358 Array prototype callback methods on array-like receivers", () => {
  describe("regression coverage — true Array receivers still go through fast path", () => {
    it("[1,2,3].every(v => v > 0) === true", async () => {
      const out = await compileAndCall<number>(
        `export function f(): number { return [1,2,3].every(v => v > 0) ? 1 : 0; }`,
        "f",
      );
      expect(out).toBe(1);
    });

    it("[1,2,3].some(v => v > 2) === true", async () => {
      const out = await compileAndCall<number>(
        `export function f(): number { return [1,2,3].some(v => v > 2) ? 1 : 0; }`,
        "f",
      );
      expect(out).toBe(1);
    });

    it("[1,0,3].some(v => v > 2) === true", async () => {
      const out = await compileAndCall<number>(
        `export function f(): number { return [1,0,3].some(v => v > 2) ? 1 : 0; }`,
        "f",
      );
      expect(out).toBe(1);
    });

    it("[1,2,3].forEach with side-effect runs all elements", async () => {
      const out = await compileAndCall<number>(
        `let sum = 0; [1,2,3].forEach((v: number) => { sum += v; }); export function f(): number { return sum; }`,
        "f",
      );
      expect(out).toBe(6);
    });

    it("[10,20,30].find(v => v > 15) === 20", async () => {
      const out = await compileAndCall<number>(
        `export function f(): number { return [10,20,30].find(v => v > 15) ?? -1; }`,
        "f",
      );
      expect(out).toBe(20);
    });
  });

  describe("regression coverage — Array.prototype.X.call on a plain Array still works", () => {
    it("Array.prototype.every.call([1,2,3], v => v > 0) === true", async () => {
      const out = await compileAndCall<number>(
        `export function f(): number { return Array.prototype.every.call([1,2,3], (v: number) => v > 0) ? 1 : 0; }`,
        "f",
      );
      expect(out).toBe(1);
    });

    it("Array.prototype.some.call([1,2,3], v => v > 2) === true", async () => {
      const out = await compileAndCall<number>(
        `export function f(): number { return Array.prototype.some.call([1,2,3], (v: number) => v > 2) ? 1 : 0; }`,
        "f",
      );
      expect(out).toBe(1);
    });
  });
});
