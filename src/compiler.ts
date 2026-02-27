import { analyzeSource } from "./checker/index.js";
import { generateModule } from "./codegen/index.js";
import { emitBinary } from "./emit/binary.js";
import { emitWat } from "./emit/wat.js";
import type { CompileResult, CompileError, CompileOptions } from "./index.js";

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

  // Step 1: Parse and type-check
  const ast = analyzeSource(source, options.moduleName ?? "input.ts");

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
  const hasSyntaxErrors = ast.diagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile,
  );

  if (hasSyntaxErrors && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      success: false,
      errors,
    };
  }

  // Step 2: Generate IR
  let mod;
  try {
    mod = generateModule(ast);
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
      success: false,
      errors,
    };
  }

  // Step 3: Emit binary
  let binary: Uint8Array;
  try {
    binary = emitBinary(mod);
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
      success: false,
      errors,
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

  return {
    binary,
    wat,
    success: true,
    errors,
  };
}
