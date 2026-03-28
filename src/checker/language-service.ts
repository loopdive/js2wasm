import ts from "typescript";
import type { TypedAST, AnalyzeOptions } from "./index.js";

/**
 * Incremental compiler that reuses parsed lib SourceFiles across compilations
 * via ts.createProgram's oldProgram parameter.
 *
 * Each compilation creates a FRESH Program and TypeChecker (no state leakage),
 * but reuses cached lib SourceFile parses from the previous Program.
 *
 * This eliminates ~50ms of lib re-parsing per compilation while maintaining
 * identical output to standalone ts.createProgram.
 *
 * Usage:
 *   const service = new IncrementalLanguageService();
 *   service.updateSource("export function foo(): number { return 42; }");
 *   const ast = service.analyze();
 */
export class IncrementalLanguageService {
  private currentSource = "";
  private fileName: string;
  private compilerOptions: ts.CompilerOptions;
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
  }

  /** Update the source for the next compilation */
  updateSource(source: string, fileName?: string): void {
    this.currentSource = source;
    if (fileName) this.fileName = fileName;
  }

  /**
   * Analyze the current source — creates a fresh Program (fresh checker)
   * but reuses parsed lib SourceFiles from the previous Program via oldProgram.
   */
  analyze(analyzeOptions?: AnalyzeOptions): TypedAST {
    const useAllowJs = analyzeOptions?.allowJs;
    const options = { ...this.compilerOptions };
    if (useAllowJs) {
      options.allowJs = true;
      options.checkJs = true;
    }

    // Virtual file host — serves our source file + real lib files from disk
    const sourceFile = ts.createSourceFile(
      this.fileName,
      this.currentSource,
      options.target ?? ts.ScriptTarget.ES2022,
      true,
    );

    const host = ts.createCompilerHost(options);
    const origGetSourceFile = host.getSourceFile;
    host.getSourceFile = (name: string, languageVersion: ts.ScriptTarget, ...rest: any[]) => {
      if (name === this.fileName) return sourceFile;
      return (origGetSourceFile as any).call(host, name, languageVersion, ...rest);
    };
    host.fileExists = (name: string) => {
      if (name === this.fileName) return true;
      return ts.sys.fileExists(name);
    };
    host.readFile = (name: string) => {
      if (name === this.fileName) return this.currentSource;
      return ts.sys.readFile(name);
    };

    // Create fresh Program with oldProgram for lib SourceFile reuse
    const program = ts.createProgram(
      [this.fileName],
      options,
      host,
      this.oldProgram, // reuses parsed lib SourceFiles, creates fresh checker
    );

    // Save for next compilation
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
