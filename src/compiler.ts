// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  analyzeFiles,
  analyzeMultiSource,
  analyzeSource,
  IncrementalLanguageService,
  type TypedAST,
} from "./checker/index.js";
import { generateLinearModule, generateLinearMultiModule } from "./codegen-linear/index.js";
import { resetCompileDepth } from "./codegen/expressions.js";
import { generateModule, generateMultiModule } from "./codegen/index.js";
import {
  buildImportManifest,
  checkJsTypeCoverage,
  DOWNGRADE_DIAG_CODES,
  looksLikeTsSyntaxOnJs,
} from "./compiler/import-manifest.js";
import { applyCabiTransform, generateDts, generateImportsHelper, widenNonDefaultableTypes } from "./compiler/output.js";
import {
  detectEarlyErrors,
  pushSourceAnchoredDiagnostic,
  rewriteEvalSuperCall,
  validateHardenedMode,
  validateSafeMode,
} from "./compiler/validation.js";
import { emitBinary, emitBinaryWithSourceMap, emitSourceMappingURLSection } from "./emit/binary.js";
import { WasmEncoder } from "./emit/encoder.js";
import { generateSourceMap } from "./emit/sourcemap.js";
import { emitWat } from "./emit/wat.js";
import { applyDefineSubstitutions } from "./compiler/define-substitution.js";
import { preprocessImports } from "./import-resolver.js";
import type { CompileError, CompileOptions, CompileResult } from "./index.js";
import { optimizeBinary } from "./optimize.js";
import { generateWit } from "./wit-generator.js";
export { compileToObjectSource } from "./compiler/output.js";
export type { ObjectCompileResult } from "./compiler/output.js";

const HARD_TS_DIAG_CODES = new Set([
  2322, // "Type 'X' is not assignable to type 'Y'"
  2345, // "Argument of type 'X' is not assignable to parameter of type 'Y'"
]);

function isHardTypeScriptDiagnostic(diag: { category: number; code: number }): boolean {
  return diag.category === 1 && HARD_TS_DIAG_CODES.has(diag.code);
}

/**
 * Orchestrates the full compilation pipeline:
 * TS Source → tsc Parser+Checker → Codegen → Binary + WAT
 */
