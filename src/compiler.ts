import ts from "typescript";
import {
  analyzeMultiSource,
  analyzeSource,
  type TypedAST,
} from "./checker/index.js";
import { generateModule, generateMultiModule } from "./codegen/index.js";
import { generateLinearModule, generateLinearMultiModule } from "./codegen-linear/index.js";
import {
  emitBinary,
  emitBinaryWithSourceMap,
  emitSourceMappingURLSection,
} from "./emit/binary.js";
import { WasmEncoder } from "./emit/encoder.js";
import { emitObject } from "./emit/object.js";
import { generateSourceMap } from "./emit/sourcemap.js";
import { emitWat } from "./emit/wat.js";
import { preprocessImports } from "./import-resolver.js";
import type { CompileError, CompileOptions, CompileResult, ImportDescriptor, ImportIntent } from "./index.js";
import type { WasmModule, FuncTypeDef } from "./ir/types.js";
import { generateCHeader, extractCHeaderExports } from "./emit/c-header.js";
import type { CabiExportInfo, CabiParam, ParamDef } from "./codegen-linear/c-abi.js";
import { mapParamsToCabi, mapResultToCabi, emitCabiWrappers, inferSemantic } from "./codegen-linear/c-abi.js";

// Default blocked members on extern classes in safe mode
const DEFAULT_BLOCKED_MEMBERS = new Set([
  "__proto__", "constructor", "prototype", "valueOf", "toString",
  "innerHTML", "outerHTML", "insertAdjacentHTML",
]);

