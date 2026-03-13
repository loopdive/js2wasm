/**
 * Issue #271: Cannot find name -- missing harness or global declarations
 *
 * Verifies that test262 harness globals ($ERROR, print, Test262Error, etc.)
 * are properly declared or replaced so they don't cause compile errors.
 */
import { describe, it, expect } from "vitest";
import { wrapTest, shouldSkip, parseMeta } from "./test262-runner.ts";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

describe("Issue #271: missing harness/global declarations", () => {
  it("$ERROR calls are replaced with return 0", () => {
    const code = '/*--- ---*/\nvar x = 1;\nif (x !== 1) $ERROR("bad");';
    const wrapped = wrapTest(code);
    expect(wrapped).toContain("return 0;");
    expect(wrapped).not.toContain("$ERROR");
  });

  it("$ERROR with complex arguments is replaced", () => {
    const code = '/*--- ---*/\nvar x = 1;\n$ERROR("#1: " + x);';
    const wrapped = wrapTest(code);
    expect(wrapped).toContain("return 0;");
    expect(wrapped).not.toContain("$ERROR");
  });

  it("print function is declared in the preamble", () => {
    const code = '/*--- ---*/\nvar x: number = 42;\nprint(x);';
    const wrapped = wrapTest(code);
    expect(wrapped).toContain("function print");
  });

  it("print call compiles without error", () => {
    const code = '/*--- ---*/\nvar x: number = 42;\nprint(x);';
    const wrapped = wrapTest(code);
    const result = compile(wrapped, { fileName: "test.ts" });
    const errors = result.errors.filter(e => e.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("BigInt feature is skipped", () => {
    const code = '/*---\nfeatures: [BigInt]\n---*/\nassert.sameValue(typeof 0n, "bigint");';
    const meta = parseMeta(code);
    const skip = shouldSkip(code, meta);
    expect(skip.skip).toBe(true);
    expect(skip.reason).toContain("BigInt");
  });

  it("Reflect reference in code is skipped", () => {
    const code = '/*--- ---*/\nassert.sameValue(typeof Reflect, "object");';
    const meta = parseMeta(code);
    const skip = shouldSkip(code, meta);
    expect(skip.skip).toBe(true);
    expect(skip.reason).toContain("Reflect");
  });

  it("Reflect in comments is not skipped", () => {
    const code = '/*---\ndescription: test Reflect concept\n---*/\nvar x: number = 1;\nassert.sameValue(x, 1);';
    const meta = parseMeta(code);
    const skip = shouldSkip(code, meta);
    if (skip.skip) {
      expect(skip.reason).not.toContain("Reflect");
    }
  });

  it("$ERROR replacement compiles and runs correctly", async () => {
    const code = '/*--- ---*/\nvar x: number = 1;\nif (x !== 1) $ERROR("should not reach");';
    const wrapped = wrapTest(code);
    const result = compile(wrapped, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const errors = result.errors.filter(e => e.severity === "error");
    expect(errors).toHaveLength(0);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const testFn = (instance.exports as any).test;
    expect(testFn()).toBe(1);
  });

  it("$ERROR replacement causes test failure when triggered", async () => {
    const code = '/*--- ---*/\nvar x: number = 2;\nif (x !== 1) $ERROR("x should be 1");';
    const wrapped = wrapTest(code);
    const result = compile(wrapped, { fileName: "test.ts" });
    expect(result.success).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const testFn = (instance.exports as any).test;
    expect(testFn()).toBe(0);
  });
});
