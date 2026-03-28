import ts from "typescript";
import type { TypedAST, AnalyzeOptions } from "./index.js";

/**
 * ES spec early error diagnostic codes that should NOT be suppressed
 * even when skipSemanticDiagnostics is true.
 */
const ES_EARLY_ERROR_CODES = new Set([
  1100, 1102, 1103, 1210, 1211, 1213, 1214, 1359, 1360, 2300, 2480, 18050,
]);

/**
 * Persistent TypeScript Language Service that caches parsed lib files
 * across compilations. Only the user source file is re-parsed on each update.
 *
 * Usage:
 *   const service = new IncrementalLanguageService();
 *   service.updateSource("export function foo(): number { return 42; }");
 *   const ast = service.analyze();
 */
export class IncrementalLanguageService {
  private currentSource = "";
  private version = 0;
  private fileName: string;
  private service: ts.LanguageService;
  private compilerOptions: ts.CompilerOptions;

  /** Pre-read lib file contents, cached for the lifetime of this service */
  private libFileContents = new Map<string, string>();

  /** Pre-parsed lib SourceFiles, cached for the lifetime of this service */
  private libSourceFiles = new Map<string, ts.SourceFile>();

  constructor(fileName = "input.ts") {
    this.fileName = fileName;

    this.compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noImplicitAny: false,
      noEmit: true,
    };

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [this.fileName],
      getScriptVersion: (name: string) => {
        if (name === this.fileName) return String(this.version);
        return "1"; // lib files never change
      },
      getScriptSnapshot: (name: string) => {
        if (name === this.fileName) {
          return ts.ScriptSnapshot.fromString(this.currentSource);
        }
        // Serve lib files
        const content = this.getLibContent(name);
        if (content !== undefined) {
          return ts.ScriptSnapshot.fromString(content);
        }
        return undefined;
      },
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
      getCurrentDirectory: () => "/",
      fileExists: (name: string) => {
        if (name === this.fileName) return true;
        return this.getLibContent(name) !== undefined;
      },
      readFile: (name: string) => {
        if (name === this.fileName) return this.currentSource;
        return this.getLibContent(name);
      },
      directoryExists: () => true,
      getDirectories: () => [],
    };

    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /**
   * Get lib file content by name, using the same lazy-loading strategy
   * as the main checker but caching on this instance.
   */
  private getLibContent(name: string): string | undefined {
    if (this.libFileContents.has(name)) {
      return this.libFileContents.get(name);
    }

    // Only handle lib files
    if (!name.includes("lib.") || !name.endsWith(".d.ts")) {
      return undefined;
    }

    try {
      const { readFileSync } = require("fs");
      const { dirname, join } = require("path");
      const { createRequire } = require("module");

      // Resolve typescript lib directory
      let tsLibDir: string;
      try {
        const esmRequire = createRequire(
          typeof __filename !== "undefined"
            ? __filename
            : require("url").fileURLToPath(import.meta.url),
        );
        tsLibDir = dirname(esmRequire.resolve("typescript/lib/lib.d.ts"));
      } catch {
        tsLibDir = dirname(require.resolve("typescript/lib/lib.d.ts"));
      }

      const content = readFileSync(join(tsLibDir, name.split("/").pop()!), "utf-8");
      if (content) {
        this.libFileContents.set(name, content);
        return content;
      }
    } catch {
      // File not found
    }

    return undefined;
  }

  /**
   * Update the virtual source file content. Increments the version
   * so the Language Service knows to re-parse only this file.
   */
  updateSource(source: string, fileName?: string): void {
    if (fileName && fileName !== this.fileName) {
      this.fileName = fileName;
    }
    this.currentSource = source;
    this.version++;
  }

  /**
   * Get the current TypeScript Program from the Language Service.
   * The LS caches parsed lib files internally — only the user file is re-parsed.
   */
  getProgram(): ts.Program {
    const program = this.service.getProgram();
    if (!program) {
      throw new Error("Language service failed to produce a program");
    }
    return program;
  }

  /**
   * Analyze the current source, returning the same TypedAST structure
   * as the non-incremental analyzeSource().
   */
  analyze(analyzeOptions?: AnalyzeOptions): TypedAST {
    const program = this.getProgram();
    const sourceFile = program.getSourceFile(this.fileName);
    if (!sourceFile) {
      throw new Error(`Source file ${this.fileName} not found in program`);
    }

    const checker = program.getTypeChecker();
    const syntacticDiagnostics = program.getSyntacticDiagnostics(sourceFile);
    const semanticDiagnostics = analyzeOptions?.skipSemanticDiagnostics
      ? ([] as ts.Diagnostic[])
      : program.getSemanticDiagnostics(sourceFile);
    const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

    return {
      sourceFile,
      checker,
      program,
      diagnostics,
      syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
    };
  }

  /**
   * Dispose of the language service to free memory.
   */
  dispose(): void {
    this.service.dispose();
  }
}
