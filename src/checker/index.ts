import ts from "typescript";

function getBundledLibFiles(): Record<string, string> | undefined {
  const files = (globalThis as any).__js2wasmTsLibFiles ?? (globalThis as any).__ts2wasmTsLibFiles;
  return files && typeof files === "object" ? (files as Record<string, string>) : undefined;
}

async function safeImport<T>(id: string): Promise<T | null> {
  try {
    return (await import(/* @vite-ignore */ id)) as T;
  } catch {
    return null;
  }
}

// Top-level await loads for all Node builtins — browsers get null silently.
const _nodePathMod = await safeImport<typeof import("node:path")>("node:path");
function getPath() {
  return _nodePathMod;
}
function dirname(p: string) {
  return getPath()?.dirname(p) ?? "";
}
function join(...args: string[]) {
  return getPath()?.join(...args) ?? args.join("/");
}
// Top-level await: resolve Node builtins once at module load.
// In browsers, these silently resolve to null.
const _nodeFsMod = await safeImport<typeof import("node:fs")>("node:fs");
const _nodeModuleMod = await safeImport<typeof import("node:module")>("node:module");
const _nodeUrlMod = await safeImport<typeof import("node:url")>("node:url");

function getReadFileSync() {
  return _nodeFsMod?.readFileSync ?? null;
}
function getCreateRequire() {
  return _nodeModuleMod?.createRequire ?? null;
}
function getFileURLToPath() {
  return _nodeUrlMod?.fileURLToPath ?? null;
}
// Custom type declarations not found in TS lib files
// All lib types now loaded from the typescript package at runtime.
// No custom lib imports needed — lib: ["es2021", "dom"] in compilerOptions
// handles everything including Generator, Iterator, Map, Set, etc.

export interface TypedAST {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  diagnostics: ts.Diagnostic[];
  syntacticDiagnostics: readonly ts.Diagnostic[];
}

// ── Lazy lib file resolution ────────────────────────────────────────────────

/** Resolved directory containing TypeScript lib .d.ts files (cached) */
let _tsLibDir: string | undefined;
function getTsLibDir(): string {
  if (_tsLibDir === undefined) {
    try {
      // Use createRequire to resolve the typescript package location
      // This works in both CJS and ESM contexts
      const cr = getCreateRequire();
      const fup = getFileURLToPath();
      if (!cr || !fup) throw new Error("Node.js modules not available");
      const esmRequire = cr(typeof __filename !== "undefined" ? __filename : fup(import.meta.url));
      _tsLibDir = dirname(esmRequire.resolve("typescript/lib/lib.d.ts"));
    } catch {
      try {
        // Fallback: try CJS require
        _tsLibDir = dirname(require.resolve("typescript/lib/lib.d.ts"));
      } catch {
        _tsLibDir = "";
      }
    }
  }
  return _tsLibDir;
}

/**
 * Read a lib .d.ts file from the installed typescript package at runtime.
 * Returns empty string if the file cannot be found (e.g. browser environment).
 */
function readLibFile(name: string): string {
  const bundled = getBundledLibFiles()?.[name];
  if (typeof bundled === "string" && bundled.length > 0) {
    return bundled;
  }
  try {
    const rfs = getReadFileSync();
    if (!rfs) return "";
    return rfs(join(getTsLibDir(), name), "utf-8");
  } catch {
    return "";
  }
}

/** Lazily-populated cache of lib file contents */
const LIB_FILES: Record<string, string> = {};

/** Names of lib files that TS ships and we serve at runtime */
const TS_LIB_NAMES = new Set([
  "lib.es5.d.ts",
  "lib.dom.d.ts",
  "lib.decorators.d.ts",
  "lib.decorators.legacy.d.ts",
  "lib.es2015.d.ts",
  "lib.es2015.core.d.ts",
  "lib.es2015.collection.d.ts",
  "lib.es2015.generator.d.ts",
  "lib.es2015.iterable.d.ts",
  "lib.es2015.promise.d.ts",
  "lib.es2015.proxy.d.ts",
  "lib.es2015.reflect.d.ts",
  "lib.es2015.symbol.d.ts",
  "lib.es2015.symbol.wellknown.d.ts",
  "lib.es2021.d.ts",
  "lib.es2021.promise.d.ts",
  "lib.es2021.string.d.ts",
  "lib.es2021.weakref.d.ts",
]);

/**
 * Get the contents of a lib file by name. Reads from the typescript package
 * on first access, then caches. Custom declarations (generators, es2015,
 * es2021) are always available; standard TS libs are loaded from disk.
 */
