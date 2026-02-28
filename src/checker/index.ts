import ts from "typescript";
import libEs5 from "./lib-es5";
import libDom from "./lib-dom";
import libDecorators from "./lib-decorators";
import libDecoratorsLegacy from "./lib-decorators-legacy";

export interface TypedAST {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  diagnostics: ts.Diagnostic[];
  syntacticDiagnostics: readonly ts.Diagnostic[];
}

/** Map of lib filenames to their contents */
const LIB_FILES: Record<string, string> = {
  "lib.d.ts": libEs5 + "\n" + libDom,
  "lib.es5.d.ts": libEs5,
  "lib.dom.d.ts": libDom,
  "lib.decorators.d.ts": libDecorators,
  "lib.decorators.legacy.d.ts": libDecoratorsLegacy,
};

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
      const libContent = LIB_FILES[name];
      if (libContent !== undefined) {
        return ts.createSourceFile(name, libContent, languageVersion);
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
      name === fileName || name in LIB_FILES,
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
      noImplicitAny: false,
      noEmit: true,
    },
    compilerHost,
  );

  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  const semanticDiagnostics = program.getSemanticDiagnostics();
  const diagnostics = [...syntacticDiagnostics, ...semanticDiagnostics];

  return {
    sourceFile: program.getSourceFile(fileName)!,
    checker: program.getTypeChecker(),
    program,
    diagnostics,
    syntacticDiagnostics: syntacticDiagnostics as readonly ts.Diagnostic[],
  };
}
