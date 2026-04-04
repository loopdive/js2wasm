import ts from "typescript";
import type { TypedAST, AnalyzeOptions } from "./index.js";
import { isKnownLibName, getLibSourceFile } from "./index.js";

/**
 * Incremental compiler that reuses parsed lib SourceFiles across compilations.
 *
 * Uses the module-level LIB_SOURCE_FILES cache from checker/index.ts to return
 * the SAME SourceFile objects for lib files. Combined with oldProgram, this
 * enables TS to achieve full structure reuse — skipping re-parsing, re-binding,
 * and re-resolving for unchanged lib files.
 *
 * Each compilation creates a FRESH checker (no state leakage between tests).
 */
export class IncrementalLanguageService {
  private currentSource = "";
  private currentSourceFile: ts.SourceFile | undefined;
  private fileName: string;
  private compilerOptions: ts.CompilerOptions;
  private host: ts.CompilerHost;
  private oldProgram: ts.Program | undefined;

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
    // Same object identity across calls enables oldProgram structure reuse.
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

    const program = ts.createProgram([this.fileName], options, this.host, this.oldProgram);
    this.oldProgram = program;

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
    this.oldProgram = undefined;
  }
}