function getLibSource(name: string): string | undefined {
  if (name in LIB_FILES) return LIB_FILES[name];

  // Composite lib.d.ts: concatenate all needed lib files directly.
  // We must include the sub-files (e.g. lib.es2015.collection.d.ts) rather than
  // the umbrella files (lib.es2015.d.ts) because umbrella files only contain
  // /// <reference lib="..."> directives which are NOT resolved when the content
  // is concatenated into a single source file.
  if (name === "lib.d.ts") {
    const libNames = [
      // ES5 base
      "lib.es5.d.ts",
      // ES2015 sub-libs (from lib.es2015.d.ts references)
      "lib.es2015.core.d.ts",
      "lib.es2015.collection.d.ts",
      "lib.es2015.generator.d.ts",
      "lib.es2015.iterable.d.ts",
      "lib.es2015.promise.d.ts",
      "lib.es2015.proxy.d.ts",
      "lib.es2015.reflect.d.ts",
      "lib.es2015.symbol.d.ts",
      "lib.es2015.symbol.wellknown.d.ts",
      // ES2016
      "lib.es2016.array.include.d.ts",
      "lib.es2016.intl.d.ts",
      // ES2017
      "lib.es2017.object.d.ts",
      "lib.es2017.string.d.ts",
      "lib.es2017.intl.d.ts",
      "lib.es2017.typedarrays.d.ts",
      "lib.es2017.date.d.ts",
      "lib.es2017.sharedmemory.d.ts",
      // ES2018
      "lib.es2018.asyncgenerator.d.ts",
      "lib.es2018.asynciterable.d.ts",
      "lib.es2018.intl.d.ts",
      "lib.es2018.promise.d.ts",
      "lib.es2018.regexp.d.ts",
      // ES2019
      "lib.es2019.array.d.ts",
      "lib.es2019.intl.d.ts",
      "lib.es2019.object.d.ts",
      "lib.es2019.string.d.ts",
      "lib.es2019.symbol.d.ts",
      // ES2020
      "lib.es2020.bigint.d.ts",
      "lib.es2020.date.d.ts",
      "lib.es2020.intl.d.ts",
      "lib.es2020.number.d.ts",
      "lib.es2020.promise.d.ts",
      "lib.es2020.sharedmemory.d.ts",
      "lib.es2020.string.d.ts",
      "lib.es2020.symbol.wellknown.d.ts",
      // ES2021
      "lib.es2021.intl.d.ts",
      "lib.es2021.promise.d.ts",
      "lib.es2021.string.d.ts",
      "lib.es2021.weakref.d.ts",
      // ES2024
      "lib.es2024.collection.d.ts",
      // ESNext — Set methods (union, intersection, difference, etc.)
      "lib.esnext.collection.d.ts",
      // DOM (decorators loaded via /// <reference> in lib.es5.d.ts)
      "lib.dom.d.ts",
    ];
    const parts = libNames.map((n) => getLibSource(n) ?? "");
    const content = parts.join("\n");
    LIB_FILES[name] = content;
    return content;
  }

  // Any lib.*.d.ts file — read from typescript package
  if (name.startsWith("lib.") && name.endsWith(".d.ts")) {
    const content = readLibFile(name);
    if (content) {
      LIB_FILES[name] = content;
      return content;
    }
    return undefined;
  }

  return undefined;
}

/** Check if a file name is a known lib file */
export function isKnownLibName(name: string): boolean {
  return name === "lib.d.ts" || TS_LIB_NAMES.has(name) || (name.startsWith("lib.") && name.endsWith(".d.ts"));
}

