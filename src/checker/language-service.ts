// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import type { AnalyzeOptions, TypedAST } from "./index.js";
import { getLibSourceFile, isKnownLibName } from "./index.js";

/**
 * Incremental compiler that reuses parsed lib SourceFiles across compilations.
 *
 * Uses the module-level LIB_SOURCE_FILES cache from checker/index.ts to return
 * the SAME SourceFile objects for lib files. This lets TypeScript skip re-parsing
 * of unchanged lib files across compilations — the main performance win.
 *
 * Each compilation creates a FRESH ts.Program with a FRESH checker — we deliberately
 * do NOT pass `oldProgram` into ts.createProgram. Structure reuse via oldProgram
 * can leak checker state between compilations (#1119): a specific user test can
 * poison the reused program's internal state (scope chain / type resolution
 * cycles) and every subsequent compile throws "Maximum call stack size exceeded"
 * in ~0ms until the compiler is recreated. Giving up structure reuse costs a
 * few ms per compile but eliminates an entire class of cross-test contamination.
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
    // Identity stability lets TypeScript skip re-parsing unchanged libs.
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

    // Intentionally no oldProgram — see class-level doc (#1119).
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
    // Nothing to dispose — lib SourceFile cache is module-level and persists for the process.
  }
}
