export type ImportIntent =
  | { type: "string_literal"; value: string }
  | { type: "math"; method: string }
  | { type: "console_log"; variant: string }
  | { type: "extern_class"; className: string; action: "new" | "method" | "get" | "set"; member?: string }
  | { type: "string_method"; method: string }
  | { type: "builtin"; name: string }
  | { type: "callback_maker" }
  | { type: "await" }
  | { type: "typeof_check"; targetType: string }
  | { type: "box"; targetType: string }
  | { type: "unbox"; targetType: string }
  | { type: "extern_get" }
  | { type: "truthy_check" }
  | { type: "date_new" }
  | { type: "date_method"; method: string }
  | { type: "declared_global"; name: string };

export interface ImportDescriptor {
  module: "env" | "wasm:js-string" | "string_constants";
  name: string;
  kind: "func" | "global";
  intent: ImportIntent;
}

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
  /** Import descriptors for closed import building */
  imports: ImportDescriptor[];
}

export interface CompileError {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
}

export interface DomContainmentOptions {
  domRoot: Element | ShadowRoot;
}

export interface ImportPolicy {
  blocked: Set<string>;
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
  /** Compilation target: "gc" (WasmGC, default) or "linear" (linear memory) */
  target?: "gc" | "linear";
  /** Enable fast mode — i32 default numbers, performance optimizations */
  fast?: boolean;
  /** Enable SIMD-accelerated string/array helpers (requires engine SIMD support) */
  simd?: boolean;
  /** Enable safe mode — reject unsafe TypeScript patterns at compile time */
  safe?: boolean;
  /** Globals allowed in safe mode (e.g. ["document"]) */
  allowedGlobals?: string[];
  /** Extern class members allowed in safe mode (e.g. { Element: ["textContent"] }) */
  allowedExternMembers?: Record<string, string[]>;
  /** Allow JavaScript source files as input (auto-detected for .js fileName) */
  allowJs?: boolean;
  /** Virtual file name for the source (controls language: use ".js" for JS input) */
  fileName?: string;
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
  buildImports,
  buildStringConstants,
  checkPolicy,
  compileAndInstantiate,
  instantiateWasm,
} from "./runtime.js";
