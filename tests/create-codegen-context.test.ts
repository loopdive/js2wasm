/**
 * Tests for createCodegenContext() factory (#636).
 *
 * Verifies that the shared factory initializes all fields correctly,
 * including WASI fields that were previously missing from generateMultiModule.
 */
import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/index.js";
import ts from "typescript";

/** Create a minimal TypeChecker stub for testing context creation. */
function makeDummyChecker(): ts.TypeChecker {
  // We only need the object to exist — no methods are called during context creation.
  return {} as unknown as ts.TypeChecker;
}

describe("createCodegenContext", () => {
  it("initializes all fields with defaults (no options)", () => {
    const mod = createEmptyModule();
    const checker = makeDummyChecker();
    const ctx = createCodegenContext(mod, checker);

    expect(ctx.mod).toBe(mod);
    expect(ctx.checker).toBe(checker);
    expect(ctx.funcMap.size).toBe(0);
    expect(ctx.structMap.size).toBe(0);
    expect(ctx.numImportFuncs).toBe(0);
    expect(ctx.currentFunc).toBeNull();
    expect(ctx.errors).toEqual([]);
    expect(ctx.exnTagIdx).toBe(-1);
    expect(ctx.wasi).toBe(false);
    expect(ctx.wasiFdWriteIdx).toBe(-1);
    expect(ctx.wasiProcExitIdx).toBe(-1);
    expect(ctx.wasiBumpPtrGlobalIdx).toBe(-1);
    expect(ctx.fast).toBe(false);
    expect(ctx.nativeStrings).toBe(false);
    expect(ctx.sourceMap).toBe(false);
  });

  it("propagates options.wasi correctly", () => {
    const mod = createEmptyModule();
    const checker = makeDummyChecker();
    const ctx = createCodegenContext(mod, checker, { wasi: true });

    expect(ctx.wasi).toBe(true);
    // WASI implies nativeStrings
    expect(ctx.nativeStrings).toBe(true);
    // WASI idx fields start at -1 (registered later by registerWasiImports)
    expect(ctx.wasiFdWriteIdx).toBe(-1);
    expect(ctx.wasiProcExitIdx).toBe(-1);
    expect(ctx.wasiBumpPtrGlobalIdx).toBe(-1);
  });

  it("propagates options.fast correctly", () => {
    const mod = createEmptyModule();
    const checker = makeDummyChecker();
    const ctx = createCodegenContext(mod, checker, { fast: true });

    expect(ctx.fast).toBe(true);
    // fast implies nativeStrings
    expect(ctx.nativeStrings).toBe(true);
  });

  it("propagates options.sourceMap correctly", () => {
    const mod = createEmptyModule();
    const checker = makeDummyChecker();
    const ctx = createCodegenContext(mod, checker, { sourceMap: true });

    expect(ctx.sourceMap).toBe(true);
  });

  it("pre-registers common vec types", () => {
    const mod = createEmptyModule();
    const checker = makeDummyChecker();
    const ctx = createCodegenContext(mod, checker);

    // Pre-registration of externref and f64 vec types should have happened
    expect(ctx.vecTypeMap.has("externref")).toBe(true);
    expect(ctx.vecTypeMap.has("f64")).toBe(true);
  });
});
