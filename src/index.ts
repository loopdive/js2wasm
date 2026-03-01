export interface CompileResult {
  /** Wasm binary with GC proposal */
  binary: Uint8Array;
  /** WAT text representation (debug) */
  wat: string;
  /** TypeScript declaration file for exports and imports */
  dts: string;
  /** JS module with createImports() helper function */
  importsHelper: string;
  /** true if compilation was successful */
  success: boolean;
  /** Error messages with line numbers */
  errors: CompileError[];
  /** String literal pool (values used in the source) */
  stringPool: string[];
  /** Source map v3 JSON string (only present when sourceMap option is enabled) */
  sourceMap?: string;
}

export interface CompileError {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
}

export interface CompileOptions {
  /** Emit WAT debug output (default: true) */
  emitWat?: boolean;
  /** Module name (for debugging) */
  moduleName?: string;
  /** Generate source map (default: false) */
  sourceMap?: boolean;
  /** Source map URL to embed in the wasm binary (default: "module.wasm.map") */
  sourceMapUrl?: string;
}

import { compileSource, compileMultiSource, compileToObjectSource } from "./compiler.js";

/**
 * Compile TypeScript source to Wasm GC binary.
 *
 * @example
 * ```ts
 * const result = compile(`
 *   export function add(a: number, b: number): number {
 *     return a + b;
 *   }
 * `);
 * if (result.success) {
 *   const { instance } = await WebAssembly.instantiate(result.binary, imports);
 *   console.log(instance.exports.add(2, 3)); // 5
 * }
 * ```
 */
export function compile(
  source: string,
  options?: CompileOptions,
): CompileResult {
  return compileSource(source, options);
}

/**
 * Compile multiple TypeScript source files into a single Wasm GC binary.
 * Supports cross-file imports: `import { foo } from "./bar"`.
 */
export function compileMulti(
  files: Record<string, string>,
  entryFile: string,
  options?: CompileOptions,
): CompileResult {
  return compileMultiSource(files, entryFile, options);
}

/** Only WAT text (debug) */
export function compileToWat(source: string): string {
  const result = compileSource(source, { emitWat: true });
  return result.wat;
}

/**
 * Compile TypeScript source to a relocatable Wasm object file (.o).
 * The output contains LLVM-style linking and relocation metadata
 * suitable for use with a Wasm linker.
 */
export function compileToObject(
  source: string,
  options?: CompileOptions,
) {
  return compileToObjectSource(source, options);
}

export {
  jsString,
  jsApi,
  domApi,
  buildImports,
  compileAndInstantiate,
} from "./runtime.js";