/** Validate source against safe mode restrictions. Returns errors for violations. */
function validateSafeMode(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  options: CompileOptions,
): CompileError[] {
  const errors: CompileError[] = [];
  const allowedGlobals = new Set(options.allowedGlobals ?? []);
  const allowedMembers = options.allowedExternMembers ?? {};

  function pos(node: ts.Node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return { line: line + 1, column: character + 1 };
  }

  function visit(node: ts.Node): void {
    // 1. Check declare var/const globals
    if (ts.isVariableStatement(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText();
        // Block undeclared globals unless allowlisted
        if (!allowedGlobals.has(name)) {
          const p = pos(decl);
          errors.push({
            message: `Safe mode: declared global "${name}" is not in allowedGlobals`,
            line: p.line, column: p.column, severity: "error",
          });
        }
        // Block any type on declared globals
        if (decl.type) {
          const t = checker.getTypeAtLocation(decl.type);
          if (t.flags & ts.TypeFlags.Any) {
            const p = pos(decl.type);
            errors.push({
              message: `Safe mode: "any" type on declared global "${name}" is not allowed`,
              line: p.line, column: p.column, severity: "error",
            });
          }
        }
      }
    }

    // 2. Check declare class (extern class) members
    if (ts.isClassDeclaration(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      const className = node.name?.getText() ?? "(anonymous)";
      const allowed = allowedMembers[className];
      for (const member of node.members) {
        const memberName = member.name?.getText();
        if (!memberName) continue;

        // Block default-blocked members
        if (DEFAULT_BLOCKED_MEMBERS.has(memberName)) {
          const p = pos(member);
          errors.push({
            message: `Safe mode: extern class "${className}" member "${memberName}" is blocked`,
            line: p.line, column: p.column, severity: "error",
          });
          continue;
        }

        // If an allowlist is provided for this class, check against it
        if (allowed && !allowed.includes(memberName)) {
          const p = pos(member);
          errors.push({
            message: `Safe mode: extern class "${className}" member "${memberName}" is not in allowedExternMembers`,
            line: p.line, column: p.column, severity: "error",
          });
          continue;
        }

        // Block "any" types on extern class members
        if (ts.isPropertyDeclaration(member) && member.type) {
          const t = checker.getTypeAtLocation(member.type);
          if (t.flags & ts.TypeFlags.Any) {
            const p = pos(member.type);
            errors.push({
              message: `Safe mode: "any" type on extern class "${className}.${memberName}" is not allowed`,
              line: p.line, column: p.column, severity: "error",
            });
          }
        }
      }
    }

    // 3. Check for dynamic property access on externref (element access with non-literal)
    if (ts.isElementAccessExpression(node)) {
      const objType = checker.getTypeAtLocation(node.expression);
      // If the object is an extern class type (declared class), block dynamic access
      const objSymbol = objType.getSymbol();
      if (objSymbol) {
        const decls = objSymbol.getDeclarations() ?? [];
        const isDeclaredClass = decls.some(d =>
          ts.isClassDeclaration(d) && d.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)
        );
        if (isDeclaredClass) {
          const p = pos(node);
          errors.push({
            message: `Safe mode: dynamic property access on extern class "${objSymbol.getName()}" is not allowed`,
            line: p.line, column: p.column, severity: "error",
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
}

function classifyImport(name: string, mod: WasmModule): ImportIntent {
  // String literals
  const strValue = mod.stringLiteralValues.get(name);
  if (strValue !== undefined) return { type: "string_literal", value: strValue };

  // Console (log, warn, error)
  // For console.log, keep backward-compatible variant format ("number", "bool", etc.)
  if (name === "console_log_number") return { type: "console_log", variant: "number" };
  if (name === "console_log_bool") return { type: "console_log", variant: "bool" };
  if (name === "console_log_string") return { type: "console_log", variant: "string" };
  if (name === "console_log_externref") return { type: "console_log", variant: "externref" };
  for (const cm of ["warn", "error"]) {
    if (name === `console_${cm}_number`) return { type: "console_log", variant: `${cm}_number` };
    if (name === `console_${cm}_bool`) return { type: "console_log", variant: `${cm}_bool` };
    if (name === `console_${cm}_string`) return { type: "console_log", variant: `${cm}_string` };
    if (name === `console_${cm}_externref`) return { type: "console_log", variant: `${cm}_externref` };
  }

  // Math
  if (name.startsWith("Math_")) return { type: "math", method: name.slice(5) };

  // String compare (lexicographic ordering)
  if (name === "string_compare") return { type: "builtin", name };

  // String methods
  if (name.startsWith("string_")) return { type: "string_method", method: name.slice(7) };

  // Builtins
  if (name === "number_toString") return { type: "builtin", name };
  if (name === "number_toFixed") return { type: "builtin", name };

  // Date
  if (name === "Date_new") return { type: "date_new" };
  if (name.startsWith("Date_")) return { type: "date_method", method: name.slice(5) };

  // Extern classes — check mod.externClasses
  for (const ec of mod.externClasses) {
    const prefix = ec.importPrefix;
    if (name === `${prefix}_new`) return { type: "extern_class", className: ec.className, action: "new" };
    for (const [methodName] of ec.methods) {
      if (name === `${prefix}_${methodName}`) return { type: "extern_class", className: ec.className, action: "method", member: methodName };
    }
    for (const [propName] of ec.properties) {
      if (name === `${prefix}_get_${propName}`) return { type: "extern_class", className: ec.className, action: "get", member: propName };
      if (name === `${prefix}_set_${propName}`) return { type: "extern_class", className: ec.className, action: "set", member: propName };
    }
  }

  // Callback maker
  if (name === "__make_callback") return { type: "callback_maker" };

  // Async/await
  if (name === "__await") return { type: "await" };

  // Union type helpers
  if (name === "__typeof_number") return { type: "typeof_check", targetType: "number" };
  if (name === "__typeof_string") return { type: "typeof_check", targetType: "string" };
  if (name === "__typeof_boolean") return { type: "typeof_check", targetType: "boolean" };
  if (name === "__unbox_number") return { type: "unbox", targetType: "number" };
  if (name === "__unbox_boolean") return { type: "unbox", targetType: "boolean" };
  if (name === "__box_number") return { type: "box", targetType: "number" };
  if (name === "__box_boolean") return { type: "box", targetType: "boolean" };
  if (name === "__is_truthy") return { type: "truthy_check" };
  if (name === "__typeof") return { type: "builtin", name: "__typeof" };

  // Extern get
  if (name === "__extern_get") return { type: "extern_get" };

  // Declared globals (like `declare const document: Document`)
  if (name.startsWith("global_")) return { type: "declared_global", name: name.slice(7) };

  // Unknown constructor imports (__new_ClassName)
  if (name.startsWith("__new_")) {
    return { type: "extern_class", className: name.slice(6), action: "new" };
  }

  // Fallback
  return { type: "builtin", name };
}

function buildImportManifest(mod: WasmModule): ImportDescriptor[] {
  const manifest: ImportDescriptor[] = [];
  for (const imp of mod.imports) {
    if (imp.module !== "env") continue;
    manifest.push({
      module: "env",
      name: imp.name,
      kind: imp.desc.kind === "func" ? "func" : "global",
      intent: classifyImport(imp.name, mod),
    });
  }
  return manifest;
}

/** Check if TS syntax errors look like the source is plain JavaScript (no type annotations). */
function looksLikeTsSyntaxOnJs(diagnostics: readonly { code: number; messageText: string | ts.DiagnosticMessageChain }[]): boolean {
  // TS error codes that indicate TS-specific syntax was expected but not found,
  // or the parser hit JS-only patterns it can't handle in .ts mode.
  // Common: 1005 (';' expected), 2304 (cannot find name), 2552 (cannot find name, did you mean),
  // 1109 (expression expected — happens with arrow functions returning JSX-like).
  // We also check message text for typical TS-on-JS confusion.
  for (const d of diagnostics) {
    const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
    // These patterns strongly suggest the user passed JS to the TS parser
    if (msg.includes("Type annotations can only be used in TypeScript files")) return true;
    if (msg.includes("types can only be used in a .ts file")) return true;
    if (msg.includes("'type' modifier cannot be used in a JavaScript file")) return true;
  }
  return false;
}

/**
 * Detect untyped parameters in JS mode and add helpful warnings suggesting JSDoc annotations.
 * Returns warning CompileErrors for each function parameter that resolved to 'any'.
 */
function checkJsTypeCoverage(ast: TypedAST): CompileError[] {
  const warnings: CompileError[] = [];
  const sf = ast.sourceFile;

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      const fnName = node.name.text;
      for (const param of node.parameters) {
        const paramType = ast.checker.getTypeAtLocation(param);
        if (paramType.flags & ts.TypeFlags.Any) {
          const paramName = ts.isIdentifier(param.name) ? param.name.text : "?";
          const { line, character } = sf.getLineAndCharacterOfPosition(param.getStart());
          warnings.push({
            message: `Parameter '${paramName}' in function '${fnName}' has implicit 'any' type. ` +
              `Add a JSDoc annotation: /** @param {number} ${paramName} */`,
            line: line + 1,
            column: character + 1,
            severity: "warning",
          });
        }
      }
      // Check return type
      const sig = ast.checker.getSignatureFromDeclaration(node);
      if (sig) {
        const retType = ast.checker.getReturnTypeOfSignature(sig);
        if (retType.flags & ts.TypeFlags.Any) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.name.getStart());
          warnings.push({
            message: `Function '${fnName}' has implicit 'any' return type. ` +
              `Add a JSDoc annotation: /** @returns {number} */`,
            line: line + 1,
            column: character + 1,
            severity: "warning",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return warnings;
}

/**
 * Orchestrates the full compilation pipeline:
 * TS Source → tsc Parser+Checker → Codegen → Binary + WAT
 */
export function compileSource(
  source: string,
  options: CompileOptions = {},
): CompileResult {
  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  // Step 0: Pre-process imports (replace import * as X with declare namespace)
  const processedSource = preprocessImports(source);

  // Step 1: Parse and type-check
  let isJsMode = options.allowJs === true || (options.fileName?.endsWith(".js") ?? false);
  const defaultFileName = options.fileName ?? (isJsMode ? "input.js" : "input.ts");
  const effectiveFileName = options.moduleName ?? defaultFileName;
  let ast = analyzeSource(processedSource, effectiveFileName, { allowJs: options.allowJs });

  // Auto-detect: if parsing as TS fails with syntax errors that look like
  // the source is plain JS, retry with allowJs mode enabled.
  if (!isJsMode) {
    const syntaxErrors = ast.syntacticDiagnostics.filter(
      (d) => d.category === 1 && d.file === ast.sourceFile,
    );
    if (syntaxErrors.length > 0 && looksLikeTsSyntaxOnJs(syntaxErrors)) {
      // Retry as JS
      isJsMode = true;
      const jsFileName = effectiveFileName.replace(/\.ts$/, ".js");
      ast = analyzeSource(processedSource, jsFileName, { allowJs: true });
    }
  }

  // In JS mode, check for untyped parameters and add helpful warnings
  if (isJsMode) {
    const typeWarnings = checkJsTypeCoverage(ast);
    errors.push(...typeWarnings);
  }

  // TS diagnostics that the wasm codegen can handle gracefully —
  // downgrade from error to warning so they don't block compilation.
  const DOWNGRADE_DIAG_CODES = new Set([
    2304, // "Cannot find name 'X'" — unknown identifiers compiled as externref/unreachable
    2345, // "Argument of type 'X' is not assignable to parameter of type 'Y'"
    2322, // "Type 'X' is not assignable to type 'Y'"
    2339, // "Property 'X' does not exist on type 'Y'" — dynamic property access
    2454, // "Variable 'X' is used before being assigned"
    2531, // "Object is possibly 'null'"
    2532, // "Object is possibly 'undefined'"
    2367, // "This comparison appears to be unintentional" (always truthy/falsy)
    2554, // "Expected N arguments, but got M"
    2683, // "'this' implicitly has type 'any'"
    2769, // "No overload matches this call"
    18049, // "'X' is declared but its value is never read" (unused vars)
    2358, // "The left-hand side of an 'instanceof' expression must be..."
    2362, // "The left-hand side of an arithmetic operation must be..."
    2365, // "Operator 'X' cannot be applied to types 'Y' and 'Z'"
    18050, // "The value 'null'/'undefined' cannot be used here"
    2872, // "This kind of expression is always truthy"
    2873, // "This kind of expression is always falsy"
    2363, // "The right-hand side of an arithmetic operation must be..."
    2695, // "Left side of comma operator is unused and has no side effects"
    2869, // "Right operand of ?? is unreachable because the left operand is never nullish"
    2349, // "This expression is not callable"
    2552, // "Cannot find name 'X'. Did you mean 'Y'?"
    18046, // "'X' is of type 'unknown'"
    2871, // "This expression is always nullish"
    18048, // "'X' is possibly 'undefined'"
    2839, // "This condition will always return true/false since JS compares objects by reference"
    2703, // "The operand of a 'delete' operator must be a property reference"
    2630, // "Cannot assign to 'X' because it is a function"
    2447, // "The '|'/'&' operator is not allowed for boolean types"
    2300, // "Duplicate identifier 'X'"
    2408, // "Setters cannot return a value" — valid in JS, codegen handles it
    1345, // "An expression of type 'void' cannot be tested for truthiness"
    2350, // "Only a void function can be called with the 'new' keyword"
    2403, // "Subsequent variable declarations must have the same type" — var re-declarations legal in JS
    2377, // "Constructors for derived classes must contain a 'super' call" — valid JS pattern
    2376, // "A 'super' call must be the first statement in the constructor" — valid JS pattern
    17009, // "'super' must be called before accessing 'this' in derived class constructor"
    17011, // "'super' must be called before accessing a property of 'super' in derived class constructor"
    2540, // "Cannot assign to 'X' because it is a read-only property" — private fields are writable in JS
    2803, // "Cannot assign to private method 'X'. Private methods are not writable" — valid JS pattern
    2806, // "Private accessor was defined without a getter" — valid JS pattern
    18030, // "An optional chain cannot contain private identifiers" — valid JS pattern
    2729, // "Property 'X' is used before its initialization" — valid JS pattern
    18014, // "The property '#x' cannot be accessed on type 'X' within this class because it is shadowed" — valid JS
    1166, // "A computed property name in a class property declaration must have a simple literal type" — valid JS
    1168, // "A computed property name in a method overload must refer to an expression whose type is a literal type"
    1169, // "A computed property name in an interface must refer to an expression whose type is a literal type"
    1170, // "A computed property name in a type literal must refer to an expression whose type is a literal type"
    2464, // "A computed property name must be of type 'string', 'number', 'symbol', or 'any'" — valid JS
    2418, // "Type of computed property's value is not assignable to type" — valid JS
    1214, // "Identifier expected. 'yield' is a reserved word in strict mode" — sloppy-mode test262 tests
    1212, // "Identifier expected. 'X' is a reserved word in strict mode" — sloppy-mode test262 tests
  ]);

  // Collect TS diagnostics as errors (or warnings for handled cases)
  for (const diag of ast.diagnostics) {
    if (diag.category === 1) {
      // Error
      const pos = diag.file
        ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0)
        : { line: 0, character: 0 };
      const severity = DOWNGRADE_DIAG_CODES.has(diag.code) ? "warning" : "error";
      errors.push({
        message:
          typeof diag.messageText === "string"
            ? diag.messageText
            : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: severity as "error" | "warning",
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
  ]);
  const hasSyntaxErrors = ast.syntacticDiagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile && !TOLERATED_SYNTAX_CODES.has(d.code),
  );

  if (hasSyntaxErrors && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
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
      const result = generateModule(ast, { sourceMap: emitSourceMap, fast: options.fast });
      mod = result.module;
      // Propagate codegen errors with source locations
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: "error",
        });
      }
    }
  } catch (e) {
    errors.push({
      message: `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Step 2b: Apply C ABI transformations if requested
  let cHeader: string | undefined;
  if (options.abi === "c" && options.target === "linear") {
    const cabiResult = applyCabiTransform(mod, options.moduleName ?? "module");
    cHeader = cabiResult.cHeader;
  }

  // Step 3: Emit binary (with source map collection if enabled)
  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);

      // Generate source map JSON
      const sourcesContent = new Map<string, string>();
      sourcesContent.set(effectiveFileName, source);
      const sourceMap = generateSourceMap(
        emitResult.sourceMapEntries,
        sourcesContent,
      );
      sourceMapJson = JSON.stringify(sourceMap);

      // Append sourceMappingURL custom section to the binary
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();

      // Concatenate the binary with the sourceMappingURL section
      const combined = new Uint8Array(
        emitResult.binary.length + urlSectionBytes.length,
      );
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    errors.push({
      message: `Binary emit error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Step 4: Emit WAT (optional)
  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      // WAT emit failure is non-fatal
      errors.push({
        message: `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        line: 0,
        column: 0,
        severity: "warning",
      });
    }
  }

  // Step 5: Generate .d.ts
  const dts = generateDts(ast, mod);

  // Step 6: Generate imports helper
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
    cHeader,
  };
}

/**
 * Apply C ABI transformation to a compiled WasmModule.
 * Rewrites exported function signatures for C compatibility and generates a C header.
 */
function applyCabiTransform(
  mod: WasmModule,
  moduleName: string,
): { cHeader: string } {
  const numImportFuncs = mod.imports.filter(
    (i) => i.desc.kind === "func",
  ).length;

  // Build CabiExportInfo for each exported function
  const exportInfos: CabiExportInfo[] = [];
  for (const exp of mod.exports) {
    if (exp.desc.kind !== "func") continue;
    if (exp.name === "memory") continue;

    const funcIdx = exp.desc.index;
    const localIdx = funcIdx - numImportFuncs;
    if (localIdx < 0 || localIdx >= mod.functions.length) continue;

    const func = mod.functions[localIdx];
    const typeDef = mod.types[func.typeIdx];
    if (!typeDef || typeDef.kind !== "func") continue;

    // Build ParamDefs from the function type
    // In linear memory mode: f64 = number, i32 = pointer (string/array/object)
    // We infer semantics from the function name and wasm types
    const paramDefs: ParamDef[] = typeDef.params.map((wt, i) => {
      // Without TS type info at this stage, we infer from wasm types:
      // f64 → number, i32 → could be string/array/object/boolean
      // For now, treat all i32 params as direct (caller provides i32)
      const semantic = wt.kind === "f64" ? "number_f64" as const : "number_i32" as const;
      return { name: `p${i}`, wasmType: wt, semantic };
    });

    const cabiParams = mapParamsToCabi(paramDefs);
    const resultSemantic = typeDef.results.length === 0
      ? "void" as const
      : typeDef.results[0].kind === "f64"
        ? "number_f64" as const
        : "number_i32" as const;
    const cabiResult = mapResultToCabi(
      typeDef.results.length > 0 ? typeDef.results[0] : null,
      resultSemantic,
    );

    const cabiName = exp.name; // mangleCabiName is identity for simple names

    exportInfos.push({
      tsName: exp.name,
      cabiName,
      params: cabiParams,
      result: cabiResult,
    });
  }

  // Apply wrappers for functions that need them
  emitCabiWrappers(mod, exportInfos);

  // Generate C header from the final module state
  const headerExports = extractCHeaderExports(mod);
  const cHeader = generateCHeader(moduleName, headerExports);

  return { cHeader };
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

  const multiAst = analyzeMultiSource(files, entryFile);

  for (const diag of multiAst.diagnostics) {
    if (diag.category === 1) {
      const pos = diag.file
        ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0)
        : { line: 0, character: 0 };
      errors.push({
        message:
          typeof diag.messageText === "string"
            ? diag.messageText
            : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: "error",
      });
    }
  }

  const hasSyntaxErrors = multiAst.syntacticDiagnostics.some(
    (d) => d.category === 1 && multiAst.sourceFiles.some((sf) => d.file === sf),
  );

  if (hasSyntaxErrors && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Safe mode validation for all source files
  if (options.safe) {
    for (const sf of multiAst.sourceFiles) {
      const safeErrors = validateSafeMode(sf, multiAst.checker, options);
      errors.push(...safeErrors);
    }
    if (errors.some(e => e.severity === "error")) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
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
      const result = generateMultiModule(multiAst, { sourceMap: emitSourceMap, fast: options.fast });
      mod = result.module;
      // Propagate codegen errors with source locations
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: "error",
        });
      }
    }
  } catch (e) {
    errors.push({
      message: `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

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
      const sourceMap = generateSourceMap(
        emitResult.sourceMapEntries,
        sourcesContent,
      );
      sourceMapJson = JSON.stringify(sourceMap);

      // Append sourceMappingURL custom section
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();

      const combined = new Uint8Array(
        emitResult.binary.length + urlSectionBytes.length,
      );
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    errors.push({
      message: `Binary emit error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      errors.push({
        message: `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        line: 0,
        column: 0,
        severity: "warning",
      });
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
  };
}

// ── .d.ts generation ─────────────────────────────────────────────────

function generateDts(ast: TypedAST, mod: WasmModule): string {
  const lines: string[] = ["// Generated by ts2wasm", ""];

  // Exports interface
  const exportLines: string[] = [];
  for (const stmt of ast.sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name &&
      hasExportModifier(stmt)
    ) {
      const name = stmt.name.text;
      const isAsync = mod.asyncFunctions.has(name);
      const params = stmt.parameters
        .map((p) => {
          const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
          const typeText = mapTypeForDts(p.type, ast.sourceFile);
          const optional = p.questionToken ? "?" : "";
          return `${paramName}${optional}: ${typeText}`;
        })
        .join(", ");
      let returnType = mapTypeForDts(stmt.type, ast.sourceFile);
      // For async functions, preserve the Promise<T> wrapper in the .d.ts output
      if (isAsync && !returnType.startsWith("Promise<")) {
        returnType = `Promise<${returnType}>`;
      }
      exportLines.push(`  ${name}(${params}): ${returnType};`);
    }
  }

  if (exportLines.length > 0) {
    lines.push(
      ...exportLines.map((l) => {
        // Convert "  name(params): ret;" to "export declare function name(params): ret;"
        const m = l.match(/^\s+(\w+)\(([^)]*)\):\s*(.+);$/);
        if (m) return `export declare function ${m[1]}(${m[2]}): ${m[3]};`;
        return l;
      }),
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ── Imports helper generation ────────────────────────────────────────

function generateImportsHelper(mod: WasmModule): string {
  const lines: string[] = [
    "// Generated by ts2wasm — runtime imports helper",
    "// Usage: const imports = createImports(deps);",
    "//        const { instance } = await WebAssembly.instantiate(wasmBytes, imports,",
    "//          { builtins: ['js-string'], importedStringConstants: 'string_constants' }",
    "//        );",
    "",
  ];

  // Determine what we need
  const hasDeps = mod.externClasses.length > 0;
  const hasStringPool = mod.stringPool.length > 0;
  const hasJsString = mod.imports.some((i) => i.module === "wasm:js-string");
  const hasCallbacks = mod.imports.some((i) => i.name === "__make_callback");

  // Late-binding variable for callback support
  if (hasCallbacks) {
    lines.push("let wasmExports;");
    lines.push(
      "export function setExports(exports) { wasmExports = exports; }",
    );
    lines.push("");
  }

  // Function signature
  lines.push(`export function createImports(${hasDeps ? "deps" : ""}) {`);

  // env object
  lines.push("  const env = {");

  for (const imp of mod.imports) {
    if (imp.module !== "env") continue;
    if (imp.desc.kind !== "func") continue;

    const line = generateEnvImportLine(imp.name, mod);
    lines.push(`    ${line},`);
  }

  lines.push("  };");

  // String constants (importedStringConstants namespace)
  if (hasStringPool) {
    lines.push("");
    lines.push("  // String constants as WebAssembly.Global values");
    lines.push("  const string_constants = {");
    for (const s of mod.stringPool) {
      lines.push(`    ${JSON.stringify(s)}: new WebAssembly.Global({ value: "externref", mutable: false }, ${JSON.stringify(s)}),`);
    }
    lines.push("  };");
  }

  // wasm:js-string polyfill
  if (hasJsString) {
    lines.push("");
    lines.push(
      "  // Polyfill for engines without native wasm:js-string support",
    );
    lines.push("  const jsString = {");
    lines.push("    concat: (a, b) => a + b,");
    lines.push("    length: (s) => s.length,");
    lines.push("    equals: (a, b) => a === b ? 1 : 0,");
    lines.push("    substring: (s, start, end) => s.substring(start, end),");
    lines.push("    charCodeAt: (s, i) => s.charCodeAt(i),");
    lines.push("  };");
  }

  // Return statement
  lines.push("");
  const parts: string[] = ["env"];
  if (hasStringPool) parts.push("string_constants");
  if (hasJsString) parts.push('"wasm:js-string": jsString');
  lines.push(`  return { ${parts.join(", ")} };`);
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

function generateEnvImportLine(name: string, mod: WasmModule): string {
  // String literal thunks
  const strValue = mod.stringLiteralValues.get(name);
  if (strValue !== undefined) {
    return `${name}: () => ${JSON.stringify(strValue)}`;
  }

  // Console stubs (log, warn, error)
  for (const cm of ["log", "warn", "error"]) {
    if (name === `console_${cm}_number`)
      return `console_${cm}_number: (v) => console.${cm}(v)`;
    if (name === `console_${cm}_bool`)
      return `console_${cm}_bool: (v) => console.${cm}(Boolean(v))`;
    if (name === `console_${cm}_string`)
      return `console_${cm}_string: (v) => console.${cm}(v)`;
    if (name === `console_${cm}_externref`)
      return `console_${cm}_externref: (v) => console.${cm}(v)`;
  }

  // Primitive method imports
  if (name === "number_toString") return "number_toString: (v) => String(v)";

  // String compare (lexicographic ordering)
  if (name === "string_compare")
    return "string_compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0)";

  // String method imports
  if (name.startsWith("string_")) {
    const method = name.slice(7);
    return `${name}: (s, ...a) => s.${method}(...a)`;
  }

  // String.fromCharCode
  if (name === "String_fromCharCode")
    return "String_fromCharCode: (code) => String.fromCharCode(code)";

  // ToUint32 helper for Math.clz32/imul
  if (name === "__toUint32")
    return "__toUint32: (x) => x >>> 0";

  // Math host imports
  if (name.startsWith("Math_")) {
    const method = name.slice(5);
    return `${name}: Math.${method}`;
  }

  // Extern class imports
  for (const ec of mod.externClasses) {
    const prefix = ec.importPrefix;
    const nsAccess =
      ec.namespacePath.length > 0
        ? `deps.${ec.namespacePath.join(".")}`
        : `deps`;

    if (name === `${prefix}_new`) {
      const paramList = ec.constructorParams.map((_, i) => `a${i}`).join(", ");
      return `${name}: (${paramList}) => new ${nsAccess}.${ec.className}(${paramList})`;
    }
    for (const [methodName, sig] of ec.methods) {
      if (name === `${prefix}_${methodName}`) {
        const paramList = sig.params
          .slice(1)
          .map((_, i) => `a${i}`)
          .join(", ");
        return `${name}: (self${paramList ? ", " + paramList : ""}) => self.${methodName}(${paramList})`;
      }
    }
    for (const [propName, propInfo] of ec.properties) {
      if (name === `${prefix}_get_${propName}`) {
        return `${name}: (self) => self.${propName}`;
      }
      if (name === `${prefix}_set_${propName}`) {
        return `${name}: (self, v) => { self.${propName} = v; }`;
      }
    }
  }

  // __make_callback: late-binding wrapper
  if (name === "__make_callback") {
    return `${name}: (id, cap) => (...args) => wasmExports[\`__cb_\${id}\`](cap, ...args)`;
  }

  // Async/await support: __await is identity (host functions are sync from Wasm's perspective)
  if (name === "__await") return `${name}: (v) => v`;

  // Generator support
  if (name === "__gen_create_buffer") return `${name}: () => []`;
  if (name === "__gen_push_f64") return `${name}: (buf, v) => { buf.push(v); }`;
  if (name === "__gen_push_i32") return `${name}: (buf, v) => { buf.push(v); }`;
  if (name === "__gen_push_ref") return `${name}: (buf, v) => { buf.push(v); }`;
  if (name === "__create_generator")
    return `${name}: (buf) => { let i = 0; return { next() { if (i < buf.length) return { value: buf[i++], done: false }; return { value: undefined, done: true }; }, return(v) { i = buf.length; return { value: v, done: true }; }, throw(e) { i = buf.length; throw e; }, [Symbol.iterator]() { return this; } }; }`;
  if (name === "__gen_next") return `${name}: (gen) => gen.next()`;
  if (name === "__gen_result_value") return `${name}: (r) => r.value`;
  if (name === "__gen_result_value_f64") return `${name}: (r) => Number(r.value)`;
  if (name === "__gen_result_done") return `${name}: (r) => r.done ? 1 : 0`;

  // Union type helper imports
  if (name === "__typeof_number")
    return `${name}: (v) => typeof v === "number" ? 1 : 0`;
  if (name === "__typeof_string")
    return `${name}: (v) => typeof v === "string" ? 1 : 0`;
  if (name === "__typeof_boolean")
    return `${name}: (v) => typeof v === "boolean" ? 1 : 0`;
  if (name === "__unbox_number") return `${name}: (v) => Number(v)`;
  if (name === "__unbox_boolean") return `${name}: (v) => v ? 1 : 0`;
  if (name === "__box_number") return `${name}: (v) => v`;
  if (name === "__box_boolean") return `${name}: (v) => Boolean(v)`;
  if (name === "__is_truthy") return `${name}: (v) => v ? 1 : 0`;
  if (name === "__typeof") return `${name}: (v) => typeof v`;

  // Callback bridges for functional array methods
  if (name === "__call_1_f64") return `${name}: (fn, a) => fn(a)`;
  if (name === "__call_2_f64") return `${name}: (fn, a, b) => fn(a, b)`;

  // Fallback: no-op stub
  return `${name}: () => {}`;
}

function mapTypeForDts(
  typeNode: ts.TypeNode | undefined,
  sf: ts.SourceFile,
): string {
  if (!typeNode) return "void";
  const text = typeNode.getText(sf);
  if (
    text === "number" ||
    text === "boolean" ||
    text === "string" ||
    text === "void"
  ) {
    return text;
  }
  // Handle Promise<T> type references
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sf);
    if (typeName === "Promise" && typeNode.typeArguments?.length === 1) {
      const innerType = mapTypeForDts(typeNode.typeArguments[0], sf);
      return `Promise<${innerType}>`;
    }
  }
  return "any";
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return (
    modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

// ── Object file compilation ─────────────────────────────────────────

export interface ObjectCompileResult {
  /** Relocatable Wasm object file (.o) */
  object: Uint8Array;
  /** true if compilation was successful */
  success: boolean;
  /** Error messages with line numbers */
  errors: CompileError[];
}

/**
 * Compile TypeScript source to a relocatable Wasm object file (.o).
 * Uses the same pipeline as compileSource but emits LLVM-style
 * linking metadata instead of a final executable module.
 */
export function compileToObjectSource(
  source: string,
  options: CompileOptions = {},
): ObjectCompileResult {
  const errors: CompileError[] = [];

  const processedSource = preprocessImports(source);
  const defaultFileName = options.fileName ?? (options.allowJs ? "input.js" : "input.ts");
  const effectiveFileName = options.moduleName ?? defaultFileName;
  const ast = analyzeSource(processedSource, effectiveFileName, { allowJs: options.allowJs });

  for (const diag of ast.diagnostics) {
    if (diag.category === 1) {
      const pos = diag.file
        ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0)
        : { line: 0, character: 0 };
      errors.push({
        message:
          typeof diag.messageText === "string"
            ? diag.messageText
            : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: "error",
      });
    }
  }

  const hasSyntaxErrors = ast.syntacticDiagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile,
  );

  if (hasSyntaxErrors && errors.length > 0) {
    return { object: new Uint8Array(0), success: false, errors };
  }

  let mod;
  try {
    const result = generateModule(ast);
    mod = result.module;
    for (const err of result.errors) {
      errors.push({
        message: err.message,
        line: err.line,
        column: err.column,
        severity: "error",
      });
    }
  } catch (e) {
    errors.push({
      message: `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return { object: new Uint8Array(0), success: false, errors };
  }

  let object: Uint8Array;
  try {
    object = emitObject(mod);
  } catch (e) {
    errors.push({
      message: `Object emit error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return { object: new Uint8Array(0), success: false, errors };
  }

  return { object, success: true, errors };
}
