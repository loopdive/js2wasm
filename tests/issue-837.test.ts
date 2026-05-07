// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #837 — Map / WeakMap upsert proposal (TC39 Stage 3): expose
// `getOrInsert(key, value)` and `getOrInsertComputed(key, callback)` as
// host imports for both Map and WeakMap. ~110 test262 tests are gated on
// the `upsert` feature flag — registering the methods unblocks them.
//
// Implementation:
//   - `src/codegen/index.ts` — both extern-class definitions (Map, WeakMap)
//     gain two new `externMethod(2)` entries.
//   - `tests/test262-runner.ts` — `upsert` removed from PROPOSAL_FEATURES
//     so the skip filter no longer fires.
//   - `src/runtime.ts:__extern_method_call` — polyfill for engines that
//     don't yet ship the upsert methods natively (Node 25 / V8). The
//     polyfill mirrors the spec algorithm: `has(key)` → return existing,
//     else `set(key, value-or-callback(key))` and return the new value.

import { describe, it, expect } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function runTest(src: string): Promise<unknown> {
  const exports = await compileAndInstantiate(src);
  return (exports as Record<string, () => unknown>).test?.();
}

describe("#837 — Map/WeakMap upsert (getOrInsert / getOrInsertComputed)", () => {
  it("Map.getOrInsert inserts a new value when key is missing", async () => {
    const got = await runTest(`
      export function test(): string {
        const m = new Map<string, string>();
        return m.getOrInsert("k", "v");
      }
    `);
    expect(got).toBe("v");
  });

  it("Map.getOrInsert returns existing value when key is present (no overwrite)", async () => {
    const got = await runTest(`
      export function test(): string {
        const m = new Map<string, string>();
        m.set("k", "first");
        const r = m.getOrInsert("k", "second");
        return r + "/" + m.get("k");
      }
    `);
    expect(got).toBe("first/first");
  });

  it("Map.getOrInsertComputed inserts via inline callback when key missing", async () => {
    // Note: the callback arg goes through the host-callback path
    // (__make_callback). Using an inline arrow here so the literal
    // form is wrapped as a JS function the host polyfill can invoke.
    // A captured `cb = ...` Identifier is the storage-side issue from
    // #1298 — that path leaves the arrow as a wasm closure struct that
    // the host can't call. Inline literals work today.
    const got = await runTest(`
      export function test(): number {
        const m = new Map<string, number>();
        m.getOrInsertComputed("ab", (k: string) => k.length * 10);
        return m.get("ab") ?? 0;
      }
    `);
    expect(got).toBe(20);
  });

  it("Map.size reflects upserts", async () => {
    const got = await runTest(`
      export function test(): number {
        const m = new Map<string, string>();
        m.getOrInsert("a", "1");
        m.getOrInsert("b", "2");
        m.getOrInsert("a", "3");  // existing — no-op for size
        return m.size;
      }
    `);
    expect(got).toBe(2);
  });

  it("WeakMap.getOrInsert with object key", async () => {
    const got = await runTest(`
      export function test(): number {
        const wm = new WeakMap<object, number>();
        const k = {};
        const r1 = wm.getOrInsert(k, 42);
        const r2 = wm.getOrInsert(k, 99); // existing
        return r1 + r2;
      }
    `);
    expect(got).toBe(84);
  });

  it("WeakMap.getOrInsertComputed", async () => {
    const got = await runTest(`
      export function test(): number {
        const wm = new WeakMap<object, number>();
        const k = {};
        return wm.getOrInsertComputed(k, () => 7);
      }
    `);
    expect(got).toBe(7);
  });

  it("Map iteration order: getOrInsert appends as last entry", async () => {
    const got = await runTest(`
      export function test(): string {
        const m = new Map<string, string>();
        m.set("a", "1");
        m.set("b", "2");
        m.getOrInsert("c", "3");
        let out = "";
        for (const [k, v] of m) {
          out = out + k + "=" + v + ";";
        }
        return out;
      }
    `);
    expect(got).toBe("a=1;b=2;c=3;");
  });
});
