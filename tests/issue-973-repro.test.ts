import { compile, createIncrementalCompiler } from "../src/index.ts";
import { describe, it, expect } from "vitest";

describe("issue-973: incremental compiler state leak", () => {
  it("incremental compiler should produce same result as standalone", () => {
    const contaminant = `
      class MyError extends Error {
        constructor(msg: string) { super(msg); this.name = "MyError"; }
      }
      export function test(): number {
        try { throw new MyError("test"); } catch (e) { return 1; }
      }
    `;
    const victim = `
      export function test(): number { const x = 42; return x; }
    `;

    const standaloneResult = compile(victim, { fileName: "test.ts" });
    const compiler = createIncrementalCompiler({ fileName: "test.ts" });
    compiler.compile(contaminant);
    const incrementalResult = compiler.compile(victim);
    compiler.dispose();

    console.log("Standalone:", {
      success: standaloneResult.success,
      binarySize: standaloneResult.binary.length,
      importCount: standaloneResult.imports.length,
    });
    console.log("Incremental:", {
      success: incrementalResult.success,
      binarySize: incrementalResult.binary.length,
      importCount: incrementalResult.imports.length,
    });

    expect(standaloneResult.success).toBe(true);
    expect(incrementalResult.success).toBe(true);
    expect(incrementalResult.imports.length).toBe(standaloneResult.imports.length);
  });

  it("performance: incremental compile time is reasonable", () => {
    const compiler = createIncrementalCompiler({
      fileName: "test.ts",
      skipSemanticDiagnostics: true,
    });

    const source = `export function test(): number { return Math.max(1, 2); }`;

    // Warm up
    compiler.compile(source);

    // Time 5 compilations
    const start = performance.now();
    for (let i = 0; i < 5; i++) {
      compiler.compile(source);
    }
    const elapsed = performance.now() - start;
    const perTest = elapsed / 5;

    compiler.dispose();
    console.log(`5 compilations: ${elapsed.toFixed(0)}ms (${perTest.toFixed(0)}ms/test)`);

    // Should be under 500ms per test (standalone is ~100-200ms)
    expect(perTest).toBeLessThan(500);
  }, 30000);
});
