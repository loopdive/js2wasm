/**
 * Shared helpers for vitest bench benchmarks.
 * Compiles and instantiates wasm modules for benchmarking.
 */
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import type { CompileOptions } from "../src/index.js";

export async function compileAndRun(
  source: string,
  options: CompileOptions = {},
): Promise<Record<string, Function>> {
  const result = compile(source, options);
  if (!result.success) {
    throw new Error(
      result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"),
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports as Record<string, Function>;
}

/**
 * Try to compile and instantiate; return null instead of throwing on failure.
 * Used so a failing gc-native variant doesn't crash the entire benchmark suite.
 */
export async function tryCompileAndRun(
  source: string,
  options: CompileOptions = {},
): Promise<Record<string, Function> | null> {
  try {
    return await compileAndRun(source, options);
  } catch {
    return null;
  }
}