export function compileSource(
  source: string,
  options: CompileOptions = {},
  /** Optional persistent language service for incremental compilation */
  languageService?: IncrementalLanguageService,
): CompileResult {
  // Reset compile-expression recursion depth counter for this compilation unit.
  // Without this, the depth accumulates across compilations in the same process
  // (e.g., test262 worker pool), causing false "depth exceeded" errors.
  resetCompileDepth();

  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  // Step 0a: Apply compile-time define substitutions (#1043)
  const definedSource = options.define ? applyDefineSubstitutions(source, options.define) : source;

  // Step 0b: Pre-process imports (replace import * as X with declare namespace)
  // #1054: rewrite eval("...super()...") to a throwing IIFE so early-error
  // rules for PerformEval fire at runtime.
  const processedSource = preprocessImports(rewriteEvalSuperCall(definedSource));

  // Step 1: Parse and type-check
  let isJsMode = options.allowJs === true || (options.fileName?.endsWith(".js") ?? false);
  const defaultFileName = options.fileName ?? (isJsMode ? "input.js" : "input.ts");
  const effectiveFileName = options.moduleName ?? defaultFileName;
  let ast: TypedAST;
  if (languageService) {
    // Incremental path: reuse cached lib files via the language service
    languageService.updateSource(processedSource, effectiveFileName);
    ast = languageService.analyze({
      allowJs: options.allowJs,
      skipSemanticDiagnostics: options.skipSemanticDiagnostics,
    });
  } else {
    ast = analyzeSource(processedSource, effectiveFileName, {
      allowJs: options.allowJs,
      skipSemanticDiagnostics: options.skipSemanticDiagnostics,
    });
  }

  // Auto-detect: if parsing as TS fails with syntax errors that look like
  // the source is plain JS, retry with allowJs mode enabled.
  if (!isJsMode) {
    const syntaxErrors = ast.syntacticDiagnostics.filter((d) => d.category === 1 && d.file === ast.sourceFile);
    if (syntaxErrors.length > 0 && looksLikeTsSyntaxOnJs(syntaxErrors)) {
      // Retry as JS
      isJsMode = true;
      const jsFileName = effectiveFileName.replace(/\.ts$/, ".js");
      if (languageService) {
        languageService.updateSource(processedSource, jsFileName);
        ast = languageService.analyze({ allowJs: true });
      } else {
        ast = analyzeSource(processedSource, jsFileName, { allowJs: true });
      }
    }
  }

  // In JS mode, check for untyped parameters and add helpful warnings
  if (isJsMode) {
    const typeWarnings = checkJsTypeCoverage(ast);
    errors.push(...typeWarnings);
  }

  // TS diagnostics that the wasm codegen can handle gracefully —
  // downgrade from error to warning so they don't block compilation.
  // (Uses module-level DOWNGRADE_DIAG_CODES set defined above)

  // Collect TS diagnostics as errors (or warnings for handled cases)
  for (const diag of ast.diagnostics) {
    if (diag.category === 1) {
      // Error
      const pos = diag.file ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0) : { line: 0, character: 0 };
      const severity = DOWNGRADE_DIAG_CODES.has(diag.code) ? "warning" : "error";
      errors.push({
        message: typeof diag.messageText === "string" ? diag.messageText : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: severity as "error" | "warning",
        code: diag.code,
      });
    }
  }

  // Don't stop on type errors – the compiler can still generate code for many cases
  // Only stop on syntax errors (parsing failures), except tolerated ones
  const TOLERATED_SYNTAX_CODES = new Set([
    1156, // "'let' declarations can only be declared inside a block"
    1313, // "The body of an 'if' statement cannot be the empty statement"
    1344, // "A label is not allowed here"
    1182, // "A destructuring declaration must have an initializer"
    1228, // "A type predicate is only allowed in return type position"
    1163, // "A 'yield' expression is only allowed in a generator body" — syntactic diagnostic (#267)
    1206, // "Decorators are not valid here" — decorator syntax tolerated, decorators ignored (#376)
    1207, // "Decorators cannot be applied to multiple get/set accessors" (#376)
    1436, // "Decorators must precede the name and all keywords of property declarations" (#376)
    1486, // "Decorator used before 'export' here" (#376)
    1497, // "Expression must be enclosed in parentheses to be used as a decorator" (#376)
    1498, // "Invalid syntax in decorator" (#376)
    8038, // "Decorators may not appear after 'export' or 'export default'" (#376)
    1184, // "Modifiers cannot appear here" — valid JS patterns in test262 (#537)
    1109, // "Expression expected" — valid JS patterns in test262 (#537)
    1135, // "Argument expression expected" — valid JS patterns in test262 (#537)
    1262, // "Identifier expected. 'X' is a reserved word at the top-level of a module" — await as identifier (#537)
    1435, // "Unknown keyword or identifier. Did you mean 'X'?" — yield in nested generator contexts (#521)
    1503, // "This regular expression flag is only available when targeting 'es2024'" (#654)
    1232, // "An import declaration can only be used at the top level of a namespace or module" (#654)
    1102, // "'delete' cannot be called on an identifier in strict mode" — valid sloppy-mode JS (#535)
    1100, // "Invalid use of 'X' in strict mode" — sloppy-mode JS allows eval/arguments (#331)
    1121, // "Octal literals are not allowed in strict mode" — valid sloppy-mode JS
    1489, // "Decimals with leading zeros are not allowed" — valid sloppy-mode JS octal literals
  ]);
  const hasSyntaxErrors = ast.syntacticDiagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile && !TOLERATED_SYNTAX_CODES.has(d.code),
  );
  const hasHardTypeErrors = ast.diagnostics.some(isHardTypeScriptDiagnostic);

  if ((hasSyntaxErrors || hasHardTypeErrors) && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Step 1a: Early error detection — catch ES-spec syntax errors that TypeScript misses
  const earlyErrors = detectEarlyErrors(ast.sourceFile);
  errors.push(...earlyErrors);
  const hasHardEarlyErrors = earlyErrors.some((e) => e.severity !== "warning");
  if (hasHardEarlyErrors) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Step 1b: Safe mode validation
  if (options.safe) {
    const safeErrors = validateSafeMode(ast.sourceFile, ast.checker, options);
    errors.push(...safeErrors);
    if (safeErrors.length > 0) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  // Step 1c: Hardened mode validation
  if (options.hardened) {
    const hardenedErrors = validateHardenedMode(ast.sourceFile);
    errors.push(...hardenedErrors);
    if (hardenedErrors.length > 0) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  // Step 2: Generate IR
  let mod;
  try {
    if (useLinear) {
      mod = generateLinearModule(ast);
    } else {
      const result = generateModule(ast, {
        sourceMap: emitSourceMap,
        fast: options.fast,
        nativeStrings: options.nativeStrings,
        wasi: options.target === "wasi",
      });
      mod = result.module;
      // Propagate codegen errors with source locations
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: err.severity ?? "error",
        });
      }
      if (result.errors.some((err) => err.message.startsWith("Codegen error:"))) {
        return {
          binary: new Uint8Array(0),
          wat: "",
          dts: "",
          importsHelper: "",
          success: false,
          errors,
          stringPool: [],
          imports: [],
          hasMain: false,
          hasTopLevelStatements: false,
        };
      }
    }
  } catch (e) {
    pushSourceAnchoredDiagnostic(
      errors,
      ast.sourceFile,
      `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Step 2b: Apply C ABI transformations if requested
  let cHeader: string | undefined;
  if (options.abi === "c" && options.target === "linear") {
    const cabiResult = applyCabiTransform(mod, options.moduleName ?? "module");
    cHeader = cabiResult.cHeader;
  }

  // Step 2c: Widen non-defaultable ref types to ref_null in locals, params, and results.
  // This avoids "uninitialized non-defaultable local" and struct.get/set type errors.
  widenNonDefaultableTypes(mod);

  // Step 3: Emit binary (with source map collection if enabled)
  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);

      // Generate source map JSON
      const sourcesContent = new Map<string, string>();
      sourcesContent.set(effectiveFileName, source);
      const sourceMap = generateSourceMap(emitResult.sourceMapEntries, sourcesContent);
      sourceMapJson = JSON.stringify(sourceMap);

      // Append sourceMappingURL custom section to the binary
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();

      // Concatenate the binary with the sourceMappingURL section
      const combined = new Uint8Array(emitResult.binary.length + urlSectionBytes.length);
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    pushSourceAnchoredDiagnostic(
      errors,
      ast.sourceFile,
      `Binary emit error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Step 3b: Optimize binary with Binaryen (optional)
  if (options.optimize) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = optimizeBinary(binary, { level });
    if (optResult.optimized) {
      binary = optResult.binary;
    }
    if (optResult.warning) {
      pushSourceAnchoredDiagnostic(errors, ast.sourceFile, optResult.warning, "warning");
    }
  }

  // Step 4: Emit WAT (optional)
  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      // WAT emit failure is non-fatal
      pushSourceAnchoredDiagnostic(
        errors,
        ast.sourceFile,
        `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  }

  // Step 5: Generate .d.ts
  const dts = generateDts(ast, mod);

  // Step 6: Generate imports helper
  const importsHelper = generateImportsHelper(mod);

  // Step 7: Generate WIT interface (optional)
  let witOutput: string | undefined;
  if (options.wit) {
    const witOpts = typeof options.wit === "object" ? options.wit : undefined;
    witOutput = generateWit(ast, witOpts);
  }

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: true,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports: buildImportManifest(mod),
    cHeader,
    wit: witOutput,
    hasMain: mod.exports.some((e) => e.name === "main" && e.desc.kind === "func"),
    hasTopLevelStatements: mod.hasTopLevelStatements === true,
  };
}

/**
 * Compile multiple TypeScript source files into a single Wasm module.
 * Supports cross-file imports: `import { foo } from "./bar"`.
 */
export function compileMultiSource(
  files: Record<string, string>,
  entryFile: string,
  options: CompileOptions = {},
): CompileResult {
  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  // Apply define substitutions to all source files (#1043)
  const processedFiles = options.define
    ? Object.fromEntries(Object.entries(files).map(([k, v]) => [k, applyDefineSubstitutions(v, options.define!)]))
    : files;

  const multiAst = analyzeMultiSource(processedFiles, entryFile, undefined, {
    allowJs: options.allowJs,
    skipSemanticDiagnostics: options.skipSemanticDiagnostics,
  });

  // When allowJs is set (e.g. compiling npm packages like lodash-es), only report
  // diagnostics from the entry file — dependency files may have TS errors we can't
  // control (missing globals, JSDoc param issues, etc.).
  const isEntryDiag = (diag: { file?: { fileName: string } }) =>
    !options.allowJs || !diag.file || diag.file === multiAst.entryFile;

  for (const diag of multiAst.diagnostics) {
    if (diag.category === 1 && isEntryDiag(diag)) {
      const pos = diag.file ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0) : { line: 0, character: 0 };
      errors.push({
        message: typeof diag.messageText === "string" ? diag.messageText : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: "error",
        code: diag.code,
      });
    }
  }

  // When allowJs is set, don't bail on TS diagnostics — JS packages with JSDoc
  // annotations produce many false-positive errors (TS1016 optional params,
  // TS2322 type mismatches, TS8017 signature-in-JS, etc.). Codegen handles it fine.
  const hasSyntaxErrors =
    !options.allowJs &&
    multiAst.syntacticDiagnostics.some(
      (d) => d.category === 1 && isEntryDiag(d) && multiAst.sourceFiles.some((sf) => d.file === sf),
    );
  const hasHardTypeErrors =
    !options.allowJs && multiAst.diagnostics.some((d) => isHardTypeScriptDiagnostic(d) && isEntryDiag(d));

  if ((hasSyntaxErrors || hasHardTypeErrors) && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Safe mode validation for all source files
  if (options.safe) {
    for (const sf of multiAst.sourceFiles) {
      const safeErrors = validateSafeMode(sf, multiAst.checker, options);
      errors.push(...safeErrors);
    }
    if (errors.some((e) => e.severity === "error")) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  let mod;
  try {
    if (useLinear) {
      mod = generateLinearMultiModule(multiAst);
    } else {
      const result = generateMultiModule(multiAst, {
        sourceMap: emitSourceMap,
        fast: options.fast,
        nativeStrings: options.nativeStrings,
        wasi: options.target === "wasi",
      });
      mod = result.module;
      // Propagate codegen errors with source locations
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: err.severity ?? "error",
        });
      }
      if (result.errors.some((err) => err.message.startsWith("Codegen error:"))) {
        return {
          binary: new Uint8Array(0),
          wat: "",
          dts: "",
          importsHelper: "",
          success: false,
          errors,
          stringPool: [],
          imports: [],
          hasMain: false,
          hasTopLevelStatements: false,
        };
      }
    }
  } catch (e) {
    pushSourceAnchoredDiagnostic(
      errors,
      multiAst.entryFile,
      `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Widen non-defaultable ref types to ref_null in locals, params, and results
  widenNonDefaultableTypes(mod);

  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);

      // Build sources content from input files
      const sourcesContent = new Map<string, string>();
      for (const [name, content] of Object.entries(files)) {
        sourcesContent.set(name, content);
      }
      const sourceMap = generateSourceMap(emitResult.sourceMapEntries, sourcesContent);
      sourceMapJson = JSON.stringify(sourceMap);

      // Append sourceMappingURL custom section
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();

      const combined = new Uint8Array(emitResult.binary.length + urlSectionBytes.length);
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    pushSourceAnchoredDiagnostic(
      errors,
      multiAst.entryFile,
      `Binary emit error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Optimize binary with Binaryen (optional)
  if (options.optimize) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = optimizeBinary(binary, { level });
    if (optResult.optimized) {
      binary = optResult.binary;
    }
    if (optResult.warning) {
      pushSourceAnchoredDiagnostic(errors, multiAst.entryFile, optResult.warning, "warning");
    }
  }

  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      pushSourceAnchoredDiagnostic(
        errors,
        multiAst.entryFile,
        `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  }

  const entryAst: TypedAST = {
    sourceFile: multiAst.entryFile,
    checker: multiAst.checker,
    program: multiAst.program,
    diagnostics: multiAst.diagnostics,
    syntacticDiagnostics: multiAst.syntacticDiagnostics,
  };
  const dts = generateDts(entryAst, mod);
  const importsHelper = generateImportsHelper(mod);

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: true,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports: buildImportManifest(mod),
    hasMain: mod.exports.some((e) => e.name === "main" && e.desc.kind === "func"),
    hasTopLevelStatements: mod.hasTopLevelStatements === true,
  };
}

