// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1248 — `typeof x === "string"` guard breaks `substring(start)`
// (single-arg form returns a single character instead of the suffix).
//
// Root cause: when a value is type-narrowed to `string` via `typeof`, the
// dispatch in compileCallExpression takes the `isStringType(receiverType)`
// path which calls the host import `string_substring(self, start, end)`.
// The generic missing-arg padding loop (calls.ts:4051-4058) pushed
// `f64.const 0` for the missing `end`, so the host call became
// `s.substring(start, 0)`. Per ECMA-262 §22.1.3.21, `substring(a, b)`
// swaps args when `a > b` — so `s.substring(1, 0)` returns `s.substring(0, 1)`,
// the FIRST character, not the suffix from `start`.
//
// Fix: special-case `substring` and `slice` when `args.length === 1`. Save
// the receiver to a temp local, then pad the missing `end` with the actual
// `s.length` (computed via wasm:js-string.length) instead of `0`.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStringTest(source: string, fn = "test"): Promise<string> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, () => string>)[fn]!();
}

describe("Issue #1248 — substring(start) under typeof guard", () => {
  // Canonical repro from the issue file.
  it("withGuard: typeof-narrowed string + substring(1) returns suffix not single char", async () => {
    const src = `
      export function withGuard(seg: any): any {
        if (typeof seg === "string" && seg.charAt(0) === ":") {
          return seg.substring(1);
        }
        return null;
      }
      export function test(): string {
        const r = withGuard(":id");
        return typeof r === "string" ? r : "(non-string)";
      }
    `;
    expect(await runStringTest(src)).toBe("id"); // was ":" before fix
  });

  // Sanity: without the typeof guard, the fix should not affect behavior.
  it("noGuard: any-typed receiver + substring(1) still works", async () => {
    const src = `
      export function noGuard(seg: any): any {
        if (seg.charAt(0) === ":") {
          return seg.substring(1);
        }
        return null;
      }
      export function test(): string {
        const r = noGuard(":id");
        return typeof r === "string" ? r : "(non-string)";
      }
    `;
    expect(await runStringTest(src)).toBe("id");
  });

  // Two-arg substring still works (regression check on the padding logic).
  it("two-arg substring is unchanged by the fix", async () => {
    const src = `
      export function test(): string {
        const s: string = "hello";
        return s.substring(1, 4); // "ell"
      }
    `;
    expect(await runStringTest(src)).toBe("ell");
  });

  // Single-arg substring on a directly-typed string also goes through the
  // same dispatch.
  it("string-typed receiver + substring(start) returns suffix", async () => {
    const src = `
      export function test(): string {
        const s: string = "hello world";
        return s.substring(6); // "world"
      }
    `;
    expect(await runStringTest(src)).toBe("world");
  });

  // slice has the same single-arg semantics — single arg defaults to length.
  it("string-typed receiver + slice(start) returns suffix", async () => {
    const src = `
      export function test(): string {
        const s: string = "hello world";
        return s.slice(6); // "world"
      }
    `;
    expect(await runStringTest(src)).toBe("world");
  });

  // Edge case: substring(0) — should return the full string.
  it("substring(0) returns the full string", async () => {
    const src = `
      export function test(): string {
        const s: string = "abc";
        return s.substring(0);
      }
    `;
    expect(await runStringTest(src)).toBe("abc");
  });

  // Edge case: substring(length) — returns empty string.
  it("substring(length) returns empty string", async () => {
    const src = `
      export function test(): string {
        const s: string = "abc";
        return s.substring(3);
      }
    `;
    expect(await runStringTest(src)).toBe("");
  });
});
