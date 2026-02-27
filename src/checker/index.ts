import ts from "typescript";

export interface TypedAST {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  diagnostics: ts.Diagnostic[];
}

/**
 * Parse and type-check a TS source file.
 * In-memory CompilerHost – no filesystem needed.
 */
export function analyzeSource(
  source: string,
  fileName = "input.ts",
): TypedAST {
  const compilerHost: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      if (name === fileName) {
        return ts.createSourceFile(
          name,
          source,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        );
      }
      if (name === "lib.d.ts" || name.startsWith("lib.")) {
        return ts.createSourceFile(
          name,
          MINIMAL_LIB_DTS,
          languageVersion,
        );
      }
      return undefined;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) =>
      name === fileName || name === "lib.d.ts" || name.startsWith("lib."),
    readFile: () => undefined,
    getDirectories: () => [],
    directoryExists: () => true,
  };

  const program = ts.createProgram(
    [fileName],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: true,
      noEmit: true,
    },
    compilerHost,
  );

  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];

  return {
    sourceFile: program.getSourceFile(fileName)!,
    checker: program.getTypeChecker(),
    program,
    diagnostics,
  };
}

/** Minimal built-in type definitions – only what the compiler needs */
const MINIMAL_LIB_DTS = `
interface Array<T> {
  length: number;
  push(item: T): number;
  [index: number]: T;
}
interface ReadonlyArray<T> {
  readonly length: number;
  readonly [index: number]: T;
}
interface String {
  readonly length: number;
  charAt(pos: number): string;
}
interface Number {}
interface Boolean {}
interface Function {}
interface Object {}
interface RegExp {}
interface IArguments {}
interface Math {
  sqrt(x: number): number;
  abs(x: number): number;
  floor(x: number): number;
  ceil(x: number): number;
  min(...values: number[]): number;
  max(...values: number[]): number;
  PI: number;
}
declare const Math: Math;
declare const console: { log(...args: any[]): void };
declare const undefined: undefined;
`;
