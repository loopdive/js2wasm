import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("wasm-opt optimization pass", () => {
  const source = `
    export function add(a: number, b: number): number {
      return a + b;
    }
    export function fib(n: number): number {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    }
  `;

  it("compiles successfully without optimize flag", () => {
    const result = compile(source);
    expect(result.success).toBe(true);
    expect(result.binary.byteLength).toBeGreaterThan(0);
  });

  it("compiles successfully with optimize: true", () => {
    const result = compile(source, { optimize: true });
    expect(result.success).toBe(true);
    expect(result.binary.byteLength).toBeGreaterThan(0);
    // When wasm-opt is not available, we should get the original binary back
    // with a warning. When it IS available, we get an optimized binary.
    // Either way, compilation should succeed.
  });

  it("compiles successfully with optimize: 1", () => {
    const result = compile(source, { optimize: 1 });
    expect(result.success).toBe(true);
    expect(result.binary.byteLength).toBeGreaterThan(0);
  });

  it("gracefully handles missing wasm-opt with a warning", () => {
    // This test verifies the graceful fallback behavior.
    // If wasm-opt is not installed, the result should still be successful
    // but may contain a warning about wasm-opt not being available.
    const result = compile(source, { optimize: true });
    expect(result.success).toBe(true);

    const hasOptWarning = result.errors.some(
      (e) => e.severity === "warning" && e.message.includes("wasm-opt"),
    );

    // If optimization was not applied (no binaryen npm package, no system binary),
    // there should be a warning. If it WAS applied, no warning.
    // We just verify the contract: success is true in both cases.
    if (hasOptWarning) {
      // Verify the binary is the same as without optimization
      const unoptimized = compile(source);
      expect(result.binary.byteLength).toBe(unoptimized.binary.byteLength);
    }
  });

  it("produces valid wasm binary header with optimize flag", () => {
    const result = compile(source, { optimize: true });
    expect(result.success).toBe(true);
    // Wasm magic number: \0asm
    expect(result.binary[0]).toBe(0x00);
    expect(result.binary[1]).toBe(0x61);
    expect(result.binary[2]).toBe(0x73);
    expect(result.binary[3]).toBe(0x6d);
  });

  it("does not affect WAT output (WAT is from pre-optimization IR)", () => {
    const withOpt = compile(source, { optimize: true });
    const withoutOpt = compile(source);
    // WAT should be the same regardless of optimize flag,
    // because WAT is emitted from the IR, not from the binary
    expect(withOpt.wat).toBe(withoutOpt.wat);
  });
});
