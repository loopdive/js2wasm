// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1186 — Legacy `compileForOfString` produces invalid Wasm in
// `nativeStrings: true` mode because the captured `__str_charAt`
// funcIdx in `ctx.nativeStrHelpers` becomes stale after late-import
// shifts.
//
// The companion #1183 (IR slice 6 part 4) sidesteps this bug for the
// IR path by re-resolving funcref names via `ctx.mod.functions[i].name`
// at lowering time. This test exercises the LEGACY path only
// (`experimentalIR: false`), validating the matching legacy fix.
//
// Cases mirror the native-strings cases in `tests/issue-1183.test.ts`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

interface Case {
  name: string;
  source: string;
  fn: string;
  expectedValue: number;
}

const CASES: Case[] = [
  {
    name: "count chars in 'hello' (5 chars)",
    source: `
      export function fn(): number {
        const s = "hello";
        let count = 0;
        for (const c of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedValue: 5,
  },
  {
    name: "empty string returns 0",
    source: `
      export function fn(): number {
        const s = "";
        let count = 0;
        for (const c of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedValue: 0,
  },
  {
    name: "single-char string",
    source: `
      export function fn(): number {
        const s = "z";
        let count = 0;
        for (const c of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedValue: 1,
  },
  {
    name: "compound assignment in body — count chars * 2",
    source: `
      export function fn(): number {
        const s = "abcdef";
        let count = 0;
        for (const c of s) {
          count += 2;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedValue: 12,
  },
  {
    name: "BMP unicode 'café' (4 code units)",
    source: `
      export function fn(): number {
        const s = "café";
        let count = 0;
        for (const c of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedValue: 4,
  },
  // Repro that exposes the late-import-shift bug specifically: a
  // function-body that triggers late imports between the for-of's
  // `ensureNativeStringHelpers` call and the actual `__str_charAt`
  // emit. Calling typeof / boxing operations is one such trigger.
  {
    name: "for-of preceded by a typeof call (forces late imports)",
    source: `
      export function fn(): number {
        const s = "abc";
        let count = 0;
        // Force a late import via typeof on a non-trivial value
        const t: any = 42;
        if (typeof t === "number") {
          for (const c of s) {
            count = count + 1;
          }
        }
        return count;
      }
    `,
    fn: "fn",
    expectedValue: 3,
  },
];

describe("#1186 — legacy compileForOfString re-resolves __str_charAt by name", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const r = compile(c.source, { experimentalIR: false, nativeStrings: true });
      expect(r.success).toBe(true);
      if (!r.success) return;

      // The crux: the binary must be VALID Wasm. Pre-fix, this throws
      // CompileError because the captured __str_charAt funcIdx points
      // at a function with the wrong signature.
      const built = buildImports(r.imports, ENV_STUB, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, {
        env: built.env,
        string_constants: built.string_constants,
      });

      const fn = instance.exports[c.fn] as () => number;
      const result = fn();
      expect(result).toBe(c.expectedValue);
    });
  }

  // Exact reproducer from the issue — the parameterised version.
  // Note: native-strings mode does NOT auto-coerce a JS string param
  // to a (ref $AnyString); a separate test-runtime concern (#1187).
  // For this case we only validate the binary compiles successfully.
  it("reproducer: fn(s: string) compiles to valid Wasm", async () => {
    const source = `
      export function fn(s: string): number {
        let n = 0;
        for (const c of s) { n = n + 1; }
        return n;
      }
    `;
    const r = compile(source, { experimentalIR: false, nativeStrings: true });
    expect(r.success).toBe(true);
    if (!r.success) return;

    // Pre-fix: WebAssembly.compile threw "function fn failed: call[0]
    // expected externref, found local.get of type i32".
    await WebAssembly.compile(r.binary);
  });
});
