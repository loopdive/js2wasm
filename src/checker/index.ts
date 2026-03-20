import ts from "typescript";
import libEs5 from "./lib-es5";
import libDom from "./lib-dom";
import libDecorators from "./lib-decorators";
import libDecoratorsLegacy from "./lib-decorators-legacy";
import libGenerators from "./lib-generators";
import libEs2015 from "./lib-es2015";
import libEs2021 from "./lib-es2021";

export interface TypedAST {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  diagnostics: ts.Diagnostic[];
  syntacticDiagnostics: readonly ts.Diagnostic[];
}

/** Map of lib filenames to their contents */
const LIB_FILES: Record<string, string> = {
  "lib.d.ts": libEs5 + "\n" + libEs2015 + "\n" + libEs2021 + "\n" + libDom + "\n" + libGenerators,
  "lib.es5.d.ts": libEs5,
  "lib.dom.d.ts": libDom,
  "lib.decorators.d.ts": libDecorators,
  "lib.decorators.legacy.d.ts": libDecoratorsLegacy,
};

/** Pre-parsed lib SourceFiles — cached to avoid re-parsing on every compile */
const LIB_SOURCE_FILES = new Map<string, ts.SourceFile>();
function getLibSourceFile(name: string, languageVersion: ts.ScriptTarget): ts.SourceFile | undefined {
  const content = LIB_FILES[name];
  if (content === undefined) return undefined;
  const key = `${name}:${languageVersion}`;
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
 * Parse and type-check a TS or JS source file.
 * In-memory CompilerHost – no filesystem needed.
 */
export function analyzeSource(
  source: string,
  fileName = "input.ts",
  analyzeOptions?: AnalyzeOptions,
): TypedAST {
  const isJs = fileName.endsWith(".js") || fileName.endsWith(".jsx");
  const scriptKind = isJs ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const useAllowJs = isJs || analyzeOptions?.allowJs === true;

  const compilerHost: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      if (name === fileName) {
        return ts.createSourceFile(
          name,
          source,
          languageVersion,
          true,
          scriptKind,
        );
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
    fileExists: (name) =>
      name === fileName || name in LIB_FILES,
    readFile: () => undefined,
    getDirectories: () => [],
    directoryExists: () => true,
  };

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: !isJs,
    noImplicitAny: false,
    noEmit: true,
  };

  if (useAllowJs) {
    compilerOptions.allowJs = true;
    compilerOptions.checkJs = true;
  }

  const program = ts.createProgram(
    [fileName],
    compilerOptions,
    compilerHost,
  );

  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics ? [] as ts.Diagnostic[] : program.getSemanticDiagnostics();
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
  if (name.startsWith("./")) {
    name = name.slice(2);
  }
  if (name.startsWith("/")) {
    name = name.slice(1);
  }
  // Resolve ".." path segments (e.g., "link/../emit/foo" → "emit/foo")
  const parts = name.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  name = resolved.join("/");
  // Replace .js extension with .ts, or append .ts if no extension
  if (name.endsWith(".js")) {
    name = name.slice(0, -3) + ".ts";
  } else if (!name.endsWith(".ts")) {
    name = name + ".ts";
  }
  return name;
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
        return ts.createSourceFile(
          name,
          userContent,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        );
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
    fileExists: (name) =>
      normalizedFiles.has(name) || name in LIB_FILES,
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
