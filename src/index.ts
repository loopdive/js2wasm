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
  | { type: "extern_set" }
  | { type: "truthy_check" }
  | { type: "date_new" }
  | { type: "date_method"; method: string }
  | { type: "declared_global"; name: string }
  | { type: "dynamic_import" };

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
  /** C header file content (only present when abi: "c") */
  cHeader?: string;
  /** WIT interface definition (only present when wit option is enabled) */
  wit?: string;
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
  /** Compilation target: "gc" (WasmGC, default), "linear" (linear memory), or "wasi" (WASI-compatible GC) */
  target?: "gc" | "linear" | "wasi";
  /** Enable fast mode — i32 default numbers, performance optimizations */
  fast?: boolean;
  /** Use WasmGC-native strings (array i16) instead of wasm:js-string imports.
   *  Enabled automatically when fast: true or target: "wasi".
   *  Required for non-browser runtimes (wasmtime, wasmer, etc.) */
  nativeStrings?: boolean;
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
  /** Module resolution options for npm packages */
  resolve?: {
    /** Directories to search for modules (default: ["node_modules"]) */
    modules?: string[];
    /** File extensions to try during resolution (default: [".ts", ".tsx", ".d.ts"]) */
    extensions?: string[];
  };
  /** Packages to keep as host imports (not resolved/bundled) */
  externals?: string[];
  /** Enable tree-shaking to eliminate unused exports (default: false) */
  treeshake?: boolean;
  /** ABI for exported functions: "default" (normal) or "c" (C-compatible calling conventions).
   *  C ABI is only supported with target: "linear". Strings/arrays become (ptr, len) pairs. */
  abi?: "default" | "c";
  /** Enable hardened mode: reject eval, Function constructor, with, __proto__ at compile time */
  hardened?: boolean;
  /** Skip semantic diagnostics for faster compilation (checker still available for type queries) */
  skipSemanticDiagnostics?: boolean;
  /** Generate a WIT (WebAssembly Interface Types) file from exported functions.
   *  When set, the result will include a `wit` field with the WIT interface definition.
   *  Value can be true (use defaults) or an object with packageName/worldName options. */
  wit?: boolean | { packageName?: string; worldName?: string };
  /** Run Binaryen wasm-opt post-processing on the output binary (default: false).
   *  Requires either the 'binaryen' npm package or wasm-opt on PATH.
   *  Set to true for -O3 defaults, or pass a number (1-4) for a specific level. */
  optimize?: boolean | 1 | 2 | 3 | 4;
}

import * as path from "path";
import { compileSource, compileMultiSource, compileToObjectSource } from "./compiler.js";
import { ModuleResolver, resolveAllImports } from "./resolve.js";
import { treeshake, getEntryExportNames } from "./treeshake.js";

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

/**
 * Compile a TypeScript project from an entry file on disk.
 * Resolves npm package imports and relative imports recursively,
 * then compiles all resolved files into a single Wasm module.
 *
 * @param entryFile - Absolute or relative path to the entry .ts file
 * @param options - Compile options including resolve and externals settings
 */
export function compileProject(
  entryFile: string,
  options?: CompileOptions,
): CompileResult {
  const resolvedEntry = path.resolve(entryFile);
  const rootDir = path.dirname(resolvedEntry);

  // Create resolver
  const resolver = new ModuleResolver(rootDir, options);

  // Resolve all imports recursively
  const allFiles = resolveAllImports(resolvedEntry, resolver);

  // Convert to the Record<string, string> format expected by compileMulti
  const files: Record<string, string> = {};
  for (const [filePath, content] of allFiles) {
    // Use relative paths from root dir as keys
    const relPath = path.relative(rootDir, filePath);
    // Ensure paths start with ./ for the multi-file compiler
    const key = relPath.startsWith(".") ? relPath : `./${relPath}`;
    files[key] = content;
  }

  // Entry file key
  const entryKey = `./${path.relative(rootDir, resolvedEntry)}`;

  return compileMultiSource(files, entryKey, options);
}

export { generateWit } from "./wit-generator.js";
export type { WitGeneratorOptions } from "./wit-generator.js";
export { ModuleResolver, resolveAllImports, getBarePackageName } from "./resolve.js";
export { treeshake, getEntryExportNames } from "./treeshake.js";

export {
  jsString,
  buildImports,
  buildStringConstants,
  checkPolicy,
  compileAndInstantiate,
  instantiateWasm,
} from "./runtime.js";
