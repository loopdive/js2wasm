// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1178 — `string-hash` benchmark hits `wasm trap: call stack exhausted` at
 * runtime after the #1175 fix made it compile.
 *
 * Root cause: the rope-flattening helper `__str_copy_tree` was recursive over
 * the cons tree. Long `text += <expr>` chains build a left-leaning spine of
 * `Cons(Cons(Cons(..., c2), c1), c0)`, so the depth of the rope == number of
 * concatenations. With 20K+ iterations Wasmtime's default stack budget
 * exhausts on the first flatten attempt (e.g. `text.length` is fine — it's a
 * struct.get — but `text.charCodeAt(i)` triggers `__str_flatten` →
 * `__str_copy_tree`, which then self-recurses 60K times).
 *
 * Fix: rewrite `__str_copy_tree` as an iterative descent with an explicit
 * worklist of right-children. Stack frames stay constant at one regardless of
 * rope depth. A pre-allocated array of length `node.len` is used as the
 * worklist (overestimate; depth ≤ leaves ≤ len since each leaf is ≥ 1 char).
 *
 * Acceptance criterion (from the issue file): a new test exercises
 * `text += <expr>` over at least 50,000 iterations and asserts no trap.
 */
describe("#1178 — long `text += <expr>` chains do not trap", () => {
  function compileWasi(source: string) {
    return compile(source, { fileName: "t.js", allowJs: true, target: "wasi", optimize: 0 });
  }

  it("compiles, validates, and runs `text += literal` over 50,000 iterations", async () => {
    // 50K iterations of `text += "x"`. Each += allocates a ConsString node on
    // top of the previous one, so after 50K ops the rope has depth 50K. Reading
    // `text.length` is O(1), so we then force a flatten via .charAt(0) which
    // calls __str_copy_tree — the historical trap site.
    const src = `
      /** @returns {number} */
      export function run() {
        let text = "";
        for (let i = 0; i < 50000; i++) {
          text += "x";
        }
        // Touch the rope through a flatten path — pre-fix this would
        // exhaust the wasm stack with 50K self-recursive frames.
        const first = text.charAt(0);
        return text.length + (first === "x" ? 0 : 1000000);
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    const m = await WebAssembly.compile(r.binary);
    const inst = await WebAssembly.instantiate(m, {});
    const out = (inst.exports as any).run();
    // Concat 50K x's → length 50000, charAt(0) is "x" so penalty is 0.
    expect(out).toBe(50000);
  }, 60_000);

  it("compiles, validates, and runs `text += alphabet.charAt(...)` over 50,000 iterations", async () => {
    // The canonical pattern from the string-hash benchmark — three concats
    // per iteration, mixing flat-literal and charAt() results.
    const src = `
      /** @param {number} n @returns {number} */
      export function run(n) {
        const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
        let text = "";
        for (let i = 0; i < n; i++) {
          const a = (i * 13) & 31;
          const b = (a + 7) & 31;
          text += alphabet.charAt(a);
          text += alphabet.charAt(b);
          text += ";";
        }
        return text.length;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    const m = await WebAssembly.compile(r.binary);
    const inst = await WebAssembly.instantiate(m, {});
    // 20K iterations × 3 concats = 60K chars total. Pre-fix this trapped
    // with `call stack exhausted`. Post-fix the rope depth is irrelevant
    // because __str_copy_tree no longer recurses.
    const out20k = (inst.exports as any).run(20000);
    expect(out20k).toBe(60000);
    // Push past the original 20K threshold to confirm the bound is gone.
    const out50k = (inst.exports as any).run(50000);
    expect(out50k).toBe(150000);
  }, 60_000);

  it("flatten of a deep rope (via charAt(0)) does not trap on 60K-deep cons tree", async () => {
    // A 60K-deep rope with every concat producing a 1-char addition. The
    // charAt(0) call forces a full flatten through __str_copy_tree which is
    // the exact frame that recursed pre-fix.
    const src = `
      /** @returns {number} */
      export function run() {
        let text = "";
        for (let i = 0; i < 60000; i++) {
          text += "a";
        }
        // First char of a 60000-char rope of 'a' is 'a' (charCode 97).
        return text.charCodeAt(0);
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    const m = await WebAssembly.compile(r.binary);
    const inst = await WebAssembly.instantiate(m, {});
    const out = (inst.exports as any).run();
    expect(out).toBe(97); // 'a'.charCodeAt(0)
  }, 60_000);
});