/** Pre-parsed lib SourceFiles — cached to avoid re-parsing on every compile */
const LIB_SOURCE_FILES = new Map<string, ts.SourceFile>();
export function getLibSourceFile(
  name: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.SourceFile | undefined {
  const content = getLibSource(name);
  if (content === undefined) return undefined;
  const key = `${name}:${JSON.stringify(languageVersion)}`;
  let sf = LIB_SOURCE_FILES.get(key);
  if (!sf) {
    sf = ts.createSourceFile(name, content, languageVersion);
    LIB_SOURCE_FILES.set(key, sf);
  }
  return sf;
}

export interface AnalyzeOptions {
  /** Allow JavaScript source files (enables allowJs + checkJs in TS compiler) */
  allowJs?: boolean;
  /** Skip semantic diagnostics collection (faster — checker still available for type queries) */
  skipSemanticDiagnostics?: boolean;
}

/**
 * ES spec early error diagnostic codes that should NOT be suppressed
 * even when skipSemanticDiagnostics is true. These correspond to
 * SyntaxError/ReferenceError conditions mandated by the spec.
 */
const ES_EARLY_ERROR_CODES = new Set([
  1100, // 'this' cannot be used as a parameter
  1102, // delete of unqualified identifier in strict mode
  1103, // delete target must be a property reference
  1210, // Invalid use of 'arguments' in class field initializer
  1211, // Class declaration without 'default' must have a name
  1213, // Identifier expected; 'X' is a reserved word in strict mode
  1214, // Identifier expected
  1359, // Identifier expected; 'yield' is a reserved keyword
  1360, // Identifier expected; 'await' is a reserved keyword
  2300, // Duplicate identifier
  2480, // 'import()' expression is not callable with this argument
  18050, // A rest element cannot have an initializer
]);

/**
 * Parse and type-check a TS or JS source file.
 * In-memory CompilerHost – no filesystem needed.
 */
export function analyzeSource(source: string, fileName = "input.ts", analyzeOptions?: AnalyzeOptions): TypedAST {
  const isJs = fileName.endsWith(".js") || fileName.endsWith(".jsx");
  const scriptKind = isJs ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const useAllowJs = isJs || analyzeOptions?.allowJs === true;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: !isJs,
    noImplicitAny: false,
    noEmit: true,
  };

  const compilerHost: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      if (name === fileName) {
        return ts.createSourceFile(name, source, languageVersion, true, scriptKind);
      }
      const libSf = getLibSourceFile(name, languageVersion);
      if (libSf) return libSf;
      return undefined;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName || isKnownLibName(name),
    readFile: () => undefined,
    getDirectories: () => [],
    directoryExists: () => true,
  };

  if (useAllowJs) {
    compilerOptions.allowJs = true;
    compilerOptions.checkJs = true;
  }

  const program = ts.createProgram([fileName], compilerOptions, compilerHost);

  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics
    ? ([] as ts.Diagnostic[])
    : program.getSemanticDiagnostics();
  const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

  return {
    sourceFile: program.getSourceFile(fileName)!,
    checker: program.getTypeChecker(),
    program,
    diagnostics,
    syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
  };
}

/** Result of multi-file analysis */
export interface MultiTypedAST {
  /** All user source files (in dependency order, entry file last) */
  sourceFiles: ts.SourceFile[];
  /** The entry source file */
  entryFile: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  diagnostics: ts.Diagnostic[];
  syntacticDiagnostics: readonly ts.Diagnostic[];
}

/**
 * Normalize a file path to a canonical form used as key in our in-memory file map.
 * Strips leading "./", resolves ".." segments, and ensures ".ts" extension.
 */
function normalizeFileName(name: string): string {
  let normalized = name.startsWith("./") ? name.slice(2) : name;
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  // Resolve ".." path segments (e.g., "link/../emit/foo" → "emit/foo")
  const parts = normalized.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  normalized = resolved.join("/");
  // Replace .js extension with .ts, or append .ts if no extension
  if (normalized.endsWith(".js")) {
    normalized = `${normalized.slice(0, -3)}.ts`;
  } else if (!normalized.endsWith(".ts")) {
    normalized = `${normalized}.ts`;
  }
  return normalized;
}

/**
 * Parse and type-check multiple TS source files.
 * In-memory CompilerHost — no filesystem needed.
 * The TypeScript compiler handles cross-file imports natively.
 */
