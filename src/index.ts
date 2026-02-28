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
}

import { compileSource } from "./compiler.js";

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

/** Only WAT text (debug) */
export function compileToWat(source: string): string {
  const result = compileSource(source, { emitWat: true });
  return result.wat;
}

export {
  jsString,
  jsApi,
  domApi,
  buildImports,
  compileAndInstantiate,
} from "./runtime.js";
