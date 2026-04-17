// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import type { AnalyzeOptions, TypedAST } from "./index.js";
import { getLibSourceFile, isKnownLibName } from "./index.js";

/**
 * Incremental compiler that reuses parsed lib SourceFiles across compilations.
 *
 * Uses the module-level LIB_SOURCE_FILES cache from checker/index.ts to return
 * the SAME SourceFile objects for lib files. Each compilation creates a fresh
 * Program and checker — no type state leaks between compilations. (#973)
 *
 * Performance: lib SourceFile caching avoids re-parsing ~10MB of .d.ts files
 * per compilation, which is the dominant cost. We intentionally do NOT pass
 * oldProgram to ts.createProgram — TypeScript's structure reuse carries forward
 * internal symbol tables and type caches that leak stale type info between
 * unrelated test compilations, causing ~400 false compile errors in the fork
 * worker pool.
 */
export class IncrementalLanguageService {
  private currentSource = "";
  private currentSourceFile: ts.SourceFile | undefined;
  private fileName: string;
  private compilerOptions: ts.CompilerOptions;
  private host: ts.CompilerHost;

  constructor(fileName = "input.ts") {
    this.fileName = fileName;

    this.compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noImplicitAny: false,
      noEmit: true,
    };

    // Custom host that returns CACHED SourceFile objects for lib files.
    // Same object identity across calls is fine — lib files never change.
    this.host = {
      getSourceFile: (name: string, languageVersion: ts.ScriptTarget) => {
        if (name === this.fileName) return this.currentSourceFile;
        return getLibSourceFile(name, languageVersion);
      },
      getDefaultLibFileName: () => "lib.d.ts",
      writeFile: () => {},
      getCurrentDirectory: () => "/",
      getCanonicalFileName: (f: string) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (name: string) => name === this.fileName || isKnownLibName(name),
      readFile: (name: string) => {
        if (name === this.fileName) return this.currentSource;
        return undefined;
      },
      getDirectories: () => [],
      directoryExists: () => true,
    };
  }

  /** Update the source for the next compilation */
  updateSource(source: string, fileName?: string): void {
    this.currentSource = source;
    if (fileName) this.fileName = fileName;
    this.currentSourceFile = ts.createSourceFile(
      this.fileName,
      this.currentSource,
      this.compilerOptions.target ?? ts.ScriptTarget.ES2022,
      true,
    );
  }

  /**
   * Analyze — fresh Program + fresh checker, cached lib SourceFiles.
   */
  analyze(analyzeOptions?: AnalyzeOptions): TypedAST {
    const options = { ...this.compilerOptions };
    if (analyzeOptions?.allowJs) {
      options.allowJs = true;
      options.checkJs = true;
    }

    // Fresh program each time — no oldProgram reuse. (#973)
    const program = ts.createProgram([this.fileName], options, this.host);

    const checker = program.getTypeChecker();
    const syntacticDiagnostics = program.getSyntacticDiagnostics();
    const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics
      ? ([] as ts.Diagnostic[])
      : program.getSemanticDiagnostics();
    const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

    return {
      sourceFile: program.getSourceFile(this.fileName)!,
      checker,
      program,
      diagnostics,
      syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
    };
  }

  dispose(): void {
    // No-op — no accumulated state to clear.
    // Lib SourceFile cache is module-level and shared across all instances.
  }
}
