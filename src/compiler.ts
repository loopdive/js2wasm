import ts from "typescript";
import {
  analyzeMultiSource,
  analyzeSource,
  type TypedAST,
} from "./checker/index.js";
import { generateModule, generateMultiModule } from "./codegen/index.js";
import { generateLinearModule } from "./codegen-linear/index.js";
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
import type { WasmModule } from "./ir/types.js";

function classifyImport(name: string, mod: WasmModule): ImportIntent {
  // String literals
  const strValue = mod.stringLiteralValues.get(name);
  if (strValue !== undefined) return { type: "string_literal", value: strValue };

  // Console
  if (name === "console_log_number") return { type: "console_log", variant: "number" };
  if (name === "console_log_bool") return { type: "console_log", variant: "bool" };
  if (name === "console_log_string") return { type: "console_log", variant: "string" };
  if (name === "console_log_externref") return { type: "console_log", variant: "externref" };

  // Math
  if (name.startsWith("Math_")) return { type: "math", method: name.slice(5) };

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

  // Extern get
  if (name === "__extern_get") return { type: "extern_get" };

  // Declared globals (like `declare const document: Document`)
  if (name.startsWith("global_")) return { type: "declared_global", name: name.slice(7) };

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
  const ast = analyzeSource(processedSource, options.moduleName ?? "input.ts");

  // Collect TS diagnostics as errors
  for (const diag of ast.diagnostics) {
    if (diag.category === 1) {
      // Error
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

  // Don't stop on type errors – the compiler can still generate code for many cases
  // Only stop on syntax errors (parsing failures)
  const hasSyntaxErrors = ast.syntacticDiagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile,
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

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  // Step 2: Generate IR
  let mod;
  try {
    if (useLinear) {
      mod = generateLinearModule(ast);
    } else {
      const result = generateModule(ast, { sourceMap: emitSourceMap });
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

  // Step 3: Emit binary (with source map collection if enabled)
  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);

      // Generate source map JSON
      const sourcesContent = new Map<string, string>();
      sourcesContent.set(options.moduleName ?? "input.ts", source);
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

  const emitSourceMap = options.sourceMap === true;

  let mod;
  try {
    const result = generateMultiModule(multiAst, { sourceMap: emitSourceMap });
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
    "//        const { instance } = await WebAssembly.instantiate(wasmBytes, imports.env ? { env: imports.env } : {},",
    "//          { builtins: ['js-string'] }  // native builtins (Chrome 130+, Firefox 135+)",
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
  if (hasJsString) {
    lines.push('  return { env, "wasm:js-string": jsString };');
  } else {
    lines.push("  return { env };");
  }
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

  // Console stubs
  if (name === "console_log_number")
    return "console_log_number: (v) => console.log(v)";
  if (name === "console_log_bool")
    return "console_log_bool: (v) => console.log(Boolean(v))";
  if (name === "console_log_string")
    return "console_log_string: (v) => console.log(v)";
  if (name === "console_log_externref")
    return "console_log_externref: (v) => console.log(v)";

  // Primitive method imports
  if (name === "number_toString") return "number_toString: (v) => String(v)";

  // String method imports
  if (name.startsWith("string_")) {
    const method = name.slice(7);
    return `${name}: (s, ...a) => s.${method}(...a)`;
  }

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
  const ast = analyzeSource(processedSource, options.moduleName ?? "input.ts");

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
