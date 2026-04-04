import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { readFileSync } from "fs";
import { parseMeta, wrapTest } from "./test262-runner.ts";
import { buildImports } from "../src/runtime.ts";

// Read the list of currently failing negative tests from latest test262 run
const lines = readFileSync("/tmp/current-neg-failures.txt", "utf-8").trim().split("\n");

describe("Issue #927 batch test — negative test rejection rate", () => {
  it("should reject negative tests (matching vitest runner behavior)", async () => {
    let nowReject = 0;
    let stillAccept = 0;
    let fileErrors = 0;
    const acceptedTests: string[] = [];

    for (const rel of lines) {
      const fullPath = "/workspace/test262/" + rel;
      try {
        const src = readFileSync(fullPath, "utf-8");
        const meta = parseMeta(src);

        // Use wrapTest like the vitest runner does (includes resolveUnicodeEscapes etc.)
        const { source: wrapped } = wrapTest(src, meta);

        // Compile with skipSemanticDiagnostics like the worker does
        const result = compile(wrapped, {
          fileName: "test.ts",
          emitWat: false,
          skipSemanticDiagnostics: true,
        });

        // Same logic as test262-worker.mjs: check success and error-severity only
        const hasErrors = !result.success || result.errors.some((e: any) => e.severity === "error");

        if (hasErrors) {
          nowReject++;
          continue;
        }

        // Compilation succeeded — try instantiation (like the worker does)
        try {
          const imports = buildImports(result.imports, undefined, result.stringPool);
          await WebAssembly.instantiate(result.binary, imports);
        } catch {
          // Instantiation failed — counts as rejection
          nowReject++;
          continue;
        }

        // Compiled AND instantiated successfully — still failing
        stillAccept++;
        if (acceptedTests.length < 30) {
          acceptedTests.push(rel);
        }
      } catch {
        fileErrors++;
      }
    }

    console.log(`\n  Results: ${nowReject} now rejected, ${stillAccept} still accepted, ${fileErrors} file errors`);
    console.log(`  Rate: ${nowReject}/${lines.length} = ${(nowReject/lines.length*100).toFixed(1)}%`);
    if (acceptedTests.length > 0) {
      console.log(`  Still accepted (first ${Math.min(acceptedTests.length, 20)}):`);
      for (const t of acceptedTests.slice(0, 20)) console.log(`    ${t}`);
    }
    // Acceptance criteria: significant improvement
    expect(nowReject).toBeGreaterThanOrEqual(100);
  }, 600000);
});
