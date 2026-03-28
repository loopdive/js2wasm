import ts from "typescript";
import type { TypedAST, AnalyzeOptions } from "./index.js";

/**
 * Incremental compiler that reuses parsed lib SourceFiles across compilations
 * via ts.createProgram's oldProgram parameter and a persistent CompilerHost.
 *
 * Each compilation creates a FRESH Program and TypeChecker (no state leakage),
 * but reuses cached lib SourceFile parses via:
 * 1. Persistent CompilerHost (same host = same internal SourceFile cache)
 * 2. oldProgram parameter (TS reuses unchanged SourceFiles from previous Program)
 *
 * This eliminates ~50ms of lib re-parsing per compilation while maintaining
 * identical output to standalone ts.createProgram.
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

    // Create host ONCE — its internal SourceFile cache persists across compilations
    this.host = ts.createCompilerHost(this.compilerOptions);
    const origGetSourceFile = this.host.getSourceFile;
    this.host.getSourceFile = (name: string, languageVersion: ts.ScriptTarget, ...rest: any[]) => {
      if (name === this.fileName) return this.currentSourceFile;
      return (origGetSourceFile as any).call(this.host, name, languageVersion, ...rest);
    };
    const origFileExists = this.host.fileExists;
    this.host.fileExists = (name: string) => {
      if (name === this.fileName) return true;
      return origFileExists.call(this.host, name);
    };
    const origReadFile = this.host.readFile;
    this.host.readFile = (name: string) => {
      if (name === this.fileName) return this.currentSource;
      return origReadFile!.call(this.host, name);
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
   * Analyze the current source — creates a fresh Program (fresh checker)
   * but reuses parsed lib SourceFiles from the previous Program.
   */
  analyze(analyzeOptions?: AnalyzeOptions): TypedAST {
    const options = { ...this.compilerOptions };
    if (analyzeOptions?.allowJs) {
      options.allowJs = true;
      options.checkJs = true;
    }

    // Fresh Program with oldProgram for lib reuse + persistent host cache
    const program = ts.createProgram(
      [this.fileName],
      options,
      this.host,
      this.oldProgram,
    );

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

  /** Release resources */
  dispose(): void {
    this.oldProgram = undefined;
  }
}
