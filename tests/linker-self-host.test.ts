import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { compileMulti } from "../src/index.js";

function loadLinkerFiles(): Record<string, string> {
  return {
    // Linker source files (under link/)
    "link/reader.ts": readFileSync("src/link/reader.ts", "utf8"),
    "link/resolver.ts": readFileSync("src/link/resolver.ts", "utf8"),
    "link/isolation.ts": readFileSync("src/link/isolation.ts", "utf8"),
    "link/linker.ts": readFileSync("src/link/linker.ts", "utf8"),
    "link/index.ts": readFileSync("src/link/index.ts", "utf8"),
    // External dependencies (under emit/)
    "emit/encoder.ts": readFileSync("src/emit/encoder.ts", "utf8"),
    "emit/opcodes.ts": readFileSync("src/emit/opcodes.ts", "utf8"),
  };
}

describe("linker self-host", { timeout: 60_000 }, () => {
  it("compiles the linker source files via the linear backend", () => {
    const files = loadLinkerFiles();
    const result = compileMulti(files, "link/index.ts", { target: "linear" });

    // Separate codegen errors from type-check errors
    const codegenErrors = result.errors.filter((e) => e.message.startsWith("Codegen error:"));
    const otherErrors = result.errors.filter((e) => !e.message.startsWith("Codegen error:"));
    if (otherErrors.length > 0) {
      console.log(`Type-check errors (${otherErrors.length}):`);
      for (const err of otherErrors.slice(0, 10)) {
        console.log(`  ${err.line}:${err.column} ${err.message}`);
      }
      if (otherErrors.length > 10) console.log(`  ... and ${otherErrors.length - 10} more`);
    }
    if (codegenErrors.length > 0) {
      console.log(`Codegen errors (${codegenErrors.length}):`);
      for (const err of codegenErrors) {
        console.log(`  ${err.message}`);
      }
    }
    // Error breakdown
    const errCounts = new Map<string, number>();
    for (const e of result.errors) {
      const key = e.message.split(":")[0] ?? e.message.slice(0, 40);
      errCounts.set(key, (errCounts.get(key) ?? 0) + 1);
    }
    console.log(
      `success: ${result.success}, binary size: ${result.binary.length}, total errors: ${result.errors.length}`,
    );
    for (const [k, v] of [...errCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${v}x ${k}`);
    }
    // Show unique unsupported property access and method call errors
    const propErrors = new Set<string>();
    const methodErrors = new Set<string>();
    const identErrors = new Set<string>();
    for (const e of result.errors) {
      if (e.message.startsWith("Unsupported property access") && propErrors.size < 15) propErrors.add(e.message);
      if (e.message.startsWith("Unsupported method call") && methodErrors.size < 15) methodErrors.add(e.message);
      if (e.message.startsWith("Unknown identifier") && identErrors.size < 10) identErrors.add(e.message);
      if (e.message.startsWith("Unknown function") && identErrors.size < 10) identErrors.add(e.message);
    }
    if (propErrors.size > 0) {
      console.log("Property access errors:");
      for (const e of propErrors) console.log("  " + e);
    }
    if (methodErrors.size > 0) {
      console.log("Method call errors:");
      for (const e of methodErrors) console.log("  " + e);
    }
    if (identErrors.size > 0) {
      console.log("Identifier errors:");
      for (const e of identErrors) console.log("  " + e);
    }

    expect(result.success).toBe(true);
  });

  it("linker.wasm validates and instantiates", async () => {
    const files = loadLinkerFiles();
    const result = compileMulti(files, "link/index.ts", { target: "linear" });
    expect(result.success).toBe(true);

    // Write binary to file for wasm-tools analysis
    writeFileSync("/tmp/linker.wasm", result.binary);

    // Verify the module validates and instantiates
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect(instance).toBeDefined();
  });
});
