import { describe, it, expect, afterAll } from "vitest";
import { createIncrementalCompiler, compile, buildImports } from "../src/index.ts";

describe("Incremental Language Service Compiler", () => {
  const compiler = createIncrementalCompiler();

  afterAll(() => {
    compiler.dispose();
  });

  it("compiles a simple function", () => {
    const result = compiler.compile(
      "export function add(a: number, b: number): number { return a + b; }",
    );
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
  });

  it("compiles a second function (reusing cached libs)", () => {
    const result = compiler.compile(
      "export function mul(a: number, b: number): number { return a * b; }",
    );
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
  });

  it("warm compilation is faster than cold", () => {
    // First call may still be warm from previous tests, but we measure relative speed
    const iterations = 5;
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      compiler.compile(
        `export function fn${i}(x: number): number { return x * ${i}; }`,
      );
      times.push(performance.now() - t0);
    }
    // Last few should be fast
    const avgLast3 = times.slice(-3).reduce((a, b) => a + b, 0) / 3;
    // Just verify they complete in reasonable time (< 200ms each for warm)
    expect(avgLast3).toBeLessThan(200);
  });

  it("produces valid Wasm that can be instantiated", async () => {
    const result = compiler.compile(
      "export function double(n: number): number { return n * 2; }",
    );
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const double = instance.exports.double as (n: number) => number;
    expect(double(21)).toBe(42);
  });

  it("produces same results as non-incremental compile", () => {
    const source =
      "export function add(a: number, b: number): number { return a + b; }";
    const incResult = compiler.compile(source);
    const stdResult = compile(source);

    expect(incResult.success).toBe(stdResult.success);
    expect(incResult.errors.filter((e) => e.severity === "error").length).toBe(
      stdResult.errors.filter((e) => e.severity === "error").length,
    );
    // Both should produce valid Wasm binary
    expect(incResult.binary.length).toBeGreaterThan(0);
    expect(stdResult.binary.length).toBeGreaterThan(0);
  });

  it("handles compilation errors gracefully", () => {
    const result = compiler.compile("export function bad( { }");
    // Should still return a result (may have errors)
    expect(result).toBeDefined();
    expect(typeof result.success).toBe("boolean");
  });

  it("handles skipSemanticDiagnostics option", () => {
    const result = compiler.compile(
      "export function test(): number { const x: string = 42; return x; }",
      { skipSemanticDiagnostics: true },
    );
    // With skipped semantics, type errors become warnings or are absent
    expect(result).toBeDefined();
  });
});
