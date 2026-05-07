// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1324 — JSON.stringify of statically-typed primitive values compiles
// to pure Wasm instead of routing through the `JSON_stringify` host
// import. Standalone-mode (no JS host) builds get correct output for
// the primitive subset; object/array/string/bigint cases fall through
// to the existing host import (full Wasm shape walking is tracked
// under #1336).
//
// Tested cases mirror the spec algorithm in §25.5.2:
//   - null               → string "null"
//   - undefined          → JS undefined (NOT a string — per spec)
//   - boolean true/false → string "true" / "false"
//   - number             → number_toString result
//   - NaN / ±Infinity    → string "null" (per §25.5.2 step 11)
// Object/array/string fall through to the host path, exercised here so
// regressions in the slice's `tryEmitJsonStringifyPrimitive` are caught.

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const exports = await compileAndInstantiate(src);
  return (exports as Record<string, () => unknown>).test?.();
}

describe("#1324 — JSON.stringify of primitive values (pure Wasm slice)", () => {
  it('null literal → string "null"', async () => {
    expect(await runTest(`export function test(): string { return JSON.stringify(null); }`)).toBe("null");
  });

  it('true literal → string "true"', async () => {
    expect(await runTest(`export function test(): string { return JSON.stringify(true); }`)).toBe("true");
  });

  it('false literal → string "false"', async () => {
    expect(await runTest(`export function test(): string { return JSON.stringify(false); }`)).toBe("false");
  });

  it("number literal → decimal string", async () => {
    expect(await runTest(`export function test(): string { return JSON.stringify(42); }`)).toBe("42");
    expect(await runTest(`export function test(): string { return JSON.stringify(-7); }`)).toBe("-7");
    expect(await runTest(`export function test(): string { return JSON.stringify(3.14); }`)).toBe("3.14");
  });

  it('NaN → string "null" (per spec §25.5.2 step 11)', async () => {
    expect(await runTest(`export function test(): string { return JSON.stringify(NaN); }`)).toBe("null");
  });

  it('Infinity → string "null"', async () => {
    expect(await runTest(`export function test(): string { return JSON.stringify(Infinity); }`)).toBe("null");
  });

  it('-Infinity → string "null"', async () => {
    expect(await runTest(`export function test(): string { return JSON.stringify(-Infinity); }`)).toBe("null");
  });

  it("undefined → JS undefined (not a string)", async () => {
    // `JSON.stringify(undefined)` returns the value `undefined`, not a
    // string. The wrapper checks identity so we can detect this case
    // without ambiguity.
    const got = await runTest(`
      export function test(): string {
        const r = JSON.stringify(undefined);
        return r === undefined ? "(undefined)" : r;
      }
    `);
    expect(got).toBe("(undefined)");
  });

  it("statically-typed boolean variable", async () => {
    expect(
      await runTest(`
        export function test(): string {
          const b: boolean = true;
          return JSON.stringify(b);
        }
      `),
    ).toBe("true");
  });

  it("statically-typed number variable", async () => {
    expect(
      await runTest(`
        export function test(): string {
          const n: number = 100;
          return JSON.stringify(n);
        }
      `),
    ).toBe("100");
  });

  it("falls through to host for object input — output is correct JSON", async () => {
    expect(
      await runTest(`
        export function test(): string {
          const o = { a: 1, b: 2 };
          return JSON.stringify(o);
        }
      `),
    ).toBe('{"a":1,"b":2}');
  });

  it("falls through to host for string input — output is correct JSON", async () => {
    expect(
      await runTest(`
        export function test(): string {
          return JSON.stringify("hello");
        }
      `),
    ).toBe('"hello"');
  });

  it("primitives slice ignores replacer/space args (compiled for side effects)", async () => {
    // Replacer is observed only when the value being stringified is an
    // object/array (the "fallback" path). For a number, the replacer
    // function is never invoked. Verify that passing replacer/space
    // doesn't break the slice's primitive emit.
    expect(
      await runTest(`
        export function test(): string {
          let calls = 0;
          const r = JSON.stringify(42, function(k, v) { calls = calls + 1; return v; }, 2);
          return r + ":" + calls;
        }
      `),
    ).toBe("42:0");
  });
});