/**
 * Compile a TypeScript project from an entry file on disk.
 * Uses ts.createProgram with real filesystem access -- TypeScript resolves
 * all imports automatically via standard module resolution.
 */
export function compileFilesSource(entryPath: string, options: CompileOptions = {}): CompileResult {
  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  const multiAst = analyzeFiles(entryPath, {
    allowJs: options.allowJs,
    skipSemanticDiagnostics: options.skipSemanticDiagnostics,
  });

  for (const diag of multiAst.diagnostics) {
    if (diag.category === 1) {
      const pos = diag.file ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0) : { line: 0, character: 0 };
      errors.push({
        message: typeof diag.messageText === "string" ? diag.messageText : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: "error",
        code: diag.code,
      });
    }
  }

  const hasSyntaxErrors = multiAst.syntacticDiagnostics.some(
    (d) => d.category === 1 && multiAst.sourceFiles.some((sf) => d.file === sf),
  );
  const hasHardTypeErrors = multiAst.diagnostics.some(isHardTypeScriptDiagnostic);

  if ((hasSyntaxErrors || hasHardTypeErrors) && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Safe mode validation for all source files
  if (options.safe) {
    for (const sf of multiAst.sourceFiles) {
      const safeErrors = validateSafeMode(sf, multiAst.checker, options);
      errors.push(...safeErrors);
    }
    if (errors.some((e) => e.severity === "error")) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  let mod;
  try {
    if (useLinear) {
      mod = generateLinearMultiModule(multiAst);
    } else {
      const result = generateMultiModule(multiAst, {
        sourceMap: emitSourceMap,
        fast: options.fast,
        nativeStrings: options.nativeStrings,
        wasi: options.target === "wasi",
      });
      mod = result.module;
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: err.severity ?? "error",
        });
      }
      if (result.errors.some((err) => err.message.startsWith("Codegen error:"))) {
        return {
          binary: new Uint8Array(0),
          wat: "",
          dts: "",
          importsHelper: "",
          success: false,
          errors,
          stringPool: [],
          imports: [],
          hasMain: false,
          hasTopLevelStatements: false,
        };
      }
    }
  } catch (e) {
    pushSourceAnchoredDiagnostic(
      errors,
      multiAst.entryFile,
      `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  widenNonDefaultableTypes(mod);

  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);
      const sourcesContent = new Map<string, string>();
      for (const sf of multiAst.sourceFiles) {
        sourcesContent.set(sf.fileName, sf.getFullText());
      }
      const sourceMap = generateSourceMap(emitResult.sourceMapEntries, sourcesContent);
      sourceMapJson = JSON.stringify(sourceMap);
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();
      const combined = new Uint8Array(emitResult.binary.length + urlSectionBytes.length);
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    pushSourceAnchoredDiagnostic(
      errors,
      multiAst.entryFile,
      `Binary emit error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  if (options.optimize) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = optimizeBinary(binary, { level });
    if (optResult.optimized) {
      binary = optResult.binary;
    }
    if (optResult.warning) {
      pushSourceAnchoredDiagnostic(errors, multiAst.entryFile, optResult.warning, "warning");
    }
  }

  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      pushSourceAnchoredDiagnostic(
        errors,
        multiAst.entryFile,
        `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  }

  const entryAst: TypedAST = {
    sourceFile: multiAst.entryFile,
    checker: multiAst.checker,
    program: multiAst.program,
    diagnostics: multiAst.diagnostics,
    syntacticDiagnostics: multiAst.syntacticDiagnostics,
  };
  const dts = generateDts(entryAst, mod);
  const importsHelper = generateImportsHelper(mod);

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: true,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports: buildImportManifest(mod),
    hasMain: mod.exports.some((e) => e.name === "main" && e.desc.kind === "func"),
    hasTopLevelStatements: mod.hasTopLevelStatements === true,
  };
}
