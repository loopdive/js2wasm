// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1358 — Array.prototype callback methods on array-like (.call) receivers.
//
// `compileArrayLikePrototypeCall` previously bailed out when the call site was
// lexically inside `assert_throws(...)`, routing those tests to the legacy
// `__proto_method_call` host bridge. The bailout is dropped — the Wasm-native
// loop now compiles the same way regardless of caller context.
//
// These tests verify:
//   1. Callback-thrown exceptions propagate to the caller's try/catch when the
//      receiver is an array-like (`{ length, [idx]: v }`).
//   2. Basic `every` / `some` / `forEach` / `find` / `findIndex` semantics are
//      preserved (no regression in the common path).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndCall<T>(src: string, fnName = "test"): Promise<T> {
  const r = compile(src, { fileName: "test.ts" });
  const errs = r.errors.filter((e) => e.severity === "error");
  if (errs.length) {
    throw new Error(`compile failed: ${errs.map((e) => `L${e.line}:${e.column} ${e.message}`).join(" | ")}`);
  }
  const env = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, env);
  if (env.setExports) env.setExports(instance.exports as Record<string, Function>);
  const fn = (instance.exports as Record<string, () => T>)[fnName]!;
  return fn();
}

describe("issue #1358 — Array callback methods on array-like (.call) receivers", () => {
  describe("exception propagation through Wasm-native loop", () => {
    it("callback throw escapes the every loop", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var obj: any = { 0: 1, 1: 2, length: 2 };
          var caught = 0;
          try {
            Array.prototype.every.call(obj, function(v: any) {
              if (v === 2) throw "from-callback";
              return true;
            });
          } catch (e: any) {
            caught = 1;
          }
          return caught;
        }`,
      );
      expect(ret).toBe(1);
    });

    it("callback throw escapes the some loop", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var obj: any = { 0: 1, 1: 2, length: 2 };
          var caught = 0;
          try {
            Array.prototype.some.call(obj, function(v: any) {
              if (v === 2) throw "from-callback";
              return false;
            });
          } catch (e: any) {
            caught = 1;
          }
          return caught;
        }`,
      );
      expect(ret).toBe(1);
    });

    it("callback throw escapes the forEach loop", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var obj: any = { 0: 1, 1: 2, length: 2 };
          var caught = 0;
          try {
            Array.prototype.forEach.call(obj, function(v: any) {
              if (v === 2) throw "from-callback";
            });
          } catch (e: any) {
            caught = 1;
          }
          return caught;
        }`,
      );
      expect(ret).toBe(1);
    });
  });

  describe("basic semantics preserved (no regression on .call path)", () => {
    it("every iterates and accumulates correctly", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var obj: any = { 0: 10, 1: 20, length: 2 };
          var sum = 0;
          Array.prototype.every.call(obj, function(v: any) {
            sum = sum + v;
            return true;
          });
          return sum;
        }`,
      );
      expect(ret).toBe(30);
    });

    it("some short-circuits on truthy", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
          var visited = 0;
          Array.prototype.some.call(obj, function(v: any) {
            visited = visited + 1;
            return v === 2;
          });
          return visited;
        }`,
      );
      expect(ret).toBe(2);
    });

    it("forEach visits all indices", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
          var sum = 0;
          Array.prototype.forEach.call(obj, function(v: any) {
            sum = sum + v;
          });
          return sum;
        }`,
      );
      expect(ret).toBe(6);
    });

    it("findIndex returns first match index", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
          return Array.prototype.findIndex.call(obj, function(v: any) {
            return v === 20;
          });
        }`,
      );
      expect(ret).toBe(1);
    });
  });
});