export function analyzeMultiSource(
  files: Record<string, string>,
  entryFile: string,
  /** Optional mapping from bare specifiers to file keys (e.g. { "lodash": "lodash/index.ts" }) */
  specifierMap?: Record<string, string>,
): MultiTypedAST {
  const normalizedFiles = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) {
    normalizedFiles.set(normalizeFileName(name), content);
  }
  const normalizedEntry = normalizeFileName(entryFile);
  const rootNames = Array.from(normalizedFiles.keys());

  // Build a bare-specifier-to-normalized-file lookup.
  // Explicit specifierMap entries take priority, then we auto-derive
  // mappings from file keys (e.g. "utils.ts" -> bare specifier "utils").
  const bareSpecifierLookup = new Map<string, string>();
  // Auto-derive: for each file key, register its basename without extension
  // and the full key without extension as potential bare specifiers.
  for (const normalized of normalizedFiles.keys()) {
    // "foo/bar.ts" -> bare specifiers "foo/bar" and "bar"
    const withoutExt = normalized.replace(/\.ts$/, "");
    bareSpecifierLookup.set(withoutExt, normalized);
    const basename = withoutExt.split("/").pop()!;
    if (basename && !bareSpecifierLookup.has(basename)) {
      bareSpecifierLookup.set(basename, normalized);
    }
    // Also support "foo/index.ts" -> bare specifier "foo"
    if (basename === "index") {
      const dir = withoutExt.replace(/\/index$/, "");
      if (dir && !bareSpecifierLookup.has(dir)) {
        bareSpecifierLookup.set(dir, normalized);
      }
    }
  }
  // Explicit specifierMap overrides auto-derived entries
  if (specifierMap) {
    for (const [specifier, fileKey] of Object.entries(specifierMap)) {
      bareSpecifierLookup.set(specifier, normalizeFileName(fileKey));
    }
  }

  const compilerHost: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      const userContent = normalizedFiles.get(name);
      if (userContent !== undefined) {
        return ts.createSourceFile(name, userContent, languageVersion, true, ts.ScriptKind.TS);
      }
      const libSf = getLibSourceFile(name, languageVersion);
      if (libSf) return libSf;
      return undefined;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => normalizedFiles.has(name) || isKnownLibName(name),
    readFile: (name) => normalizedFiles.get(name),
    getDirectories: () => [],
    directoryExists: () => true,
    resolveModuleNameLiterals(moduleLiterals, containingFile) {
      return moduleLiterals.map((literal) => {
        const moduleName = literal.text;
        // Resolve relative paths against the containing file's directory
        let resolved: string;
        if (moduleName.startsWith("./") || moduleName.startsWith("../")) {
          const containingDir = containingFile.replace(/[^/]*$/, "");
          resolved = normalizeFileName(containingDir + moduleName);
        } else {
          // Bare specifier: check the lookup map first, then fall back to normalizeFileName
          resolved = bareSpecifierLookup.get(moduleName) ?? normalizeFileName(moduleName);
        }
        if (normalizedFiles.has(resolved)) {
          return {
            resolvedModule: {
              resolvedFileName: resolved,
              isExternalLibraryImport: false,
              extension: ts.Extension.Ts,
            },
          };
        }
        return { resolvedModule: undefined };
      });
    },
  };

  const program = ts.createProgram(
    rootNames,
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noImplicitAny: false,
      noEmit: true,
    },
    compilerHost,
  );

  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  const semanticDiagnostics = program.getSemanticDiagnostics();
  const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

  const entrySourceFile = program.getSourceFile(normalizedEntry)!;
  const userSourceFiles: ts.SourceFile[] = [];
  for (const name of rootNames) {
    if (name !== normalizedEntry) {
      const sf = program.getSourceFile(name);
      if (sf) userSourceFiles.push(sf);
    }
  }
  userSourceFiles.push(entrySourceFile);

  return {
    sourceFiles: userSourceFiles,
    entryFile: entrySourceFile,
    checker: program.getTypeChecker(),
    program,
    diagnostics,
    syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
  };
}

/**
 * Analyze a TypeScript project from an entry file on disk.
 * Uses ts.createProgram with real filesystem access -- TypeScript resolves
 * all imports automatically via its standard module resolution.
 *
 * Returns a MultiTypedAST suitable for generateMultiModule().
 */
export function analyzeFiles(entryPath: string, analyzeOptions?: AnalyzeOptions): MultiTypedAST {
  const pathMod = require("node:path") as typeof import("node:path");
  const resolvedEntry = pathMod.resolve(entryPath);

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    noImplicitAny: false,
    noEmit: true,
    rootDir: pathMod.dirname(resolvedEntry),
  };

  if (analyzeOptions?.allowJs) {
    compilerOptions.allowJs = true;
    compilerOptions.checkJs = true;
  }

  const program = ts.createProgram([resolvedEntry], compilerOptions);
  const checker = program.getTypeChecker();

  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics
    ? ([] as ts.Diagnostic[])
    : program.getSemanticDiagnostics();
  const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

  const entrySourceFile = program.getSourceFile(resolvedEntry);
  if (!entrySourceFile) {
    throw new Error(`Entry file not found: ${resolvedEntry}`);
  }

  // Collect user source files (skip lib files and node_modules)
  const userSourceFiles: ts.SourceFile[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName === resolvedEntry) continue; // entry goes last
    if (sf.isDeclarationFile) continue;
    if (sf.fileName.includes("node_modules")) continue;
    userSourceFiles.push(sf);
  }
  // Entry file goes last (dependency order: deps before entry)
  userSourceFiles.push(entrySourceFile);

  return {
    sourceFiles: userSourceFiles,
    entryFile: entrySourceFile,
    checker,
    program,
    diagnostics,
    syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
  };
}

export { IncrementalLanguageService } from "./language-service.js";
