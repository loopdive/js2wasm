// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1184 — `__str_copy_tree` worklist sized at depth via dynamic doubling growth
// instead of `node.len` upfront. Verify correctness across small and deep ropes,
// and verify the string-hash kernel runs in reasonable wall-clock.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1184 — depth-bounded worklist for rope flatten", () => {
  function compileWasi(source: string) {
    return compile(source, { fileName: "t.js", allowJs: true, target: "wasi", optimize: 0 });
  }

  it("shallow rope (depth ~10): correctness preserved", async () => {
    // Build a rope of depth ~10 — sits comfortably inside the initial 16-slot
    // worklist so the grow path is NOT exercised. Verify we still get the
    // correct flattened content via charCodeAt.
    const src = `
      /** @returns {number} */
      export function run() {
        let text = "";
        for (let i = 0; i < 10; i++) text += "abc"; // 30 chars, depth ~10
        // Charcode-sum the whole flattened string. Triggers __str_copy_tree
        // for each charCodeAt call (no caching of flattened result currently).
        let sum = 0;
        for (let i = 0; i < text.length; i++) {
          sum = (sum + text.charCodeAt(i)) | 0;
        }
        return sum;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    const m = await WebAssembly.compile(r.binary);
    const inst = await WebAssembly.instantiate(m, {});
    const out = (inst.exports as any).run();
    // 10 × ("a"+"b"+"c") = 10 × (97+98+99) = 10 × 294 = 2940
    expect(out).toBe(2940);
  });

  it("deep rope (depth > 16): grow path exercised correctly", async () => {
    // Build a left-leaning rope of depth 100 (50 single-char concats × 2 each
    // doesn't double, since we use += "X" in a loop which produces depth = N).
    // 100 > 16 so the worklist grows: 16 → 32 → 64 → 128.
    const src = `
      /** @returns {number} */
      export function run() {
        let text = "";
        for (let i = 0; i < 100; i++) text += "Z"; // depth 100, 100 chars
        let sum = 0;
        for (let i = 0; i < text.length; i++) {
          sum = (sum + text.charCodeAt(i)) | 0;
        }
        return sum;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    const m = await WebAssembly.compile(r.binary);
    const inst = await WebAssembly.instantiate(m, {});
    const out = (inst.exports as any).run();
    // 100 × 'Z' = 100 × 90 = 9000
    expect(out).toBe(9000);
  });

  it("very deep rope (depth >> 16): multiple grow events", async () => {
    // 1000 single-char concats. Worklist grows 16 → 32 → 64 → 128 → 256 → 512 → 1024.
    // 7 grow events, total slots allocated = 16 + 32 + ... + 1024 = 2032 (≈ 2 × 1000).
    const src = `
      /** @returns {number} */
      export function run() {
        let text = "";
        for (let i = 0; i < 1000; i++) text += "A";
        let sum = 0;
        for (let i = 0; i < text.length; i++) {
          sum = (sum + text.charCodeAt(i)) | 0;
        }
        return sum;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    const m = await WebAssembly.compile(r.binary);
    const inst = await WebAssembly.instantiate(m, {});
    const out = (inst.exports as any).run();
    // 1000 × 'A' = 1000 × 65 = 65000
    expect(out).toBe(65000);
  });

  it("string-hash kernel: hashes a 5,000-char rope in well under 5 seconds (#1184 AC)", async () => {
    // Acceptance criterion #2 from the issue:
    //   The labs `string-hash` benchmark (`run(20000)`) completes in well under
    //   60 seconds on `wasmtime run` with `--target wasi`, returning the same
    //   hash as the Node.js baseline.
    //
    // We use n=5000 here (smaller than the 20K target) to get a fast unit test
    // that still exercises the grow-path hot loop. Pre-#1184, even n=5000 took
    // many seconds because each charCodeAt allocated a 5K-slot worklist.
    // Post-#1184, the same workload should run in under 5 seconds. The full
    // 20K case is a benchmark concern (covered by labs/), not a unit test.
    const src = `
      /** @param {number} n @returns {number} */
      export function run(n) {
        let text = "";
        for (let i = 0; i < n; i++) text += "x";
        let h = 0;
        for (let i = 0; i < text.length; i++) {
          h = (h * 31 + text.charCodeAt(i)) | 0;
        }
        return h;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    const m = await WebAssembly.compile(r.binary);
    const inst = await WebAssembly.instantiate(m, {});
    const start = performance.now();
    const h = (inst.exports as any).run(5000);
    const elapsed = performance.now() - start;
    // Compute expected hash to verify correctness.
    let expected = 0;
    for (let i = 0; i < 5000; i++) {
      expected = (expected * 31 + 120) | 0; // 'x' is 120
    }
    expect(h).toBe(expected);
    expect(elapsed).toBeLessThan(5000); // < 5s, vs >60s pre-fix on n=20K
  }, 30_000);
});
