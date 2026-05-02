// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1247 — typed string[] local with String.prototype.split initializer
// triggers struct-type mismatch.
//
// Root cause: `ensureStructForType` registered `string[]` (an Array<string>
// reference type) as an anonymous struct that pulled in every Array.prototype
// method as a callable field. When `paths.shift()` was compiled, the dispatch
// in compileCallExpression at calls.ts:3666 found the anon struct via
// resolveStructName and routed `shift` through compileCallablePropertyCall
// (treating it as a callable struct field) — bypassing the array-method
// dispatch at calls.ts:3803 entirely. Since the anon struct's vec type idx
// differed from the local's (vec_externref) idx, struct.get on the wrong
// type idx failed wasm validation at instantiation.
//
// Fix: skip Array (and other built-in container types like TypedArrays,
// Promise, Date, Map, Set, RegExp, wrapper objects) in ensureStructForType.
// These types have their own dedicated codegen paths (vec types, externref
// classes, etc.) and must not be re-registered as anonymous structs.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

describe("Issue #1247 — typed string[] with split initializer", () => {
  // The minimal repro from the issue file: splitPath as a separate function
  // that types its local as string[] and mutates it via shift().
  it("splitPath: typed string[] local + split initializer + shift mutation", async () => {
    const src = `
      export function splitPath(path: string): string[] {
        const paths: string[] = path.split("/");
        if (paths[0] === "") {
          paths.shift();
        }
        return paths;
      }
      export function test(): number {
        const r = splitPath("/a/b/c");
        return r.length;
      }
    `;
    expect(await runTest(src)).toBe(3); // "/a/b/c".split("/") → ["", "a", "b", "c"], shift → ["a", "b", "c"]
  });

  // Without the leading "/" — the if branch shouldn't fire, paths.length === 3
  it("splitPath: no leading slash leaves length unchanged", async () => {
    const src = `
      export function splitPath(path: string): string[] {
        const paths: string[] = path.split("/");
        if (paths[0] === "") {
          paths.shift();
        }
        return paths;
      }
      export function test(): number {
        const r = splitPath("a/b/c");
        return r.length;
      }
    `;
    expect(await runTest(src)).toBe(3);
  });

  // Direct typed-string[] local with split + push (another mutating method)
  it("typed string[] + split + push works in a function with params", async () => {
    const src = `
      export function process(s: string): string[] {
        const parts: string[] = s.split(",");
        parts.push("end");
        return parts;
      }
      export function test(): number {
        return process("a,b,c").length; // 3 + 1 = 4
      }
    `;
    expect(await runTest(src)).toBe(4);
  });

  // Typed string[] passed as parameter and returned — exercises both directions
  // of the vec/anon-struct mismatch.
  it("typed string[] parameter + array methods", async () => {
    const src = `
      export function tail(arr: string[]): number {
        if (arr.length > 0) {
          arr.shift();
        }
        return arr.length;
      }
      export function test(): number {
        const a: string[] = "x,y,z".split(",");
        return tail(a);
      }
    `;
    expect(await runTest(src)).toBe(2); // ["x","y","z"], shift → ["y","z"], length 2
  });

  // Sanity: untyped local (inferred type) still works — this was the existing
  // workaround.
  it("untyped paths via split still works (regression check)", async () => {
    const src = `
      export function test(): number {
        const paths = "/a/b".split("/");
        return paths.length; // 3 (extern path)
      }
    `;
    expect(await runTest(src)).toBe(3);
  });
});
