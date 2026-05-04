/**
 * #1222 — wasm-hash noise filter for PR regression gate.
 *
 * The dev-self-merge gate counts pass→fail transitions as regressions, but
 * symmetric flip noise (CI runner variance: scheduling, memory pressure, GC
 * timing) inflates that count even when the compiled Wasm binary is byte-
 * identical on both base and branch. Pass→fail flips on identical Wasm cannot
 * be real compiler regressions.
 *
 * The fix is to record a 12-char sha256 hex digest of the binary in each
 * test262 result entry, and to filter regressions in `diff-test262.ts` so
 * that byte-identical "regressions" no longer count.
 *
 * This test verifies:
 *   1. `computeWasmSha` returns a 12-char hex string for a real binary
 *   2. The hash is deterministic — same input source produces the same hash
 *   3. Distinct sources produce distinct hashes
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { computeWasmSha } from "./test262-runner.js";

const HEX_12 = /^[0-9a-f]{12}$/;

function compileSimple(src: string): Uint8Array {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    const errs = result.errors.map((e) => `L${e.line}:${e.column} ${e.message}`).join("; ");
    throw new Error(`compile failed: ${errs}`);
  }
  return result.binary;
}

describe("#1222 — wasm-hash noise filter", () => {
  it("computeWasmSha returns a 12-char lowercase hex digest", () => {
    const binary = compileSimple(`export function test(): number { return 1; }`);
    const sha = computeWasmSha(binary);
    expect(sha).toMatch(HEX_12);
    expect(sha.length).toBe(12);
  });

  it("is deterministic — compiling the same snippet twice yields the same sha", () => {
    const src = `export function test(): number { return 42; }`;
    const a = computeWasmSha(compileSimple(src));
    const b = computeWasmSha(compileSimple(src));
    expect(a).toBe(b);
    expect(a).toMatch(HEX_12);
  });

  it("is sensitive to source changes — distinct sources yield distinct shas", () => {
    const a = computeWasmSha(compileSimple(`export function test(): number { return 1; }`));
    const b = computeWasmSha(compileSimple(`export function test(): number { return 2; }`));
    // Different return values produce a different f64.const operand in the
    // emitted Wasm, so the binaries cannot be byte-identical even after
    // constant folding.
    expect(a).not.toBe(b);
    expect(a).toMatch(HEX_12);
    expect(b).toMatch(HEX_12);
  });

  it("hashes raw Uint8Array bytes (independent of compiler)", () => {
    // Cover the pure-function contract: feed the same bytes, get the same hash;
    // change a single byte, get a different hash. This protects the regression-
    // gate filter from upstream changes to the compiler.
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const a = computeWasmSha(bytes);
    const b = computeWasmSha(bytes);
    expect(a).toBe(b);

    const mutated = new Uint8Array(bytes);
    mutated[0] = 0xff;
    const c = computeWasmSha(mutated);
    expect(c).not.toBe(a);
    expect(c).toMatch(HEX_12);
  });
});
