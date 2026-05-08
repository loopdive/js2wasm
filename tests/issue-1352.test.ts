// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1352 — Set new methods (union, intersection, difference, symmetricDifference,
// isSubsetOf, isSupersetOf, isDisjointFrom) must accept any set-like argument
// (object with size + has(v) + keys()), not just Set instances. The native V8
// Set.prototype.union etc. already implement spec GetSetRecord — we just need
// to bridge wasmGC structs through `_wrapForHost` so their sidecar properties
// (`size`, `has`, `keys`) are visible to native JS access.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function runTest(source: string): Promise<number> {
  const r = compile(source);
  if (!r.success) {
    throw new Error("compile failed: " + r.errors.map((e) => e.message).join("\n"));
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  const fn = instance.exports.test as () => number;
  return fn();
}

describe("#1352 — Set methods accept set-like arguments", () => {
  it("union accepts set-like wasm struct (size + has + keys)", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const s2 = {
          size: 2,
          has: (v: number) => false,
          keys: function* () {
            yield 2;
            yield 3;
          },
        };
        const combined = s1.union(s2);
        // Expect {1, 2, 3}
        if (combined.size !== 3) return 1;
        if (!combined.has(1)) return 2;
        if (!combined.has(2)) return 3;
        if (!combined.has(3)) return 4;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("intersection accepts set-like wasm struct (uses has)", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        s1.add(3);
        const s2 = {
          size: 5,
          has: (v: number) => v === 2 || v === 3 || v === 4,
          keys: function* () {
            yield 2;
            yield 3;
          },
        };
        // s1.size <= s2.size → iterate s1, keep those s2.has accepts
        const result = s1.intersection(s2);
        if (result.size !== 2) return 1;
        if (!result.has(2)) return 2;
        if (!result.has(3)) return 3;
        if (result.has(1)) return 4;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("difference accepts set-like wasm struct", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        s1.add(3);
        const s2 = {
          size: 2,
          has: (v: number) => v === 2 || v === 4,
          keys: function* () {
            yield 2;
            yield 4;
          },
        };
        const result = s1.difference(s2);
        // {1, 2, 3} - {2, 4} = {1, 3}
        if (result.size !== 2) return 1;
        if (!result.has(1)) return 2;
        if (!result.has(3)) return 3;
        if (result.has(2)) return 4;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("isSubsetOf accepts set-like wasm struct", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const s2 = {
          size: 4,
          has: (v: number) => v >= 1 && v <= 4,
          keys: function* () {
            yield 1;
            yield 2;
            yield 3;
            yield 4;
          },
        };
        // {1,2} ⊆ {1,2,3,4}
        if (!s1.isSubsetOf(s2)) return 1;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("isDisjointFrom accepts set-like wasm struct", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const s2 = {
          size: 2,
          has: (v: number) => v === 3 || v === 4,
          keys: function* () {
            yield 3;
            yield 4;
          },
        };
        // {1,2} disjoint from {3,4}
        if (!s1.isDisjointFrom(s2)) return 1;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("symmetricDifference accepts set-like wasm struct", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const s2 = {
          size: 2,
          has: (v: number) => v === 2 || v === 3,
          keys: function* () {
            yield 2;
            yield 3;
          },
        };
        // {1,2} ⊕ {2,3} = {1,3}
        const result = s1.symmetricDifference(s2);
        if (result.size !== 2) return 1;
        if (!result.has(1)) return 2;
        if (!result.has(3)) return 3;
        if (result.has(2)) return 4;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });
});
