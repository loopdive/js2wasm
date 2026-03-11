import ts from "typescript";
import type { CodegenContext, FunctionContext, ClosureInfo, RestParamInfo } from "./index.js";
import { allocLocal, getLocalType, resolveWasmType, getOrRegisterArrayType, getOrRegisterVecType, getArrTypeIdxFromVec, addFuncType, addImport, addUnionImports, parseRegExpLiteral, ensureStructForType, isTupleType, getTupleElementTypes, getOrRegisterTupleType, localGlobalIdx, nativeStringType, flatStringType, ensureNativeStringHelpers, getOrRegisterRefCellType, isAnyValue, ensureAnyHelpers, addStringImports, cacheStringLiterals } from "./index.js";
import {
  mapTsTypeToWasm,
  isNumberType,
  isBooleanType,
  isBigIntType,
  isStringType,
  isVoidType,
  isExternalDeclaredClass,
  isHeterogeneousUnion,
  isGeneratorType,
  isIteratorResultType,
} from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction, FieldDef, StructTypeDef } from "../ir/types.js";
import { ensureI32Condition } from "./index.js";
import { compileStatement } from "./statements.js";
import { ensureTimsortHelper } from "./timsort.js";

/** Sentinel: expression compiled successfully but produces no value (void) */
const VOID_RESULT = Symbol("void");
type InnerResult = ValType | null | typeof VOID_RESULT;

/**
 * Compile an expression, pushing its result onto the Wasm stack.
 * Returns null only for void expressions that intentionally produce no value.
 * For failed expressions, pushes a typed fallback to keep the stack balanced.
 */
export function compileExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  // Fast-path: null/undefined in numeric context — emit the correct f64 constant
  // directly instead of going through externref + __unbox_number, because wasm's
  // ref.null.extern is indistinguishable between null and undefined at the JS
  // boundary (both become JS null), so Number(null)=0 but Number(undefined)=NaN
  // cannot be recovered after the externref roundtrip.
  if (expectedType?.kind === "f64") {
    if (expr.kind === ts.SyntaxKind.NullKeyword) {
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }
    if (expr.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(expr) && expr.text === "undefined")) {
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }
  }

  const bodyLenBefore = fctx.body.length;
  let result: InnerResult;
  try {
    result = compileExpressionInner(ctx, fctx, expr);
  } catch (e) {
    // Defensive: catch any unhandled crash in expression compilation
    fctx.body.length = bodyLenBefore;
    const msg = e instanceof Error ? e.message : String(e);
    ctx.errors.push({
      message: `Internal error compiling expression: ${msg}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    const fallbackType = expectedType ?? { kind: "f64" as const };
    pushDefaultValue(fctx, fallbackType);
    return fallbackType;
  }
  if (result === VOID_RESULT) return null; // void — no value on stack
  if (result !== null) {
    // Coerce to expected type if there's a mismatch
    if (expectedType && result.kind !== expectedType.kind) {
      coerceType(ctx, fctx, result, expectedType);
      return expectedType;
    }
    return result;
  }

  // Compilation failed — rollback any partially-emitted instructions
  // (e.g. sub-expressions that were compiled before the failure point)
  // then push a single typed fallback to keep the stack balanced.
  fctx.body.length = bodyLenBefore;
  let wasmType: ValType;
  if (expectedType) {
    wasmType = expectedType;
  } else {
    try {
      wasmType = mapTsTypeToWasm(ctx.checker.getTypeAtLocation(expr), ctx.checker);
    } catch {
      wasmType = { kind: "f64" };
    }
  }
  pushDefaultValue(fctx, wasmType);
  return wasmType;
}

/** Check if two ValTypes are structurally equal */
function valTypesMatch(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") &&
      (b.kind === "ref" || b.kind === "ref_null")) {
    return (a as { typeIdx: number }).typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}

/** Coerce a value on the stack from one type to another */
function coerceType(ctx: CodegenContext, fctx: FunctionContext, from: ValType, to: ValType): void {
  if (from.kind === to.kind) {
    // Same kind but check if ref typeIdx differs (e.g. ref $AnyValue vs ref $SomeStruct)
    if ((from.kind === "ref" || from.kind === "ref_null") &&
        (to.kind === "ref" || to.kind === "ref_null")) {
      const fromIdx = (from as { typeIdx: number }).typeIdx;
      const toIdx = (to as { typeIdx: number }).typeIdx;
      if (fromIdx === toIdx) return;
      // Boxing: non-any ref → any ref
      if (isAnyValue(to, ctx) && !isAnyValue(from, ctx)) {
        ensureAnyHelpers(ctx);
        const funcIdx = ctx.funcMap.get("__any_box_ref");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return;
        }
      }
      // Unboxing: any ref → non-any ref (extract refval and cast)
      if (isAnyValue(from, ctx) && !isAnyValue(to, ctx)) {
        ensureAnyHelpers(ctx);
        // Get the refval field (eqref), then ref.cast to target type
        fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 });
        fctx.body.push({ op: "ref.cast", typeIdx: toIdx });
        return;
      }
    }
    return;
  }
  // ref is a subtype of ref_null — no coercion needed
  if (from.kind === "ref" && to.kind === "ref_null") {
    // But check for any-value boxing (ref $X → ref_null $AnyValue)
    if (isAnyValue(to, ctx) && !isAnyValue(from, ctx)) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_ref");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    return;
  }
  if (from.kind === "ref_null" && to.kind === "ref") {
    // Unboxing: ref_null $AnyValue → ref $X
    if (isAnyValue(from, ctx) && !isAnyValue(to, ctx)) {
      ensureAnyHelpers(ctx);
      const toIdx = (to as { typeIdx: number }).typeIdx;
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 });
      fctx.body.push({ op: "ref.cast", typeIdx: toIdx });
      return;
    }
    return;
  }

  // ── Boxing: primitive → ref $AnyValue ──
  if (isAnyValue(to, ctx)) {
    ensureAnyHelpers(ctx);
    if (from.kind === "i32") {
      const funcIdx = ctx.funcMap.get("__any_box_i32");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (from.kind === "f64") {
      const funcIdx = ctx.funcMap.get("__any_box_f64");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (from.kind === "externref") {
      const funcIdx = ctx.funcMap.get("__any_box_string");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (from.kind === "ref" || from.kind === "ref_null") {
      const funcIdx = ctx.funcMap.get("__any_box_ref");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
  }

  // ── Unboxing: ref $AnyValue → primitive ──
  if (isAnyValue(from, ctx)) {
    ensureAnyHelpers(ctx);
    if (to.kind === "i32") {
      const funcIdx = ctx.funcMap.get("__any_unbox_i32");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (to.kind === "f64") {
      const funcIdx = ctx.funcMap.get("__any_unbox_f64");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (to.kind === "externref") {
      // Convert GC ref (AnyValue struct) to externref via extern.convert_any
      fctx.body.push({ op: "extern.convert_any" });
      return;
    }
  }

  // i64 → f64 (Number(bigint))
  if (from.kind === "i64" && to.kind === "f64") {
    fctx.body.push({ op: "f64.convert_i64_s" });
    return;
  }
  // f64 → i64 (BigInt(number))
  if (from.kind === "f64" && to.kind === "i64") {
    fctx.body.push({ op: "i64.trunc_f64_s" });
    return;
  }
  // i32 → i64
  if (from.kind === "i32" && to.kind === "i64") {
    fctx.body.push({ op: "i64.extend_i32_s" });
    return;
  }
  // i64 → i32
  if (from.kind === "i64" && to.kind === "i32") {
    // Truncate: check if non-zero (truthiness for conditions)
    fctx.body.push({ op: "i64.const", value: 0n });
    fctx.body.push({ op: "i64.ne" });
    return;
  }
  // i32 → f64
  if (from.kind === "i32" && to.kind === "f64") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }
  // f64 → i32
  if (from.kind === "f64" && to.kind === "i32") {
    fctx.body.push({ op: "i32.trunc_f64_s" });
    return;
  }
  // externref → i32 (unbox as number to preserve value, then truncate)
  if (from.kind === "externref" && to.kind === "i32") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      fctx.body.push({ op: "i32.trunc_f64_s" });
      return;
    }
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
    return;
  }
  // externref → f64 (unbox number)
  if (from.kind === "externref" && to.kind === "f64") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
    // Fallback: drop and push default
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: 0 });
    return;
  }
  // f64 → externref (box number)
  if (from.kind === "f64" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
  }
  // i32 → externref (box as number to preserve value)
  if (from.kind === "i32" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
  }
  // ref/ref_null → externref: call toString() method if available, else extern.convert_any
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "externref") {
    const typeIdx = (from as { typeIdx: number }).typeIdx;
    for (const [name, idx] of ctx.structMap) {
      if (idx === typeIdx) {
        const toStringFuncIdx = ctx.funcMap.get(`${name}_toString`);
        if (toStringFuncIdx !== undefined) {
          // Call ClassName_toString(self) — self is already on stack
          fctx.body.push({ op: "call", funcIdx: toStringFuncIdx });
          return;
        }
        break;
      }
    }
    fctx.body.push({ op: "extern.convert_any" });
    return;
  }
  // i32/f64 → externref (fallback)
  if (to.kind === "externref") {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // ref (struct) → f64: JS ToNumber semantics via valueOf
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "f64") {
    const typeIdx = (from as { typeIdx: number }).typeIdx;
    for (const [name, idx] of ctx.structMap) {
      if (idx === typeIdx) {
        const fields = ctx.structFields.get(name);
        if (!fields) { break; }
        const fieldIdx = fields.findIndex(f => f.name === "valueOf");
        if (fieldIdx < 0) {
          // No valueOf field — check for a class method valueOf (ClassName_valueOf)
          const valueOfFuncIdx = ctx.funcMap.get(`${name}_valueOf`);
          if (valueOfFuncIdx !== undefined) {
            // Call ClassName_valueOf(self) — self is already on stack
            fctx.body.push({ op: "call", funcIdx: valueOfFuncIdx });
            // Check return type — if i32, convert to f64
            const funcType = ctx.mod.types[ctx.mod.functions[valueOfFuncIdx - ctx.numImportFuncs]?.typeIdx ?? -1];
            if (funcType?.kind === "func" && funcType.results?.[0]?.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
            }
            return;
          }
          // No valueOf — ToNumber({}) = NaN per spec
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: NaN });
          return;
        }
        const valueOfField = fields[fieldIdx]!;
        if (valueOfField.type.kind === "ref" || valueOfField.type.kind === "ref_null") {
          // valueOf is a closure ref — call it via call_ref
          const closureTypeIdx = (valueOfField.type as { typeIdx: number }).typeIdx;
          // Find closure info by struct type index
          const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
          if (closureInfo) {
            // Save struct ref to local, extract valueOf closure, call it
            const structLocal = allocLocal(fctx, `__coerce_struct_${fctx.locals.length}`, from);
            fctx.body.push({ op: "local.set", index: structLocal });
            // Get closure ref from struct
            fctx.body.push({ op: "local.get", index: structLocal });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
            const closureLocal = allocLocal(fctx, `__coerce_closure_${fctx.locals.length}`, valueOfField.type);
            fctx.body.push({ op: "local.tee", index: closureLocal });
            // Push closure ref as self param, then funcref from field 0
            // call_ref signature: [closure_ref, funcref] → results
            fctx.body.push({ op: "local.get", index: closureLocal });
            fctx.body.push({ op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.funcTypeIdx });
            fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
            // If valueOf returns void/null, result is NaN; if f64, keep it
            if (!closureInfo.returnType || closureInfo.returnType.kind === "i32") {
              // void → push NaN (the call produced nothing or an i32)
              if (closureInfo.returnType?.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
              } else {
                fctx.body.push({ op: "f64.const", value: NaN });
              }
            }
            // f64 return → value is already on stack
            return;
          }
        }
        if (valueOfField.type.kind === "externref") {
          // valueOf is externref (can't call_ref) — push NaN
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: NaN });
          return;
        }
        break;
      }
    }
  }

  // Fallback: drop + push default
  fctx.body.push({ op: "drop" });
  pushDefaultValue(fctx, to);
}

function compileExpressionInner(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): InnerResult {
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text.replace(/_/g, ""));
    if (ctx.fast && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      fctx.body.push({ op: "i32.const", value });
      return { kind: "i32" };
    }
    fctx.body.push({ op: "f64.const", value });
    return { kind: "f64" };
  }

  if (ts.isBigIntLiteral(expr)) {
    // BigInt literal: 42n → i64.const 42
    // expr.text includes trailing 'n', strip it
    const text = expr.text.replace(/_/g, "").replace(/n$/i, "");
    const value = BigInt(text);
    fctx.body.push({ op: "i64.const", value });
    return { kind: "i64" };
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return compileStringLiteral(ctx, fctx, expr.text, expr);
  }

  if (ts.isTemplateExpression(expr)) {
    return compileTemplateExpression(ctx, fctx, expr);
  }

  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32" };
  }

  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  if (expr.kind === ts.SyntaxKind.NullKeyword || expr.kind === ts.SyntaxKind.UndefinedKeyword) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (ts.isIdentifier(expr) && expr.text === "undefined") {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    const selfIdx = fctx.localMap.get("this");
    if (selfIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: selfIdx });
      if (selfIdx < fctx.params.length) {
        return fctx.params[selfIdx]!.type;
      }
      const localDef = fctx.locals[selfIdx - fctx.params.length];
      return localDef?.type ?? { kind: "externref" };
    }
    return null;
  }

  if (ts.isIdentifier(expr)) {
    return compileIdentifier(ctx, fctx, expr);
  }

  if (ts.isBinaryExpression(expr)) {
    return compileBinaryExpression(ctx, fctx, expr);
  }

  if (ts.isTypeOfExpression(expr)) {
    return compileTypeofExpression(ctx, fctx, expr);
  }

  if (ts.isPrefixUnaryExpression(expr)) {
    return compilePrefixUnary(ctx, fctx, expr);
  }

  if (ts.isPostfixUnaryExpression(expr)) {
    return compilePostfixUnary(ctx, fctx, expr);
  }

  if (ts.isParenthesizedExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression);
  }

  if (ts.isCallExpression(expr)) {
    return compileCallExpression(ctx, fctx, expr);
  }

  if (ts.isNewExpression(expr)) {
    return compileNewExpression(ctx, fctx, expr);
  }

  if (ts.isConditionalExpression(expr)) {
    return compileConditionalExpression(ctx, fctx, expr);
  }

  if (ts.isPropertyAccessExpression(expr)) {
    return compilePropertyAccess(ctx, fctx, expr);
  }

  if (ts.isElementAccessExpression(expr)) {
    return compileElementAccess(ctx, fctx, expr);
  }

  if (ts.isObjectLiteralExpression(expr)) {
    return compileObjectLiteral(ctx, fctx, expr);
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return compileArrayLiteral(ctx, fctx, expr);
  }

  if (ts.isAsExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression);
  }

  if (ts.isNonNullExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression);
  }

  // await expr — compile as pass-through (host functions are sync from Wasm's perspective)
  if (ts.isAwaitExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression);
  }

  // yield expr — inside a generator function, push value to the generator buffer
  if (ts.isYieldExpression(expr)) {
    return compileYieldExpression(ctx, fctx, expr);
  }

  // void expr — evaluate operand for side effects, then produce undefined
  if (ts.isVoidExpression(expr)) {
    const operandType = compileExpressionInner(ctx, fctx, expr.expression);
    if (operandType !== null && operandType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return compileArrowFunction(ctx, fctx, expr);
  }

  // RegExp literal (/pattern/flags) → desugar to new RegExp(pattern, flags)
  if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return compileRegExpLiteral(ctx, fctx, expr);
  }


  // Tagged template expression: tag`hello ${x} world`
  if (ts.isTaggedTemplateExpression(expr)) {
    return compileTaggedTemplateExpression(ctx, fctx, expr);
  }
  ctx.errors.push({
    message: `Unsupported expression: ${ts.SyntaxKind[expr.kind]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── RegExp literal ────────────────────────────────────────────────────

/**
 * Compile a RegExp literal (e.g. /\d+/g) by desugaring it to new RegExp(pattern, flags).
 * The pattern and flags strings are loaded from the string pool, then RegExp_new is called.
 */
function compileRegExpLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): ValType | null {
  const { pattern, flags } = parseRegExpLiteral(expr.getText());

  // Load pattern string
  const patternResult = compileStringLiteral(ctx, fctx, pattern, expr);
  if (!patternResult) return null;

  // Load flags string (or ref.null.extern if no flags)
  if (flags) {
    const flagsResult = compileStringLiteral(ctx, fctx, flags, expr);
    if (!flagsResult) return null;
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Call RegExp_new(pattern, flags) → externref
  const funcIdx = ctx.funcMap.get("RegExp_new");
  if (funcIdx === undefined) {
    ctx.errors.push({
      message: "Missing RegExp_new import for regex literal",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }
  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

// ── Arrow function callbacks ──────────────────────────────────────────

/** Collect all identifiers referenced in a node */
export function collectReferencedIdentifiers(node: ts.Node, names: Set<string>): void {
  if (ts.isIdentifier(node)) {
    names.add(node.text);
  }
  ts.forEachChild(node, (child) => collectReferencedIdentifiers(child, names));
}

/**
 * Collect identifiers that are WRITTEN to within a node tree.
 * Detects: assignment (=, +=, etc.), ++, --.
 */
export function collectWrittenIdentifiers(node: ts.Node, names: Set<string>): void {
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    // Assignment operators
    if (
      op === ts.SyntaxKind.EqualsToken ||
      op === ts.SyntaxKind.PlusEqualsToken ||
      op === ts.SyntaxKind.MinusEqualsToken ||
      op === ts.SyntaxKind.AsteriskEqualsToken ||
      op === ts.SyntaxKind.SlashEqualsToken ||
      op === ts.SyntaxKind.PercentEqualsToken ||
      op === ts.SyntaxKind.AmpersandEqualsToken ||
      op === ts.SyntaxKind.BarEqualsToken ||
      op === ts.SyntaxKind.CaretEqualsToken ||
      op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      op === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      if (ts.isIdentifier(node.left)) {
        names.add(node.left.text);
      }
    }
  } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const op = node.operator;
    if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
      if (ts.isIdentifier(node.operand)) {
        names.add(node.operand.text);
      }
    }
  }
  ts.forEachChild(node, (child) => collectWrittenIdentifiers(child, names));
}

/** Check if an arrow/function expression is used as a callback argument to a call */
function isCallbackArgument(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent)) {
    return parent.arguments.some((arg) => arg === node);
  }
  return false;
}

function compileArrowFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  // If used as callback argument to a host call, use the __make_callback path
  if (isCallbackArgument(arrow)) {
    return compileArrowAsCallback(ctx, fctx, arrow);
  }
  // Otherwise, compile as a first-class closure value
  return compileArrowAsClosure(ctx, fctx, arrow);
}

/** Compile an arrow function as a first-class closure value (Wasm GC struct + funcref) */
function compileArrowAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  const closureId = ctx.closureCounter++;
  const closureName = `__closure_${closureId}`;
  const body = arrow.body;

  // 1. Determine arrow parameter types and return type
  const arrowParams: ValType[] = [];
  for (const p of arrow.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    arrowParams.push(resolveWasmType(ctx, paramType));
  }

  const sig = ctx.checker.getSignatureFromDeclaration(arrow);
  let closureReturnType: ValType | null = null;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      closureReturnType = resolveWasmType(ctx, retType);
    }
  }

  // 2. Analyze captured variables
  const referencedNames = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames);
  }

  // Detect which captured variables are written inside the closure body
  const writtenInClosure = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectWrittenIdentifiers(stmt, writtenInClosure);
    }
  } else {
    collectWrittenIdentifiers(body, writtenInClosure);
  }

  const captures: { name: string; type: ValType; localIdx: number; mutable: boolean }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    // Skip if the name is the arrow's own parameter
    const isOwnParam = arrow.parameters.some(
      (p) => ts.isIdentifier(p.name) && p.name.text === name,
    );
    if (isOwnParam) continue;
    // Skip if the name is a named function expression's own name (self-reference)
    if (ts.isFunctionExpression(arrow) && arrow.name && arrow.name.text === name) continue;
    const type = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" };
    // A capture is mutable if the closure writes to it
    const isMutable = writtenInClosure.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable });
  }

  // 3. Create struct type: field 0 = funcref, fields 1..N = captured vars
  //    For mutable captures, the field type is a ref cell (struct { value: T })
  const closureResults: ValType[] = closureReturnType ? [closureReturnType] : [];

  const structFields = [
    { name: "func", type: { kind: "funcref" as const }, mutable: false },
    ...captures.map((c) => {
      if (c.mutable) {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
        return {
          name: c.name,
          type: { kind: "ref_null" as const, typeIdx: refCellTypeIdx },
          mutable: false,
        };
      }
      return {
        name: c.name,
        type: c.type,
        mutable: false,
      };
    }),
  ];

  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
  });

  // 4. Create the lifted function type: (ref $closure_struct, ...arrowParams) → results
  const liftedParams: ValType[] = [
    { kind: "ref", typeIdx: structTypeIdx },
    ...arrowParams,
  ];
  let liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);

  // 5. Build the lifted function body
  const liftedFctx: FunctionContext = {
    name: closureName,
    params: [
      { name: "__self", type: { kind: "ref", typeIdx: structTypeIdx } },
      ...arrow.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: arrowParams[i] ?? { kind: "f64" as const },
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType: closureReturnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
  };

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // Initialize locals for captured variables from struct fields
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      // Mutable capture: store the ref cell reference itself
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      const refCellType: ValType = { kind: "ref_null", typeIdx: refCellTypeIdx };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      liftedFctx.body.push({ op: "local.get", index: 0 }); // __self
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      // Register as boxed so identifier read/write uses struct.get/set
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
    } else {
      const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
      liftedFctx.body.push({ op: "local.get", index: 0 }); // __self
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // For named function expressions, register the name in the lifted
  // function's local scope so recursive calls resolve to __self (the
  // closure struct).  Also register in closureMap so the call-site
  // compiler emits call_ref instead of a direct call.
  let funcExprName: string | undefined;
  if (ts.isFunctionExpression(arrow) && arrow.name) {
    funcExprName = arrow.name.text;
    // Map the name to the __self param (index 0) inside the lifted body
    liftedFctx.localMap.set(funcExprName, 0);
  }

  const savedFunc = ctx.currentFunc;
  ctx.currentFunc = liftedFctx;

  // Temporarily register closure info for named function expressions so
  // recursive calls inside the body are compiled as closure calls.
  const closureInfoForSelf: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
  };
  if (funcExprName) {
    ctx.closureMap.set(funcExprName, closureInfoForSelf);
  }

  let conciseBodyHasValue = false;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    const exprType = compileExpression(ctx, liftedFctx, body);
    if (exprType !== null && closureReturnType) {
      // Expression result is the return value - already on stack
      conciseBodyHasValue = true;

      // The actual expression type may differ from the declared return type
      // (e.g. TS infers `any`→externref but codegen produces f64 for arithmetic).
      // Coerce the expression result to match the declared return type.
      if (exprType.kind !== closureReturnType.kind) {
        if (closureReturnType.kind === "externref" && (exprType.kind === "ref" || exprType.kind === "ref_null")) {
          // Upcast struct ref to externref via extern.convert_any
          liftedFctx.body.push({ op: "extern.convert_any" });
        } else if (closureReturnType.kind === "externref" && exprType.kind === "f64") {
          // f64 cannot be converted to externref; fix the return type instead
          closureReturnType = exprType;
          liftedFctx.returnType = exprType;
          closureResults[0] = exprType;
          liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
          closureInfoForSelf.returnType = exprType;
          closureInfoForSelf.funcTypeIdx = liftedFuncTypeIdx;
        }
      }
    } else if (exprType !== null) {
      liftedFctx.body.push({ op: "drop" });
    }
  }

  // Clean up the temporary closure map entry for named function expressions
  if (funcExprName) {
    ctx.closureMap.delete(funcExprName);
  }

  // Ensure return value for non-void functions (skip if concise body already left a value)
  if (closureReturnType && !conciseBodyHasValue) {
    const lastInstr = liftedFctx.body[liftedFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (closureReturnType.kind === "f64") {
        liftedFctx.body.push({ op: "f64.const", value: 0 });
      } else if (closureReturnType.kind === "i32") {
        liftedFctx.body.push({ op: "i32.const", value: 0 });
      } else if (closureReturnType.kind === "externref") {
        liftedFctx.body.push({ op: "ref.null.extern" });
      }
    }
  }

  ctx.currentFunc = savedFunc;

  // 6. Register the lifted function
  const liftedFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: closureName,
    typeIdx: liftedFuncTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(closureName, liftedFuncIdx);

  // 7. At the creation site, emit struct.new with funcref + captured values
  fctx.body.push({ op: "ref.func", funcIdx: liftedFuncIdx });
  for (const cap of captures) {
    if (cap.mutable) {
      // Check if the outer scope already has this variable boxed (nested closure case)
      if (fctx.boxedCaptures?.has(cap.name)) {
        // Already a ref cell — pass the ref cell reference directly
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        // Wrap the current value in a ref cell
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        // Also box the outer local so subsequent reads/writes go through the ref cell
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, { kind: "ref_null", typeIdx: refCellTypeIdx });
        // Duplicate: we need the ref cell for the closure struct AND for the outer local
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        // Re-register the original name to point to the boxed local
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // 8. Register closure info so call sites can emit call_ref
  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
  };

  // Always register by struct type index (for valueOf coercion and anonymous closures)
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);

  const parent = arrow.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    ctx.closureMap.set(parent.name.text, closureInfo);
  }

  return { kind: "ref", typeIdx: structTypeIdx };
}

/** Compile an arrow function as a host callback via __make_callback.
 *  Captures are bundled into a per-instance GC struct (not shared globals). */
function compileArrowAsCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  const cbId = ctx.callbackCounter++;
  const cbName = `__cb_${cbId}`;
  const body = arrow.body;

  // 1. Analyze captured variables
  const referencedNames = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames);
  }

  const captures: { name: string; type: ValType; localIdx: number }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const type = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" };
    captures.push({ name, type, localIdx });
  }

  // 2. Create capture struct type (if captures exist)
  let capStructTypeIdx = -1;
  if (captures.length > 0) {
    capStructTypeIdx = ctx.mod.types.length;
    const fields: FieldDef[] = captures.map((cap) => ({
      name: cap.name,
      type: cap.type,
      mutable: false, // captures are immutable snapshots
    }));
    ctx.mod.types.push({
      kind: "struct",
      name: `__cb_cap_${cbId}`,
      fields,
    } as StructTypeDef);
  }

  // 3. Build the __cb_N function — first param is externref captures
  const cbParams: ValType[] = [{ kind: "externref" }]; // captures param
  for (const p of arrow.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    cbParams.push(resolveWasmType(ctx, paramType));
  }

  const sig = ctx.checker.getSignatureFromDeclaration(arrow);
  let cbReturnType: ValType | null = null;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      cbReturnType = resolveWasmType(ctx, retType);
    }
  }

  const cbResults: ValType[] = cbReturnType ? [cbReturnType] : [];
  const cbTypeIdx = addFuncType(ctx, cbParams, cbResults, `${cbName}_type`);

  const cbFctx: FunctionContext = {
    name: cbName,
    params: [
      { name: "__captures", type: { kind: "externref" } },
      ...arrow.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: cbParams[i + 1] ?? { kind: "f64" as const },
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType: cbReturnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
  };

  // Register params as locals (param 0 = __captures, then arrow params)
  for (let i = 0; i < cbFctx.params.length; i++) {
    cbFctx.localMap.set(cbFctx.params[i]!.name, i);
  }

  // 4. Extract captures from struct into locals at start of __cb_N body
  if (captures.length > 0) {
    // Convert externref captures → anyref → ref $__cb_cap_N
    const capLocal = allocLocal(cbFctx, `__cap_ref`, { kind: "ref", typeIdx: capStructTypeIdx });
    cbFctx.body.push({ op: "local.get", index: 0 }); // __captures externref
    cbFctx.body.push({ op: "any.convert_extern" });
    cbFctx.body.push({ op: "ref.cast", typeIdx: capStructTypeIdx });
    cbFctx.body.push({ op: "local.set", index: capLocal });

    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i]!;
      const localIdx = allocLocal(cbFctx, cap.name, cap.type);
      cbFctx.body.push({ op: "local.get", index: capLocal });
      cbFctx.body.push({ op: "struct.get", typeIdx: capStructTypeIdx, fieldIdx: i });
      cbFctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // 5. Compile the callback body
  const savedFunc = ctx.currentFunc;
  ctx.currentFunc = cbFctx;

  let exprBodyHasReturnValue = false;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, cbFctx, stmt);
    }
  } else {
    const exprType = compileExpression(ctx, cbFctx, body);
    if (exprType !== null && cbReturnType) {
      // Expression result is the return value — already on stack
      exprBodyHasReturnValue = true;
    } else if (exprType !== null) {
      cbFctx.body.push({ op: "drop" });
    }
  }

  if (cbReturnType && !exprBodyHasReturnValue) {
    const lastInstr = cbFctx.body[cbFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (cbReturnType.kind === "f64") {
        cbFctx.body.push({ op: "f64.const", value: 0 });
      } else if (cbReturnType.kind === "i32") {
        cbFctx.body.push({ op: "i32.const", value: 0 });
      } else if (cbReturnType.kind === "externref") {
        cbFctx.body.push({ op: "ref.null.extern" });
      }
    }
  }

  ctx.currentFunc = savedFunc;

  // 6. Register and export the callback function
  const cbFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: cbName,
    typeIdx: cbTypeIdx,
    locals: cbFctx.locals,
    body: cbFctx.body,
    exported: true,
  });
  ctx.funcMap.set(cbName, cbFuncIdx);
  ctx.mod.exports.push({
    name: cbName,
    desc: { kind: "func", index: cbFuncIdx },
  });

  // 7. At creation site: push cbId + captures externref, call __make_callback
  const makeCallbackIdx = ctx.funcMap.get("__make_callback");
  if (makeCallbackIdx === undefined) {
    ctx.errors.push({
      message: "Missing __make_callback import",
      line: getLine(arrow),
      column: getCol(arrow),
    });
    return null;
  }

  fctx.body.push({ op: "i32.const", value: cbId });

  if (captures.length > 0) {
    // Push captured locals and create struct
    for (const cap of captures) {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
    fctx.body.push({ op: "struct.new", typeIdx: capStructTypeIdx });
    fctx.body.push({ op: "extern.convert_any" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: makeCallbackIdx });
  return { kind: "externref" };
}

function compileIdentifier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
): ValType | null {
  const name = id.text;
  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    // Check if this is a boxed (ref cell) mutable capture
    const boxed = fctx.boxedCaptures?.get(name);
    if (boxed) {
      // Read through ref cell: local.get → struct.get $ref_cell 0
      fctx.body.push({ op: "local.get", index: localIdx });
      fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
      return boxed.valType;
    }

    fctx.body.push({ op: "local.get", index: localIdx });
    // Determine declared type from params or locals
    let declaredType: ValType;
    if (localIdx < fctx.params.length) {
      declaredType = fctx.params[localIdx]!.type;
    } else {
      const localDef = fctx.locals[localIdx - fctx.params.length];
      declaredType = localDef?.type ?? { kind: "f64" };
    }

    // Narrowing: if the declared type is externref (boxed union) but the
    // checker narrows it to a concrete type, emit an unbox call.
    if (declaredType.kind === "externref") {
      const narrowedType = ctx.checker.getTypeAtLocation(id);
      const narrowed = narrowTypeToUnbox(ctx, fctx, narrowedType);
      if (narrowed) return narrowed;
    }

    return declaredType;
  }

  // Check captured globals (variables promoted from enclosing scope for callbacks)
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: capturedIdx });
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
    const gType = globalDef?.type ?? { kind: "f64" };
    // Globals widened from ref to ref_null for null init — narrow back
    if (gType.kind === "ref_null" && ctx.capturedGlobalsWidened.has(name)) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: gType.typeIdx };
    }
    return gType;
  }

  // Check module-level globals (top-level let/const declarations)
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: moduleIdx });
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    return globalDef?.type ?? { kind: "f64" };
  }

  // Check declared globals (e.g. document, window)
  const globalInfo = ctx.declaredGlobals.get(name);
  if (globalInfo) {
    fctx.body.push({ op: "call", funcIdx: globalInfo.funcIdx });
    return globalInfo.type;
  }

  // Built-in numeric constants: NaN, Infinity
  if (name === "NaN") {
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }
  if (name === "Infinity") {
    fctx.body.push({ op: "f64.const", value: Infinity });
    return { kind: "f64" };
  }

  ctx.errors.push({
    message: `Unknown identifier: ${name}`,
    line: getLine(id),
    column: getCol(id),
  });
  return null;
}

/**
 * If the narrowed TS type indicates a concrete primitive, emit an unbox call
 * and return the unboxed ValType. The externref value must already be on stack.
 * Returns null if no unboxing is needed (type is still a union or externref).
 */
function narrowTypeToUnbox(
  ctx: CodegenContext,
  fctx: FunctionContext,
  narrowedType: ts.Type,
): ValType | null {
  // Don't unbox if the narrowed type is still a heterogeneous union
  if (isHeterogeneousUnion(narrowedType, ctx.checker)) return null;
  // Don't unbox if still a union with null/undefined (stays externref)
  if (narrowedType.isUnion()) return null;

  if (isNumberType(narrowedType)) {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }
  if (isBooleanType(narrowedType)) {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_boolean");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
  }
  // String stays as externref — no unboxing needed
  if (isStringType(narrowedType)) return null;

  return null;
}

/**
 * Compile `expr instanceof ClassName`.
 * Reads the hidden __tag field (index 0) from the struct and compares
 * it against the class's compile-time tag value.
 */
function compileInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  // Right operand must be a class name identifier
  if (!ts.isIdentifier(expr.right)) {
    ctx.errors.push({
      message: "instanceof right operand must be a class name",
      line: getLine(expr.right),
      column: getCol(expr.right),
    });
    return null;
  }

  const className = expr.right.text;
  const tagValue = ctx.classTagMap.get(className);
  if (tagValue === undefined) {
    ctx.errors.push({
      message: `instanceof: unknown class "${className}"`,
      line: getLine(expr.right),
      column: getCol(expr.right),
    });
    return null;
  }

  // Compile left operand (the value to test) — must be a ref to a class struct
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) return null;

  // Resolve the struct type index from the left operand's type
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  let leftClassName = leftTsType.getSymbol()?.name;
  if (leftClassName && !ctx.structMap.has(leftClassName)) {
    leftClassName = ctx.classExprNameMap.get(leftClassName) ?? leftClassName;
  }
  const leftStructTypeIdx = leftClassName ? ctx.structMap.get(leftClassName) : undefined;
  if (leftStructTypeIdx === undefined) {
    ctx.errors.push({
      message: "instanceof: left operand must be a class instance",
      line: getLine(expr.left),
      column: getCol(expr.left),
    });
    return null;
  }

  // Read the __tag field (field index 0) from the struct
  fctx.body.push({ op: "struct.get", typeIdx: leftStructTypeIdx, fieldIdx: 0 });
  // Compare with the expected tag value
  fctx.body.push({ op: "i32.const", value: tagValue });
  fctx.body.push({ op: "i32.eq" });
  return { kind: "i32" };
}

/**
 * Compile `typeof x` as a standalone expression that returns a type string (externref).
 * For statically known types, emits the string constant directly.
 * For externref/union types, calls the __typeof host helper.
 */
function compileTypeofExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TypeOfExpression,
): ValType | null {
  const operand = expr.expression;

  // typeof Math.<method> → "function" (static resolution)
  if (ts.isPropertyAccessExpression(operand) &&
      ts.isIdentifier(operand.expression) &&
      operand.expression.text === "Math") {
    return compileStringLiteral(ctx, fctx, "function");
  }

  const tsType = ctx.checker.getTypeAtLocation(operand);
  const wasmType = resolveWasmType(ctx, tsType);

  // For statically known types, emit the constant string directly.
  // The type-name strings are pre-registered by collectStringLiterals.
  if (wasmType.kind === "f64") {
    return compileStringLiteral(ctx, fctx, "number");
  }
  if (wasmType.kind === "i32") {
    // Determine if this is boolean or number (i32 is used for both)
    if (isBooleanType(tsType)) {
      return compileStringLiteral(ctx, fctx, "boolean");
    }
    // i32 used as number (e.g. void, but unlikely in typeof)
    return compileStringLiteral(ctx, fctx, "number");
  }
  if (wasmType.kind === "ref" || wasmType.kind === "ref_null") {
    // Fast mode: any-typed operand → runtime typeof via __any_typeof
    if (ctx.fast && isAnyValue(wasmType, ctx)) {
      ensureAnyHelpers(ctx);
      const typeofIdx = ctx.funcMap.get("__any_typeof");
      if (typeofIdx !== undefined) {
        const operandType = compileExpression(ctx, fctx, operand);
        if (operandType === null) return null;
        fctx.body.push({ op: "call", funcIdx: typeofIdx });
        return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      }
    }
    // Check if the TS type is callable (function/arrow/class) — typeof should return "function"
    const callSigs = tsType.getCallSignatures?.();
    if (callSigs && callSigs.length > 0) {
      return compileStringLiteral(ctx, fctx, "function");
    }
    return compileStringLiteral(ctx, fctx, "object");
  }

  // For externref: check if the TS type is statically known as string
  if (isStringType(tsType)) {
    return compileStringLiteral(ctx, fctx, "string");
  }

  // For union/unknown externref types, call the __typeof host helper at runtime
  addUnionImports(ctx);
  const funcIdx = ctx.funcMap.get("__typeof");
  if (funcIdx === undefined) return null;

  // Compile the operand to push its value onto the stack
  const operandType = compileExpression(ctx, fctx, operand);
  if (operandType === null) return null;

  // Coerce to externref if needed (e.g. f64 → boxed number)
  if (operandType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (operandType.kind === "i32") {
    const boxIdx = ctx.funcMap.get("__box_boolean");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  }

  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

/**
 * Compile `typeof x === "number"` / `typeof x !== "string"` etc.
 * Returns i32 result, or null if the expression is not a typeof comparison.
 */
function compileTypeofComparison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  const op = expr.operatorToken.kind;
  const isEq =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  // Detect typeof on left or right
  let typeofExpr: ts.TypeOfExpression | null = null;
  let stringLiteral: string | null = null;

  if (ts.isTypeOfExpression(expr.left) && ts.isStringLiteral(expr.right)) {
    typeofExpr = expr.left;
    stringLiteral = expr.right.text;
  } else if (ts.isTypeOfExpression(expr.right) && ts.isStringLiteral(expr.left)) {
    typeofExpr = expr.right;
    stringLiteral = expr.left.text;
  }

  if (!typeofExpr || !stringLiteral) return null;

  // Static resolution: if the typeof result is known at compile time,
  // emit a constant comparison result without any runtime call.
  const operand = typeofExpr.expression;
  const tsType = ctx.checker.getTypeAtLocation(operand);
  let staticTypeof: string | null = null;
  // Math.<method> → "function"
  if (ts.isPropertyAccessExpression(operand) &&
      ts.isIdentifier(operand.expression) &&
      operand.expression.text === "Math") {
    staticTypeof = "function";
  } else {
    const wasmType = resolveWasmType(ctx, tsType);
    if (wasmType.kind === "f64") staticTypeof = "number";
    else if (wasmType.kind === "i32") staticTypeof = isBooleanType(tsType) ? "boolean" : "number";
    else if ((wasmType.kind === "ref" || wasmType.kind === "ref_null") && !isAnyValue(wasmType, ctx)) {
      const callSigs = tsType.getCallSignatures?.();
      staticTypeof = (callSigs && callSigs.length > 0) ? "function" : "object";
    }
    else if (isStringType(tsType)) staticTypeof = "string";
  }
  if (staticTypeof !== null) {
    const matches = staticTypeof === stringLiteral;
    const result = isEq ? (matches ? 1 : 0) : (matches ? 0 : 1);
    fctx.body.push({ op: "i32.const", value: result });
    return { kind: "i32" };
  }

  // Fast mode: any-typed typeof comparison via tag check
  // Instead of calling __any_typeof + string comparison, we can directly check the tag
  // on the $AnyValue struct. This avoids pulling in the full native string helpers.
  if (ctx.fast && isAnyValue(resolveWasmType(ctx, tsType), ctx)) {
    ensureAnyHelpers(ctx);
    // Map the string literal to tag check(s)
    let tagChecks: number[] | null = null;
    if (stringLiteral === "number") tagChecks = [2, 3]; // i32 or f64
    else if (stringLiteral === "boolean") tagChecks = [4];
    else if (stringLiteral === "string") tagChecks = [5, 6]; // externref string or gcref string
    else if (stringLiteral === "undefined") tagChecks = [1];
    else if (stringLiteral === "object") tagChecks = [0]; // null → "object"

    if (tagChecks !== null) {
      // Compile the operand
      const operandType = compileExpression(ctx, fctx, operand);
      if (!operandType) return null;
      // Get the tag field
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 0 });
      // Check if tag matches any of the expected values
      if (tagChecks.length === 1) {
        fctx.body.push({ op: "i32.const", value: tagChecks[0]! });
        fctx.body.push({ op: "i32.eq" });
      } else {
        // Multiple tags: (tag == t1) || (tag == t2)
        const tagLocal = allocLocal(fctx, `__typeof_tag_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.set", index: tagLocal });
        fctx.body.push({ op: "local.get", index: tagLocal });
        fctx.body.push({ op: "i32.const", value: tagChecks[0]! });
        fctx.body.push({ op: "i32.eq" });
        for (let i = 1; i < tagChecks.length; i++) {
          fctx.body.push({ op: "local.get", index: tagLocal });
          fctx.body.push({ op: "i32.const", value: tagChecks[i]! });
          fctx.body.push({ op: "i32.eq" });
          fctx.body.push({ op: "i32.or" });
        }
      }
      if (isNeq) {
        fctx.body.push({ op: "i32.eqz" });
      }
      return { kind: "i32" };
    }
  }

  // Ensure union imports are registered
  addUnionImports(ctx);

  // Determine the helper function name
  let helperName: string | null = null;
  if (stringLiteral === "number") helperName = "__typeof_number";
  else if (stringLiteral === "string") helperName = "__typeof_string";
  else if (stringLiteral === "boolean") helperName = "__typeof_boolean";

  if (!helperName) return null;

  const funcIdx = ctx.funcMap.get(helperName);
  if (funcIdx === undefined) return null;

  // Compile the operand of typeof — need to get the raw externref value
  // The operand should be loaded without narrowing (use the declared type)
  if (ts.isIdentifier(operand)) {
    const localIdx = fctx.localMap.get(operand.text);
    if (localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
    } else {
      // Try other resolution paths
      const valType = compileExpression(ctx, fctx, operand);
      if (!valType) return null;
    }
  } else {
    const valType = compileExpression(ctx, fctx, operand);
    if (!valType) return null;
  }

  // Call the typeof helper
  fctx.body.push({ op: "call", funcIdx });

  // If !== comparison, negate the result
  if (isNeq) {
    fctx.body.push({ op: "i32.eqz" });
  }

  return { kind: "i32" };
}

function compileBinaryExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): InnerResult {
  const op = expr.operatorToken.kind;

  // Handle assignment
  if (op === ts.SyntaxKind.EqualsToken) {
    return compileAssignment(ctx, fctx, expr);
  }

  // Handle logical assignment operators (??=, ||=, &&=)
  if (
    op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  ) {
    return compileLogicalAssignment(ctx, fctx, expr, op);
  }

  // Handle compound assignments
  if (isCompoundAssignment(op)) {
    return compileCompoundAssignment(ctx, fctx, expr, op);
  }

  // Handle logical && and ||
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
    return compileLogicalAnd(ctx, fctx, expr);
  }
  if (op === ts.SyntaxKind.BarBarToken) {
    return compileLogicalOr(ctx, fctx, expr);
  }

  // Nullish coalescing: a ?? b
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    return compileNullishCoalescing(ctx, fctx, expr);
  }

  // Comma operator: (a, b) — evaluate a, drop its value, evaluate b
  if (op === ts.SyntaxKind.CommaToken) {
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    return compileExpression(ctx, fctx, expr.right);
  }
    
  // instanceof: compile left value, resolve right to struct type, emit ref.test
  if (op === ts.SyntaxKind.InstanceOfKeyword) {
    return compileInstanceOf(ctx, fctx, expr);
  }

  // typeof x === "type" / typeof x !== "type"
  if (
    (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken)
  ) {
    const typeofResult = compileTypeofComparison(ctx, fctx, expr);
    if (typeofResult !== null) return typeofResult;
  }

  // Null comparison shortcut: x === null, x !== null, null === x, null !== x
  // Must be detected before compiling both sides to avoid pushing unnecessary null
  const isEqOp = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeqOp = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (isEqOp || isNeqOp) {
    const rightIsNull = expr.right.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(expr.right) && expr.right.text === "undefined");
    const leftIsNull = expr.left.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(expr.left) && expr.left.text === "undefined");
    if (rightIsNull || leftIsNull) {
      // Compile only the non-null side
      const nonNullExpr = rightIsNull ? expr.left : expr.right;
      const valType = compileExpression(ctx, fctx, nonNullExpr);
      if (valType && valType.kind === "externref") {
        fctx.body.push({ op: "ref.is_null" });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
      // For non-externref types compared with null, always not-equal
      if (valType) fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isNeqOp ? 1 : 0 });
      return { kind: "i32" };
    }
  }

  // `key in obj` — compile-time property existence check
  if (op === ts.SyntaxKind.InKeyword) {
    // Resolve whether the left (key) is a string literal we can check statically
    const rightType = ctx.checker.getTypeAtLocation(expr.right);
    const rightWasm = resolveWasmType(ctx, rightType);
    if ((rightWasm.kind === "ref" || rightWasm.kind === "ref_null") && ts.isStringLiteral(expr.left)) {
      const key = expr.left.text;
      const structDef = ctx.mod.types[(rightWasm as { typeIdx: number }).typeIdx];
      if (structDef?.kind === "struct") {
        const has = structDef.fields.some(f => f.name === key);
        fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
        return { kind: "i32" };
      }
    }
    // Dynamic key or unknown type — emit false as safe fallback
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Regular binary ops: evaluate both sides
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  const rightTsType = ctx.checker.getTypeAtLocation(expr.right);

  // ── Loose equality (== / !=) with mixed types ──
  // JS loose equality coerces types before comparing. Handle common cases:
  //   number == boolean / boolean == number → coerce boolean to number
  //   string == number / number == string → coerce string to number (parseFloat)
  //   string == boolean / boolean == string → coerce both to number
  const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
  if (isLooseEq || isLooseNeq) {
    const leftIsNum = isNumberType(leftTsType);
    const leftIsBool = isBooleanType(leftTsType);
    const leftIsStr = isStringType(leftTsType);
    const rightIsNum = isNumberType(rightTsType);
    const rightIsBool = isBooleanType(rightTsType);
    const rightIsStr = isStringType(rightTsType);

    // number == boolean: coerce boolean (i32) → f64, then f64.eq
    if (leftIsNum && rightIsBool) {
      compileExpression(ctx, fctx, expr.left, { kind: "f64" });
      compileExpression(ctx, fctx, expr.right);
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
      return { kind: "i32" };
    }
    // boolean == number: coerce boolean (i32) → f64, then f64.eq
    if (leftIsBool && rightIsNum) {
      compileExpression(ctx, fctx, expr.left);
      fctx.body.push({ op: "f64.convert_i32_s" });
      compileExpression(ctx, fctx, expr.right, { kind: "f64" });
      fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
      return { kind: "i32" };
    }
    // string == number / number == string: coerce string to number via parseFloat
    if ((leftIsStr && rightIsNum) || (leftIsNum && rightIsStr)) {
      const pfIdx = ctx.funcMap.get("parseFloat");
      if (pfIdx !== undefined) {
        if (leftIsStr) {
          // left is string, right is number
          compileExpression(ctx, fctx, expr.left);
          fctx.body.push({ op: "call", funcIdx: pfIdx });
          compileExpression(ctx, fctx, expr.right, { kind: "f64" });
        } else {
          // left is number, right is string
          compileExpression(ctx, fctx, expr.left, { kind: "f64" });
          compileExpression(ctx, fctx, expr.right);
          fctx.body.push({ op: "call", funcIdx: pfIdx });
        }
        fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
        return { kind: "i32" };
      }
    }
    // string == boolean / boolean == string: coerce both to number
    if ((leftIsStr && rightIsBool) || (leftIsBool && rightIsStr)) {
      const pfIdx = ctx.funcMap.get("parseFloat");
      if (pfIdx !== undefined) {
        if (leftIsStr) {
          compileExpression(ctx, fctx, expr.left);
          fctx.body.push({ op: "call", funcIdx: pfIdx });
          compileExpression(ctx, fctx, expr.right);
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else {
          compileExpression(ctx, fctx, expr.left);
          fctx.body.push({ op: "f64.convert_i32_s" });
          compileExpression(ctx, fctx, expr.right);
          fctx.body.push({ op: "call", funcIdx: pfIdx });
        }
        fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
        return { kind: "i32" };
      }
    }
  }

  // ── Fast mode: any-typed operand dispatch ──
  // When both operands are `any`, compile without numeric hint and call __any_* helpers
  if (ctx.fast && ctx.anyValueTypeIdx >= 0) {
    const leftIsAny = (leftTsType.flags & ts.TypeFlags.Any) !== 0;
    const rightIsAny = (rightTsType.flags & ts.TypeFlags.Any) !== 0;
    if (leftIsAny && rightIsAny) {
      const anyDispatch = compileAnyBinaryDispatch(ctx, fctx, expr, op);
      if (anyDispatch !== null) return anyDispatch;
    }
  }

  // String operations — either operand being a string triggers string concat for +
  if (isStringType(leftTsType) || (op === ts.SyntaxKind.PlusToken && isStringType(rightTsType))) {
    return compileStringBinaryOp(ctx, fctx, expr, op);
  }

  // BigInt operations — both operands must be bigint (mixed bigint/number is a TS error)
  if (isBigIntType(leftTsType) || isBigIntType(rightTsType)) {
    const i64Hint: ValType = { kind: "i64" };
    const leftType = compileExpression(ctx, fctx, expr.left, i64Hint);
    const rightType = compileExpression(ctx, fctx, expr.right, i64Hint);
    if (!leftType || !rightType) return null;
    return compileI64BinaryOp(ctx, fctx, op, expr);
  }

  // Determine expected operand type from operator and context
  const isNumericOp =
    op === ts.SyntaxKind.PlusToken ||
    op === ts.SyntaxKind.MinusToken ||
    op === ts.SyntaxKind.AsteriskToken ||
    op === ts.SyntaxKind.AsteriskAsteriskToken ||
    op === ts.SyntaxKind.SlashToken ||
    op === ts.SyntaxKind.PercentToken ||
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken ||
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
  // In fast mode, numeric hint is i32 (unless division/power which promotes to f64)
  const isDivOrPow = op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.AsteriskAsteriskToken;
  const numericHint: ValType | undefined = isNumericOp
    ? { kind: (ctx.fast && !isDivOrPow) ? "i32" : "f64" }
    : undefined;

  let leftType = compileExpression(ctx, fctx, expr.left, numericHint);
  let rightType = compileExpression(ctx, fctx, expr.right, numericHint);

  if (!leftType || !rightType) return null;

  // Promote i32↔f64 mismatch (e.g. string.length:i32 !== 8:f64)
  if (leftType.kind === "i32" && rightType.kind === "f64") {
    const tmpR = allocLocal(fctx, `__promote_r_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: tmpR });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.get", index: tmpR });
    leftType = { kind: "f64" };
  } else if (leftType.kind === "f64" && rightType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    rightType = { kind: "f64" };
  }

  // Fast mode: i32 numeric operations
  if (ctx.fast && isNumberType(leftTsType) && leftType.kind === "i32" && rightType.kind === "i32") {
    return compileI32BinaryOp(ctx, fctx, op, expr);
  }

  // i64 operations (bigint detected by compiled type, e.g. from variables)
  if (leftType.kind === "i64" && rightType.kind === "i64") {
    return compileI64BinaryOp(ctx, fctx, op, expr);
  }

  if (isNumberType(leftTsType) || leftType.kind === "f64") {
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
  if (isBooleanType(leftTsType) || leftType.kind === "i32") {
    return compileBooleanBinaryOp(ctx, fctx, op);
  }

  // Externref in numeric context: unbox externref operands to f64
  if ((leftType.kind === "externref" || rightType.kind === "externref") && isNumericOp) {
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number")!;
    if (rightType.kind === "externref") {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    }
    if (leftType.kind === "externref") {
      const tmpR = allocLocal(fctx, `__unbox_r_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      fctx.body.push({ op: "local.get", index: tmpR });
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  // Externref equality: unbox to f64 and compare numerically
  if ((leftType.kind === "externref" || rightType.kind === "externref") && (isEqOp || isNeqOp)) {
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number")!;
    // Unbox right side (top of stack)
    if (rightType.kind === "externref") {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    }
    // Unbox left side (below right on stack)
    if (leftType.kind === "externref") {
      const tmpR = allocLocal(fctx, `__unbox_r_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      fctx.body.push({ op: "local.get", index: tmpR });
    }
    fctx.body.push({ op: isEqOp ? "f64.eq" : "f64.ne" });
    return { kind: "i32" };
  }

  ctx.errors.push({
    message: `Unsupported binary operator for type`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

/**
 * Compile a binary expression where both operands are `any`-typed.
 * Emits both operands as ref $AnyValue and calls the appropriate __any_* helper.
 */
function compileAnyBinaryDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): InnerResult {
  // Map operator to helper name and result type
  let helperName: string | null = null;
  let resultIsI32 = false; // true for comparison/equality operators

  switch (op) {
    case ts.SyntaxKind.PlusToken: helperName = "__any_add"; break;
    case ts.SyntaxKind.MinusToken: helperName = "__any_sub"; break;
    case ts.SyntaxKind.AsteriskToken: helperName = "__any_mul"; break;
    case ts.SyntaxKind.SlashToken: helperName = "__any_div"; break;
    case ts.SyntaxKind.PercentToken: helperName = "__any_mod"; break;
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      helperName = "__any_eq"; resultIsI32 = true; break;
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      helperName = "__any_eq"; resultIsI32 = true; break;
    case ts.SyntaxKind.LessThanToken: helperName = "__any_lt"; resultIsI32 = true; break;
    case ts.SyntaxKind.GreaterThanToken: helperName = "__any_gt"; resultIsI32 = true; break;
    case ts.SyntaxKind.LessThanEqualsToken: helperName = "__any_le"; resultIsI32 = true; break;
    case ts.SyntaxKind.GreaterThanEqualsToken: helperName = "__any_ge"; resultIsI32 = true; break;
    default: return null; // Not a supported operator for any dispatch
  }

  ensureAnyHelpers(ctx);
  const funcIdx = ctx.funcMap.get(helperName);
  if (funcIdx === undefined) return null;

  // Compile both operands without numeric hint so they produce ref $AnyValue
  const leftType = compileExpression(ctx, fctx, expr.left);
  const rightType = compileExpression(ctx, fctx, expr.right);
  if (!leftType || !rightType) return null;

  fctx.body.push({ op: "call", funcIdx });

  // For != / !==, negate the __any_eq result
  if (op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    fctx.body.push({ op: "i32.eqz" });
  }

  if (resultIsI32) {
    return { kind: "i32" };
  }
  return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
}

function compileNumericBinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  expr: ts.BinaryExpression,
): ValType {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "f64.add" });
      return { kind: "f64" };
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "f64.sub" });
      return { kind: "f64" };
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "f64.mul" });
      return { kind: "f64" };
    case ts.SyntaxKind.AsteriskAsteriskToken: {
      const funcIdx = ctx.funcMap.get("Math_pow");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "f64" };
      }
      ctx.errors.push({
        message: "Math_pow import not found for ** operator",
        line: getLine(expr),
        column: getCol(expr),
      });
      return { kind: "f64" };
    }
    case ts.SyntaxKind.SlashToken:
      fctx.body.push({ op: "f64.div" });
      return { kind: "f64" };
    case ts.SyntaxKind.PercentToken:
      return compileModulo(ctx, fctx, expr);
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "f64.lt" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "f64.le" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "f64.gt" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "f64.ge" });
      return { kind: "i32" };
    case ts.SyntaxKind.AmpersandToken:
      return compileBitwiseBinaryOp(fctx, "i32.and", false);
    case ts.SyntaxKind.BarToken:
      return compileBitwiseBinaryOp(fctx, "i32.or", false);
    case ts.SyntaxKind.CaretToken:
      return compileBitwiseBinaryOp(fctx, "i32.xor", false);
    case ts.SyntaxKind.LessThanLessThanToken:
      return compileBitwiseBinaryOp(fctx, "i32.shl", false);
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return compileBitwiseBinaryOp(fctx, "i32.shr_s", false);
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return compileBitwiseBinaryOp(fctx, "i32.shr_u", true);
    default:
      ctx.errors.push({
        message: `Unsupported numeric binary operator: ${ts.SyntaxKind[op]}`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return { kind: "f64" };
  }
}

/** Fast mode: i32 arithmetic/comparison on two i32 operands */
function compileI32BinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  expr: ts.BinaryExpression,
): ValType {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "i32.add" });
      return { kind: "i32" };
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "i32.sub" });
      return { kind: "i32" };
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "i32.mul" });
      return { kind: "i32" };
    case ts.SyntaxKind.PercentToken:
      fctx.body.push({ op: "i32.rem_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "i32.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "i32.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "i32.lt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "i32.le_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "i32.gt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "i32.ge_s" });
      return { kind: "i32" };
    // Bitwise — direct i32 ops (no conversion needed!)
    case ts.SyntaxKind.AmpersandToken:
      fctx.body.push({ op: "i32.and" });
      return { kind: "i32" };
    case ts.SyntaxKind.BarToken:
      fctx.body.push({ op: "i32.or" });
      return { kind: "i32" };
    case ts.SyntaxKind.CaretToken:
      fctx.body.push({ op: "i32.xor" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanLessThanToken:
      fctx.body.push({ op: "i32.shl" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      fctx.body.push({ op: "i32.shr_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      fctx.body.push({ op: "i32.shr_u" });
      return { kind: "i32" };
    default:
      // Fall back to f64 path for division, power, etc.
      return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
}

/** BigInt: i64 arithmetic/comparison on two i64 operands */
function compileI64BinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  expr: ts.BinaryExpression,
): ValType {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "i64.add" });
      return { kind: "i64" };
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "i64.sub" });
      return { kind: "i64" };
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "i64.mul" });
      return { kind: "i64" };
    case ts.SyntaxKind.SlashToken:
      fctx.body.push({ op: "i64.div_s" });
      return { kind: "i64" };
    case ts.SyntaxKind.PercentToken:
      fctx.body.push({ op: "i64.rem_s" });
      return { kind: "i64" };
    case ts.SyntaxKind.AsteriskAsteriskToken: {
      // BigInt ** not supported in wasm — report error
      ctx.errors.push({
        message: "BigInt exponentiation (**) is not supported in Wasm",
        line: getLine(expr),
        column: getCol(expr),
      });
      return { kind: "i64" };
    }
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "i64.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "i64.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "i64.lt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "i64.le_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "i64.gt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "i64.ge_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.AmpersandToken:
      fctx.body.push({ op: "i64.and" });
      return { kind: "i64" };
    case ts.SyntaxKind.BarToken:
      fctx.body.push({ op: "i64.or" });
      return { kind: "i64" };
    case ts.SyntaxKind.CaretToken:
      fctx.body.push({ op: "i64.xor" });
      return { kind: "i64" };
    case ts.SyntaxKind.LessThanLessThanToken:
      fctx.body.push({ op: "i64.shl" });
      return { kind: "i64" };
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      fctx.body.push({ op: "i64.shr_s" });
      return { kind: "i64" };
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      fctx.body.push({ op: "i64.shr_u" });
      return { kind: "i64" };
    default:
      ctx.errors.push({
        message: `Unsupported BigInt binary operator: ${ts.SyntaxKind[op]}`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return { kind: "i64" };
  }
}

/**
 * Emit JS ToInt32: reduce f64 modulo 2^32 then truncate to i32.
 * Handles NaN→0, Infinity→0, and large values that wrap.
 * Stack: [f64] → [i32]
 */
function emitToInt32(fctx: FunctionContext): void {
  // JS ToInt32 algorithm:
  //   if NaN/Infinity/0 → 0
  //   n = sign(x) * floor(abs(x))
  //   int32bit = n mod 2^32
  //   if int32bit >= 2^31 → int32bit - 2^32
  //
  // In wasm: x - floor(x / 2^32) * 2^32, then trunc_sat
  // For values in i32 range, trunc_sat alone works. We only need the
  // modulo reduction for out-of-range values.
  // Step 1: truncate fractional part toward zero (JS ToInt32 does this first)
  // Step 2: x - floor(x / 2^32) * 2^32 → maps to [0, 2^32)
  // Step 3: trunc_sat_f64_u gives correct bit pattern
  // NaN/Infinity: trunc(NaN)=NaN, Inf-Inf=NaN, trunc_sat_u(NaN)=0. Correct.
  fctx.body.push({ op: "f64.trunc" });
  const tmp = allocLocal(fctx, `__toint32_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "f64.const", value: 4294967296 });
  fctx.body.push({ op: "f64.div" });
  fctx.body.push({ op: "f64.floor" });
  fctx.body.push({ op: "f64.const", value: 4294967296 });
  fctx.body.push({ op: "f64.mul" });
  fctx.body.push({ op: "f64.sub" });
  fctx.body.push({ op: "i32.trunc_sat_f64_u" });
}

/** Truncate two f64 operands to i32 via ToInt32, apply an i32 bitwise op, convert back to f64 */
function compileBitwiseBinaryOp(
  fctx: FunctionContext,
  i32op: "i32.and" | "i32.or" | "i32.xor" | "i32.shl" | "i32.shr_s" | "i32.shr_u",
  unsigned: boolean,
): ValType {
  // Stack: [left_f64, right_f64]
  const tmpR = allocLocal(fctx, `__bw_r_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: "local.get", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: i32op });
  fctx.body.push({ op: unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s" });
  return { kind: "f64" };
}

function compileModulo(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  emitModulo(fctx);
  return { kind: "f64" };
}

/** Emit JS remainder (a % b = a - trunc(a/b) * b) — stack: [a_f64, b_f64] -> [result_f64] */
function emitModulo(fctx: FunctionContext): void {
  const tmpB = allocLocal(fctx, `__mod_b_${fctx.locals.length}`, { kind: "f64" });
  const tmpA = allocLocal(fctx, `__mod_a_${fctx.locals.length}`, { kind: "f64" });

  fctx.body.push({ op: "local.set", index: tmpB });
  fctx.body.push({ op: "local.set", index: tmpA });

  fctx.body.push({ op: "local.get", index: tmpA });
  fctx.body.push({ op: "local.get", index: tmpA });
  fctx.body.push({ op: "local.get", index: tmpB });
  fctx.body.push({ op: "f64.div" });
  fctx.body.push({ op: "f64.trunc" }); // JS % uses truncation toward zero, not floor
  fctx.body.push({ op: "local.get", index: tmpB });
  fctx.body.push({ op: "f64.mul" });
  fctx.body.push({ op: "f64.sub" });
}

function compileBooleanBinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
): ValType {
  switch (op) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "i32.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "i32.ne" });
      return { kind: "i32" };
    default:
      return { kind: "i32" };
  }
}

function compileLogicalAnd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // JS semantics: a && b → if a is falsy, return a; else return b
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) { ensureI32Condition(fctx, leftType, ctx); return { kind: "i32" }; }

  // Save LHS value for JS value semantics, then check truthiness
  const tmp = allocLocal(fctx, `__and_left_${fctx.locals.length}`, leftType);
  fctx.body.push({ op: "local.tee", index: tmp });
  ensureI32Condition(fctx, leftType, ctx);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: leftType },
    then: (() => {
      const saved = fctx.body;
      fctx.body = [];
      compileExpression(ctx, fctx, expr.right, leftType);
      const result = fctx.body;
      fctx.body = saved;
      return result;
    })(),
    else: [{ op: "local.get", index: tmp } as Instr],
  });

  return leftType;
}

function compileLogicalOr(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // JS semantics: a || b → if a is truthy, return a; else return b
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) { ensureI32Condition(fctx, leftType, ctx); return { kind: "i32" }; }

  // Save LHS value for JS value semantics, then check truthiness
  const tmp = allocLocal(fctx, `__or_left_${fctx.locals.length}`, leftType);
  fctx.body.push({ op: "local.tee", index: tmp });
  ensureI32Condition(fctx, leftType, ctx);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: leftType },
    then: [{ op: "local.get", index: tmp } as Instr],
    else: (() => {
      const saved = fctx.body;
      fctx.body = [];
      compileExpression(ctx, fctx, expr.right, leftType);
      const result = fctx.body;
      fctx.body = saved;
      return result;
    })(),
  });

  return leftType;
}

/** Nullish coalescing: a ?? b → if a is null, return b, else return a */
function compileNullishCoalescing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // Compile LHS and store in temp
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) { ctx.errors.push({ message: "Failed to compile nullish coalescing LHS", line: getLine(expr), column: getCol(expr) }); return { kind: "externref" }; }
  const resultKind: ValType = leftType ?? { kind: "externref" };
  const tmp = allocLocal(fctx, `__nullish_${fctx.locals.length}`, resultKind);
  fctx.body.push({ op: "local.tee", index: tmp });

  // If the left side is a value type (i32/f64), it can never be null — short-circuit
  if (resultKind.kind === "i32" || resultKind.kind === "f64") {
    return resultKind;
  }

  // Check if null
  fctx.body.push({ op: "ref.is_null" });

  // if null → compile RHS; else → return tmp
  const savedBody = fctx.body;
  fctx.body = [];
  compileExpression(ctx, fctx, expr.right, resultKind);
  const thenInstrs = fctx.body;

  fctx.body = savedBody;
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultKind },
    then: thenInstrs,
    else: [{ op: "local.get", index: tmp } as Instr],
  });

  return resultKind;
}

function compileAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): InnerResult {
  if (ts.isIdentifier(expr.left)) {
    const name = expr.left.text;
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) {
      // Check if this is a boxed (ref cell) mutable capture
      const boxed = fctx.boxedCaptures?.get(name);
      if (boxed) {
        // Write through ref cell: local.get ref_cell → value → struct.set $ref_cell 0
        const resultType = compileExpression(ctx, fctx, expr.right, boxed.valType);
        if (!resultType) { ctx.errors.push({ message: "Failed to compile assignment value", line: getLine(expr), column: getCol(expr) }); return null; }
        const tmpVal = allocLocal(fctx, `__box_tmp_${fctx.locals.length}`, boxed.valType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: localIdx });
        fctx.body.push({ op: "local.get", index: tmpVal });
        fctx.body.push({ op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
        // Return the assigned value (expression result)
        fctx.body.push({ op: "local.get", index: tmpVal });
        return resultType;
      }
      const localType = localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : fctx.locals[localIdx - fctx.params.length]?.type;
      const resultType = compileExpression(ctx, fctx, expr.right, localType);
      if (!resultType) { ctx.errors.push({ message: "Failed to compile assignment value", line: getLine(expr), column: getCol(expr) }); return null; }
      fctx.body.push({ op: "local.tee", index: localIdx });
      return resultType;
    }
    // Check captured globals
    const capturedIdx = ctx.capturedGlobals.get(name);
    if (capturedIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
      const resultType = compileExpression(ctx, fctx, expr.right, globalDef?.type);
      if (!resultType) { ctx.errors.push({ message: "Failed to compile assignment value", line: getLine(expr), column: getCol(expr) }); return null; }
      fctx.body.push({ op: "global.set", index: capturedIdx });
      // global.set consumes the value; re-push it for expression result
      fctx.body.push({ op: "global.get", index: capturedIdx });
      return resultType;
    }
    // Check module-level globals
    const moduleIdx = ctx.moduleGlobals.get(name);
    if (moduleIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
      const resultType = compileExpression(ctx, fctx, expr.right, globalDef?.type);
      if (!resultType) { ctx.errors.push({ message: "Failed to compile assignment value", line: getLine(expr), column: getCol(expr) }); return null; }
      fctx.body.push({ op: "global.set", index: moduleIdx });
      fctx.body.push({ op: "global.get", index: moduleIdx });
      return resultType;
    }
  }

  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyAssignment(ctx, fctx, expr.left, expr.right);
  }

  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementAssignment(ctx, fctx, expr.left, expr.right);
  }

  if (ts.isObjectLiteralExpression(expr.left)) {
    return compileDestructuringAssignment(ctx, fctx, expr.left, expr.right);
  }

  ctx.errors.push({
    message: "Unsupported assignment target",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

function compileDestructuringAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ObjectLiteralExpression,
  value: ts.Expression,
): InnerResult {
  // Compile the RHS — should produce a struct ref
  const resultType = compileExpression(ctx, fctx, value);
  if (!resultType) return null;

  // Determine struct type from the RHS expression's type
  const rhsType = ctx.checker.getTypeAtLocation(value);
  const typeName =
    ctx.anonTypeMap.get(rhsType) ?? rhsType.symbol?.name;

  if (!typeName) {
    ctx.errors.push({
      message: "Cannot destructure: unknown type",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    ctx.errors.push({
      message: `Cannot destructure: not a known struct type: ${typeName}`,
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  // Save the struct ref in a temp local
  const tmpLocal = allocLocal(fctx, `__destruct_assign_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // For each property in the destructuring pattern, set the existing local
  for (const prop of target.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      // { width } = ... → prop.name is "width"
      const propName = prop.name.text;
      const localIdx = fctx.localMap.get(propName);
      if (localIdx === undefined) {
        ctx.errors.push({
          message: `Unknown variable in destructuring: ${propName}`,
          line: getLine(prop),
          column: getCol(prop),
        });
        continue;
      }

      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) {
        ctx.errors.push({
          message: `Unknown field in destructuring: ${propName}`,
          line: getLine(prop),
          column: getCol(prop),
        });
        continue;
      }

      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (ts.isPropertyAssignment(prop)) {
      // { width: w } = ... → prop.name is "width", prop.initializer is "w"
      const propName = (prop.name as ts.Identifier).text;
      const localName = ts.isIdentifier(prop.initializer) ? prop.initializer.text : propName;
      const localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) continue;

      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) continue;

      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  return VOID_RESULT; // destructuring assignment has no result value
}

function compilePropertyAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): InnerResult {
  const objType = ctx.checker.getTypeAtLocation(target.expression);

  // Handle static property assignment: ClassName.staticProp = value
  if (ts.isIdentifier(target.expression) && ctx.classSet.has(target.expression.text)) {
    const clsName = target.expression.text;
    const fullName = `${clsName}_${target.name.text}`;
    const globalIdx = ctx.staticProps.get(fullName);
    if (globalIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      compileExpression(ctx, fctx, value, globalDef?.type);
      fctx.body.push({ op: "global.set", index: globalIdx });
      return VOID_RESULT;
    }
  }

  // Handle externref property set
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    return compileExternPropertySet(ctx, fctx, target, value, objType);
  }

  // Handle shape-inferred array-like variables: obj.length = N
  if (ts.isIdentifier(target.expression)) {
    const shapeInfo = ctx.shapeMap.get(target.expression.text);
    if (shapeInfo) {
      const fieldName = target.name.text;
      const vecDef = ctx.mod.types[shapeInfo.vecTypeIdx];
      if (vecDef && vecDef.kind === "struct") {
        const fieldIdx = vecDef.fields.findIndex((f: { name: string }) => f.name === fieldName);
        if (fieldIdx >= 0) {
          const structObjResult = compileExpression(ctx, fctx, target.expression);
          if (!structObjResult) return null;
          compileExpression(ctx, fctx, value, vecDef.fields[fieldIdx]!.type);
          fctx.body.push({ op: "struct.set", typeIdx: shapeInfo.vecTypeIdx, fieldIdx });
          return VOID_RESULT;
        }
      }
    }
  }

  const typeName = resolveStructName(ctx, objType);
  if (!typeName) return null;

  // Check for setter accessor on user-defined classes
  const fieldName = ts.isPrivateIdentifier(target.name) ? target.name.text.slice(1) : target.name.text;
  const accessorKey = `${typeName}_${fieldName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const setterName = `${typeName}_set_${fieldName}`;
    const funcIdx = ctx.funcMap.get(setterName);
    if (funcIdx !== undefined) {
      const setterObjResult = compileExpression(ctx, fctx, target.expression);
      if (!setterObjResult) { ctx.errors.push({ message: "Failed to compile setter receiver", line: getLine(target), column: getCol(target) }); return null; }
      const setterValResult = compileExpression(ctx, fctx, value);
      if (!setterValResult) { ctx.errors.push({ message: "Failed to compile setter value", line: getLine(target), column: getCol(target) }); return null; }
      fctx.body.push({ op: "call", funcIdx });
      return VOID_RESULT;
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) return null;

  const fieldIdx = fields.findIndex((f) => f.name === fieldName);
  if (fieldIdx === -1) return null;

  const structObjResult = compileExpression(ctx, fctx, target.expression);
  if (!structObjResult) { ctx.errors.push({ message: "Failed to compile struct field receiver", line: getLine(target), column: getCol(target) }); return null; }
  compileExpression(ctx, fctx, value, fields[fieldIdx]!.type);
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  return VOID_RESULT;
}

function compileExternPropertySet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  objType: ts.Type,
): InnerResult {
  const className = objType.getSymbol()?.name;
  const propName = target.name.text;
  if (!className) return null;

  // Walk inheritance chain to find the class that declares the property
  const resolvedInfo = findExternInfoForMember(ctx, className, propName, "property");
  const propOwner = resolvedInfo ?? ctx.externClasses.get(className);
  if (!propOwner) {
    ctx.errors.push({
      message: `Unknown extern class: ${className}`,
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  // Push object, then value (with type hint from property type)
  const externObjResult = compileExpression(ctx, fctx, target.expression);
  if (!externObjResult) { ctx.errors.push({ message: "Failed to compile extern property receiver", line: getLine(target), column: getCol(target) }); return null; }
  const propInfo = propOwner.properties.get(propName);
  const externValResult = compileExpression(ctx, fctx, value, propInfo?.type);
  if (!externValResult) { ctx.errors.push({ message: "Failed to compile extern property value", line: getLine(target), column: getCol(target) }); return null; }

  const importName = `${propOwner.importPrefix}_set_${propName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    ctx.errors.push({
      message: `Missing import for property set: ${importName}`,
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  fctx.body.push({ op: "call", funcIdx });
  return VOID_RESULT;
}

function compileElementAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
): InnerResult {
  // Push array ref
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) {
    ctx.errors.push({ message: "Assignment to non-array", line: getLine(target), column: getCol(target) });
    return null;
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle vec struct (array wrapped in {length, data}) — only for actual __vec_* types
  const isVecStruct = typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      ctx.errors.push({ message: "Assignment: vec data is not array", line: 0, column: 0 });
      return null;
    }
    // Save vec ref and index in locals for reuse
    const vecLocal = allocLocal(fctx, `__vec_${fctx.locals.length}`, arrType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
    if (!idxResult) { ctx.errors.push({ message: "Failed to compile element index", line: getLine(target), column: getCol(target) }); return null; }
    fctx.body.push({ op: "i32.trunc_f64_s" });
    const idxLocal = allocLocal(fctx, `__idx_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: idxLocal });
    // Compile value
    const elemValResult = compileExpression(ctx, fctx, value, arrDef.element);
    if (!elemValResult) { ctx.errors.push({ message: "Failed to compile element value", line: getLine(target), column: getCol(target) }); return null; }
    const valLocal = allocLocal(fctx, `__val_${fctx.locals.length}`, arrDef.element);
    fctx.body.push({ op: "local.set", index: valLocal });

    // Get data array into a local so we can update it after potential grow
    const dataLocal = allocLocal(fctx, `__vec_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data
    fctx.body.push({ op: "local.set", index: dataLocal });

    // Ensure capacity: if idx >= array.len(data), grow backing array
    const newCapLocal = allocLocal(fctx, `__vec_ncap_${fctx.locals.length}`, { kind: "i32" });
    const newDataLocal = allocLocal(fctx, `__vec_ndata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
    const oldCapLocal = allocLocal(fctx, `__vec_ocap_${fctx.locals.length}`, { kind: "i32" });

    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "i32.ge_s" }); // idx >= capacity?

    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // oldCap = array.len(data)
        { op: "local.get", index: dataLocal } as Instr,
        { op: "array.len" } as Instr,
        { op: "local.set", index: oldCapLocal } as Instr,

        // newCap = max(idx + 1, oldCap * 2): store idx+1 first, then compare
        { op: "local.get", index: idxLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.set", index: newCapLocal } as Instr, // newCap = idx + 1
        // if oldCap * 2 > newCap, use oldCap * 2
        { op: "local.get", index: oldCapLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.shl" } as Instr, // oldCap * 2
        { op: "local.get", index: newCapLocal } as Instr,
        { op: "i32.gt_s" } as Instr,
        {
          op: "if", blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: oldCapLocal } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.shl" } as Instr,
            { op: "local.set", index: newCapLocal } as Instr,
          ],
        } as Instr,
        // Ensure at least 4
        { op: "i32.const", value: 4 } as Instr,
        { op: "local.get", index: newCapLocal } as Instr,
        { op: "i32.gt_s" } as Instr,
        {
          op: "if", blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 4 } as Instr,
            { op: "local.set", index: newCapLocal } as Instr,
          ],
        } as Instr,

        // newData = array.new_default(newCap)
        { op: "local.get", index: newCapLocal } as Instr,
        { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
        { op: "local.set", index: newDataLocal } as Instr,

        // array.copy newData[0..oldCap] = data[0..oldCap]
        { op: "local.get", index: newDataLocal } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: dataLocal } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: oldCapLocal } as Instr,
        { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,

        // Update vec.data = newData
        { op: "local.get", index: vecLocal } as Instr,
        { op: "local.get", index: newDataLocal } as Instr,
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.set", typeIdx, fieldIdx: 1 } as Instr,

        // Update local data pointer
        { op: "local.get", index: newDataLocal } as Instr,
        { op: "local.set", index: dataLocal } as Instr,
      ],
    } as Instr);

    // array.set: data[idx] = val (using potentially grown data)
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });

    // Update length if idx+1 > current length:
    // if (idx + 1 > vec.length) vec.length = idx + 1
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // get length
    fctx.body.push({ op: "i32.gt_s" });
    fctx.body.push({
      op: "if", blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: vecLocal },
        { op: "local.get", index: idxLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx, fieldIdx: 0 },
      ],
    });
    return VOID_RESULT;
  }

  // Plain struct (non-vec): resolve string/numeric literal index to struct.set
  if (typeDef?.kind === "struct") {
    let fieldName: string | undefined;
    if (ts.isStringLiteral(target.argumentExpression)) {
      fieldName = target.argumentExpression.text;
    } else if (ts.isNumericLiteral(target.argumentExpression)) {
      fieldName = target.argumentExpression.text;
    } else if (ts.isIdentifier(target.argumentExpression)) {
      const sym = ctx.checker.getSymbolAtLocation(target.argumentExpression);
      if (sym) {
        const decl = sym.valueDeclaration;
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
          const declList = decl.parent;
          if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
            if (ts.isStringLiteral(decl.initializer)) fieldName = decl.initializer.text;
            else if (ts.isNumericLiteral(decl.initializer)) fieldName = decl.initializer.text;
          }
        }
      }
    }
    if (fieldName === undefined) {
      const constVal = resolveConstantExpression(ctx, target.argumentExpression);
      if (constVal !== undefined) fieldName = String(constVal);
    }
    if (fieldName !== undefined) {
      // Check for setter accessor first (obj['prop'] = val where prop has a setter)
      const objTsType = ctx.checker.getTypeAtLocation(target.expression);
      const sName = resolveStructName(ctx, objTsType);
      if (sName) {
        const accessorKey = `${sName}_${fieldName}`;
        if (ctx.classAccessorSet.has(accessorKey)) {
          const setterName = `${sName}_set_${fieldName}`;
          const funcIdx = ctx.funcMap.get(setterName);
          if (funcIdx !== undefined) {
            // struct ref is already on stack; save it, compile value, then call setter
            const objLocal = allocLocal(fctx, `__struct_obj_${fctx.locals.length}`, arrType);
            fctx.body.push({ op: "local.set", index: objLocal });
            const valResult = compileExpression(ctx, fctx, value);
            if (!valResult) return null;
            const valLocal = allocLocal(fctx, `__struct_val_${fctx.locals.length}`, valResult);
            fctx.body.push({ op: "local.set", index: valLocal });
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "local.get", index: valLocal });
            fctx.body.push({ op: "call", funcIdx });
            return VOID_RESULT;
          }
        }
      }

      const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
      if (fieldIdx >= 0) {
        // struct ref is already on stack; save it, compile value, then struct.set
        const objLocal = allocLocal(fctx, `__struct_obj_${fctx.locals.length}`, arrType);
        fctx.body.push({ op: "local.set", index: objLocal });
        const fieldType = typeDef.fields[fieldIdx]!.type;
        const valResult = compileExpression(ctx, fctx, value, fieldType);
        if (!valResult) return null;
        const valLocal = allocLocal(fctx, `__struct_val_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.set", index: valLocal });
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "local.get", index: valLocal });
        fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
        return VOID_RESULT;
      }
    }
  }

  if (!typeDef || typeDef.kind !== "array") {
    ctx.errors.push({ message: "Assignment to non-array type", line: getLine(target), column: getCol(target) });
    return null;
  }
  // Push index (as i32)
  const plainIdxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
  if (!plainIdxResult) { ctx.errors.push({ message: "Failed to compile element index", line: getLine(target), column: getCol(target) }); return null; }
  fctx.body.push({ op: "i32.trunc_f64_s" });
  // Push value
  const plainValResult = compileExpression(ctx, fctx, value, typeDef.element);
  if (!plainValResult) { ctx.errors.push({ message: "Failed to compile element value", line: getLine(target), column: getCol(target) }); return null; }
  fctx.body.push({ op: "array.set", typeIdx });
  return VOID_RESULT;
}

/**
 * Compile logical assignment operators: ??=, ||=, &&=
 *
 * Desugars to value-preserving semantics:
 *   a ??= b  →  if (a is null) a = b; result = a
 *   a ||= b  →  if (!a) a = b; result = a
 *   a &&= b  →  if (a) a = b; result = a
 */
function compileLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  if (!ts.isIdentifier(expr.left)) {
    ctx.errors.push({
      message: "Logical assignment only supported for simple identifiers",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  const name = expr.left.text;

  // Resolve the variable storage location
  let storage: { kind: "local"; index: number; type: ValType } |
               { kind: "captured"; index: number; type: ValType } |
               { kind: "module"; index: number; type: ValType } | null = null;

  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    const localType = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type;
    storage = { kind: "local", index: localIdx, type: localType ?? { kind: "f64" } };
  }
  if (!storage) {
    const capturedIdx = ctx.capturedGlobals.get(name);
    if (capturedIdx !== undefined) {
      const globalDef = ctx.mod.globals[capturedIdx];
      storage = { kind: "captured", index: capturedIdx, type: globalDef?.type ?? { kind: "f64" } };
    }
  }
  if (!storage) {
    const moduleIdx = ctx.moduleGlobals.get(name);
    if (moduleIdx !== undefined) {
      const globalDef = ctx.mod.globals[moduleIdx];
      storage = { kind: "module", index: moduleIdx, type: globalDef?.type ?? { kind: "f64" } };
    }
  }

  if (!storage) {
    ctx.errors.push({
      message: `Unknown variable: ${name}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  const varType = storage.type;

  // Emit: read current value
  const emitGet = () => {
    if (storage!.kind === "local") fctx.body.push({ op: "local.get", index: storage!.index });
    else fctx.body.push({ op: "global.get", index: storage!.index });
  };
  const emitSet = () => {
    if (storage!.kind === "local") fctx.body.push({ op: "local.tee", index: storage!.index });
    else {
      fctx.body.push({ op: "global.set", index: storage!.index });
      fctx.body.push({ op: "global.get", index: storage!.index });
    }
  };

  if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    // a ??= b  →  if (a is null) { a = b }; result = a
    // This operates on externref (nullable) values
    emitGet();
    fctx.body.push({ op: "ref.is_null" });

    // Compile the RHS in a separate body
    const savedBody = fctx.body;
    fctx.body = [];
    const nullishRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!nullishRhsResult) { fctx.body = savedBody; return null; }
    emitSet();
    const thenInstrs = fctx.body;

    // Else: just read the current value (it's not null)
    fctx.body = [];
    emitGet();
    const elseInstrs = fctx.body;

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else if (op === ts.SyntaxKind.BarBarEqualsToken) {
    // a ||= b  →  if (!a) { a = b }; result = a
    emitGet();
    ensureI32Condition(fctx, varType, ctx);

    // Then (truthy): keep current value
    const savedBody = fctx.body;
    fctx.body = [];
    emitGet();
    const thenInstrs = fctx.body;

    // Else (falsy): assign RHS
    fctx.body = [];
    const orRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!orRhsResult) { fctx.body = savedBody; return null; }
    emitSet();
    const elseInstrs = fctx.body;

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else {
    // a &&= b  →  if (a) { a = b }; result = a
    emitGet();
    ensureI32Condition(fctx, varType, ctx);

    // Then (truthy): assign RHS
    const savedBody = fctx.body;
    fctx.body = [];
    const andRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!andRhsResult) { fctx.body = savedBody; return null; }
    emitSet();
    const thenInstrs = fctx.body;

    // Else (falsy): keep current value
    fctx.body = [];
    emitGet();
    const elseInstrs = fctx.body;

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  }

  return varType;
}

function isCompoundAssignment(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.PlusEqualsToken ||
    op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken ||
    op === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    op === ts.SyntaxKind.SlashEqualsToken ||
    op === ts.SyntaxKind.PercentEqualsToken ||
    op === ts.SyntaxKind.AmpersandEqualsToken ||
    op === ts.SyntaxKind.BarEqualsToken ||
    op === ts.SyntaxKind.CaretEqualsToken ||
    op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
  );
}

/**
 * Handle string += : load current string value, compile RHS (coercing
 * numbers to string if needed), call concat, store back.
 */
function compileStringCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  name: string,
): ValType | null {
  // Ensure string imports are registered
  addStringImports(ctx);

  const concatIdx = ctx.funcMap.get("concat");
  if (concatIdx === undefined) {
    ctx.errors.push({
      message: "String concat import not available",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Determine storage location
  const localIdx = fctx.localMap.get(name);
  const capturedIdx = ctx.capturedGlobals.get(name);
  const moduleIdx = ctx.moduleGlobals.get(name);

  // Load current value
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: localIdx });
  } else if (capturedIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: capturedIdx });
  } else if (moduleIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: moduleIdx });
  } else {
    ctx.errors.push({
      message: `Unknown variable: ${name}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Compile RHS, coercing numbers to string
  const rhsType = compileExpression(ctx, fctx, expr.right);
  if (!rhsType) {
    ctx.errors.push({
      message: "Failed to compile string += RHS",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }
  if (rhsType.kind === "f64" || rhsType.kind === "i32") {
    if (rhsType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    const toStr = ctx.funcMap.get("number_toString");
    if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
  }

  // Call concat
  fctx.body.push({ op: "call", funcIdx: concatIdx });

  // Store back
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.tee", index: localIdx });
  } else if (capturedIdx !== undefined) {
    fctx.body.push({ op: "global.set", index: capturedIdx });
    fctx.body.push({ op: "global.get", index: capturedIdx });
  } else if (moduleIdx !== undefined) {
    fctx.body.push({ op: "global.set", index: moduleIdx });
    fctx.body.push({ op: "global.get", index: moduleIdx });
  }

  return { kind: "externref" };
}

function compileCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  if (!ts.isIdentifier(expr.left)) {
    ctx.errors.push({
      message: "Compound assignment only supported for simple identifiers",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  const name = expr.left.text;

  // String += : concat instead of numeric add
  if (op === ts.SyntaxKind.PlusEqualsToken) {
    const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
    if (isStringType(leftTsType)) {
      return compileStringCompoundAssignment(ctx, fctx, expr, name);
    }
  }

  // Check captured globals first
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined && fctx.localMap.get(name) === undefined) {
    fctx.body.push({ op: "global.get", index: capturedIdx });
    const compoundRhsType1 = compileExpression(ctx, fctx, expr.right, { kind: "f64" });
    if (!compoundRhsType1) { ctx.errors.push({ message: "Failed to compile compound assignment RHS", line: getLine(expr), column: getCol(expr) }); return null; }

    switch (op) {
      case ts.SyntaxKind.PlusEqualsToken:
        fctx.body.push({ op: "f64.add" });
        break;
      case ts.SyntaxKind.MinusEqualsToken:
        fctx.body.push({ op: "f64.sub" });
        break;
      case ts.SyntaxKind.AsteriskEqualsToken:
        fctx.body.push({ op: "f64.mul" });
        break;
      case ts.SyntaxKind.AsteriskAsteriskEqualsToken: {
        const funcIdx = ctx.funcMap.get("Math_pow");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
        }
        break;
      }
      case ts.SyntaxKind.SlashEqualsToken:
        fctx.body.push({ op: "f64.div" });
        break;
      case ts.SyntaxKind.PercentEqualsToken:
        emitModulo(fctx);
        break;
      case ts.SyntaxKind.AmpersandEqualsToken:
      case ts.SyntaxKind.BarEqualsToken:
      case ts.SyntaxKind.CaretEqualsToken:
      case ts.SyntaxKind.LessThanLessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
        emitBitwiseCompoundOp(fctx, op);
        break;
    }

    fctx.body.push({ op: "global.set", index: capturedIdx });
    fctx.body.push({ op: "global.get", index: capturedIdx });
    return { kind: "f64" };
  }

  // Check module-level globals
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined && fctx.localMap.get(name) === undefined) {
    fctx.body.push({ op: "global.get", index: moduleIdx });
    const compoundRhsType2 = compileExpression(ctx, fctx, expr.right, { kind: "f64" });
    if (!compoundRhsType2) { ctx.errors.push({ message: "Failed to compile compound assignment RHS", line: getLine(expr), column: getCol(expr) }); return null; }

    switch (op) {
      case ts.SyntaxKind.PlusEqualsToken:
        fctx.body.push({ op: "f64.add" });
        break;
      case ts.SyntaxKind.MinusEqualsToken:
        fctx.body.push({ op: "f64.sub" });
        break;
      case ts.SyntaxKind.AsteriskEqualsToken:
        fctx.body.push({ op: "f64.mul" });
        break;
      case ts.SyntaxKind.AsteriskAsteriskEqualsToken: {
        const funcIdx = ctx.funcMap.get("Math_pow");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
        }
        break;
      }
      case ts.SyntaxKind.SlashEqualsToken:
        fctx.body.push({ op: "f64.div" });
        break;
      case ts.SyntaxKind.PercentEqualsToken:
        emitModulo(fctx);
        break;
      case ts.SyntaxKind.AmpersandEqualsToken:
      case ts.SyntaxKind.BarEqualsToken:
      case ts.SyntaxKind.CaretEqualsToken:
      case ts.SyntaxKind.LessThanLessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
        emitBitwiseCompoundOp(fctx, op);
        break;
    }

    fctx.body.push({ op: "global.set", index: moduleIdx });
    fctx.body.push({ op: "global.get", index: moduleIdx });
    return { kind: "f64" };
  }

  const localIdx = fctx.localMap.get(name);
  if (localIdx === undefined) {
    ctx.errors.push({
      message: `Unknown variable: ${name}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Handle boxed (ref cell) mutable captures
  const boxed = fctx.boxedCaptures?.get(name);
  if (boxed) {
    // Read current value from ref cell
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
    const compoundRhsBoxed = compileExpression(ctx, fctx, expr.right, boxed.valType);
    if (!compoundRhsBoxed) { ctx.errors.push({ message: "Failed to compile compound assignment RHS", line: getLine(expr), column: getCol(expr) }); return null; }
    switch (op) {
      case ts.SyntaxKind.PlusEqualsToken: fctx.body.push({ op: "f64.add" }); break;
      case ts.SyntaxKind.MinusEqualsToken: fctx.body.push({ op: "f64.sub" }); break;
      case ts.SyntaxKind.AsteriskEqualsToken: fctx.body.push({ op: "f64.mul" }); break;
      case ts.SyntaxKind.SlashEqualsToken: fctx.body.push({ op: "f64.div" }); break;
      case ts.SyntaxKind.PercentEqualsToken: emitModulo(fctx); break;
      case ts.SyntaxKind.AsteriskAsteriskEqualsToken: {
        const fi = ctx.funcMap.get("Math_pow");
        if (fi !== undefined) fctx.body.push({ op: "call", funcIdx: fi });
        break;
      }
      case ts.SyntaxKind.AmpersandEqualsToken:
      case ts.SyntaxKind.BarEqualsToken:
      case ts.SyntaxKind.CaretEqualsToken:
      case ts.SyntaxKind.LessThanLessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
        emitBitwiseCompoundOp(fctx, op);
        break;
    }
    // Write back to ref cell
    const tmpResult = allocLocal(fctx, `__box_cmp_${fctx.locals.length}`, boxed.valType);
    fctx.body.push({ op: "local.set", index: tmpResult });
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "local.get", index: tmpResult });
    fctx.body.push({ op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.get", index: tmpResult });
    return boxed.valType;
  }

  const localType = getLocalType(fctx, localIdx);
  const isExternLocal = localType?.kind === "externref";

  if (isExternLocal) {
    // Externref local used in arithmetic — unbox to f64 first
    addUnionImports(ctx);
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
  } else {
    fctx.body.push({ op: "local.get", index: localIdx });
  }
  const compoundRhsType3 = compileExpression(ctx, fctx, expr.right, { kind: "f64" });
  if (!compoundRhsType3) { ctx.errors.push({ message: "Failed to compile compound assignment RHS", line: getLine(expr), column: getCol(expr) }); return null; }

  switch (op) {
    case ts.SyntaxKind.PlusEqualsToken:
      fctx.body.push({ op: "f64.add" });
      break;
    case ts.SyntaxKind.MinusEqualsToken:
      fctx.body.push({ op: "f64.sub" });
      break;
    case ts.SyntaxKind.AsteriskEqualsToken:
      fctx.body.push({ op: "f64.mul" });
      break;
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken: {
      const funcIdx = ctx.funcMap.get("Math_pow");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      break;
    }
    case ts.SyntaxKind.SlashEqualsToken:
      fctx.body.push({ op: "f64.div" });
      break;
    case ts.SyntaxKind.PercentEqualsToken:
      emitModulo(fctx);
      break;
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      emitBitwiseCompoundOp(fctx, op);
      break;
  }

  if (isExternLocal) {
    // Box result back to externref and store
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
    fctx.body.push({ op: "local.tee", index: localIdx });
    return { kind: "externref" };
  }
  fctx.body.push({ op: "local.tee", index: localIdx });
  return { kind: "f64" };
}

/** Emit bitwise compound op: stack has [left_f64, right_f64], replaces with result f64 */
function emitBitwiseCompoundOp(fctx: FunctionContext, op: ts.SyntaxKind): void {
  const opMap: Record<number, { i32op: "i32.and" | "i32.or" | "i32.xor" | "i32.shl" | "i32.shr_s" | "i32.shr_u"; unsigned: boolean }> = {
    [ts.SyntaxKind.AmpersandEqualsToken]: { i32op: "i32.and", unsigned: false },
    [ts.SyntaxKind.BarEqualsToken]: { i32op: "i32.or", unsigned: false },
    [ts.SyntaxKind.CaretEqualsToken]: { i32op: "i32.xor", unsigned: false },
    [ts.SyntaxKind.LessThanLessThanEqualsToken]: { i32op: "i32.shl", unsigned: false },
    [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: { i32op: "i32.shr_s", unsigned: false },
    [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: { i32op: "i32.shr_u", unsigned: true },
  };
  const entry = opMap[op]!;
  const tmpR = allocLocal(fctx, `__bw_r_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: "local.get", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: entry.i32op });
  fctx.body.push({ op: entry.unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s" });
}

function compilePrefixUnary(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PrefixUnaryExpression,
): ValType | null {
  switch (expr.operator) {
    case ts.SyntaxKind.PlusToken: {
      // Unary + is ToNumber coercion
      // Try static resolution first (handles objects with valueOf, {}, NaN, etc.)
      const staticVal = tryStaticToNumber(ctx, expr.operand);
      if (staticVal !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticVal });
        return { kind: "f64" };
      }
      const operandType = compileExpression(ctx, fctx, expr.operand);
      if (operandType?.kind === "externref") {
        // String → number: call parseFloat host import
        const pfIdx = ctx.funcMap.get("parseFloat");
        if (pfIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: pfIdx });
          return { kind: "f64" };
        }
      }
      // Struct ref → f64: coerce via valueOf (JS ToNumber semantics)
      if (operandType && (operandType.kind === "ref" || operandType.kind === "ref_null")) {
        coerceType(ctx, fctx, operandType, { kind: "f64" });
        return { kind: "f64" };
      }
      // Already numeric — no-op
      return operandType;
    }
    case ts.SyntaxKind.MinusToken: {
      const operandType = compileExpression(ctx, fctx, expr.operand);
      if (!operandType) return null;
      // any-typed negate: call __any_neg
      if (ctx.fast && isAnyValue(operandType, ctx)) {
        ensureAnyHelpers(ctx);
        const negIdx = ctx.funcMap.get("__any_neg");
        if (negIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: negIdx });
          return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
        }
      }
      if (ctx.fast && operandType?.kind === "i32") {
        // i32 negate: 0 - x
        const tmp = allocLocal(fctx, `__neg_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.set", index: tmp });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "i32.sub" });
        return { kind: "i32" };
      }
      if (operandType?.kind === "i64") {
        // i64 negate: 0 - x
        const tmp = allocLocal(fctx, `__neg_${fctx.locals.length}`, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: tmp });
        fctx.body.push({ op: "i64.const", value: 0n });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "i64.sub" });
        return { kind: "i64" };
      }
      fctx.body.push({ op: "f64.neg" });
      return { kind: "f64" };
    }
    case ts.SyntaxKind.ExclamationToken: {
      const operandType = compileExpression(ctx, fctx, expr.operand);
      ensureI32Condition(fctx, operandType, ctx);
      fctx.body.push({ op: "i32.eqz" });
      return { kind: "i32" };
    }
    case ts.SyntaxKind.TildeToken: {
      const operandType = compileExpression(ctx, fctx, expr.operand);
      if (operandType?.kind === "i64") {
        // ~bigint => bigint ^ -1n
        fctx.body.push({ op: "i64.const", value: -1n });
        fctx.body.push({ op: "i64.xor" });
        return { kind: "i64" };
      }
      if (ctx.fast) {
        if (operandType?.kind !== "i32") coerceType(ctx, fctx, operandType!, { kind: "i32" });
        fctx.body.push({ op: "i32.const", value: -1 });
        fctx.body.push({ op: "i32.xor" });
        return { kind: "i32" };
      }
      // ~x => f64.convert_i32_s(i32.xor(ToInt32(x), -1))
      if (operandType?.kind !== "f64") coerceType(ctx, fctx, operandType!, { kind: "f64" });
      emitToInt32(fctx);
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.xor" });
      fctx.body.push({ op: "f64.convert_i32_s" });
      return { kind: "f64" };
    }
    case ts.SyntaxKind.PlusPlusToken: {
      if (ts.isIdentifier(expr.operand)) {
        const idx = fctx.localMap.get(expr.operand.text);
        if (idx !== undefined) {
          const boxedPP = fctx.boxedCaptures?.get(expr.operand.text);
          if (boxedPP) {
            // ++x through ref cell
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "struct.get", typeIdx: boxedPP.refCellTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            const ppTmp = allocLocal(fctx, `__pp_${fctx.locals.length}`, boxedPP.valType);
            fctx.body.push({ op: "local.tee", index: ppTmp });
            fctx.body.push({ op: "struct.set", typeIdx: boxedPP.refCellTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "local.get", index: ppTmp });
            return boxedPP.valType;
          }
          const localType = getLocalType(fctx, idx);
          if (ctx.fast && localType?.kind === "i32") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: "i32.add" });
            fctx.body.push({ op: "local.tee", index: idx });
            return { kind: "i32" };
          }
          if (localType?.kind === "externref") {
            addUnionImports(ctx);
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
            fctx.body.push({ op: "local.tee", index: idx });
            return { kind: "externref" };
          }
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.tee", index: idx });
          return { kind: "f64" };
        }
      }
      break;
    }
    case ts.SyntaxKind.MinusMinusToken: {
      if (ts.isIdentifier(expr.operand)) {
        const idx = fctx.localMap.get(expr.operand.text);
        if (idx !== undefined) {
          const boxedMM = fctx.boxedCaptures?.get(expr.operand.text);
          if (boxedMM) {
            // --x through ref cell
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "struct.get", typeIdx: boxedMM.refCellTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.sub" });
            const mmTmp = allocLocal(fctx, `__mm_${fctx.locals.length}`, boxedMM.valType);
            fctx.body.push({ op: "local.tee", index: mmTmp });
            fctx.body.push({ op: "struct.set", typeIdx: boxedMM.refCellTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "local.get", index: mmTmp });
            return boxedMM.valType;
          }
          const localType = getLocalType(fctx, idx);
          if (ctx.fast && localType?.kind === "i32") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: "i32.sub" });
            fctx.body.push({ op: "local.tee", index: idx });
            return { kind: "i32" };
          }
          if (localType?.kind === "externref") {
            addUnionImports(ctx);
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.sub" });
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
            fctx.body.push({ op: "local.tee", index: idx });
            return { kind: "externref" };
          }
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.sub" });
          fctx.body.push({ op: "local.tee", index: idx });
          return { kind: "f64" };
        }
      }
      break;
    }
  }

  ctx.errors.push({
    message: `Unsupported prefix unary operator: ${ts.SyntaxKind[expr.operator]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

function compilePostfixUnary(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PostfixUnaryExpression,
): ValType | null {
  if (!ts.isIdentifier(expr.operand)) {
    ctx.errors.push({
      message: "Postfix unary only supported for identifiers",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  const idx = fctx.localMap.get(expr.operand.text);
  if (idx === undefined) {
    ctx.errors.push({
      message: `Unknown variable: ${expr.operand.text}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Handle boxed (ref cell) mutable captures for postfix
  const boxedPost = fctx.boxedCaptures?.get(expr.operand.text);
  if (boxedPost) {
    // Return old value, store incremented/decremented
    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "struct.get", typeIdx: boxedPost.refCellTypeIdx, fieldIdx: 0 });
    const oldTmp = allocLocal(fctx, `__postbox_${fctx.locals.length}`, boxedPost.valType);
    fctx.body.push({ op: "local.tee", index: oldTmp });
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: expr.operator === ts.SyntaxKind.PlusPlusToken ? "f64.add" : "f64.sub" });
    const newTmp = allocLocal(fctx, `__postnew_${fctx.locals.length}`, boxedPost.valType);
    fctx.body.push({ op: "local.set", index: newTmp });
    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "local.get", index: newTmp });
    fctx.body.push({ op: "struct.set", typeIdx: boxedPost.refCellTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.get", index: oldTmp });
    return boxedPost.valType;
  }

  const localType = getLocalType(fctx, idx);
  if (ctx.fast && localType?.kind === "i32") {
    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: expr.operator === ts.SyntaxKind.PlusPlusToken ? "i32.add" : "i32.sub" });
    fctx.body.push({ op: "local.set", index: idx });
    return { kind: "i32" };
  }

  if (localType?.kind === "externref") {
    // Postfix on externref: return old value (unboxed), store incremented (boxed)
    addUnionImports(ctx);
    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
    // Stack: [old_f64]. Duplicate for arithmetic.
    const tmpOld = allocLocal(fctx, `__postfix_old_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.tee", index: tmpOld });
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: expr.operator === ts.SyntaxKind.PlusPlusToken ? "f64.add" : "f64.sub" });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
    fctx.body.push({ op: "local.set", index: idx });
    fctx.body.push({ op: "local.get", index: tmpOld });
    return { kind: "f64" };
  }

  fctx.body.push({ op: "local.get", index: idx });
  fctx.body.push({ op: "local.get", index: idx });
  fctx.body.push({ op: "f64.const", value: 1 });

  if (expr.operator === ts.SyntaxKind.PlusPlusToken) {
    fctx.body.push({ op: "f64.add" });
  } else {
    fctx.body.push({ op: "f64.sub" });
  }

  fctx.body.push({ op: "local.set", index: idx });
  return { kind: "f64" };
}

// ── Call expressions ─────────────────────────────────────────────────

/** Look up parameter types for a function by its index */
function getFuncParamTypes(ctx: CodegenContext, funcIdx: number): ValType[] | undefined {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          if (typeDef?.kind === "func") return typeDef.params;
          return undefined;
        }
        importFuncCount++;
      }
    }
  } else {
    const localIdx = funcIdx - ctx.numImportFuncs;
    const func = ctx.mod.functions[localIdx];
    if (func) {
      const typeDef = ctx.mod.types[func.typeIdx];
      if (typeDef?.kind === "func") return typeDef.params;
    }
  }
  return undefined;
}

/** Compile a call to a closure variable: closureVar(args...) */
function compileClosureCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  varName: string,
  info: ClosureInfo,
): ValType | null {
  const localIdx = fctx.localMap.get(varName);
  if (localIdx === undefined) return null;

  // Stack for call_ref needs: [closure_ref, ...args, funcref]
  // where the lifted func type is (ref $closure_struct, ...arrowParams) → results

  // Push closure ref as first arg (self param of the lifted function)
  fctx.body.push({ op: "local.get", index: localIdx });

  // Push call arguments
  for (let i = 0; i < expr.arguments.length; i++) {
    compileExpression(ctx, fctx, expr.arguments[i]!, info.paramTypes[i]);
  }

  // Push the funcref from the closure struct (field 0) and cast to typed ref
  fctx.body.push({ op: "local.get", index: localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: info.structTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "ref.cast", typeIdx: info.funcTypeIdx });

  // call_ref with the lifted function's type index
  fctx.body.push({ op: "call_ref", typeIdx: info.funcTypeIdx });

  return info.returnType;
}

function compileCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult {
  // Optional chaining on calls: obj?.method()
  if (expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
    return compileOptionalCallExpression(ctx, fctx, expr);
  }

  // Handle super.method() calls — resolve to ParentClass_method with this as first arg
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return compileSuperMethodCall(ctx, fctx, expr);
  }

  // Handle property access calls: console.log, Math.xxx, extern methods
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const propAccess = expr.expression;

    // Handle Array.prototype.METHOD.call(obj, ...args) — inline as array method on shape-inferred obj
    {
      const callResult = compileArrayPrototypeCall(ctx, fctx, expr, propAccess);
      if (callResult !== undefined) return callResult;
    }

    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "console" &&
      (propAccess.name.text === "log" || propAccess.name.text === "warn" || propAccess.name.text === "error")
    ) {
      return compileConsoleCall(ctx, fctx, expr, propAccess.name.text);
    }

    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Math"
    ) {
      return compileMathCall(ctx, fctx, propAccess.name.text, expr);
    }

    // Handle Number.isNaN(n) and Number.isInteger(n)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Number"
    ) {
      const method = propAccess.name.text;
      if (method === "isNaN" && expr.arguments.length >= 1) {
        // NaN !== NaN is true; for any other value it's false
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        const tmp = allocLocal(fctx, `__isnan_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.ne" } as Instr);
        return { kind: "i32" };
      }
      if (method === "isInteger" && expr.arguments.length >= 1) {
        // n === Math.trunc(n) && isFinite(n)
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        const tmp = allocLocal(fctx, `__isint_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.trunc" } as Instr);
        fctx.body.push({ op: "f64.eq" } as Instr);
        // Also check finite: n - n === 0 (Infinity - Infinity = NaN, NaN !== 0)
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.sub" } as Instr);
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" } as Instr);
        fctx.body.push({ op: "i32.and" } as Instr);
        return { kind: "i32" };
      }
      if (method === "isFinite" && expr.arguments.length >= 1) {
        // isFinite(n) → n - n === 0.0
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        const tmp = allocLocal(fctx, `__isfin_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.sub" } as Instr);
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" } as Instr);
        return { kind: "i32" };
      }
      if (method === "isSafeInteger" && expr.arguments.length >= 1) {
        // isSafeInteger(n) = isInteger(n) && abs(n) <= MAX_SAFE_INTEGER
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        const tmp = allocLocal(fctx, `__issafe_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        // isInteger: n === trunc(n) && isFinite(n)
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.trunc" } as Instr);
        fctx.body.push({ op: "f64.eq" } as Instr);
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.sub" } as Instr);
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" } as Instr);
        fctx.body.push({ op: "i32.and" } as Instr);
        // abs(n) <= MAX_SAFE_INTEGER
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.abs" } as Instr);
        fctx.body.push({ op: "f64.const", value: Number.MAX_SAFE_INTEGER });
        fctx.body.push({ op: "f64.le" } as Instr);
        fctx.body.push({ op: "i32.and" } as Instr);
        return { kind: "i32" };
      }
      if ((method === "parseFloat" || method === "parseInt") && expr.arguments.length >= 1) {
        // Delegate to the global parseInt / parseFloat host import
        const funcIdx = ctx.funcMap.get(method === "parseFloat" ? "parseFloat" : "parseInt");
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
          if (method === "parseInt") {
            if (expr.arguments.length >= 2) {
              compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
            } else {
              // No radix supplied — push NaN sentinel so runtime treats it as undefined
              fctx.body.push({ op: "f64.const", value: NaN });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "f64" };
        }
      }
    }

    // Handle Array.isArray(x) — compile-time type check
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Array" &&
      propAccess.name.text === "isArray" &&
      expr.arguments.length >= 1
    ) {
      // Check the TypeScript type of the argument at compile time
      const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
      const argWasmType = resolveWasmType(ctx, argTsType);
      // If the wasm type is a ref to a vec struct (array), return true; otherwise false
      const isArr = (argWasmType.kind === "ref" || argWasmType.kind === "ref_null");
      // Still compile the argument for side effects, then drop it
      compileExpression(ctx, fctx, expr.arguments[0]!);
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isArr ? 1 : 0 });
      return { kind: "i32" };
    }

    // Handle String.fromCharCode(code) — host import
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "String" &&
      propAccess.name.text === "fromCharCode" &&
      expr.arguments.length >= 1
    ) {
      const funcIdx = ctx.funcMap.get("String_fromCharCode");
      if (funcIdx !== undefined) {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        if (argType && argType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        fctx.body.push({ op: "call", funcIdx });
        // In fast mode, marshal externref string to native string
        if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
          const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern");
          if (fromExternIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: fromExternIdx });
          }
          return nativeStringType(ctx);
        }
        return { kind: "externref" };
      }
    }

    // Handle Array.from(arr) — array copy
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Array" &&
      propAccess.name.text === "from" &&
      expr.arguments.length >= 1
    ) {
      const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
      const argWasmType = resolveWasmType(ctx, argTsType);
      // Only handle array arguments — create a shallow copy
      if (argWasmType.kind === "ref" || argWasmType.kind === "ref_null") {
        const arrInfo = resolveArrayInfo(ctx, argTsType);
        if (arrInfo) {
          const { vecTypeIdx, arrTypeIdx, elemType } = arrInfo;
          // Compile the source array
          compileExpression(ctx, fctx, expr.arguments[0]!);
          const srcVec = allocLocal(fctx, `__arrfrom_src_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
          const srcData = allocLocal(fctx, `__arrfrom_sdata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
          const lenTmp = allocLocal(fctx, `__arrfrom_len_${fctx.locals.length}`, { kind: "i32" });
          const dstData = allocLocal(fctx, `__arrfrom_ddata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });

          fctx.body.push({ op: "local.set", index: srcVec });
          // Get length
          fctx.body.push({ op: "local.get", index: srcVec });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "local.set", index: lenTmp });
          // Get source data
          fctx.body.push({ op: "local.get", index: srcVec });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "local.set", index: srcData });
          // Create new data array with default value
          const defaultVal = elemType.kind === "f64"
            ? { op: "f64.const", value: 0 }
            : elemType.kind === "i32"
              ? { op: "i32.const", value: 0 }
              : { op: "ref.null", typeIdx: (elemType as any).typeIdx ?? -1 };
          fctx.body.push(defaultVal as Instr);
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "array.new", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "local.set", index: dstData });
          // Copy elements: array.copy dst dstOff src srcOff len
          fctx.body.push({ op: "local.get", index: dstData });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: srcData });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);
          // Create new vec struct with copied data
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "local.get", index: dstData });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref", typeIdx: vecTypeIdx };
        }
      }
    }

    // Handle Object.keys(obj) and Object.values(obj)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "keys" || propAccess.name.text === "values") &&
      expr.arguments.length === 1
    ) {
      return compileObjectKeysOrValues(ctx, fctx, propAccess.name.text, expr);
    }

    // Handle Promise.all / Promise.race — host-delegated static calls
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Promise" &&
      (propAccess.name.text === "all" || propAccess.name.text === "race") &&
      expr.arguments.length >= 1
    ) {
      const importName = `Promise_${propAccess.name.text}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // Handle JSON.stringify / JSON.parse as host import calls
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "JSON"
    ) {
      const method = propAccess.name.text;
      if ((method === "stringify" || method === "parse") && expr.arguments.length >= 1) {
        const importName = `JSON_${method}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          // Compile argument and coerce to externref if needed
          // (boxing imports registered early in collectJsonImports)
          const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
          if (argType && argType.kind === "f64") {
            const boxIdx = ctx.funcMap.get("__box_number");
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          } else if (argType && argType.kind === "i32") {
            const boxIdx = ctx.funcMap.get("__box_boolean");
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
    }

    // Check if this is a static method call: ClassName.staticMethod(args)
    if (ts.isIdentifier(propAccess.expression) && ctx.classSet.has(propAccess.expression.text)) {
      const clsName = propAccess.expression.text;
      const methodName = propAccess.name.text;
      const fullName = `${clsName}_${methodName}`;
      if (ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          // No self parameter for static methods
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          for (let i = 0; i < expr.arguments.length; i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isVoidType(retType)) return VOID_RESULT;
            return resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }
    }

    // Check if receiver is an externref object
    const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
    if (isExternalDeclaredClass(receiverType, ctx.checker)) {
      return compileExternMethodCall(ctx, fctx, propAccess, expr);
    }

    // Generator method calls: gen.next()
    if (isGeneratorType(receiverType) && propAccess.name.text === "next") {
      compileExpression(ctx, fctx, propAccess.expression);
      const funcIdx = ctx.funcMap.get("__gen_next");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" }; // Returns IteratorResult as externref
      }
    }

    // Check if receiver is a local class instance
    let receiverClassName = receiverType.getSymbol()?.name;
    // Map class expression symbol names to their synthetic names
    if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
      receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
    }
    if (receiverClassName && ctx.classSet.has(receiverClassName)) {
      const methodName = ts.isPrivateIdentifier(propAccess.name) ? propAccess.name.text.slice(1) : propAccess.name.text;
      const fullName = `${receiverClassName}_${methodName}`;
      const funcIdx = ctx.funcMap.get(fullName);
      if (funcIdx !== undefined) {
        // Push self (the receiver) as first argument
        compileExpression(ctx, fctx, propAccess.expression);
        // Push remaining arguments with type hints
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let i = 0; i < expr.arguments.length; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
        }
        fctx.body.push({ op: "call", funcIdx });

        // Determine return type
        const sig = ctx.checker.getResolvedSignature(expr);
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (isVoidType(retType)) return VOID_RESULT;
          return resolveWasmType(ctx, retType);
        }
        return VOID_RESULT;
      }
    }

    // Check if receiver is a struct type (e.g. object literal with methods)
    {
      const structTypeName = resolveStructName(ctx, receiverType);
      if (structTypeName) {
        const methodName = propAccess.name.text;
        const fullName = `${structTypeName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument
          compileExpression(ctx, fctx, propAccess.expression);
          // Push remaining arguments with type hints
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          for (let i = 0; i < expr.arguments.length; i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isVoidType(retType)) return VOID_RESULT;
            return resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }
    }

    // Array method calls
    {
      const arrMethodResult = compileArrayMethodCall(ctx, fctx, propAccess, expr, receiverType);
      if (arrMethodResult !== undefined) return arrMethodResult;
    }

    // Primitive method calls: number.toString(), number.toFixed()
    if (isNumberType(receiverType) && propAccess.name.text === "toString") {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      // number_toString expects f64 but source may be i32 (e.g. string.length)
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      const funcIdx = ctx.funcMap.get("number_toString");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    if (isNumberType(receiverType) && propAccess.name.text === "toFixed") {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      // Compile the digits argument (default 0)
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      const funcIdx = ctx.funcMap.get("number_toFixed");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // String method calls
    if (isStringType(receiverType)) {
      const method = propAccess.name.text;

      // Fast mode: native string method dispatch
      if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
        return compileNativeStringMethodCall(ctx, fctx, expr, propAccess, method);
      }

      const importName = `string_${method}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        compileExpression(ctx, fctx, propAccess.expression);
        for (const arg of expr.arguments) {
          compileExpression(ctx, fctx, arg);
        }
        fctx.body.push({ op: "call", funcIdx });
        const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
        return returnsBool ? { kind: "i32" } : method === "indexOf" || method === "lastIndexOf" ? { kind: "f64" } : { kind: "externref" };
      }
    }
  }

  // Handle global isNaN(n) / isFinite(n) — inline wasm
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;

    if (funcName === "isNaN" && expr.arguments.length >= 1) {
      // isNaN(n) → n !== n
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isnan_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.ne" } as Instr);
      return { kind: "i32" };
    }

    if (funcName === "isFinite" && expr.arguments.length >= 1) {
      // isFinite(n) → n - n === 0.0  (Infinity - Infinity = NaN, NaN - NaN = NaN, finite - finite = 0)
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isfin_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.sub" } as Instr);
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" } as Instr);
      return { kind: "i32" };
    }

    // parseInt(s, radix?) and parseFloat(s) — host imports
    if ((funcName === "parseInt" || funcName === "parseFloat") && expr.arguments.length >= 1) {
      const importFuncIdx = ctx.funcMap.get(funcName);
      if (importFuncIdx !== undefined) {
        const arg0 = expr.arguments[0]!;
        const arg0Type = compileExpression(ctx, fctx, arg0);
        // Coerce to externref, preserving boolean identity (not boxing as number)
        if (arg0Type && arg0Type.kind !== "externref") {
          if (arg0Type.kind === "i32" && (arg0.kind === ts.SyntaxKind.TrueKeyword || arg0.kind === ts.SyntaxKind.FalseKeyword)) {
            // Boolean literal: box as boolean so String(true) → "true"
            addUnionImports(ctx);
            const boxIdx = ctx.funcMap.get("__box_boolean");
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          } else {
            coerceType(ctx, fctx, arg0Type, { kind: "externref" });
          }
        }
        if (funcName === "parseInt") {
          if (expr.arguments.length >= 2) {
            compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
          } else {
            // No radix supplied — push NaN sentinel so runtime treats it as undefined
            fctx.body.push({ op: "f64.const", value: NaN });
          }
        }
        fctx.body.push({ op: "call", funcIdx: importFuncIdx });
        return { kind: "f64" };
      }
    }

    // Number(x) — ToNumber coercion
    if (funcName === "Number" && expr.arguments.length >= 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType?.kind === "i64") {
        // BigInt → number: f64.convert_i64_s
        fctx.body.push({ op: "f64.convert_i64_s" });
        return { kind: "f64" };
      }
      if (argType?.kind === "externref") {
        // String → number: use parseFloat
        const pfIdx = ctx.funcMap.get("parseFloat");
        if (pfIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: pfIdx });
          return { kind: "f64" };
        }
      }
      // Already numeric — no-op
      return argType;
    }

    // BigInt(x) — ToBigInt coercion
    if (funcName === "BigInt" && expr.arguments.length >= 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType?.kind === "f64") {
        fctx.body.push({ op: "i64.trunc_f64_s" });
        return { kind: "i64" };
      }
      if (argType?.kind === "i32") {
        fctx.body.push({ op: "i64.extend_i32_s" });
        return { kind: "i64" };
      }
      // Already i64 — no-op
      return argType;
    }

    // Number() with 0 args → 0
    if (funcName === "Number" && expr.arguments.length === 0) {
      fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: 0 } as Instr);
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }

    // String(x) — ToString coercion
    if (funcName === "String") {
      if (expr.arguments.length === 0) {
        // String() with no args → ""
        const emptyStrFuncIdx = ctx.funcMap.get("__str_empty") ?? ctx.funcMap.get("string_empty");
        if (emptyStrFuncIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: emptyStrFuncIdx });
          return { kind: "externref" };
        }
        // Fallback: return empty string via toString
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push(ctx.fast ? { op: "i32.const", value: 0 } as Instr : { op: "f64.const", value: 0 } as Instr);
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
        return { kind: "externref" };
      }
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType?.kind === "f64" || argType?.kind === "i32") {
        // number → string
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          if (argType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }
      if (argType?.kind === "externref") {
        // Already a string (or null/undefined) — use host toString
        const toStrIdx = ctx.funcMap.get("extern_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
        }
        return { kind: "externref" };
      }
      return argType ?? { kind: "externref" };
    }

    // Boolean(x) — ToBoolean coercion → returns i32 (0 or 1)
    if (funcName === "Boolean") {
      if (expr.arguments.length === 0) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType?.kind === "f64") {
        // f64: truthy if != 0 and != NaN
        const tmp = allocLocal(fctx, `__bool_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.ne" } as Instr);
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.eq" } as Instr); // NaN check: x == x
        fctx.body.push({ op: "i32.and" } as Instr);
        return { kind: "i32" };
      }
      if (argType?.kind === "i32") {
        // i32: truthy if != 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ne" } as Instr);
        return { kind: "i32" };
      }
      if (argType?.kind === "externref") {
        // externref: truthy if non-null (and not "" or 0 — but we can't check that without host)
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.xor" } as Instr);
        return { kind: "i32" };
      }
      // fallback: treat as truthy (non-null ref)
      return { kind: "i32" };
    }

    // Array(n) — create array of length n, or Array(a,b,c) → [a,b,c]
    if (funcName === "Array") {
      if (expr.arguments.length === 0) {
        // Array() → [] — emit empty array literal
        return compileExpression(ctx, fctx, ts.factory.createArrayLiteralExpression([]));
      }
      // For single numeric arg: treated as new Array literal with those elements
      // (full semantics require Array(n) → length-n sparse array, but the simplest
      // safe fallback is to compile as if it were [...args])
      // Fall through to "Unknown function" — tests that need Array(n) skip gracefully
    }
  }

  // Regular function call
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;

    // Check if this is a closure call
    const closureInfo = ctx.closureMap.get(funcName);
    if (closureInfo) {
      return compileClosureCall(ctx, fctx, expr, funcName, closureInfo);
    }

    const funcIdx = ctx.funcMap.get(funcName);
    if (funcIdx === undefined) {
      ctx.errors.push({
        message: `Unknown function: ${funcName}`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    // Prepend captured values for nested functions with captures
    const nestedCaptures = ctx.nestedFuncCaptures.get(funcName);
    if (nestedCaptures) {
      for (const cap of nestedCaptures) {
        fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
      }
    }

    // Check for rest parameters on the callee
    const restInfo = ctx.funcRestParams.get(funcName);

    // Check if any argument uses spread syntax
    const hasSpreadArg = expr.arguments.some((a) => ts.isSpreadElement(a));

    if (restInfo && !hasSpreadArg) {
      // Calling a rest-param function: pack trailing args into a GC array
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      // Compile non-rest arguments
      for (let i = 0; i < restInfo.restIndex; i++) {
        if (i < expr.arguments.length) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
        } else {
          pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
        }
      }
      // Pack remaining arguments into a vec struct (array + length)
      const restArgCount = Math.max(0, expr.arguments.length - restInfo.restIndex);
      // Push length first (for struct.new order: length, data)
      fctx.body.push({ op: "i32.const", value: restArgCount });
      // Push elements, then array.new_fixed
      for (let i = restInfo.restIndex; i < expr.arguments.length; i++) {
        compileExpression(ctx, fctx, expr.arguments[i]!, restInfo.elemType);
      }
      fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: restArgCount });
      // Wrap in vec struct: { length, data }
      fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
    } else if (hasSpreadArg) {
      // Spread in function call: fn(...arr) — unpack array elements as positional args
      compileSpreadCallArgs(ctx, fctx, expr, funcIdx, restInfo);
    } else {
      // Normal call — compile provided arguments with type hints from function signature
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      for (let i = 0; i < expr.arguments.length; i++) {
        compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
      }

      // Supply defaults for missing optional params
      const optInfo = ctx.funcOptionalParams.get(funcName);
      if (optInfo) {
        const numProvided = expr.arguments.length;
        for (const opt of optInfo) {
          if (opt.index >= numProvided) {
            pushDefaultValue(fctx, opt.type);
          }
        }
      }
    }

    // Re-lookup funcIdx: argument compilation may trigger addUnionImports
    // which shifts defined-function indices, making the earlier lookup stale.
    const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx;
    fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

    // Determine return type from function signature
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (isVoidType(retType)) return VOID_RESULT;
      return resolveWasmType(ctx, retType);
    }
    return { kind: "f64" };
  }

  // Handle standalone super() calls (constructor chaining) — normally handled by
  // compileClassBodies, but handle here as fallback
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    // super() call in constructor — already handled by compileClassBodies inline
    // Just return void since the work is done there
    return null;
  }

  ctx.errors.push({
    message: "Unsupported call expression",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── New expressions ──────────────────────────────────────────────────

/** Compile super.method(args) — resolve to ParentClass_method and call with this */
function compileSuperMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const methodName = propAccess.name.text;

  // Determine which class we're in from the current function name (ClassName_methodName)
  const currentFuncName = fctx.name;
  const underscoreIdx = currentFuncName.indexOf("_");
  if (underscoreIdx === -1) return null;
  const currentClassName = currentFuncName.substring(0, underscoreIdx);

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    ctx.errors.push({
      message: `Cannot use super in class without parent: ${currentClassName}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Resolve parent method — walk up the inheritance chain
  let ancestor: string | undefined = parentClassName;
  let funcIdx: number | undefined;
  while (ancestor) {
    funcIdx = ctx.funcMap.get(`${ancestor}_${methodName}`);
    if (funcIdx !== undefined) break;
    ancestor = ctx.classParentMap.get(ancestor);
  }

  if (funcIdx === undefined) {
    ctx.errors.push({
      message: `Cannot find method '${methodName}' on parent class '${parentClassName}'`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Push this as first argument
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }

  // Push remaining arguments with type hints
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  for (let i = 0; i < expr.arguments.length; i++) {
    compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
  }
  fctx.body.push({ op: "call", funcIdx });

  // Determine return type
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isVoidType(retType)) return null;
    return resolveWasmType(ctx, retType);
  }
  return null;
}

/**
 * Infer the element type of an untyped `new Array()` by scanning how the
 * target variable is used. Walks the enclosing function body for element
 * assignments (arr[i] = value) and push calls (arr.push(value)), then
 * returns the TS element type of the first concrete (non-any) value found.
 */
function inferArrayElementType(ctx: CodegenContext, expr: ts.NewExpression): ts.Type | null {
  // Find the variable name this `new Array()` is assigned to.
  // Pattern: `var x = new Array()` or `var x: T = new Array()`
  const parent = expr.parent;
  let varName: string | null = null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    varName = parent.name.text;
  } else if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
             && ts.isIdentifier(parent.left)) {
    varName = parent.left.text;
  }
  if (!varName) return null;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = expr;
  while (scope && !ts.isFunctionDeclaration(scope) && !ts.isFunctionExpression(scope)
         && !ts.isArrowFunction(scope) && !ts.isMethodDeclaration(scope)
         && !ts.isSourceFile(scope)) {
    scope = scope.parent;
  }
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;

  function visit(node: ts.Node) {
    if (inferredElemType) return; // already found

    // arr[i] = value
    if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isElementAccessExpression(node.left)
        && ts.isIdentifier(node.left.expression)
        && node.left.expression.text === varName) {
      const valType = ctx.checker.getTypeAtLocation(node.right);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    // arr.push(value)
    if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "push"
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === varName
        && node.arguments.length >= 1) {
      const valType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(scope);
  return inferredElemType;
}

function compileNewExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | null {
  const type = ctx.checker.getTypeAtLocation(expr);
  const symbol = type.getSymbol();
  let className = symbol?.name;

  // For class expressions (const C = class { ... }), the symbol name may be
  // the internal anonymous name (e.g. "__class"). Look up the mapped name first,
  // then fall back to the identifier used in the new expression.
  if (className && !ctx.classSet.has(className)) {
    const mapped = ctx.classExprNameMap.get(className);
    if (mapped) {
      className = mapped;
    }
  }
  if ((!className || !ctx.classSet.has(className)) && ts.isIdentifier(expr.expression)) {
    const idName = expr.expression.text;
    if (ctx.classSet.has(idName)) {
      className = idName;
    }
  }

  if (!className) {
    // Unknown constructor (e.g. Test262Error) — call an imported constructor
    // registered upfront by collectUnknownConstructorImports.
    const ctorName = ts.isIdentifier(expr.expression) ? expr.expression.text : "__unknown";
    const importName = `__new_${ctorName}`;
    const funcIdx = ctx.funcMap.get(importName);

    if (funcIdx !== undefined) {
      // Compile arguments as externref
      const args = expr.arguments ?? [];
      for (const arg of args) {
        const resultType = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (resultType && resultType.kind !== "externref") {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
      fctx.body.push({ op: "call", funcIdx });
    } else {
      // Fallback: no import registered (shouldn't happen), produce null
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle local class constructors
  if (ctx.classSet.has(className)) {
    const ctorName = `${className}_new`;
    const funcIdx = ctx.funcMap.get(ctorName);
    if (funcIdx === undefined) {
      ctx.errors.push({
        message: `Missing constructor for class: ${className}`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    // Compile constructor arguments with type hints
    const paramTypes = getFuncParamTypes(ctx, funcIdx);
    const args = expr.arguments ?? [];
    for (let i = 0; i < args.length; i++) {
      compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
    }

    fctx.body.push({ op: "call", funcIdx });
    const structTypeIdx = ctx.structMap.get(className)!;
    return { kind: "ref", typeIdx: structTypeIdx };
  }

  const externInfo = ctx.externClasses.get(className);
  if (externInfo) {
    // Compile constructor arguments with type hints
    const args = expr.arguments ?? [];
    for (let i = 0; i < args.length; i++) {
      compileExpression(ctx, fctx, args[i]!, externInfo.constructorParams[i]);
    }
    // Pad missing optional args with default values
    for (let i = args.length; i < externInfo.constructorParams.length; i++) {
      pushDefaultValue(fctx, externInfo.constructorParams[i]!);
    }

    const importName = `${externInfo.importPrefix}_new`;
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) {
      ctx.errors.push({
        message: `Missing import for constructor: ${importName}`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  // new Array() / new Array(n) / new Array(a, b, c)
  if (className === "Array") {
    // Use contextual type (from variable declaration) if available, else expression type.
    // `new Array()` without type args gives Array<any>, but `var a: number[] = new Array()`
    // needs to produce Array<number> to match the variable's vec type.
    const ctxType = ctx.checker.getContextualType(expr);
    let exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);
    // If element type is `any` (no contextual type, no explicit type arg),
    // infer from how the array variable is used: scan element assignments
    // like arr[i] = value and arr.push(value) to determine the element type.
    let inferredElemWasm: ValType | null = null;
    const rawTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
    if (rawTypeArgs?.[0] && (rawTypeArgs[0].flags & ts.TypeFlags.Any)) {
      const inferredElemTsType = inferArrayElementType(ctx, expr);
      if (inferredElemTsType) {
        inferredElemWasm = resolveWasmType(ctx, inferredElemTsType);
      }
    }

    let vecTypeIdx: number;
    let arrTypeIdx: number;
    let elemWasm: ValType;
    if (inferredElemWasm) {
      // Use inferred element type to register/find the right vec type
      const elemKey =
        inferredElemWasm.kind === "ref" || inferredElemWasm.kind === "ref_null"
          ? `ref_${(inferredElemWasm as { typeIdx: number }).typeIdx}`
          : inferredElemWasm.kind;
      vecTypeIdx = getOrRegisterVecType(ctx, elemKey, inferredElemWasm);
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      elemWasm = inferredElemWasm;
    } else {
      const resolved = resolveWasmType(ctx, exprType);
      vecTypeIdx = (resolved as { typeIdx: number }).typeIdx;
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const typeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
      const elemTsType = typeArgs?.[0];
      elemWasm = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
    }

    if (arrTypeIdx < 0) {
      ctx.errors.push({ message: "new Array(): invalid vec type", line: getLine(expr), column: getCol(expr) });
      return null;
    }

    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // new Array() → empty array with default backing capacity
      // JS arrays are dynamically resizable; wasm arrays are fixed-size.
      // Allocate a default backing buffer so index assignments work.
      const DEFAULT_CAPACITY = 64;
      fctx.body.push({ op: "i32.const", value: 0 });           // length = 0
      fctx.body.push({ op: "i32.const", value: DEFAULT_CAPACITY });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    if (args.length === 1) {
      // new Array(n) → array with capacity n, length 0
      // For test262 patterns like `var a = new Array(16); a[0] = x;`
      // we create an array of size n with default values and set length to n
      // (JS semantics: sparse array with length n, all slots undefined)
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_f64_s" });
      const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.tee", index: sizeLocal });
      fctx.body.push({ op: "local.get", index: sizeLocal });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    // new Array(a, b, c) → [a, b, c]
    for (const arg of args) {
      compileExpression(ctx, fctx, arg, elemWasm);
    }
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: args.length });
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: args.length });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  ctx.errors.push({
    message: `Unsupported new expression for class: ${className}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Extern class inheritance helper ──────────────────────────────────

import type { ExternClassInfo } from "./index.js";

/** Walk the externClassParent chain to find the extern class that declares a member */
function findExternInfoForMember(
  ctx: CodegenContext,
  className: string,
  memberName: string,
  kind: "method" | "property",
): ExternClassInfo | null {
  let current: string | undefined = className;
  while (current) {
    const info = ctx.externClasses.get(current);
    if (info) {
      if (kind === "method" && info.methods.has(memberName)) return info;
      if (kind === "property" && info.properties.has(memberName)) return info;
    }
    current = ctx.externClassParent.get(current);
  }
  return null;
}

// ── Extern method calls ──────────────────────────────────────────────

function compileExternMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const className = receiverType.getSymbol()?.name;
  const methodName = propAccess.name.text;

  if (!className) return null;

  // Walk inheritance chain to find the class that declares the method
  const resolvedInfo = findExternInfoForMember(ctx, className, methodName, "method");
  const externInfo = resolvedInfo ?? ctx.externClasses.get(className);
  if (!externInfo) {
    ctx.errors.push({
      message: `Unknown extern class: ${className}`,
      line: getLine(callExpr),
      column: getCol(callExpr),
    });
    return null;
  }

  // Push 'this' (the receiver object)
  compileExpression(ctx, fctx, propAccess.expression);

  // Push arguments with type hints (params[0] is 'this', args start at [1])
  const methodOwner = resolvedInfo ?? externInfo;
  const methodInfo = methodOwner.methods.get(methodName);
  for (let i = 0; i < callExpr.arguments.length; i++) {
    const hint = methodInfo?.params[i + 1]; // +1 to skip 'this'
    compileExpression(ctx, fctx, callExpr.arguments[i]!, hint);
  }

  // Pad missing optional args with default values
  if (methodInfo) {
    const actualArgs = callExpr.arguments.length + 1; // +1 for 'this'
    for (let i = actualArgs; i < methodInfo.params.length; i++) {
      pushDefaultValue(fctx, methodInfo.params[i]!);
    }
  }

  const importName = `${methodOwner.importPrefix}_${methodName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    ctx.errors.push({
      message: `Missing import for method: ${importName}`,
      line: getLine(callExpr),
      column: getCol(callExpr),
    });
    return null;
  }

  fctx.body.push({ op: "call", funcIdx });

  if (!methodInfo || methodInfo.results.length === 0) return VOID_RESULT;
  return methodInfo.results[0]!;
}

// ── Helper: push default value for a type ────────────────────────────

function pushDefaultValue(fctx: FunctionContext, type: ValType): void {
  switch (type.kind) {
    case "f64":
      fctx.body.push({ op: "f64.const", value: 0 });
      break;
    case "i32":
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
    case "i64":
      fctx.body.push({ op: "i64.const", value: 0n });
      break;
    case "externref":
      fctx.body.push({ op: "ref.null.extern" });
      break;
    case "ref_null":
    case "ref":
      fctx.body.push({ op: "ref.null", typeIdx: type.typeIdx });
      break;
    default:
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
  }
}

// ── Spread in function calls ─────────────────────────────────────────

/**
 * Compile function call arguments when spread syntax is used: fn(...arr)
 * For non-rest targets: unpack array elements as positional args using locals.
 * For rest-param targets: pass the spread array directly as the rest param.
 */
function compileSpreadCallArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  funcIdx: number,
  restInfo: RestParamInfo | undefined,
): void {
  const paramTypes = getFuncParamTypes(ctx, funcIdx);

  if (restInfo) {
    // Calling a rest-param function with spread — compile non-rest args normally,
    // then for the rest portion, if it's a single spread of an array, pass directly
    let argIdx = 0;
    for (let i = 0; i < restInfo.restIndex; i++) {
      if (argIdx < expr.arguments.length) {
        compileExpression(ctx, fctx, expr.arguments[argIdx]!, paramTypes?.[i]);
        argIdx++;
      }
    }
    // Remaining args should be a single spread element — pass the vec directly
    if (argIdx < expr.arguments.length) {
      const restArg = expr.arguments[argIdx]!;
      if (ts.isSpreadElement(restArg)) {
        // The spread source is already a vec struct — pass directly
        compileExpression(ctx, fctx, restArg.expression);
      } else {
        // Single non-spread arg as rest — wrap in vec struct { 1, [val] }
        fctx.body.push({ op: "i32.const", value: 1 });
        compileExpression(ctx, fctx, restArg, restInfo.elemType);
        fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: 1 });
        fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
      }
    } else {
      // No rest args provided — pass empty vec struct { 0, [] }
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: 0 });
      fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
    }
    return;
  }

  // Non-rest target: fn(...arr) — unpack array elements from vec struct into positional args
  // Strategy: for each spread arg, store the vec in a local, extract data array, then extract elements by index
  if (!paramTypes) return;

  // Collect all arguments, resolving spreads
  let paramIdx = 0;
  for (const arg of expr.arguments) {
    if (ts.isSpreadElement(arg)) {
      // Compile the spread source (vec struct)
      const vecType = compileExpression(ctx, fctx, arg.expression);
      if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) continue;

      const vecTypeDef = ctx.mod.types[vecType.typeIdx];
      if (!vecTypeDef || vecTypeDef.kind !== "struct") continue;

      // Extract data array from vec struct
      const vecLocal = allocLocal(fctx, `__spread_vec_${fctx.locals.length}`, vecType);
      fctx.body.push({ op: "local.set", index: vecLocal });

      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecType.typeIdx);
      if (arrTypeIdx < 0) continue;
      const dataLocal = allocLocal(fctx, `__spread_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vecType.typeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "local.set", index: dataLocal });

      // Extract elements up to the remaining parameter count
      const remainingParams = paramTypes.length - paramIdx;
      for (let i = 0; i < remainingParams; i++) {
        fctx.body.push({ op: "local.get", index: dataLocal });
        fctx.body.push({ op: "i32.const", value: i });
        fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
        paramIdx++;
      }
    } else {
      compileExpression(ctx, fctx, arg, paramTypes[paramIdx]);
      paramIdx++;
    }
  }
}

// ── Builtins ─────────────────────────────────────────────────────────

function compileConsoleCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: string,
): InnerResult {
  for (const arg of expr.arguments) {
    const argType = ctx.checker.getTypeAtLocation(arg);
    compileExpression(ctx, fctx, arg);

    if (isStringType(argType)) {
      // Fast mode: flatten + marshal native string to externref before passing to host
      if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
        const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
        if (strFlattenIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        }
        const toExternIdx = ctx.nativeStrHelpers.get("__str_to_extern");
        if (toExternIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toExternIdx });
        }
      }
      const funcIdx = ctx.funcMap.get(`console_${method}_string`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isBooleanType(argType)) {
      const funcIdx = ctx.funcMap.get(`console_${method}_bool`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isNumberType(argType)) {
      const funcIdx = ctx.funcMap.get(`console_${method}_number`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else {
      // externref: DOM objects, class instances, anything else
      const funcIdx = ctx.funcMap.get(`console_${method}_externref`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    }
  }
  return VOID_RESULT;
}

function compileMathCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  expr: ts.CallExpression,
): ValType | null {
  // Native Wasm unary opcodes
  const nativeUnary: Record<string, string> = {
    sqrt: "f64.sqrt",
    abs: "f64.abs",
    floor: "f64.floor",
    ceil: "f64.ceil",
    trunc: "f64.trunc",
    nearest: "f64.nearest",
  };

  const f64Hint: ValType = { kind: "f64" };

  if (method === "round" && expr.arguments.length >= 1) {
    // JS Math.round: floor(x + 0.5), but values in [-0.5, -0] must return -0.
    // Use copysign(0, x) when floor(x+0.5) is zero to preserve the sign.
    const xLocal = allocLocal(fctx, `__round_x_${fctx.locals.length}`, { kind: "f64" });
    const rLocal = allocLocal(fctx, `__round_r_${fctx.locals.length}`, { kind: "f64" });
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "local.tee", index: xLocal } as Instr);
    fctx.body.push({ op: "f64.const", value: 0.5 } as Instr);
    fctx.body.push({ op: "f64.add" } as Instr);
    fctx.body.push({ op: "f64.floor" } as Instr);
    fctx.body.push({ op: "local.tee", index: rLocal } as Instr);
    // If result == 0, use copysign(0, x) to preserve -0
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    fctx.body.push({ op: "f64.eq" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "f64.const", value: 0 } as Instr,
        { op: "local.get", index: xLocal } as Instr,
        { op: "f64.copysign" } as unknown as Instr,
      ],
      else: [
        { op: "local.get", index: rLocal } as Instr,
      ],
    } as Instr);
    return { kind: "f64" };
  }

  if (method in nativeUnary && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: nativeUnary[method]! } as Instr);
    return { kind: "f64" };
  }

  // Math.clz32(n) → ToUint32(n) then i32.clz
  // ToUint32: NaN/±Infinity → 0; otherwise truncate then modulo 2^32.
  // We use the host-imported __toUint32 for correct edge-case handling.
  if (method === "clz32" && expr.arguments.length >= 1) {
    const toU32Idx = ctx.funcMap.get("__toUint32");
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    fctx.body.push({ op: "i32.clz" } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  // Math.imul(a, b) → ToUint32(a) * ToUint32(b), result as signed i32
  if (method === "imul" && expr.arguments.length >= 2) {
    const toU32Idx = ctx.funcMap.get("__toUint32");
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    fctx.body.push({ op: "i32.mul" } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  if (method === "sign" && expr.arguments.length >= 1) {
    // sign(x): NaN→NaN, -0→-0, 0→0, x>0→1, x<0→-1
    // Use f64.copysign to preserve -0 and NaN passthrough:
    //   if (x !== x) return NaN  (NaN check)
    //   if (x == 0) return x     (preserves -0/+0)
    //   return x > 0 ? 1 : -1
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    const tmp = allocLocal(fctx, `__sign_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.tee", index: tmp });
    // NaN check: x !== x
    fctx.body.push({ op: "local.get", index: tmp });
    fctx.body.push({ op: "f64.ne" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        // return NaN
        { op: "f64.const", value: NaN },
      ],
      else: [
        // x == 0 check (true for both +0 and -0)
        { op: "local.get", index: tmp },
        { op: "f64.abs" } as Instr,
        { op: "f64.const", value: 0 },
        { op: "f64.eq" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            // return x (preserves -0)
            { op: "local.get", index: tmp },
          ],
          else: [
            // return copysign(1.0, x) — gives 1 or -1 based on sign of x
            { op: "f64.const", value: 1 },
            { op: "local.get", index: tmp },
            { op: "f64.copysign" } as unknown as Instr,
          ],
        },
      ],
    });
    return { kind: "f64" };
  }

  // Math.fround(x) → f64.promote_f32(f32.demote_f64(x))
  if (method === "fround" && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "f32.demote_f64" } as Instr);
    fctx.body.push({ op: "f64.promote_f32" } as Instr);
    return { kind: "f64" };
  }

  // Math.hypot(a, b) → sqrt(a*a + b*b) — inline for the common 2-arg case
  if (method === "hypot") {
    if (expr.arguments.length === 0) {
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }
    if (expr.arguments.length === 1) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      fctx.body.push({ op: "f64.abs" } as Instr);
      return { kind: "f64" };
    }
    // 2+ args: spec says if any arg is +-Infinity → +Infinity, else sqrt(sum of squares)
    const hypotLocals: number[] = [];
    for (let ai = 0; ai < expr.arguments.length; ai++) {
      const loc = allocLocal(fctx, `__hypot_${fctx.locals.length}`, { kind: "f64" });
      compileExpression(ctx, fctx, expr.arguments[ai]!, f64Hint);
      fctx.body.push({ op: "local.set", index: loc });
      hypotLocals.push(loc);
    }
    // Check if any arg is +-Infinity: abs(x) == +Inf
    // Build: abs(a0)==Inf || abs(a1)==Inf || ...
    for (let i = 0; i < hypotLocals.length; i++) {
      fctx.body.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      fctx.body.push({ op: "f64.abs" } as Instr);
      fctx.body.push({ op: "f64.const", value: Infinity });
      fctx.body.push({ op: "f64.eq" } as Instr);
      if (i > 0) {
        fctx.body.push({ op: "i32.or" } as Instr);
      }
    }
    // if any is Inf, return +Infinity, else sqrt(sum of squares)
    const thenBlock: Instr[] = [{ op: "f64.const", value: Infinity }];
    const elseBlock: Instr[] = [];
    for (let i = 0; i < hypotLocals.length; i++) {
      elseBlock.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      elseBlock.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      elseBlock.push({ op: "f64.mul" } as Instr);
    }
    for (let i = 1; i < hypotLocals.length; i++) {
      elseBlock.push({ op: "f64.add" } as Instr);
    }
    elseBlock.push({ op: "f64.sqrt" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: thenBlock,
      else: elseBlock,
    });
    return { kind: "f64" };
  }

  // Host-imported Math methods (1-arg): sin, cos, tan, exp, log, etc.
  const hostUnary = new Set([
    "exp", "log", "log2", "log10",
    "sin", "cos", "tan", "asin", "acos", "atan",
    "acosh", "asinh", "atanh", "cbrt", "expm1", "log1p",
  ]);
  if (hostUnary.has(method) && expr.arguments.length >= 1) {
    const funcIdx = ctx.funcMap.get(`Math_${method}`);
    if (funcIdx !== undefined) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Host-imported Math methods (2-arg): pow, atan2
  if ((method === "pow" || method === "atan2") && expr.arguments.length >= 2) {
    const funcIdx = ctx.funcMap.get(`Math_${method}`);
    if (funcIdx !== undefined) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Math.random() — 0-arg host import
  if (method === "random") {
    const funcIdx = ctx.funcMap.get("Math_random");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Math.min(...args) / Math.max(...args) — variadic with NaN propagation
  // Wasm f64.min/f64.max don't propagate NaN from the first operand in all
  // engines, so we guard each argument: if any arg is NaN, return NaN.
  // Compile-time optimization: if an arg is statically NaN, emit NaN directly.
  if ((method === "min" || method === "max") && expr.arguments) {
    const wasmOp = method === "min" ? "f64.min" : "f64.max";
    if (expr.arguments.length === 0) {
      fctx.body.push({ op: "f64.const", value: method === "min" ? Infinity : -Infinity } as Instr);
      return { kind: "f64" };
    }

    // Check if any argument is statically NaN → short-circuit
    if (expr.arguments.some(a => isStaticNaN(ctx, a))) {
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    // Try static valueOf resolution for each argument.
    // For object-typed arguments, tryStaticToNumber resolves {} → NaN,
    // { valueOf: () => 42 } → 42, { valueOf: () => void } → NaN, etc.
    const staticValues: (number | undefined)[] = expr.arguments.map(a => {
      const tsType = ctx.checker.getTypeAtLocation(a);
      // Only apply static valueOf to non-number types (objects)
      if (tsType.flags & ts.TypeFlags.Object) {
        return tryStaticToNumber(ctx, a);
      }
      return undefined;
    });

    // If ALL arguments resolved statically, compute the result at compile time
    if (staticValues.every(v => v !== undefined)) {
      const nums = staticValues as number[];
      const result = method === "min"
        ? nums.reduce((a, b) => Math.min(a, b))
        : nums.reduce((a, b) => Math.max(a, b));
      fctx.body.push({ op: "f64.const", value: result });
      return { kind: "f64" };
    }

    // 1 arg: no f64.min needed, just return the value (or its static resolution)
    if (expr.arguments.length === 1) {
      if (staticValues[0] !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticValues[0] });
      } else {
        compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      }
      return { kind: "f64" };
    }

    // 2+ args: compile into locals, check each for NaN at runtime, then chain f64.min/max
    const argLocals: number[] = [];
    for (let ai = 0; ai < expr.arguments.length; ai++) {
      const local = allocLocal(fctx, `__minmax_${fctx.locals.length}`, { kind: "f64" });
      if (staticValues[ai] !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticValues[ai]! });
      } else {
        compileExpression(ctx, fctx, expr.arguments[ai]!, f64Hint);
      }
      fctx.body.push({ op: "local.set", index: local });
      argLocals.push(local);
    }

    // Build nested if chain: for each arg, check isNaN → return it, else continue
    // Result type is f64 for each if block
    const f64Block = { kind: "val" as const, type: { kind: "f64" as const } };

    // Build from inside out: innermost is the actual f64.min/max chain
    let innerBody: Instr[] = [{ op: "local.get", index: argLocals[0]! }];
    for (let i = 1; i < argLocals.length; i++) {
      innerBody.push({ op: "local.get", index: argLocals[i]! });
      innerBody.push({ op: wasmOp } as unknown as Instr);
    }

    // Wrap with NaN checks from last arg to first
    for (let i = argLocals.length - 1; i >= 0; i--) {
      innerBody = [
        // isNaN check: local.get, local.get, f64.ne (x !== x)
        { op: "local.get", index: argLocals[i]! },
        { op: "local.get", index: argLocals[i]! },
        { op: "f64.ne" } as Instr,
        {
          op: "if",
          blockType: f64Block,
          then: [{ op: "local.get", index: argLocals[i]! }],
          else: innerBody,
        } as Instr,
      ];
    }

    for (const instr of innerBody) {
      fctx.body.push(instr);
    }
    return { kind: "f64" };
  }

  ctx.errors.push({
    message: `Unsupported Math method: ${method}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

function compileConditionalExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ConditionalExpression,
): ValType | null {
  const condType = compileExpression(ctx, fctx, expr.condition);
  if (!condType) { ctx.errors.push({ message: "Failed to compile conditional expression condition", line: getLine(expr), column: getCol(expr) }); return null; }
  ensureI32Condition(fctx, condType, ctx);

  const savedBody = fctx.body;
  fctx.body = [];
  const thenResultType = compileExpression(ctx, fctx, expr.whenTrue);
  let thenInstrs = fctx.body;

  fctx.body = [];
  const elseResultType = compileExpression(ctx, fctx, expr.whenFalse);
  let elseInstrs = fctx.body;

  fctx.body = savedBody;

  const thenType: ValType = thenResultType ?? { kind: "i32" };
  const elseType: ValType = elseResultType ?? { kind: "i32" };

  // Determine the common result type for both branches
  let resultValType: ValType = thenType;

  const sameKind = thenType.kind === elseType.kind;
  const sameRefIdx = sameKind &&
    (thenType.kind === "ref" || thenType.kind === "ref_null") &&
    (thenType as { typeIdx: number }).typeIdx === (elseType as { typeIdx: number }).typeIdx;

  if (!sameKind || ((thenType.kind === "ref" || thenType.kind === "ref_null") && !sameRefIdx)) {
    // Types differ — find a common type and coerce both branches
    if ((thenType.kind === "i32" || thenType.kind === "f64") &&
        (elseType.kind === "i32" || elseType.kind === "f64")) {
      // Both numeric — coerce to f64
      resultValType = { kind: "f64" };
    } else if ((thenType.kind === "ref" || thenType.kind === "ref_null") &&
               (elseType.kind === "ref" || elseType.kind === "ref_null") &&
               isAnyValue(thenType, ctx) === isAnyValue(elseType, ctx)) {
      // Both refs but different typeIdx — use ref_null of the then type
      resultValType = thenType.kind === "ref"
        ? { kind: "ref_null", typeIdx: (thenType as { typeIdx: number }).typeIdx }
        : thenType;
    } else {
      // Fallback: coerce both to externref
      resultValType = { kind: "externref" };
    }

    // Coerce then-branch to the common type
    if (!valTypesMatch(thenType, resultValType)) {
      const coerceBody: Instr[] = [];
      fctx.body = coerceBody;
      coerceType(ctx, fctx, thenType, resultValType);
      fctx.body = savedBody;
      thenInstrs = [...thenInstrs, ...coerceBody];
    }

    // Coerce else-branch to the common type
    if (!valTypesMatch(elseType, resultValType)) {
      const coerceBody: Instr[] = [];
      fctx.body = coerceBody;
      coerceType(ctx, fctx, elseType, resultValType);
      fctx.body = savedBody;
      elseInstrs = [...elseInstrs, ...coerceBody];
    }
  } else {
    // Same type — just pass the then-type through
    resultValType = thenType;
  }

  // Conditional results must be nullable — either branch could produce null
  if (resultValType.kind === "ref") {
    resultValType = { kind: "ref_null", typeIdx: (resultValType as { typeIdx: number }).typeIdx };
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultValType },
    then: thenInstrs,
    else: elseInstrs,
  });

  return resultValType;
}

// ── Optional chaining ────────────────────────────────────────────────

/**
 * Optional property access: obj?.prop
 * Compiles obj, checks if null → returns null, else accesses property normally.
 */
function compileOptionalPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  // Compile the receiver
  const objType = compileExpression(ctx, fctx, expr.expression);
  if (!objType) return null;

  const tmp = allocLocal(fctx, `__opt_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  // Determine result type by compiling the non-optional access in isolation
  // Create a synthetic non-optional expression to get the property type
  const resultType: ValType = { kind: "externref" };

  const savedBody = fctx.body;

  // then branch (null path): push null
  const thenInstrs: Instr[] = [{ op: "ref.null.extern" }];

  // else branch (non-null path): get the property from the temp
  fctx.body = [];
  fctx.body.push({ op: "local.get", index: tmp });
  // Compile the property access part without the receiver
  const tsObjType = ctx.checker.getTypeAtLocation(expr.expression);
  const propName = expr.name.text;
  if (isExternalDeclaredClass(tsObjType, ctx.checker)) {
    compileExternPropertyGetFromStack(ctx, fctx, tsObjType, propName);
  } else if (isStringType(tsObjType) && propName === "length") {
    if (ctx.fast && ctx.anyStrTypeIdx >= 0) {
      // len is field 0 of $AnyString — works for both FlatString and ConsString
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
    } else {
      const funcIdx = ctx.funcMap.get("length");
      if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
    }
  }
  const elseInstrs = fctx.body;

  fctx.body = savedBody;
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });

  return resultType;
}

/** Helper: compile extern property get when receiver is already on stack */
function compileExternPropertyGetFromStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objType: ts.Type,
  propName: string,
): void {
  const className = objType.getSymbol()?.name;
  if (!className) return;
  // Walk inheritance chain to find the property
  let current: string | undefined = className;
  while (current) {
    const info = ctx.externClasses.get(current);
    if (info?.properties.has(propName)) {
      const importName = `${info.importPrefix}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      return;
    }
    current = (ctx as any).externClassParent?.get(current);
  }
}

/**
 * Optional call: obj?.method(args)
 * Compiles obj, checks if null → returns null/undefined, else calls method normally.
 */
function compileOptionalCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const propAccess = expr.expression as ts.PropertyAccessExpression;

  // Compile the receiver and check for null
  const objType = compileExpression(ctx, fctx, propAccess.expression);
  if (!objType) return null;

  const tmp = allocLocal(fctx, `__optcall_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  const resultType: ValType = { kind: "externref" };

  const savedBody = fctx.body;

  // then branch (null path): push null
  const thenInstrs: Instr[] = [{ op: "ref.null.extern" }];

  // else branch (non-null path): call the method
  fctx.body = [];
  // Re-push receiver from temp, then compile the call normally
  fctx.body.push({ op: "local.get", index: tmp });
  const tsReceiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const methodName = propAccess.name.text;
  if (isExternalDeclaredClass(tsReceiverType, ctx.checker)) {
    // Find the method import and call it
    const className = tsReceiverType.getSymbol()?.name;
    if (className) {
      let current: string | undefined = className;
      while (current) {
        const info = ctx.externClasses.get(current);
        if (info?.methods.has(methodName)) {
          const importName = `${info.importPrefix}_${methodName}`;
          const funcIdx = ctx.funcMap.get(importName);
          if (funcIdx !== undefined) {
            // Compile arguments
            for (const arg of expr.arguments) {
              compileExpression(ctx, fctx, arg);
            }
            fctx.body.push({ op: "call", funcIdx });
          }
          break;
        }
        current = (ctx as any).externClassParent?.get(current);
      }
    }
  }
  const elseInstrs = fctx.body;

  fctx.body = savedBody;
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });

  return resultType;
}

// ── Property access ──────────────────────────────────────────────────

function compilePropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  // Optional chaining: obj?.prop
  if (expr.questionDotToken) {
    return compileOptionalPropertyAccess(ctx, fctx, expr);
  }

  const objType = ctx.checker.getTypeAtLocation(expr.expression);
  const propName = ts.isPrivateIdentifier(expr.name) ? expr.name.text.slice(1) : expr.name.text;

  // Check for enum member access: EnumName.Member
  if (ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    const enumKey = `${objName}.${propName}`;
    const enumVal = ctx.enumValues.get(enumKey);
    if (enumVal !== undefined) {
      fctx.body.push({ op: "f64.const", value: enumVal });
      return { kind: "f64" };
    }
    // Check for string enum member access
    const enumStrVal = ctx.enumStringValues.get(enumKey);
    if (enumStrVal !== undefined) {
      return compileStringLiteral(ctx, fctx, enumStrVal);
    }
  }

  // Check for static property access: ClassName.staticProp
  if (ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    if (ctx.classSet.has(objName)) {
      const fullName = `${objName}_${propName}`;
      const globalIdx = ctx.staticProps.get(fullName);
      if (globalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: globalIdx });
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        return globalDef?.type ?? { kind: "f64" };
      }
    }
  }

  // Handle Math.<method>.length — static function arity
  if (propName === "length" &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "Math") {
    const mathMethodArity: Record<string, number> = {
      abs: 1, ceil: 1, floor: 1, round: 1, trunc: 1, sign: 1,
      sqrt: 1, cbrt: 1, clz32: 1, fround: 1,
      exp: 1, expm1: 1, log: 1, log2: 1, log10: 1, log1p: 1,
      sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1,
      sinh: 1, cosh: 1, tanh: 1, asinh: 1, acosh: 1, atanh: 1,
      min: 2, max: 2, pow: 2, atan2: 2, imul: 2, hypot: 2,
      random: 0,
    };
    const method = expr.expression.name.text;
    if (method in mathMethodArity) {
      fctx.body.push({ op: "f64.const", value: mathMethodArity[method]! });
      return { kind: "f64" };
    }
  }

  // Handle array.length (vec struct: field 0 is the logical length)
  if (propName === "length") {
    // Shape-inferred array-like: obj.length → struct.get vec field 0
    if (ts.isIdentifier(expr.expression)) {
      const shapeInfo = ctx.shapeMap.get(expr.expression.text);
      if (shapeInfo) {
        compileExpression(ctx, fctx, expr.expression);
        fctx.body.push({ op: "struct.get", typeIdx: shapeInfo.vecTypeIdx, fieldIdx: 0 });
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
    // Check the actual local type (may differ from TS type, e.g. arguments vec struct)
    if (ts.isIdentifier(expr.expression)) {
      const localIdx = fctx.localMap.get(expr.expression.text);
      if (localIdx !== undefined) {
        const localType = localIdx < fctx.params.length
          ? fctx.params[localIdx]!.type
          : fctx.locals[localIdx - fctx.params.length]?.type;
        if (localType?.kind === "externref") {
          const funcIdx = ctx.funcMap.get("__extern_length");
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: localIdx });
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "f64" };
          }
        }
        // Vec struct ref local (e.g. `arguments` object) — struct.get field 0 (length)
        if ((localType?.kind === "ref" || localType?.kind === "ref_null") && localType.typeIdx !== undefined) {
          const vecTypeIdx = (localType as { typeIdx: number }).typeIdx;
          const typeDef = ctx.mod.types[vecTypeIdx];
          if (typeDef?.kind === "struct" && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data") {
            fctx.body.push({ op: "local.get", index: localIdx });
            fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
            if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
            return ctx.fast ? { kind: "i32" } : { kind: "f64" };
          }
        }
      }
    }
    const objWasmType = resolveWasmType(ctx, objType);
    if (objWasmType.kind === "ref" || objWasmType.kind === "ref_null") {
      const vecTypeIdx = (objWasmType as { typeIdx: number }).typeIdx;
      const typeDef = ctx.mod.types[vecTypeIdx];
      if (typeDef?.kind === "struct" && typeDef.fields[1]?.name === "data") {
        compileExpression(ctx, fctx, expr.expression);
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // get length from vec
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
  }

  // Handle Math constants
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Math"
  ) {
    const mathConstants: Record<string, number> = {
      PI: Math.PI,
      E: Math.E,
      LN2: Math.LN2,
      LN10: Math.LN10,
      SQRT2: Math.SQRT2,
    };
    if (propName in mathConstants) {
      fctx.body.push({ op: "f64.const", value: mathConstants[propName]! });
      return { kind: "f64" };
    }
  }

  // Handle Number constants
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Number"
  ) {
    const numberConstants: Record<string, number> = {
      EPSILON: Number.EPSILON,
      MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
      MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
      MAX_VALUE: Number.MAX_VALUE,
      MIN_VALUE: Number.MIN_VALUE,
      POSITIVE_INFINITY: Infinity,
      NEGATIVE_INFINITY: -Infinity,
      NaN: NaN,
    };
    if (propName in numberConstants) {
      fctx.body.push({ op: "f64.const", value: numberConstants[propName]! });
      return { kind: "f64" };
    }
  }

  // Handle string.length
  if (isStringType(objType) && propName === "length") {
    compileExpression(ctx, fctx, expr.expression);
    if (ctx.fast && ctx.anyStrTypeIdx >= 0) {
      // len is field 0 of $AnyString — works for both FlatString and ConsString
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
      return { kind: "i32" };
    }
    const funcIdx = ctx.funcMap.get("length");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
  }

  // Handle IteratorResult property access: .value and .done
  if (isIteratorResultType(objType) || isGeneratorIteratorResultLike(ctx, objType, propName)) {
    if (propName === "value") {
      compileExpression(ctx, fctx, expr.expression);
      // Check the expected value type from the IteratorResult<T>
      const valueType = getIteratorResultValueType(ctx, objType);
      if (valueType && valueType.kind === "f64") {
        const funcIdx = ctx.funcMap.get("__gen_result_value_f64");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "f64" };
        }
      }
      const funcIdx = ctx.funcMap.get("__gen_result_value");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    if (propName === "done") {
      compileExpression(ctx, fctx, expr.expression);
      const funcIdx = ctx.funcMap.get("__gen_result_done");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
    }
  }

  // Handle externref property access
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    return compileExternPropertyGet(ctx, fctx, expr, objType, propName);
  }

  // Handle getter accessor on user-defined classes
  const typeName = resolveStructName(ctx, objType);
  if (typeName) {
    const accessorKey = `${typeName}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${typeName}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        compileExpression(ctx, fctx, expr.expression);
        fctx.body.push({ op: "call", funcIdx });
        // Use the property type from the checker to determine the return type
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }

    // Handle struct field access (named or anonymous)
    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        compileExpression(ctx, fctx, expr.expression);
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx,
        });
        return fields[fieldIdx]!.type;
      }
    }
  }

  ctx.errors.push({
    message: `Cannot access property '${propName}' on type '${ctx.checker.typeToString(objType)}'`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

function compileExternPropertyGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  objType: ts.Type,
  propName: string,
): ValType | null {
  const className = objType.getSymbol()?.name;
  if (!className) return null;

  // Walk inheritance chain to find the class that declares the property
  const resolvedInfo = findExternInfoForMember(ctx, className, propName, "property");
  const propOwner = resolvedInfo ?? ctx.externClasses.get(className);
  if (!propOwner) return null;

  // Push the object
  compileExpression(ctx, fctx, expr.expression);

  const importName = `${propOwner.importPrefix}_get_${propName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    ctx.errors.push({
      message: `Missing import for property get: ${importName}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  fctx.body.push({ op: "call", funcIdx });

  const propInfo = propOwner.properties.get(propName);
  return propInfo?.type ?? { kind: "externref" };
}

function compileElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  const objType = compileExpression(ctx, fctx, expr.expression);
  if (!objType) return null;

  // Externref element access: obj[idx] → host import __extern_get(obj, f64) → externref
  if (objType.kind === "externref") {
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
    const funcIdx = ctx.funcMap.get("__extern_get");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    ctx.errors.push({
      message: "Element access on externref requires __extern_get import",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  if (objType.kind !== "ref" && objType.kind !== "ref_null") {
    ctx.errors.push({
      message: "Element access on non-array value",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  const typeIdx = (objType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle tuple struct — element access with literal index → struct.get
  if (typeDef?.kind === "struct") {
    const isVecStructAccess = typeDef.fields.length === 2 &&
      typeDef.fields[0]?.name === "length" &&
      typeDef.fields[1]?.name === "data";

    if (!isVecStructAccess) {
      // Check if this is a tuple struct (registered in tupleTypeMap)
      const isTuple = Array.from(ctx.tupleTypeMap.values()).includes(typeIdx);
      if (isTuple) {
        // Tuple element access requires a literal numeric index
        if (!ts.isNumericLiteral(expr.argumentExpression)) {
          ctx.errors.push({
            message: "Tuple element access requires a numeric literal index",
            line: getLine(expr),
            column: getCol(expr),
          });
          return null;
        }
        const fieldIdx = Number(expr.argumentExpression.text);
        if (fieldIdx < 0 || fieldIdx >= typeDef.fields.length) {
          ctx.errors.push({
            message: `Tuple index ${fieldIdx} out of bounds (tuple has ${typeDef.fields.length} elements)`,
            line: getLine(expr),
            column: getCol(expr),
          });
          return null;
        }
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
        return typeDef.fields[fieldIdx]!.type;
      }
      // String/numeric literal index on a plain struct → resolve to struct.get by field name
      let fieldName: string | undefined;
      if (ts.isStringLiteral(expr.argumentExpression)) {
        fieldName = expr.argumentExpression.text;
      } else if (ts.isNumericLiteral(expr.argumentExpression)) {
        fieldName = expr.argumentExpression.text;
      } else if (ts.isIdentifier(expr.argumentExpression)) {
        // Const variable reference: const key = "x"; obj[key]
        const sym = ctx.checker.getSymbolAtLocation(expr.argumentExpression);
        if (sym) {
          const decl = sym.valueDeclaration;
          if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            const declList = decl.parent;
            if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
              if (ts.isStringLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              } else if (ts.isNumericLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              }
            }
          }
        }
      }
      // Also handle simple binary expressions that evaluate to a known value
      // e.g. obj[1 + 1] where 1+1 = "2" as field name
      if (fieldName === undefined) {
        const constVal = resolveConstantExpression(ctx, expr.argumentExpression);
        if (constVal !== undefined) {
          fieldName = String(constVal);
        }
      }
      if (fieldName !== undefined) {
        // Check for getter accessor first (obj['prop'] where prop has a getter)
        const objTsType = ctx.checker.getTypeAtLocation(expr.expression);
        const sName = resolveStructName(ctx, objTsType);
        if (sName) {
          const accessorKey = `${sName}_${fieldName}`;
          if (ctx.classAccessorSet.has(accessorKey)) {
            const getterName = `${sName}_get_${fieldName}`;
            const funcIdx = ctx.funcMap.get(getterName);
            if (funcIdx !== undefined) {
              // obj ref is already on stack from compileExpression above
              fctx.body.push({ op: "call", funcIdx });
              const propType = ctx.checker.getTypeAtLocation(expr);
              return resolveWasmType(ctx, propType);
            }
          }
        }

        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx >= 0) {
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          return typeDef.fields[fieldIdx]!.type;
        }
      }
      // Non-vec, non-tuple struct: element access not supported
      ctx.errors.push({
        message: `Element access on struct type '${typeDef.name ?? "unknown"}'`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    // Handle vec struct (array wrapped in {length, data})
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      ctx.errors.push({ message: "Element access: vec data is not array", line: 0, column: 0 });
      return null;
    }
    // Unwrap: struct.get data field, then index into backing array
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
    if (ctx.fast) {
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
    fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
    return arrDef.element;
  }

  if (!typeDef || typeDef.kind !== "array") {
    ctx.errors.push({
      message: "Element access on non-array type",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Compile index and convert to i32
  if (ctx.fast) {
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_f64_s" });
  }

  fctx.body.push({ op: "array.get", typeIdx });
  return typeDef.element;
}

function resolveStructName(ctx: CodegenContext, tsType: ts.Type): string | undefined {
  const name = tsType.symbol?.name;
  if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) {
    return name;
  }
  // Check class expression name mapping (e.g. "__class" → "Point")
  if (name) {
    const mapped = ctx.classExprNameMap.get(name);
    if (mapped && ctx.structMap.has(mapped)) {
      return mapped;
    }
  }
  return ctx.anonTypeMap.get(tsType);
}

function compileObjectLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  const contextType = ctx.checker.getContextualType(expr);
  if (!contextType) {
    const type = ctx.checker.getTypeAtLocation(expr);
    let typeName = resolveStructName(ctx, type);
    if (!typeName) {
      // Auto-register the struct type for inline object literals
      ensureStructForType(ctx, type);
      typeName = resolveStructName(ctx, type);
    }
    if (typeName) {
      return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
    }
    ctx.errors.push({
      message: "Cannot determine struct type for object literal",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  let typeName = resolveStructName(ctx, contextType);
  if (!typeName) {
    // Auto-register the struct type for the contextual type
    ensureStructForType(ctx, contextType);
    typeName = resolveStructName(ctx, contextType);
  }
  if (typeName) {
    return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
  }

  // Contextual type couldn't be mapped; fall back to inferred type-at-location
  const inferredType = ctx.checker.getTypeAtLocation(expr);
  let inferredName = resolveStructName(ctx, inferredType);
  if (!inferredName) {
    ensureStructForType(ctx, inferredType);
    inferredName = resolveStructName(ctx, inferredType);
  }
  if (inferredName) {
    return compileObjectLiteralForStruct(ctx, fctx, expr, inferredName);
  }

  ctx.errors.push({
    message: "Object literal type not mapped to struct",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

/**
 * Try to evaluate an expression to a constant numeric or string value at compile time.
 * Supports: numeric literals, string literals, simple arithmetic (+, -, *, /),
 * and const variable references.
 * Returns the resolved value (number or string) or undefined if not resolvable.
 */
function resolveConstantExpression(
  ctx: CodegenContext,
  expr: ts.Expression,
): number | string | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isStringLiteral(expr)) return expr.text;

  // Parenthesized expression
  if (ts.isParenthesizedExpression(expr)) {
    return resolveConstantExpression(ctx, expr.expression);
  }

  // Const variable reference
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    if (sym) {
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const declList = decl.parent;
        if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
          return resolveConstantExpression(ctx, decl.initializer);
        }
      }
    }
    return undefined;
  }

  // Binary expression: a + b, a - b, a * b, a / b
  if (ts.isBinaryExpression(expr)) {
    const left = resolveConstantExpression(ctx, expr.left);
    const right = resolveConstantExpression(ctx, expr.right);
    if (left === undefined || right === undefined) return undefined;

    // String concatenation
    if (typeof left === "string" || typeof right === "string") {
      if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return String(left) + String(right);
      }
      return undefined;
    }

    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.SlashToken: return right !== 0 ? left / right : undefined;
      case ts.SyntaxKind.PercentToken: return right !== 0 ? left % right : undefined;
      default: return undefined;
    }
  }

  // Prefix unary: -x, +x
  if (ts.isPrefixUnaryExpression(expr)) {
    const operand = resolveConstantExpression(ctx, expr.operand);
    if (typeof operand !== "number") return undefined;
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken: return -operand;
      case ts.SyntaxKind.PlusToken: return operand;
      default: return undefined;
    }
  }

  return undefined;
}

/**
 * Resolve the property name of an ObjectLiteralElementLike to a static string.
 * Handles identifiers, string literals, and computed property names that can be
 * evaluated at compile time (string literal expressions, const variables, enum members).
 * Returns undefined if the name cannot be statically resolved.
 */
function resolvePropertyNameText(
  ctx: CodegenContext,
  prop: ts.ObjectLiteralElementLike,
): string | undefined {
  if (!ts.isPropertyAssignment(prop)) return undefined;
  const name = prop.name;

  // Regular identifier: { x: 1 }
  if (ts.isIdentifier(name)) return name.text;

  // String literal property name: { "x": 1 }
  if (ts.isStringLiteral(name)) return name.text;

  // Numeric literal property name: { 0: 1 } → canonical string form
  if (ts.isNumericLiteral(name)) return String(Number(name.text));

  // Computed property name: { [expr]: 1 }
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedKeyExpression(ctx, name.expression);
  }

  return undefined;
}

/**
 * Try to evaluate a computed key expression to a static string at compile time.
 * Supports:
 * - String literals: ["x"]
 * - Const variable references: [key] where const key = "x"
 * - Enum member access: [MyEnum.Key]
 */
function resolveComputedKeyExpression(
  ctx: CodegenContext,
  expr: ts.Expression,
): string | undefined {
  // Direct string literal: ["x"]
  if (ts.isStringLiteral(expr)) return expr.text;

  // Numeric literal: [0], [42], [0x10] → canonical string form
  if (ts.isNumericLiteral(expr)) return String(Number(expr.text));

  // Identifier referencing a const variable: [key]
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    if (sym) {
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        // Check that the variable is declared with const
        const declList = decl.parent;
        if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
          if (ts.isStringLiteral(decl.initializer)) {
            return decl.initializer.text;
          }
        }
      }
    }
    return undefined;
  }

  // Property access for enum members: [MyEnum.Key]
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    const propName = expr.name.text;
    const enumKey = `${objName}.${propName}`;
    const enumStrVal = ctx.enumStringValues.get(enumKey);
    if (enumStrVal !== undefined) return enumStrVal;
    // Numeric enum — convert to string
    const enumNumVal = ctx.enumValues.get(enumKey);
    if (enumNumVal !== undefined) return String(enumNumVal);
  }

  return undefined;
}

/**
 * Resolve the property name of a getter/setter accessor to a static string.
 * Handles identifiers, string literals, numeric literals, and computed property names.
 */
function resolveAccessorPropName(ctx: CodegenContext, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedKeyExpression(ctx, name.expression);
  }
  return undefined;
}

function compileObjectLiteralForStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  typeName: string,
): ValType | null {
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    ctx.errors.push({
      message: `Unknown struct type: ${typeName}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Check if there are any spread assignments — if so, compile spread sources into locals
  const spreadSources: { local: number; srcStructTypeIdx: number; srcFields: { name: string }[] }[] = [];
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const srcType = ctx.checker.getTypeAtLocation(prop.expression);
      const srcStructName = resolveStructName(ctx, srcType);
      if (srcStructName) {
        const srcStructTypeIdx = ctx.structMap.get(srcStructName);
        const srcFields = ctx.structFields.get(srcStructName);
        if (srcStructTypeIdx !== undefined && srcFields) {
          const srcValType: ValType = { kind: "ref", typeIdx: srcStructTypeIdx };
          const srcLocal = allocLocal(fctx, `__spread_obj_${fctx.locals.length}`, srcValType);
          const spreadResult = compileExpression(ctx, fctx, prop.expression);
          if (!spreadResult) continue;
          fctx.body.push({ op: "local.set", index: srcLocal });
          spreadSources.push({ local: srcLocal, srcStructTypeIdx, srcFields });
        }
      }
    }
  }

  for (const field of fields) {
    // First check for an explicit property assignment (identifier, string literal, or computed key)
    const prop = expr.properties.find(
      (p) => resolvePropertyNameText(ctx, p) === field.name,
    );
    // Also check for shorthand property assignment ({ x, y } where x/y are identifiers)
    const shorthandProp = !prop
      ? expr.properties.find(
          (p) =>
            ts.isShorthandPropertyAssignment(p) &&
            p.name.text === field.name,
        )
      : undefined;
    if (prop && ts.isPropertyAssignment(prop)) {
      compileExpression(ctx, fctx, prop.initializer, field.type);
    } else if (shorthandProp && ts.isShorthandPropertyAssignment(shorthandProp)) {
      // Shorthand { x } means the value is the identifier x — compile it
      compileExpression(ctx, fctx, shorthandProp.name, field.type);
    } else {
      // Check spread sources (last spread wins — JS semantics)
      let found = false;
      for (let si = spreadSources.length - 1; si >= 0; si--) {
        const src = spreadSources[si]!;
        const fieldIdx = src.srcFields.findIndex((f) => f.name === field.name);
        if (fieldIdx >= 0) {
          fctx.body.push({ op: "local.get", index: src.local });
          fctx.body.push({ op: "struct.get", typeIdx: src.srcStructTypeIdx, fieldIdx });
          found = true;
          break;
        }
      }
      if (!found) {
        // Default value
        if (field.type.kind === "f64") {
          fctx.body.push({ op: "f64.const", value: 0 });
        } else if (field.type.kind === "externref") {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (field.type.kind === "ref" || field.type.kind === "ref_null") {
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
        } else {
          fctx.body.push({ op: "i32.const", value: 0 });
        }
      }
    }
  }

  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // Register and compile getter/setter accessors on the object literal
  for (const prop of expr.properties) {
    if (
      ts.isGetAccessorDeclaration(prop) &&
      prop.name &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isComputedPropertyName(prop.name) || ts.isNumericLiteral(prop.name))
    ) {
      const propName = resolveAccessorPropName(ctx, prop.name);
      if (propName === undefined) continue;
      const accessorKey = `${typeName}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);

      const getterName = `${typeName}_get_${propName}`;
      const getterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      const sig = ctx.checker.getSignatureFromDeclaration(prop);
      let getterResults: ValType[] = [];
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retType)) {
          getterResults = [resolveWasmType(ctx, retType)];
        }
      }

      const getterTypeIdx = addFuncType(ctx, getterParams, getterResults, `${getterName}_type`);
      const getterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(getterName, getterFuncIdx);

      const getterFunc: WasmFunction = {
        name: getterName,
        typeIdx: getterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      ctx.mod.functions.push(getterFunc);

      // Compile getter body
      const getterFctx: FunctionContext = {
        name: getterName,
        params: [{ name: "this", type: { kind: "ref", typeIdx: structTypeIdx } }],
        locals: [],
        localMap: new Map(),
        returnType: getterResults.length > 0 ? getterResults[0]! : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
      };
      getterFctx.localMap.set("this", 0);

      const savedFunc = ctx.currentFunc;
      ctx.currentFunc = getterFctx;
      if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, getterFctx, stmt);
        }
      }
      // Ensure valid return for non-void getters
      if (getterFctx.returnType) {
        const lastInstr = getterFctx.body[getterFctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (getterFctx.returnType.kind === "f64") {
            getterFctx.body.push({ op: "f64.const", value: 0 });
          } else if (getterFctx.returnType.kind === "i32") {
            getterFctx.body.push({ op: "i32.const", value: 0 });
          } else if (getterFctx.returnType.kind === "externref") {
            getterFctx.body.push({ op: "ref.null.extern" });
          } else if (getterFctx.returnType.kind === "ref" || getterFctx.returnType.kind === "ref_null") {
            getterFctx.body.push({ op: "ref.null", typeIdx: getterFctx.returnType.typeIdx });
          }
        }
      }
      cacheStringLiterals(ctx, getterFctx);
      getterFunc.locals = getterFctx.locals;
      getterFunc.body = getterFctx.body;
      ctx.currentFunc = savedFunc;
    }

    if (
      ts.isSetAccessorDeclaration(prop) &&
      prop.name &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isComputedPropertyName(prop.name) || ts.isNumericLiteral(prop.name))
    ) {
      const propName = resolveAccessorPropName(ctx, prop.name);
      if (propName === undefined) continue;
      const accessorKey = `${typeName}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);

      const setterName = `${typeName}_set_${propName}`;
      const setterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of prop.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        setterParams.push(resolveWasmType(ctx, paramType));
      }

      const setterTypeIdx = addFuncType(ctx, setterParams, [], `${setterName}_type`);
      const setterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(setterName, setterFuncIdx);

      const setterFunc: WasmFunction = {
        name: setterName,
        typeIdx: setterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      ctx.mod.functions.push(setterFunc);

      // Compile setter body
      const setterFctxParams: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        setterFctxParams.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
      }

      const setterFctx: FunctionContext = {
        name: setterName,
        params: setterFctxParams,
        locals: [],
        localMap: new Map(),
        returnType: null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
      };
      for (let i = 0; i < setterFctxParams.length; i++) {
        setterFctx.localMap.set(setterFctxParams[i]!.name, i);
      }

      const savedFunc = ctx.currentFunc;
      ctx.currentFunc = setterFctx;
      if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, setterFctx, stmt);
        }
      }
      cacheStringLiterals(ctx, setterFctx);
      setterFunc.locals = setterFctx.locals;
      setterFunc.body = setterFctx.body;
      ctx.currentFunc = savedFunc;
    }

    // Object literal methods: { method() { ... } }
    if (
      ts.isMethodDeclaration(prop) &&
      prop.name &&
      ts.isIdentifier(prop.name)
    ) {
      const methodName = prop.name.text;
      const fullName = `${typeName}_${methodName}`;
      ctx.classMethodSet.add(fullName);

      const methodParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of prop.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        methodParams.push(resolveWasmType(ctx, paramType));
      }

      const sig = ctx.checker.getSignatureFromDeclaration(prop);
      const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;
      const methodResults: ValType[] = retType && !isVoidType(retType) ? [resolveWasmType(ctx, retType)] : [];

      const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);
      const methodFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(fullName, methodFuncIdx);

      const methodFunc: WasmFunction = {
        name: fullName,
        typeIdx: methodTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      ctx.mod.functions.push(methodFunc);

      // Compile method body
      const methodFctxParams: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        methodFctxParams.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
      }

      const methodFctx: FunctionContext = {
        name: fullName,
        params: methodFctxParams,
        locals: [],
        localMap: new Map(),
        returnType: methodResults.length > 0 ? methodResults[0]! : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
      };
      for (let i = 0; i < methodFctxParams.length; i++) {
        methodFctx.localMap.set(methodFctxParams[i]!.name, i);
      }

      const savedFunc = ctx.currentFunc;
      ctx.currentFunc = methodFctx;
      if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, methodFctx, stmt);
        }
      }
      // Ensure valid return for non-void methods
      if (methodFctx.returnType) {
        const lastInstr = methodFctx.body[methodFctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (methodFctx.returnType.kind === "f64") {
            methodFctx.body.push({ op: "f64.const", value: 0 });
          } else if (methodFctx.returnType.kind === "i32") {
            methodFctx.body.push({ op: "i32.const", value: 0 });
          } else if (methodFctx.returnType.kind === "externref") {
            methodFctx.body.push({ op: "ref.null.extern" });
          } else if (methodFctx.returnType.kind === "ref" || methodFctx.returnType.kind === "ref_null") {
            methodFctx.body.push({ op: "ref.null", typeIdx: methodFctx.returnType.typeIdx });
          }
        }
      }
      cacheStringLiterals(ctx, methodFctx);
      methodFunc.locals = methodFctx.locals;
      methodFunc.body = methodFctx.body;
      ctx.currentFunc = savedFunc;
    }
  }

  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * Compile a tuple literal [a, b, c] to a Wasm GC struct.new instruction.
 * Each element is compiled to its corresponding field type.
 */
function compileTupleLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
  tupleType: ts.Type,
): ValType | null {
  const elemTypes = getTupleElementTypes(ctx, tupleType);
  const tupleIdx = getOrRegisterTupleType(ctx, elemTypes);

  // Compile each element with the expected field type
  for (let i = 0; i < expr.elements.length; i++) {
    const expectedType = elemTypes[i] ?? { kind: "externref" as const };
    compileExpression(ctx, fctx, expr.elements[i]!, expectedType);
  }

  fctx.body.push({ op: "struct.new", typeIdx: tupleIdx });
  return { kind: "ref", typeIdx: tupleIdx };
}

function compileArrayLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
): ValType | null {
  // Check if the target type is a tuple — compile as struct.new instead of array
  const ctxTupleType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
  if (ctxTupleType && isTupleType(ctxTupleType)) {
    return compileTupleLiteral(ctx, fctx, expr, ctxTupleType);
  }

  if (expr.elements.length === 0) {
    // Empty array — try to determine element type from contextual type (e.g. number[])
    let emptyElemKind = "externref";
    const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
    if (ctxType) {
      const sym = (ctxType as ts.TypeReference).symbol ?? ctxType.symbol;
      if (sym?.name === "Array") {
        const typeArgs = ctx.checker.getTypeArguments(ctxType as ts.TypeReference);
        if (typeArgs[0]) {
          const elemWasmType = resolveWasmType(ctx, typeArgs[0]);
          emptyElemKind = (elemWasmType.kind === "ref" || elemWasmType.kind === "ref_null")
            ? `ref_${(elemWasmType as { typeIdx: number }).typeIdx}`
            : elemWasmType.kind;
        }
      }
    }
    const vecTypeIdx = getOrRegisterVecType(ctx, emptyElemKind);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      ctx.errors.push({ message: "Empty array literal: invalid vec type", line: getLine(expr), column: getCol(expr) });
      return null;
    }
    fctx.body.push({ op: "i32.const", value: 0 });           // length field (field 0)
    fctx.body.push({ op: "i32.const", value: 0 });           // size for array.new_default
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx }); // data field (field 1)
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx }); // wrap in vec struct
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Check if any element is a spread
  const hasSpread = expr.elements.some((el) => ts.isSpreadElement(el));

  // Determine element type from first non-spread element, or from spread source
  let elemWasm: ValType;
  let elemKind: string;
  const firstElem = expr.elements[0]!;
  if (ts.isSpreadElement(firstElem)) {
    const spreadType = ctx.checker.getTypeAtLocation(firstElem.expression);
    const typeArgs = ctx.checker.getTypeArguments(spreadType as ts.TypeReference);
    const innerType = typeArgs[0];
    elemWasm = innerType ? resolveWasmType(ctx, innerType) : { kind: "f64" };
  } else {
    const firstElemType = ctx.checker.getTypeAtLocation(firstElem);
    elemWasm = resolveWasmType(ctx, firstElemType);
  }
  elemKind = (elemWasm.kind === "ref" || elemWasm.kind === "ref_null")
    ? `ref_${elemWasm.typeIdx}` : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    ctx.errors.push({ message: "Array literal: invalid vec type", line: getLine(expr), column: getCol(expr) });
    return null;
  }

  if (!hasSpread) {
    // No spread — use the fast array.new_fixed path, then wrap in vec struct
    for (const el of expr.elements) {
      compileExpression(ctx, fctx, el, elemWasm);
    }
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: expr.elements.length });
    // Store data array in temp local, then build vec struct
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: expr.elements.length }); // length field (field 0)
    fctx.body.push({ op: "local.get", index: tmpData });               // data field (field 1)
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });          // wrap in vec struct
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Has spread elements — compute total length, create array, then fill
  // Step 1: Compute total length and store spread sources in locals
  const spreadLocals: { local: number; elemIdx: number; srcVecTypeIdx: number }[] = [];
  const nonSpreadCount = expr.elements.filter((el) => !ts.isSpreadElement(el)).length;

  // Push the non-spread count as the initial length
  fctx.body.push({ op: "i32.const", value: nonSpreadCount });

  // For each spread source, compile it, store in local, and add its length
  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isSpreadElement(el)) {
      const srcType = compileExpression(ctx, fctx, el.expression);
      if (!srcType || (srcType.kind !== "ref" && srcType.kind !== "ref_null")) continue;
      const srcVecTypeIdx = (srcType as { typeIdx: number }).typeIdx;
      const srcLocal = allocLocal(fctx, `__spread_src_${fctx.locals.length}`, srcType);
      fctx.body.push({ op: "local.tee", index: srcLocal });
      fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 0 }); // get length from vec
      fctx.body.push({ op: "i32.add" }); // accumulate total length
      spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx });
    }
  }

  // Step 2: Create the result backing array with computed length, default-initialized
  const resultArrType: ValType = { kind: "ref", typeIdx: arrTypeIdx };
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  const resultLocal = allocLocal(fctx, `__spread_result_${fctx.locals.length}`, resultArrType);
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Step 3: Fill the array — track current write index
  const writeIdx = allocLocal(fctx, `__spread_wi_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: writeIdx });

  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isSpreadElement(el)) {
      // Copy all elements from spread source using a loop
      const spreadInfo = spreadLocals.find((s) => s.elemIdx === i);
      if (!spreadInfo) continue;

      const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, spreadInfo.srcVecTypeIdx);
      if (srcArrTypeIdx < 0) continue;
      const readIdx = allocLocal(fctx, `__spread_ri_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: readIdx });

      // loop: while readIdx < srcVec.length
      const loopBody: Instr[] = [];
      // Condition: readIdx >= srcVec.length → break
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "local.get", index: spreadInfo.local });
      loopBody.push({ op: "struct.get", typeIdx: spreadInfo.srcVecTypeIdx, fieldIdx: 0 }); // get length from vec
      loopBody.push({ op: "i32.ge_s" });
      loopBody.push({ op: "br_if", depth: 1 }); // break out of block
      // result[writeIdx] = src.data[readIdx]
      loopBody.push({ op: "local.get", index: resultLocal });
      loopBody.push({ op: "local.get", index: writeIdx });
      loopBody.push({ op: "local.get", index: spreadInfo.local });
      loopBody.push({ op: "struct.get", typeIdx: spreadInfo.srcVecTypeIdx, fieldIdx: 1 }); // get data from vec
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "array.get", typeIdx: srcArrTypeIdx });
      loopBody.push({ op: "array.set", typeIdx: arrTypeIdx });
      // writeIdx++; readIdx++
      loopBody.push({ op: "local.get", index: writeIdx });
      loopBody.push({ op: "i32.const", value: 1 });
      loopBody.push({ op: "i32.add" });
      loopBody.push({ op: "local.set", index: writeIdx });
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "i32.const", value: 1 });
      loopBody.push({ op: "i32.add" });
      loopBody.push({ op: "local.set", index: readIdx });
      loopBody.push({ op: "br", depth: 0 }); // continue loop

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
      });
    } else {
      // Non-spread element: result[writeIdx] = el; writeIdx++
      fctx.body.push({ op: "local.get", index: resultLocal });
      fctx.body.push({ op: "local.get", index: writeIdx });
      compileExpression(ctx, fctx, el, elemWasm);
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.get", index: writeIdx });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.set", index: writeIdx });
    }
  }

  // Wrap the result backing array in a vec struct
  // Stack: totalLen (= writeIdx), data ref → struct.new
  fctx.body.push({ op: "local.get", index: writeIdx });    // length field (field 0)
  fctx.body.push({ op: "local.get", index: resultLocal }); // data field (field 1)
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx }); // wrap in vec struct
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

// ── Object.keys / Object.values ───────────────────────────────────────

/**
 * Compile Object.keys(obj) or Object.values(obj) by expanding struct fields
 * at compile time. Object.keys returns a string[] of field names,
 * Object.values returns an array of the field values.
 */
function compileObjectKeysOrValues(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  expr: ts.CallExpression,
): ValType | null {
  const arg = expr.arguments[0]!;
  const argType = ctx.checker.getTypeAtLocation(arg);

  // Resolve struct name from the argument type
  const structName = resolveStructName(ctx, argType);
  if (!structName) {
    ctx.errors.push({
      message: `Object.${method}() requires a struct type argument`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  const structTypeIdx = ctx.structMap.get(structName);
  const fields = ctx.structFields.get(structName);
  if (structTypeIdx === undefined || !fields) {
    ctx.errors.push({
      message: `Object.${method}(): unknown struct "${structName}"`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Filter out internal fields like __tag
  const userFields = fields
    .map((f, idx) => ({ field: f, fieldIdx: idx }))
    .filter((e) => !e.field.name.startsWith("__"));

  if (method === "keys") {
    // Build a string[] array from the field names
    // Each field name is already registered as a string literal thunk
    const elemKind = "externref";
    const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      ctx.errors.push({
        message: `Object.keys(): cannot resolve array type for string[]`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    // Push each field name string onto the stack
    for (const entry of userFields) {
      const importName = ctx.stringLiteralMap.get(entry.field.name);
      if (!importName) continue;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx === undefined) continue;
      fctx.body.push({ op: "call", funcIdx });
    }

    // Create the backing array with array.new_fixed
    const count = userFields.length;
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: count });
    const tmpData = allocLocal(fctx, `__obj_keys_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: count });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // method === "values"
  // Compile the argument expression, store in a local, then struct.get each field
  const argResult = compileExpression(ctx, fctx, arg);
  if (!argResult) return null;
  const objLocal = allocLocal(fctx, `__obj_vals_src_${fctx.locals.length}`, { kind: "ref", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Always use externref elements for Object.values() since the TS return type is any[]
  const elemKind = "externref";
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    ctx.errors.push({
      message: `Object.values(): cannot resolve array type for values[]`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Ensure union boxing imports are registered (needed for boxing primitives)
  addUnionImports(ctx);

  // Push each field value onto the stack, boxing primitives to externref
  for (const entry of userFields) {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });
    // Box primitive values to externref
    if (entry.field.type.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      }
    } else if (entry.field.type.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      }
    }
    // externref fields (strings, etc.) don't need boxing
  }

  // Create the backing array with array.new_fixed
  const count = userFields.length;
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: count });
  const tmpData = allocLocal(fctx, `__obj_vals_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpData });
  fctx.body.push({ op: "i32.const", value: count });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

// ── String operations ─────────────────────────────────────────────────

function compileStringLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
  node?: ts.Node,
): ValType | null {
  // Fast mode: materialize as NativeString GC struct inline
  if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
    return compileNativeStringLiteral(ctx, fctx, value);
  }

  // Use importedStringConstants: string literals are global imports
  const globalIdx = ctx.stringGlobalMap.get(value);
  if (globalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: globalIdx });
    return { kind: "externref" };
  }

  // Fallback for legacy stringLiteralMap (should not be reached)
  ctx.errors.push({
    message: `String literal not registered: "${value}"`,
    line: node ? getLine(node) : 0,
    column: node ? getCol(node) : 0,
  });
  return null;
}

/**
 * Materialize a string literal as a NativeString GC struct in fast mode.
 * Emits array.new_fixed with the WTF-16 code units, then struct.new.
 */
function compileNativeStringLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
): ValType {
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;

  // Push len (i32) — field 0
  fctx.body.push({ op: "i32.const", value: value.length });

  // Push off (i32) = 0 — field 1
  fctx.body.push({ op: "i32.const", value: 0 });

  // Push each code unit (i16) and create array with array.new_fixed
  for (let i = 0; i < value.length; i++) {
    fctx.body.push({ op: "i32.const", value: value.charCodeAt(i) });
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: strDataTypeIdx, length: value.length });

  // struct.new $NativeString(len, off, data)
  fctx.body.push({ op: "struct.new", typeIdx: strTypeIdx });

  return nativeStringType(ctx);
}

function compileTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TemplateExpression,
): ValType | null {
  // Fast mode: use native string concat
  if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
    return compileNativeTemplateExpression(ctx, fctx, expr);
  }

  const concatIdx = ctx.funcMap.get("concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  if (concatIdx === undefined) return null;

  // Start with the head text (may be empty string "")
  if (expr.head.text) {
    compileStringLiteral(ctx, fctx, expr.head.text, expr.head);
  } else {
    // Empty head — we'll start from the first span's expression
  }

  for (let i = 0; i < expr.templateSpans.length; i++) {
    const span = expr.templateSpans[i]!;

    // Compile the substitution expression and coerce to string if needed
    const spanType = compileExpression(ctx, fctx, span.expression);
    if (spanType && spanType.kind === "f64" && toStrIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    } else if (spanType && spanType.kind === "i32" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
    }
    // externref assumed to be string already

    // If we had a head (or previous spans), concat with accumulated string
    if (i === 0 && !expr.head.text) {
      // No head — the expression result IS the accumulated string so far
    } else {
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }

    // Append the span's literal text (the part after ${...} up to next ${ or backtick)
    if (span.literal.text) {
      compileStringLiteral(ctx, fctx, span.literal.text, span.literal);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
  }

  return { kind: "externref" };
}

/**
 * Compile a template expression in fast mode, using native string concat.
 * Number substitutions are converted via number_toString (returns externref)
 * then marshaled to native string.
 */
function compileNativeTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TemplateExpression,
): ValType | null {
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern");
  if (concatIdx === undefined) return null;

  if (expr.head.text) {
    compileStringLiteral(ctx, fctx, expr.head.text, expr.head);
  }

  for (let i = 0; i < expr.templateSpans.length; i++) {
    const span = expr.templateSpans[i]!;

    const spanType = compileExpression(ctx, fctx, span.expression);
    if (spanType && spanType.kind === "f64" && toStrIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      // number_toString returns externref, marshal to native string
      if (fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    } else if (spanType && spanType.kind === "i32" && toStrIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      if (fromExternIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      }
    }
    // ref $NativeString is already the right type

    if (i === 0 && !expr.head.text) {
      // No head — expression result is accumulated string
    } else {
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }

    if (span.literal.text) {
      compileStringLiteral(ctx, fctx, span.literal.text, span.literal);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
  }

  return nativeStringType(ctx);
}


// ── Tagged template expressions ──────────────────────────────────────

/**
 * Compile a tagged template expression: tag`hello ${x} world`
 * Desugars to: tag(["hello ", " world"], x)
 *
 * Implementation: build a WasmGC externref array (vec struct) of string parts,
 * then call the tag function with the array as first arg and substitutions
 * as remaining args. NO host imports needed.
 */
function compileTaggedTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TaggedTemplateExpression,
): ValType | null {
  // Extract string parts and substitution expressions from the template
  const stringParts: string[] = [];
  const substitutions: ts.Expression[] = [];

  if (ts.isNoSubstitutionTemplateLiteral(expr.template)) {
    // tag`just a string` — one string part, no substitutions
    stringParts.push(expr.template.text);
  } else {
    // TemplateExpression: head + spans
    const tmpl = expr.template as ts.TemplateExpression;
    stringParts.push(tmpl.head.text);
    for (const span of tmpl.templateSpans) {
      substitutions.push(span.expression);
      stringParts.push(span.literal.text);
    }
  }

  // Build the strings array as a WasmGC externref vec (same layout as array literals)
  const elemKind = "externref";
  const elemWasm: ValType = { kind: "externref" };
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    ctx.errors.push({ message: "Tagged template: invalid vec type for strings array", line: getLine(expr), column: getCol(expr) });
    return null;
  }

  // Push each string part onto the stack, then array.new_fixed
  for (const str of stringParts) {
    compileStringLiteral(ctx, fctx, str, expr);
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: stringParts.length });
  // Wrap in vec struct: { i32 length, array data }
  const tmpData = allocLocal(fctx, `__tt_arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpData });
  fctx.body.push({ op: "i32.const", value: stringParts.length });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });

  // Store the strings vec in a local so we can push it as an argument later
  const stringsVecType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const stringsLocal = allocLocal(fctx, `__tt_strings_${fctx.locals.length}`, stringsVecType);
  fctx.body.push({ op: "local.set", index: stringsLocal });

  // Now compile the call to the tag function.
  // The tag function receives (stringsArray, ...substitutions).
  // We handle three cases: known function, closure, or fallback.

  if (ts.isIdentifier(expr.tag)) {
    const tagName = expr.tag.text;

    // Case 1: tag is a closure variable
    const closureInfo = ctx.closureMap.get(tagName);
    if (closureInfo) {
      const localIdx = fctx.localMap.get(tagName);
      if (localIdx === undefined) {
        ctx.errors.push({ message: `Tagged template: closure variable '${tagName}' not found`, line: getLine(expr), column: getCol(expr) });
        return null;
      }

      // Push closure ref as self param
      fctx.body.push({ op: "local.get", index: localIdx });

      // Push strings array as first argument (coerce to expected param type)
      const paramType0 = closureInfo.paramTypes[0];
      fctx.body.push({ op: "local.get", index: stringsLocal });
      if (paramType0 && paramType0.kind === "externref") {
        // Need to convert GC ref to externref
        fctx.body.push({ op: "extern.convert_any" });
      }

      // Push substitution expressions as remaining arguments
      for (let i = 0; i < substitutions.length; i++) {
        const expectedParamType = closureInfo.paramTypes[i + 1];
        compileExpression(ctx, fctx, substitutions[i]!, expectedParamType);
      }

      // Push funcref from closure struct field 0 and call_ref
      fctx.body.push({ op: "local.get", index: localIdx });
      fctx.body.push({ op: "struct.get", typeIdx: closureInfo.structTypeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.funcTypeIdx });
      fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

      return closureInfo.returnType;
    }

    // Case 2: tag is a known function
    const funcIdx = ctx.funcMap.get(tagName);
    if (funcIdx !== undefined) {
      // Prepend captured values for nested functions with captures
      const nestedCaptures = ctx.nestedFuncCaptures.get(tagName);
      if (nestedCaptures) {
        for (const cap of nestedCaptures) {
          fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
        }
      }

      const restInfo = ctx.funcRestParams.get(tagName);
      const paramTypes = getFuncParamTypes(ctx, funcIdx);

      // Push the strings array as argument 0
      fctx.body.push({ op: "local.get", index: stringsLocal });
      // Coerce if needed (e.g. ref_null vec → externref)
      if (paramTypes?.[0] && paramTypes[0].kind === "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }

      if (restInfo && restInfo.restIndex === 1) {
        // Tag function has rest param at index 1: tag(strings, ...subs)
        // Pack substitutions into a vec
        const restArgCount = substitutions.length;
        fctx.body.push({ op: "i32.const", value: restArgCount });
        for (const sub of substitutions) {
          compileExpression(ctx, fctx, sub, restInfo.elemType);
        }
        fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: restArgCount });
        fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
      } else {
        // No rest param — push substitutions as positional args
        for (let i = 0; i < substitutions.length; i++) {
          compileExpression(ctx, fctx, substitutions[i]!, paramTypes?.[i + 1]);
        }

        // Supply defaults for missing optional params
        const optInfo = ctx.funcOptionalParams.get(tagName);
        if (optInfo) {
          const numProvided = substitutions.length + 1; // +1 for strings array
          for (const opt of optInfo) {
            if (opt.index >= numProvided) {
              pushDefaultValue(fctx, opt.type);
            }
          }
        }
      }

      // Re-lookup funcIdx in case imports shifted during compilation
      const finalFuncIdx = ctx.funcMap.get(tagName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

      // Determine return type
      const sig = ctx.checker.getResolvedSignature(expr);
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (isVoidType(retType)) return null;
        return resolveWasmType(ctx, retType);
      }
      return { kind: "externref" };
    }
  }

  // Fallback: unsupported tag expression type
  ctx.errors.push({
    message: `Tagged template: unsupported tag expression kind ${ts.SyntaxKind[expr.tag.kind]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}
function compileStringBinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Fast mode: native string operations
  if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
    const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;

    switch (op) {
      case ts.SyntaxKind.PlusToken: {
        // concat accepts ref $AnyString — no flatten needed
        compileExpression(ctx, fctx, expr.left);
        compileExpression(ctx, fctx, expr.right);
        const funcIdx = ctx.nativeStrHelpers.get("__str_concat");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return nativeStringType(ctx);
        }
        break;
      }
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken: {
        // equals needs flat strings — flatten both operands
        compileExpression(ctx, fctx, expr.left);
        fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        const funcIdx = ctx.nativeStrHelpers.get("__str_equals");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        break;
      }
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken: {
        compileExpression(ctx, fctx, expr.left);
        fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        const funcIdx = ctx.nativeStrHelpers.get("__str_equals");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        break;
      }
      default: {
        // For any other operator, compile both but don't know what to do
        compileExpression(ctx, fctx, expr.left);
        compileExpression(ctx, fctx, expr.right);
        break;
      }
    }

    ctx.errors.push({
      message: `Unsupported string operator: ${ts.SyntaxKind[op]}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Ensure string imports are registered (may not be if no string literals in source)
  addStringImports(ctx);

  // Compile operands with coercion: if one side is a number/bool in a string
  // context, inject number_toString to convert it to a string (JS ToNumber semantics)
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (op === ts.SyntaxKind.PlusToken && leftType && (leftType.kind === "f64" || leftType.kind === "i32")) {
    if (leftType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    const toStr = ctx.funcMap.get("number_toString");
    if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
  }
  const rightType = compileExpression(ctx, fctx, expr.right);
  if (op === ts.SyntaxKind.PlusToken && rightType && (rightType.kind === "f64" || rightType.kind === "i32")) {
    if (rightType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    const toStr = ctx.funcMap.get("number_toString");
    if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
  }

  switch (op) {
    case ts.SyntaxKind.PlusToken: {
      // String concatenation
      const funcIdx = ctx.funcMap.get("concat");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      break;
    }
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken: {
      const funcIdx = ctx.funcMap.get("equals");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      break;
    }
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken: {
      const funcIdx = ctx.funcMap.get("equals");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        fctx.body.push({ op: "i32.eqz" }); // negate
        return { kind: "i32" };
      }
      break;
    }
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken: {
      const funcIdx = ctx.funcMap.get("string_compare");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        fctx.body.push({ op: "i32.const", value: 0 });
        const cmpOp = op === ts.SyntaxKind.LessThanToken ? "i32.lt_s"
          : op === ts.SyntaxKind.LessThanEqualsToken ? "i32.le_s"
          : op === ts.SyntaxKind.GreaterThanToken ? "i32.gt_s"
          : "i32.ge_s";
        fctx.body.push({ op: cmpOp as any });
        return { kind: "i32" };
      }
      break;
    }
  }

  ctx.errors.push({
    message: `Unsupported string operator: ${ts.SyntaxKind[op]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Native string method calls (fast mode) ──────────────────────────

/**
 * Compile a method call on a native string in fast mode.
 * Handles: charCodeAt (inline), charAt, substring, slice (native helpers),
 * and delegates other methods to host via marshal.
 */
function compileNativeStringMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  method: string,
): ValType | null {
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;

  // Helper: emit a flatten call to convert ref $AnyString → ref $NativeString
  const emitFlatten = () => fctx.body.push({ op: "call", funcIdx: flattenIdx });

  // charCodeAt: inline array.get_u with offset (must flatten first)
  if (method === "charCodeAt") {
    compileExpression(ctx, fctx, propAccess.expression);
    // Flatten to FlatString (handles ConsString → FlatString)
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    fctx.body.push({ op: "call", funcIdx: flattenIdx });
    // Store flat string ref in a temp local to access both data and off
    const tmpLocal = allocLocal(fctx, "__charCodeAt_tmp", flatStringType(ctx));
    fctx.body.push({ op: "local.set", index: tmpLocal });
    // Push data ref (field 2)
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // .data
    // Compute off + idx (off is field 1)
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // .off
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "i32.add" }); // off + idx
    fctx.body.push({ op: "array.get_u", typeIdx: strDataTypeIdx });
    return { kind: "i32" };
  }

  // charAt: native helper
  if (method === "charAt") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_charAt")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // at: like charAt but supports negative indices
  if (method === "at") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const strTmp = allocLocal(fctx, `__str_at_tmp_${fctx.locals.length}`, flatStringType(ctx));
    fctx.body.push({ op: "local.tee", index: strTmp });
    // Get string length for negative index support (len is field 0)
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // .len
    const lenTmp = allocLocal(fctx, `__str_at_len_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: lenTmp });
    // Compile index
    const idxTmp = allocLocal(fctx, `__str_at_idx_${fctx.locals.length}`, { kind: "i32" });
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "local.set", index: idxTmp });
    // If index < 0, add length
    fctx.body.push({ op: "local.get", index: idxTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: idxTmp },
        { op: "local.get", index: lenTmp },
        { op: "i32.add" },
        { op: "local.set", index: idxTmp },
      ],
    } as Instr);
    // Call charAt helper with adjusted index
    fctx.body.push({ op: "local.get", index: strTmp });
    fctx.body.push({ op: "local.get", index: idxTmp });
    const funcIdx = ctx.nativeStrHelpers.get("__str_charAt")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // substring: native helper
  if (method === "substring") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // start
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // end
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      // Default end = string length
      // We need to get the receiver again — use a temp local
      // Actually, push len from the string on stack — but receiver is consumed.
      // Simpler: push i32.const MAX_INT as sentinel and let helper clamp
      fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // slice: native helper (handles negative indices)
  if (method === "slice") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // start
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // end
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_slice")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // indexOf: native helper
  if (method === "indexOf") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // search string arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    // fromIndex arg
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // lastIndexOf: native helper
  if (method === "lastIndexOf") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_lastIndexOf")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // includes: native helper
  if (method === "includes") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_includes")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // startsWith: native helper
  if (method === "startsWith") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_startsWith")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // endsWith: native helper
  if (method === "endsWith") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // suffix arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: strTypeIdx });
    }
    // endPosition arg — default to string length
    if (expr.arguments.length > 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0x7FFFFFFF });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_endsWith")!;
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }

  // trim, trimStart, trimEnd: native helpers
  if (method === "trim" || method === "trimStart" || method === "trimEnd") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const helperName = `__str_${method}`;
    const funcIdx = ctx.nativeStrHelpers.get(helperName)!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // repeat: native helper
  if (method === "repeat") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // padStart: native helper
  if (method === "padStart") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // targetLength
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // padString (default: " ")
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
    } else {
      // Create a single-space native string (len=1, off=0, [32])
      fctx.body.push({ op: "i32.const", value: 1 });  // len
      fctx.body.push({ op: "i32.const", value: 0 });  // off
      fctx.body.push({ op: "i32.const", value: 32 }); // space
      fctx.body.push({ op: "array.new_fixed", typeIdx: ctx.nativeStrDataTypeIdx, length: 1 });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_padStart")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // padEnd: native helper
  if (method === "padEnd") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // targetLength
    if (expr.arguments.length > 0) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType && argType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // padString (default: " ")
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "i32.const", value: 1 });  // len
      fctx.body.push({ op: "i32.const", value: 0 });  // off
      fctx.body.push({ op: "i32.const", value: 32 });
      fctx.body.push({ op: "array.new_fixed", typeIdx: ctx.nativeStrDataTypeIdx, length: 1 });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_padEnd")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // toLowerCase, toUpperCase: native helpers
  if (method === "toLowerCase" || method === "toUpperCase") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const helperName = `__str_${method}`;
    const funcIdx = ctx.nativeStrHelpers.get(helperName)!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // replace(search, replacement): native helper
  if (method === "replace") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // search arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      fctx.body.push({ op: "ref.null", typeIdx: ctx.nativeStrTypeIdx });
    }
    // replacement arg
    if (expr.arguments.length > 1) {
      compileExpression(ctx, fctx, expr.arguments[1]!);
      emitFlatten();
    } else {
      // default: empty string (len=0, off=0, [])
      fctx.body.push({ op: "i32.const", value: 0 });  // len
      fctx.body.push({ op: "i32.const", value: 0 });  // off
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const funcIdx = ctx.nativeStrHelpers.get("__str_replace")!;
    fctx.body.push({ op: "call", funcIdx });
    return nativeStringType(ctx);
  }

  // split: native helper, returns native string array
  if (method === "split") {
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    // separator arg
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!);
      emitFlatten();
    } else {
      // default: empty string separator (split each char) (len=0, off=0, [])
      fctx.body.push({ op: "i32.const", value: 0 });  // len
      fctx.body.push({ op: "i32.const", value: 0 });  // off
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    }
    const splitIdx = ctx.nativeStrHelpers.get("__str_split")!;
    fctx.body.push({ op: "call", funcIdx: splitIdx });
    // Return type is ref $vec_nstr — use same key as resolveWasmType for string[]
    const nstrVecTypeIdx = ctx.vecTypeMap.get(`ref_${ctx.anyStrTypeIdx}`)!;
    return { kind: "ref", typeIdx: nstrVecTypeIdx };
  }

  // Other methods: marshal native->extern, call host, marshal extern->native
  const importName = `string_${method}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx !== undefined) {
    // Marshal receiver: flatten + native string -> externref
    compileExpression(ctx, fctx, propAccess.expression);
    emitFlatten();
    const toExternIdx = ctx.nativeStrHelpers.get("__str_to_extern")!;
    fctx.body.push({ op: "call", funcIdx: toExternIdx });

    // Compile arguments — string args need flattening + marshaling
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType && argType.kind === "ref" && (argType.typeIdx === strTypeIdx || argType.typeIdx === ctx.anyStrTypeIdx)) {
        // String arg → flatten + marshal to externref
        emitFlatten();
        fctx.body.push({ op: "call", funcIdx: toExternIdx });
      }
    }

    fctx.body.push({ op: "call", funcIdx });

    // Determine return type and marshal back if needed
    const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
    const returnsNum = method === "indexOf" || method === "lastIndexOf";
    if (returnsBool) {
      return { kind: "i32" };
    } else if (returnsNum) {
      return { kind: "f64" };
    } else {
      // Returns externref string → marshal to native
      const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern")!;
      fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      return nativeStringType(ctx);
    }
  }

  ctx.errors.push({
    message: `Unknown string method: ${method}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Array method calls (pure Wasm, no host imports) ─────────────────

/** Resolve array type info from a TS type. Returns null if not a Wasm GC vec struct. */
function resolveArrayInfo(
  ctx: CodegenContext,
  tsType: ts.Type,
): { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | null {
  // In fast mode, strings are NativeString structs that look like arrays
  // (struct { len: i32, data: ref array }). Reject them here so string
  // methods are dispatched via compileNativeStringMethodCall instead.
  if (ctx.fast && ctx.nativeStrTypeIdx >= 0 && isStringType(tsType)) return null;
  const wasmType = resolveWasmType(ctx, tsType);
  if (wasmType.kind !== "ref" && wasmType.kind !== "ref_null") return null;
  const vecTypeIdx = (wasmType as { typeIdx: number }).typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") return null;
  if (vecDef.fields.length < 2) return null;
  const dataField = vecDef.fields[1]!;
  if (dataField.type.kind !== "ref") return null;
  const arrTypeIdx = dataField.type.typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;
  return { vecTypeIdx, arrTypeIdx, elemType: arrDef.element };
}

/**
 * Try to get the local index of the receiver expression (for reassigning
 * the array variable after mutating methods like push/pop/shift).
 */
function getReceiverLocalIdx(
  fctx: FunctionContext,
  expr: ts.Expression,
): number | null {
  if (ts.isIdentifier(expr)) {
    const idx = fctx.localMap.get(expr.text);
    return idx !== undefined ? idx : null;
  }
  return null;
}

/**
 * Detect and compile Array.prototype.METHOD.call(obj, ...args) patterns.
 * When `obj` is a shape-inferred array-like variable, we reuse the existing
 * array method compilers by treating `obj` as the receiver.
 *
 * Returns undefined if the pattern is not matched (caller should continue).
 * Returns ValType | null for successful/failed compilation.
 */
function compileArrayPrototypeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | typeof VOID_RESULT | undefined {
  // Pattern: X.call(obj, ...args) where X is Array.prototype.METHOD
  if (propAccess.name.text !== "call") return undefined;
  if (!ts.isPropertyAccessExpression(propAccess.expression)) return undefined;

  const methodAccess = propAccess.expression; // Array.prototype.METHOD
  const methodName = methodAccess.name.text;

  // Check that the receiver of .METHOD is Array.prototype
  if (!ts.isPropertyAccessExpression(methodAccess.expression)) return undefined;
  const protoAccess = methodAccess.expression; // Array.prototype
  if (protoAccess.name.text !== "prototype") return undefined;
  if (!ts.isIdentifier(protoAccess.expression)) return undefined;
  if (protoAccess.expression.text !== "Array") return undefined;

  // First argument to .call() is the receiver object
  if (callExpr.arguments.length < 1) return undefined;
  const receiverArg = callExpr.arguments[0]!;
  if (!ts.isIdentifier(receiverArg)) return undefined;

  // Check if the receiver is a shape-inferred variable
  const shapeInfo = ctx.shapeMap.get(receiverArg.text);
  if (!shapeInfo) return undefined;

  const { vecTypeIdx, arrTypeIdx, elemType } = shapeInfo;

  // Build a synthetic PropertyAccessExpression-like call that routes to
  // the existing array method compilers. The trick: existing compilers take
  // (propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) where propAccess.expression
  // is the receiver. We create a virtual call expression with the remaining args.

  // For methods that take the receiver via propAccess.expression, we need to
  // compile the receiver (first .call() arg) onto the stack before the method runs.
  // The existing array methods compile propAccess.expression as the receiver.
  // We'll use a wrapper approach: compile the receiver manually and use the
  // existing inline compilers with the shape's type indices.

  // The existing array method functions use compileExpression(ctx, fctx, propAccess.expression)
  // to get the receiver. For .call(), the receiver is callExpr.arguments[0].
  // We create a synthetic propAccess whose .expression is the receiver arg.
  // TypeScript's AST nodes are immutable, so instead we'll compile directly.

  switch (methodName) {
    case "indexOf":
      return compileArrayPrototypeIndexOf(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
    case "includes":
      return compileArrayPrototypeIncludes(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
    case "every":
      return compileArrayPrototypeEvery(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
    case "some":
      return compileArrayPrototypeSome(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
    case "forEach":
      return compileArrayPrototypeForEach(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
    default:
      return undefined;
  }
}

/**
 * Array.prototype.indexOf.call(obj, searchValue)
 * Inlines the indexOf search loop using the shape's vec struct.
 */
function compileArrayPrototypeIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // callExpr.arguments: [obj, searchValue, ...]
  if (callExpr.arguments.length < 2) {
    ctx.errors.push({ message: "Array.prototype.indexOf.call requires at least 2 arguments", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__apc_iof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_iof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_iof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_iof_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__apc_iof_val_${fctx.locals.length}`, elemType);

  // Compile receiver
  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile search value (second argument to .call())
  compileExpression(ctx, fctx, callExpr.arguments[1]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    { op: eqOp } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp } as Instr,
            { op: "return" } as Instr,
          ]
        : [
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "return" } as Instr,
          ],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
    return { kind: "i32" };
  }
  fctx.body.push({ op: "f64.const", value: -1 });
  return { kind: "f64" };
}

/**
 * Array.prototype.includes.call(obj, searchValue)
 */
function compileArrayPrototypeIncludes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    ctx.errors.push({ message: "Array.prototype.includes.call requires at least 2 arguments", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__apc_inc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_inc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_inc_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_inc_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__apc_inc_val_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[1]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    { op: eqOp } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "return" } as Instr,
      ],
    } as Instr,
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  fctx.body.push({ op: "i32.const", value: 0 });
  return { kind: "i32" };
}

/**
 * Array.prototype.every.call(obj, callback)
 * Inlines the every loop: returns 1 if callback(elem) is truthy for all elements.
 */
function compileArrayPrototypeEvery(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // callExpr.arguments: [obj, callback]
  if (callExpr.arguments.length < 2) {
    ctx.errors.push({ message: "Array.prototype.every.call requires at least 2 arguments", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const cbArg = callExpr.arguments[1]!;

  // The callback must be an arrow function or function expression for inline compilation
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) {
    return undefined as unknown as null;
  }

  // Compile the callback as a closure and get its info
  const cbResult = compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return null;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return null;

  const closureTmp = allocLocal(fctx, `__apc_ev_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const vecTmp = allocLocal(fctx, `__apc_ev_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_ev_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_ev_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_ev_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Loop: for each element, call the closure; if it returns falsy, return 0
  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 }, // break out of block

    // Call closure(element): push closure ref, then element
    { op: "local.get", index: closureTmp },
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    // Get function ref from closure struct field 0 and call_ref
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    { op: "ref.cast", typeIdx: closureInfo.funcTypeIdx } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,

    // Check if result is falsy (0 for i32, 0.0 for f64)
    ...(closureInfo.returnType?.kind === "f64"
      ? [
          { op: "f64.const", value: 0 } as Instr,
          { op: "f64.eq" } as Instr,
        ]
      : closureInfo.returnType?.kind === "i32"
        ? [{ op: "i32.eqz" } as Instr]
        : [{ op: "i32.eqz" } as Instr]),

    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "return" } as Instr,
      ],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  fctx.body.push({ op: "i32.const", value: 1 });
  return { kind: "i32" };
}

/**
 * Array.prototype.some.call(obj, callback)
 */
function compileArrayPrototypeSome(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) return null;
  const cbArg = callExpr.arguments[1]!;
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) return undefined as unknown as null;

  const cbResult = compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return null;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return null;

  const closureTmp = allocLocal(fctx, `__apc_some_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const vecTmp = allocLocal(fctx, `__apc_some_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_some_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_some_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_some_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: closureTmp },
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    { op: "ref.cast", typeIdx: closureInfo.funcTypeIdx } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
    ...(closureInfo.returnType?.kind === "f64"
      ? [{ op: "f64.const", value: 0 } as Instr, { op: "f64.ne" } as Instr]
      : []),
    ...(closureInfo.returnType?.kind === "i32" ? [] : [{ op: "i32.eqz" } as Instr, { op: "i32.eqz" } as Instr]),
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "return" } as Instr,
      ],
    } as Instr,
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  fctx.body.push({ op: "i32.const", value: 0 });
  return { kind: "i32" };
}

/**
 * Array.prototype.forEach.call(obj, callback)
 */
function compileArrayPrototypeForEach(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) return null;
  const cbArg = callExpr.arguments[1]!;
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) return undefined as unknown as null;

  const cbResult = compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return null;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return null;

  const closureTmp = allocLocal(fctx, `__apc_fe_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const vecTmp = allocLocal(fctx, `__apc_fe_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_fe_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_fe_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_fe_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: closureTmp },
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    { op: "ref.cast", typeIdx: closureInfo.funcTypeIdx } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
    // Drop the result if there is one
    ...(closureInfo.returnType ? [{ op: "drop" } as Instr] : []),
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  return VOID_RESULT;
}

const ARRAY_METHODS = new Set([
  "push", "pop", "shift", "indexOf", "includes",
  "slice", "concat", "join", "reverse", "splice", "at",
  "fill", "copyWithin", "lastIndexOf", "sort",
  "filter", "map", "reduce", "forEach", "find", "findIndex", "some", "every",
]);

/**
 * Compile array method calls to inline Wasm instructions.
 * Returns undefined if the call is not an array method (caller should continue).
 * Returns ValType | null for successful/failed compilation.
 */
function compileArrayMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
): ValType | null | undefined {
  const methodName = propAccess.name.text;
  if (!ARRAY_METHODS.has(methodName)) return undefined;

  const arrInfo = resolveArrayInfo(ctx, receiverType);
  if (!arrInfo) return undefined;

  const { vecTypeIdx, arrTypeIdx, elemType } = arrInfo;

  // If receiver is a module global, proxy it through a temp local so
  // getReceiverLocalIdx succeeds and mutating methods can write back.
  let moduleGlobalIdx: number | undefined;
  let savedLocal: number | undefined;
  const MUTATING = new Set(["push", "pop", "shift", "reverse", "splice", "fill", "copyWithin", "sort"]);
  if (ts.isIdentifier(propAccess.expression)) {
    const name = propAccess.expression.text;
    const gIdx = ctx.moduleGlobals.get(name);
    if (gIdx !== undefined && !fctx.localMap.has(name)) {
      moduleGlobalIdx = gIdx;
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, gIdx)];
      if (!globalDef) return null;
      const tempLocal = allocLocal(fctx, `__mod_proxy_${name}`, globalDef.type);
      fctx.body.push({ op: "global.get", index: gIdx });
      fctx.body.push({ op: "local.set", index: tempLocal });
      fctx.localMap.set(name, tempLocal);
      savedLocal = tempLocal;
    }
  }

  let result: ValType | null | undefined;
  switch (methodName) {
    case "indexOf":
      result = compileArrayIndexOf(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "includes":
      result = compileArrayIncludes(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "reverse":
      result = compileArrayReverse(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "push":
      result = compileArrayPush(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "pop":
      result = compileArrayPop(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "shift":
      result = compileArrayShift(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "slice":
      result = compileArraySlice(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "concat":
      result = compileArrayConcat(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "join":
      result = compileArrayJoin(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "splice":
      result = compileArraySplice(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "at":
      result = compileArrayAt(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "fill":
      result = compileArrayFill(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "copyWithin":
      result = compileArrayCopyWithin(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "lastIndexOf":
      result = compileArrayLastIndexOf(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType); break;
    case "sort":
      result = (elemType.kind === "f64" || elemType.kind === "i32")
        ? compileArraySort(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) : undefined; break;
    // Functional array methods — currently only supported for numeric element types (f64, i32)
    case "filter":
      result = (elemType.kind === "f64" || elemType.kind === "i32")
        ? compileArrayFilter(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) : undefined; break;
    case "map":
      result = (elemType.kind === "f64" || elemType.kind === "i32")
        ? compileArrayMap(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) : undefined; break;
    case "reduce":
      result = (elemType.kind === "f64" || elemType.kind === "i32")
        ? compileArrayReduce(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) : undefined; break;
    case "forEach":
      result = (elemType.kind === "f64" || elemType.kind === "i32")
        ? compileArrayForEach(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) : undefined; break;
    case "find":
      result = (elemType.kind === "f64" || elemType.kind === "i32")
        ? compileArrayFind(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) : undefined; break;
    case "findIndex":
      result = (elemType.kind === "f64" || elemType.kind === "i32")
        ? compileArrayFindIndex(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) : undefined; break;
    case "some":
      result = (elemType.kind === "f64" || elemType.kind === "i32")
        ? compileArraySome(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) : undefined; break;
    case "every":
      result = (elemType.kind === "f64" || elemType.kind === "i32")
        ? compileArrayEvery(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType) : undefined; break;
    default:
      result = undefined;
  }

  // Write back temp local to module global for mutating methods
  if (moduleGlobalIdx !== undefined && savedLocal !== undefined) {
    if (MUTATING.has(methodName) && result !== null && result !== undefined) {
      fctx.body.push({ op: "local.get", index: savedLocal });
      fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
    }
    // Clean up the proxy from localMap
    if (ts.isIdentifier(propAccess.expression)) {
      fctx.localMap.delete(propAccess.expression.text);
    }
  }

  return result;
}

/** Helper: emit array.copy instruction.
 * Stack: [dstArr, dstOffset, srcArr, srcOffset, count] → []
 * All args are local indices.
 */
function emitArrayCopy(
  fctx: FunctionContext,
  arrTypeIdx: number,
  dstArr: number,
  dstOffset: number | null, // local index, or null for 0
  srcArr: number,
  srcOffset: number | null, // local index, or null for 0
  count: number, // local index holding count
): void {
  fctx.body.push({ op: "local.get", index: dstArr });
  if (dstOffset !== null) {
    fctx.body.push({ op: "local.get", index: dstOffset });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.get", index: srcArr });
  if (srcOffset !== null) {
    fctx.body.push({ op: "local.get", index: srcOffset });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.get", index: count });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);
}

/**
 * arr.at(index) → supports negative indexing.
 * If index < 0, actual = length + index; otherwise actual = index.
 * Returns elem at computed index.
 */
function compileArrayAt(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "at() requires 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_at_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const idxTmp = allocLocal(fctx, `__arr_at_idx_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_at_len_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: vecTmp });

  // Get length
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Compile index argument
  const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "i32" });
  if (argType && argType.kind === "f64") {
    fctx.body.push({ op: "i32.trunc_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: idxTmp });

  // If index < 0, add length to it
  fctx.body.push({ op: "local.get", index: idxTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: idxTmp },
      { op: "local.get", index: lenTmp },
      { op: "i32.add" },
      { op: "local.set", index: idxTmp },
    ],
  } as Instr);

  // Access element: data[idx]
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.get", index: idxTmp });
  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";
  fctx.body.push({ op: getOp, typeIdx: arrTypeIdx } as Instr);

  // In non-fast mode, numbers are f64
  if (!ctx.fast && elemType.kind === "i32") {
    // Convert to f64 for non-fast mode — actually numbers are already f64 in non-fast
  }

  return elemType;
}

/**
 * arr.indexOf(val) → loop through array, return index (as f64) or -1.
 * Receiver is a vec struct; extract data and length from it.
 */
function compileArrayIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "indexOf requires 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_iof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_iof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_iof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_iof_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_iof_val_${fctx.locals.length}`, elemType);

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length from vec struct field 0
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array from vec struct field 1
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    { op: eqOp } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp } as Instr,
            { op: "return" } as Instr,
          ]
        : [
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "return" } as Instr,
          ],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
    return { kind: "i32" };
  }
  fctx.body.push({ op: "f64.const", value: -1 });
  return { kind: "f64" };
}

/**
 * arr.includes(val) → like indexOf but returns i32 (0 or 1)
 * Receiver is a vec struct.
 */
function compileArrayIncludes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "includes requires 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_inc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_inc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_inc_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_inc_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_inc_val_${fctx.locals.length}`, elemType);

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    { op: eqOp } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "return" } as Instr,
      ],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  fctx.body.push({ op: "i32.const", value: 0 });
  return { kind: "i32" };
}

/**
 * arr.reverse() → swap elements in place on the data array, return same vec ref.
 */
function compileArrayReverse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType {
  const vecTmp = allocLocal(fctx, `__arr_rev_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_rev_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_rev_i_${fctx.locals.length}`, { kind: "i32" });
  const jTmp = allocLocal(fctx, `__arr_rev_j_${fctx.locals.length}`, { kind: "i32" });
  const swapTmp = allocLocal(fctx, `__arr_rev_sw_${fctx.locals.length}`, elemType);

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length from vec, then j = length - 1
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: jTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: jTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // swap = data[i]
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: swapTmp },

    // data[i] = data[j]
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: jTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "array.set", typeIdx: arrTypeIdx },

    // data[j] = swap
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: jTmp },
    { op: "local.get", index: swapTmp },
    { op: "array.set", typeIdx: arrTypeIdx },

    // i++, j--
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },

    { op: "local.get", index: jTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: jTmp },

    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.push(val) → capacity-based amortized O(1) push.
 * Mutates vec struct in-place: grows backing array if needed, sets element, increments length.
 */
function compileArrayPush(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "push requires at least 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_push_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_push_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_push_len_${fctx.locals.length}`, { kind: "i32" });
  const newCapTmp = allocLocal(fctx, `__arr_push_ncap_${fctx.locals.length}`, { kind: "i32" });
  const newDataTmp = allocLocal(fctx, `__arr_push_ndata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.tee", index: dataTmp });

  // Check: length == capacity?
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.eq" });

  // if (length == capacity) → grow
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // newCap = max(len * 2, 4)
      { op: "local.get", index: lenTmp } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.shl" } as Instr,  // len * 2
      { op: "i32.const", value: 4 } as Instr,
      // select: if len*2 > 4 then len*2 else 4
      { op: "local.get", index: lenTmp } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.shl" } as Instr,
      { op: "i32.const", value: 4 } as Instr,
      { op: "i32.gt_s" } as Instr,
      { op: "select" } as Instr,
      { op: "local.set", index: newCapTmp } as Instr,

      // newData = array.new_default(newCap)
      { op: "local.get", index: newCapTmp } as Instr,
      { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
      { op: "local.set", index: newDataTmp } as Instr,

      // array.copy newData[0..len] = data[0..len]
      { op: "local.get", index: newDataTmp } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.get", index: dataTmp } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.get", index: lenTmp } as Instr,
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,

      // Update vec struct data field
      { op: "local.get", index: vecTmp } as Instr,
      { op: "local.get", index: newDataTmp } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,

      // Update local data pointer
      { op: "local.get", index: newDataTmp } as Instr,
      { op: "local.set", index: dataTmp } as Instr,
    ],
  } as Instr);

  // Set element: data[length] = value
  fctx.body.push({ op: "local.get", index: dataTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });

  // Increment length: vec.length = len + 1
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // Return new length (i32 in fast mode, f64 otherwise)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.pop() → O(1), decrement length and return last element.
 */
function compileArrayPop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const vecTmp = allocLocal(fctx, `__arr_pop_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const newLenTmp = allocLocal(fctx, `__arr_pop_nl_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_pop_res_${fctx.locals.length}`, elemType);

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // newLen = length - 1
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: newLenTmp });

  // result = data[newLen]
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: getOp, typeIdx: arrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: resultTmp });

  // Decrement length: vec.length = newLen
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // Return result
  fctx.body.push({ op: "local.get", index: resultTmp });
  return elemType;
}

/**
 * arr.shift() → O(n) in-place: read data[0], shift data left, decrement length.
 */
function compileArrayShift(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const vecTmp = allocLocal(fctx, `__arr_sft_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_sft_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_sft_len_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_sft_nl_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_sft_res_${fctx.locals.length}`, elemType);

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // result = data[0]
  fctx.body.push({ op: "local.get", index: dataTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: getOp, typeIdx: arrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: resultTmp });

  // newLen = len - 1
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: newLenTmp });

  // Shift left: array.copy data[0..newLen] = data[1..len]
  fctx.body.push({ op: "local.get", index: dataTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: dataTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);

  // Decrement length: vec.length = newLen
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // Return result
  fctx.body.push({ op: "local.get", index: resultTmp });
  return elemType;
}

/**
 * arr.slice(start?, end?) → create new vec struct with sliced data.
 */
function compileArraySlice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType {
  const vecTmp = allocLocal(fctx, `__arr_slc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_slc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_slc_ndata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const startTmp = allocLocal(fctx, `__arr_slc_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_slc_e_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_slc_len_${fctx.locals.length}`, { kind: "i32" });
  const sliceLenTmp = allocLocal(fctx, `__arr_slc_sl_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });

  // end arg
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });

  // sliceLen = end - start
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: sliceLenTmp });

  // newData = array.new_default(sliceLen)
  fctx.body.push({ op: "local.get", index: sliceLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // array.copy newData[0..sliceLen] = data[start..start+sliceLen]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, startTmp, sliceLenTmp);

  // Create new vec struct: { sliceLen, newData }
  fctx.body.push({ op: "local.get", index: sliceLenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.concat(other) → create new vec struct with combined data.
 */
function compileArrayConcat(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "concat requires at least 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecA = allocLocal(fctx, `__arr_cat_va_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const vecB = allocLocal(fctx, `__arr_cat_vb_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataA = allocLocal(fctx, `__arr_cat_da_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const dataB = allocLocal(fctx, `__arr_cat_db_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_cat_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenA = allocLocal(fctx, `__arr_cat_la_${fctx.locals.length}`, { kind: "i32" });
  const lenB = allocLocal(fctx, `__arr_cat_lb_${fctx.locals.length}`, { kind: "i32" });
  const totalLen = allocLocal(fctx, `__arr_cat_tl_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver A → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecA });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenA });
  fctx.body.push({ op: "local.get", index: vecA });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataA });

  // Compile argument B → vec ref
  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.tee", index: vecB });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenB });
  fctx.body.push({ op: "local.get", index: vecB });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataB });

  // totalLen = lenA + lenB
  fctx.body.push({ op: "local.get", index: lenA });
  fctx.body.push({ op: "local.get", index: lenB });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: totalLen });

  // newData = array.new_default(totalLen)
  fctx.body.push({ op: "local.get", index: totalLen });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // array.copy newData[0..lenA] = dataA[0..lenA]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataA, null, lenA);

  // array.copy newData[lenA..lenA+lenB] = dataB[0..lenB]
  emitArrayCopy(fctx, arrTypeIdx, newData, lenA, dataB, null, lenB);

  // Create new vec struct: { totalLen, newData }
  fctx.body.push({ op: "local.get", index: totalLen });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.join(sep?) → convert elements to strings and concatenate.
 * Receiver is a vec struct.
 */
function compileArrayJoin(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const concatIdx = ctx.funcMap.get("concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  if (concatIdx === undefined) {
    ctx.errors.push({ message: "join requires string support (wasm:js-string concat)", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_join_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_join_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_join_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_join_i_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_join_res_${fctx.locals.length}`, { kind: "externref" });
  const sepTmp = allocLocal(fctx, `__arr_join_sep_${fctx.locals.length}`, { kind: "externref" });

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // separator
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!);
  } else {
    // Default separator "," — check if registered as string constant global
    const commaGlobalIdx = ctx.stringGlobalMap.get(",");
    if (commaGlobalIdx !== undefined) {
      fctx.body.push({ op: "global.get", index: commaGlobalIdx });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
  }
  fctx.body.push({ op: "local.set", index: sepTmp });

  // result starts as null (empty)
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "local.set", index: resultTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Build element-to-string instructions (use dataTmp instead of arrTmp)
  const elemToStr: Instr[] = [
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
  ];
  if (elemType.kind === "f64" && toStrIdx !== undefined) {
    elemToStr.push({ op: "call", funcIdx: toStrIdx });
  } else if (elemType.kind === "i32" && toStrIdx !== undefined) {
    elemToStr.push({ op: "f64.convert_i32_s" });
    elemToStr.push({ op: "call", funcIdx: toStrIdx });
  }

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...elemToStr,
        { op: "local.set", index: resultTmp } as Instr,
      ],
      else: [
        { op: "local.get", index: resultTmp } as Instr,
        { op: "local.get", index: sepTmp } as Instr,
        { op: "call", funcIdx: concatIdx } as Instr,
        ...elemToStr,
        { op: "call", funcIdx: concatIdx } as Instr,
        { op: "local.set", index: resultTmp } as Instr,
      ],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  fctx.body.push({ op: "local.get", index: resultTmp });
  return { kind: "externref" };
}

/**
 * arr.splice(start, deleteCount?) → in-place shift, returns new vec with deleted elements.
 */
function compileArraySplice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "splice requires at least 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_spl_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_spl_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const delData = allocLocal(fctx, `__arr_spl_deld_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_spl_len_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_spl_s_${fctx.locals.length}`, { kind: "i32" });
  const delCountTmp = allocLocal(fctx, `__arr_spl_dc_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_spl_nl_${fctx.locals.length}`, { kind: "i32" });
  const tailCountTmp = allocLocal(fctx, `__arr_spl_tc_${fctx.locals.length}`, { kind: "i32" });
  const tailStartTmp = allocLocal(fctx, `__arr_spl_ts_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg
  compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_f64_s" });
  fctx.body.push({ op: "local.set", index: startTmp });

  // deleteCount (default: len - start)
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.sub" });
  }
  fctx.body.push({ op: "local.set", index: delCountTmp });

  // Create deleted elements backing array and copy
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: delData });

  // array.copy delData[0..delCount] = data[start..start+delCount]
  emitArrayCopy(fctx, arrTypeIdx, delData, null, dataTmp, startTmp, delCountTmp);

  // tailStart = start + delCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: tailStartTmp });

  // tailCount = len - tailStart
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: tailStartTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp });

  // Shift tail left in-place: array.copy data[start..start+tailCount] = data[tailStart..tailStart+tailCount]
  emitArrayCopy(fctx, arrTypeIdx, dataTmp, startTmp, dataTmp, tailStartTmp, tailCountTmp);

  // newLen = len - delCount
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: newLenTmp });

  // Update vec length
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // Return new vec with deleted elements: { delCount, delData }
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "local.get", index: delData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

// ── Generator helper functions ────────────────────────────────────────

/**
 * Check if a type looks like an IteratorResult (has .value and .done properties)
 * even if the type checker doesn't resolve it as IteratorResult directly.
 * This handles cases where the type is a union (IteratorYieldResult | IteratorReturnResult).
 */
function isGeneratorIteratorResultLike(
  ctx: CodegenContext,
  type: ts.Type,
  propName: string,
): boolean {
  if (propName !== "value" && propName !== "done") return false;
  // Check if the type has both .value and .done properties (IteratorResult shape)
  const props = type.getProperties();
  const hasValue = props.some((p) => p.name === "value");
  const hasDone = props.some((p) => p.name === "done");
  if (hasValue && hasDone) return true;
  // Check union types (IteratorResult = IteratorYieldResult | IteratorReturnResult)
  if (type.isUnion()) {
    for (const t of type.types) {
      if (isIteratorResultType(t)) return true;
    }
  }
  return false;
}

/**
 * Get the value type T from IteratorResult<T>.
 * Returns the ValType for the value, or null if not determinable.
 */
function getIteratorResultValueType(
  ctx: CodegenContext,
  type: ts.Type,
): ValType | null {
  // Try to get T from the type arguments
  const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
  if (typeArgs.length > 0) {
    return resolveWasmType(ctx, typeArgs[0]!);
  }
  // For unions, check each member
  if (type.isUnion()) {
    for (const t of type.types) {
      const args = ctx.checker.getTypeArguments(t as ts.TypeReference);
      if (args.length > 0) {
        return resolveWasmType(ctx, args[0]!);
      }
    }
  }
  return null;
}

// ── Generator yield expression ────────────────────────────────────────

/**
 * Compile a `yield expr` expression inside a generator function.
 * Pushes the yielded value into the __gen_buffer (a JS array managed by the host).
 * The yield expression itself evaluates to void (we don't support receiving
 * values via yield in this initial implementation).
 */
function compileYieldExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.YieldExpression,
): InnerResult {
  // Ensure we're inside a generator function
  if (!ctx.generatorFunctions.has(fctx.name)) {
    ctx.errors.push({
      message: "yield expression outside of generator function",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Get the buffer local
  const bufferIdx = fctx.localMap.get("__gen_buffer");
  if (bufferIdx === undefined) {
    ctx.errors.push({
      message: "Internal error: __gen_buffer not found in generator function",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  if (!expr.expression) {
    // yield with no value: push undefined
    const pushRefIdx = ctx.funcMap.get("__gen_push_ref");
    if (pushRefIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: bufferIdx });
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "call", funcIdx: pushRefIdx });
    }
    return VOID_RESULT;
  }

  // Compile the yielded expression
  const yieldedType = compileExpressionInner(ctx, fctx, expr.expression);
  if (yieldedType === null || yieldedType === VOID_RESULT) {
    return VOID_RESULT;
  }

  // Store the yielded value in a temp local, then push to buffer
  const tmpLocal = allocLocal(fctx, `__yield_tmp_${fctx.locals.length}`, yieldedType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Push to buffer based on type
  fctx.body.push({ op: "local.get", index: bufferIdx });
  fctx.body.push({ op: "local.get", index: tmpLocal });

  if (yieldedType.kind === "f64") {
    const pushIdx = ctx.funcMap.get("__gen_push_f64");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  } else if (yieldedType.kind === "i32") {
    const pushIdx = ctx.funcMap.get("__gen_push_i32");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  } else {
    // externref, ref, ref_null — all pass as externref
    const pushIdx = ctx.funcMap.get("__gen_push_ref");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  }

  return VOID_RESULT;
}

// ── Functional array methods (filter, map, reduce, forEach, find, findIndex, some, every) ──

/**
 * arr.filter(cb) → iterate elements, call host-bridged callback, build new array from truthy results.
 * Pattern: allocate result array of same capacity, copy matching elements, return new vec struct.
 */
function compileArrayFilter(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "filter requires a callback argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const callBridgeIdx = ctx.funcMap.get(ctx.fast ? "__call_1_i32" : "__call_1_f64");
  if (callBridgeIdx === undefined) {
    ctx.errors.push({ message: "Missing __call_1_f64 import for filter", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_flt_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_flt_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_flt_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_flt_i_${fctx.locals.length}`, { kind: "i32" });
  const cbTmp = allocLocal(fctx, `__arr_flt_cb_${fctx.locals.length}`, { kind: "externref" });
  const resData = allocLocal(fctx, `__arr_flt_rd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const resLen = allocLocal(fctx, `__arr_flt_rl_${fctx.locals.length}`, { kind: "i32" });
  const elemTmp = allocLocal(fctx, `__arr_flt_el_${fctx.locals.length}`, elemType);

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile callback (arrow function → externref via __make_callback)
  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.set", index: cbTmp });

  // Allocate result array with same capacity as source
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: resData });

  // resLen = 0, i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resLen });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Loop: for each element, call callback, if truthy push to result
  const loopBody: Instr[] = [
    // if (i >= len) break
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,

    // elem = data[i]
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: elemTmp } as Instr,

    // call __call_1_f64(cb, elem as f64) → f64
    { op: "local.get", index: cbTmp } as Instr,
    { op: "local.get", index: elemTmp } as Instr,
    ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
    { op: "call", funcIdx: callBridgeIdx } as Instr,

    // if result != 0 (truthy), add element to result
    ...(ctx.fast
      ? []
      : [{ op: "f64.const", value: 0 } as Instr, { op: "f64.ne" } as Instr]),
    { op: "if", blockType: { kind: "empty" },
      then: [
        // resData[resLen] = elem
        { op: "local.get", index: resData } as Instr,
        { op: "local.get", index: resLen } as Instr,
        { op: "local.get", index: elemTmp } as Instr,
        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
        // resLen++
        { op: "local.get", index: resLen } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.set", index: resLen } as Instr,
      ],
    } as Instr,

    // i++
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // Return new vec struct { resLen, resData }
  fctx.body.push({ op: "local.get", index: resLen });
  fctx.body.push({ op: "local.get", index: resData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.map(cb) → iterate elements, call callback, store results in new array.
 */
function compileArrayMap(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "map requires a callback argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const callBridgeIdx = ctx.funcMap.get(ctx.fast ? "__call_1_i32" : "__call_1_f64");
  if (callBridgeIdx === undefined) {
    ctx.errors.push({ message: "Missing __call_1_f64 import for map", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const cbArg = callExpr.arguments[0]!;
  // Determine the result element type from the callback's own return type
  let mapResultElemType: ValType = elemType; // default: same as source
  let mapArrTypeIdx = arrTypeIdx;
  let mapVecTypeIdx = vecTypeIdx;

  // Try to get the callback's return type (not the .map() call's return type)
  if (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)) {
    const cbSig = ctx.checker.getSignatureFromDeclaration(cbArg);
    if (cbSig) {
      const retType = ctx.checker.getReturnTypeOfSignature(cbSig);
      const mapped = resolveWasmType(ctx, retType);
      // If return type differs from source element, create new array types
      if (mapped.kind !== elemType.kind) {
        mapResultElemType = mapped;
        mapArrTypeIdx = getOrRegisterArrayType(ctx, mapResultElemType.kind, mapResultElemType);
        mapVecTypeIdx = getOrRegisterVecType(ctx, mapResultElemType.kind, mapResultElemType);
      }
    }
  }

  const vecTmp = allocLocal(fctx, `__arr_map_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_map_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_map_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_map_i_${fctx.locals.length}`, { kind: "i32" });
  const cbTmp = allocLocal(fctx, `__arr_map_cb_${fctx.locals.length}`, { kind: "externref" });
  const resData = allocLocal(fctx, `__arr_map_rd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: mapArrTypeIdx });

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile callback
  compileExpression(ctx, fctx, cbArg);
  fctx.body.push({ op: "local.set", index: cbTmp });

  // Allocate result array with same length
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: mapArrTypeIdx });
  fctx.body.push({ op: "local.set", index: resData });

  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Loop: for each element, resData[i] = cb(data[i])
  const loopBody: Instr[] = [
    // if (i >= len) break
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,

    // resData[i] = ...
    { op: "local.get", index: resData } as Instr,
    { op: "local.get", index: iTmp } as Instr,

    // call __call_1_f64(cb, data[i] as f64) → f64
    { op: "local.get", index: cbTmp } as Instr,
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
    { op: "call", funcIdx: callBridgeIdx } as Instr,

    // Convert result to target element type if needed
    ...(!ctx.fast && mapResultElemType.kind === "i32" ? [{ op: "i32.trunc_f64_s" } as Instr] : []),

    // array.set
    { op: "array.set", typeIdx: mapArrTypeIdx } as Instr,

    // i++
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // Return new vec struct { len, resData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: resData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: mapVecTypeIdx });
  return { kind: "ref_null", typeIdx: mapVecTypeIdx };
}

/**
 * arr.reduce(cb, initial) → iterate elements, accumulate result via callback.
 */
function compileArrayReduce(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    ctx.errors.push({ message: "reduce requires a callback and initial value", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const callBridgeIdx = ctx.funcMap.get(ctx.fast ? "__call_2_i32" : "__call_2_f64");
  if (callBridgeIdx === undefined) {
    ctx.errors.push({ message: `Missing ${ctx.fast ? "__call_2_i32" : "__call_2_f64"} import for reduce`, line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const numKind = ctx.fast ? "i32" : "f64";
  const vecTmp = allocLocal(fctx, `__arr_red_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_red_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_red_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_red_i_${fctx.locals.length}`, { kind: "i32" });
  const cbTmp = allocLocal(fctx, `__arr_red_cb_${fctx.locals.length}`, { kind: "externref" });
  const accTmp = allocLocal(fctx, `__arr_red_acc_${fctx.locals.length}`, { kind: numKind as any });

  // Compile receiver
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile callback
  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.set", index: cbTmp });

  // Compile initial value
  compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: numKind as any });
  fctx.body.push({ op: "local.set", index: accTmp });

  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Loop: acc = cb(acc, data[i])
  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,

    // acc = __call_2_f64(cb, acc, data[i])
    { op: "local.get", index: cbTmp } as Instr,
    { op: "local.get", index: accTmp } as Instr,
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
    { op: "call", funcIdx: callBridgeIdx } as Instr,
    { op: "local.set", index: accTmp } as Instr,

    // i++
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // Return accumulator
  fctx.body.push({ op: "local.get", index: accTmp });
  return { kind: numKind as any };
}

/**
 * arr.forEach(cb) → iterate elements, call callback, return void.
 */
function compileArrayForEach(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "forEach requires a callback argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const callBridgeIdx = ctx.funcMap.get(ctx.fast ? "__call_1_i32" : "__call_1_f64");
  if (callBridgeIdx === undefined) {
    ctx.errors.push({ message: "Missing __call_1_f64 import for forEach", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_fe_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_fe_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_fe_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_fe_i_${fctx.locals.length}`, { kind: "i32" });
  const cbTmp = allocLocal(fctx, `__arr_fe_cb_${fctx.locals.length}`, { kind: "externref" });

  // Compile receiver
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile callback
  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.set", index: cbTmp });

  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Loop: call cb(data[i]), drop result
  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,

    // __call_1_f64(cb, data[i]) → f64 (dropped)
    { op: "local.get", index: cbTmp } as Instr,
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
    { op: "call", funcIdx: callBridgeIdx } as Instr,
    { op: "drop" } as Instr,

    // i++
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // forEach returns void — return null to indicate no value on stack
  return null;
}

/**
 * arr.find(cb) → iterate, return first element where cb returns truthy, else NaN.
 * Since number arrays use f64, we return NaN for "not found" (approximation of undefined).
 */
function compileArrayFind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "find requires a callback argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const callBridgeIdx = ctx.funcMap.get(ctx.fast ? "__call_1_i32" : "__call_1_f64");
  if (callBridgeIdx === undefined) {
    ctx.errors.push({ message: "Missing __call_1_f64 import for find", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_find_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_find_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_find_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_find_i_${fctx.locals.length}`, { kind: "i32" });
  const cbTmp = allocLocal(fctx, `__arr_find_cb_${fctx.locals.length}`, { kind: "externref" });
  const elemTmpLocal = allocLocal(fctx, `__arr_find_el_${fctx.locals.length}`, elemType);

  // Compile receiver
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile callback
  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.set", index: cbTmp });

  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,

    // elem = data[i]
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: elemTmpLocal } as Instr,

    // if cb(elem) is truthy, return elem
    { op: "local.get", index: cbTmp } as Instr,
    { op: "local.get", index: elemTmpLocal } as Instr,
    ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
    { op: "call", funcIdx: callBridgeIdx } as Instr,
    ...(ctx.fast
      ? []
      : [{ op: "f64.const", value: 0 } as Instr, { op: "f64.ne" } as Instr]),
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: elemTmpLocal } as Instr,
        ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
        { op: "return" } as Instr,
      ],
    } as Instr,

    // i++
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // Not found: return 0 (i32) in fast mode, NaN (f64) otherwise
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.div" });
  return { kind: "f64" };
}

/**
 * arr.findIndex(cb) → iterate, return index (f64) of first truthy cb result, else -1.
 */
function compileArrayFindIndex(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "findIndex requires a callback argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const callBridgeIdx = ctx.funcMap.get(ctx.fast ? "__call_1_i32" : "__call_1_f64");
  if (callBridgeIdx === undefined) {
    ctx.errors.push({ message: "Missing __call_1_f64 import for findIndex", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_fi_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_fi_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_fi_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_fi_i_${fctx.locals.length}`, { kind: "i32" });
  const cbTmp = allocLocal(fctx, `__arr_fi_cb_${fctx.locals.length}`, { kind: "externref" });

  // Compile receiver
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.set", index: cbTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,

    // if cb(data[i]) is truthy, return i
    { op: "local.get", index: cbTmp } as Instr,
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
    { op: "call", funcIdx: callBridgeIdx } as Instr,
    ...(ctx.fast ? [] : [{ op: "f64.const", value: 0 } as Instr, { op: "f64.ne" } as Instr]),
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: iTmp } as Instr,
        ...(ctx.fast ? [] : [{ op: "f64.convert_i32_s" } as Instr]),
        { op: "return" } as Instr,
      ],
    } as Instr,

    // i++
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // Not found: return -1
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
    return { kind: "i32" };
  }
  fctx.body.push({ op: "f64.const", value: -1 });
  return { kind: "f64" };
}

/**
 * arr.some(cb) → returns i32 (1 if any element passes callback, 0 otherwise).
 */
function compileArraySome(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "some requires a callback argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const callBridgeIdx = ctx.funcMap.get(ctx.fast ? "__call_1_i32" : "__call_1_f64");
  if (callBridgeIdx === undefined) {
    ctx.errors.push({ message: "Missing __call_1_f64 import for some", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_some_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_some_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_some_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_some_i_${fctx.locals.length}`, { kind: "i32" });
  const cbTmp = allocLocal(fctx, `__arr_some_cb_${fctx.locals.length}`, { kind: "externref" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.set", index: cbTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,

    { op: "local.get", index: cbTmp } as Instr,
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
    { op: "call", funcIdx: callBridgeIdx } as Instr,
    ...(ctx.fast ? [] : [{ op: "f64.const", value: 0 } as Instr, { op: "f64.ne" } as Instr]),
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "return" } as Instr,
      ],
    } as Instr,

    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // No element matched
  fctx.body.push({ op: "i32.const", value: 0 });
  return { kind: "i32" };
}

/**
 * arr.every(cb) → returns i32 (1 if all elements pass callback, 0 otherwise).
 */
function compileArrayEvery(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "every requires a callback argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const callBridgeIdx = ctx.funcMap.get(ctx.fast ? "__call_1_i32" : "__call_1_f64");
  if (callBridgeIdx === undefined) {
    ctx.errors.push({ message: "Missing __call_1_f64 import for every", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_evr_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_evr_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_evr_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_evr_i_${fctx.locals.length}`, { kind: "i32" });
  const cbTmp = allocLocal(fctx, `__arr_evr_cb_${fctx.locals.length}`, { kind: "externref" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.set", index: cbTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,

    { op: "local.get", index: cbTmp } as Instr,
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
    { op: "call", funcIdx: callBridgeIdx } as Instr,
    ...(ctx.fast ? [{ op: "i32.eqz" } as Instr] : [{ op: "f64.const", value: 0 } as Instr, { op: "f64.eq" } as Instr]),  // if result == 0 (falsy)
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "return" } as Instr,
      ],
    } as Instr,

    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // All elements passed
  fctx.body.push({ op: "i32.const", value: 1 });
  return { kind: "i32" };
}

/**
 * arr.sort() → in-place Timsort, return same vec ref.
 * Only supported for numeric element types (i32, f64).
 */
function compileArraySort(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const elemKind = elemType.kind as "i32" | "f64";
  const timsortIdx = ensureTimsortHelper(ctx, vecTypeIdx, arrTypeIdx, elemKind);

  const vecTmp = allocLocal(fctx, `__arr_sort_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });

  // Compile receiver, save a copy for return value
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Call timsort(vec)
  fctx.body.push({ op: "call", funcIdx: timsortIdx });

  // Return the same vec ref (sort is in-place)
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.fill(value, start?, end?) → fill elements with value, return same vec ref.
 * Mutates the array in place.
 */
function compileArrayFill(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "fill requires at least 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_fill_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_fill_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_fill_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_fill_val_${fctx.locals.length}`, elemType);
  const startTmp = allocLocal(fctx, `__arr_fill_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_fill_e_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_fill_i_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile value argument
  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // start (default: 0)
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });

  // end (default: length)
  if (callExpr.arguments.length >= 3) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });

  // i = start
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "local.set", index: iTmp });

  // Loop: while (i < end) { data[i] = value; i++; }
  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: endTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // data[i] = value
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: valTmp },
    { op: "array.set", typeIdx: arrTypeIdx },

    // i++
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.copyWithin(target, start, end?) → copy elements within the same array, return same vec ref.
 * Mutates the array in place using array.copy.
 */
function compileArrayCopyWithin(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    ctx.errors.push({ message: "copyWithin requires at least 2 arguments (target, start)", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_cw_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_cw_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_cw_len_${fctx.locals.length}`, { kind: "i32" });
  const targetTmp = allocLocal(fctx, `__arr_cw_tgt_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_cw_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_cw_e_${fctx.locals.length}`, { kind: "i32" });
  const countTmp = allocLocal(fctx, `__arr_cw_cnt_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // target arg
  if (ctx.fast) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: targetTmp });

  // start arg
  if (ctx.fast) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: startTmp });

  // end arg (default: length)
  if (callExpr.arguments.length >= 3) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });

  // count = min(end - start, len - target)
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: targetTmp });
  fctx.body.push({ op: "i32.sub" });
  // select min: if (end-start) < (len-target) then (end-start) else (len-target)
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: targetTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: countTmp });

  // array.copy data[target..target+count] = data[start..start+count]
  emitArrayCopy(fctx, arrTypeIdx, dataTmp, targetTmp, dataTmp, startTmp, countTmp);

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.lastIndexOf(value, fromIndex?) → reverse linear scan, return index or -1.
 */
function compileArrayLastIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "lastIndexOf requires 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_liof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_liof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_liof_i_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_liof_val_${fctx.locals.length}`, elemType);

  // Compile receiver → vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });

  // Extract length, then i = length - 1 (or fromIndex if provided)
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });

  if (callExpr.arguments.length >= 2) {
    // fromIndex provided
    fctx.body.push({ op: "drop" });
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
  } else {
    // Default: length - 1
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
  }
  fctx.body.push({ op: "local.set", index: iTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile search value
  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Loop: while (i >= 0) { if data[i] == val return i; i--; }
  const loopBody: Instr[] = [
    // if (i < 0) break
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "br_if", depth: 1 },

    // if (data[i] == val) return i
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    { op: eqOp } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp } as Instr,
            { op: "return" } as Instr,
          ]
        : [
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "return" } as Instr,
          ],
    } as Instr,

    // i--
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr,
    ],
  });

  // Not found → return -1
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
    return { kind: "i32" };
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
    return { kind: "f64" };
  }
}

/** Check if an expression is statically known to be NaN at compile time */
/**
 * Try to statically determine the numeric value of an expression.
 * Handles: numeric literals, NaN, Infinity, -Infinity, object-with-valueOf, {}.
 * Returns undefined if the value cannot be determined at compile time.
 */
function tryStaticToNumber(ctx: CodegenContext, expr: ts.Expression): number | undefined {
  // Numeric literal
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  // NaN identifier
  if (ts.isIdentifier(expr) && expr.text === "NaN") return NaN;
  // Infinity identifier
  if (ts.isIdentifier(expr) && expr.text === "Infinity") return Infinity;
  // -Infinity: prefix minus on Infinity
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = tryStaticToNumber(ctx, expr.operand);
    if (inner !== undefined) return -inner;
  }
  // 0/0 → NaN
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.SlashToken &&
    ts.isNumericLiteral(expr.left) && Number(expr.left.text) === 0 &&
    ts.isNumericLiteral(expr.right) && Number(expr.right.text) === 0
  ) return NaN;
  // Object literal: check valueOf or return NaN for {}
  if (ts.isObjectLiteralExpression(expr)) {
    const valueOfProp = expr.properties.find(
      p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "valueOf",
    );
    if (!valueOfProp || !ts.isPropertyAssignment(valueOfProp)) {
      // {} or object without valueOf → ToNumber = NaN
      return NaN;
    }
    // valueOf is a function expression — analyze its return value
    const init = valueOfProp.initializer;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
      const retVal = getStaticReturnValue(ctx, init);
      if (retVal !== undefined) return retVal;
      // valueOf function returns void → ToNumber(undefined) = NaN
      if (returnsVoid(init)) return NaN;
    }
    return NaN; // Fallback for objects: ToNumber always produces NaN for non-primitive valueOf
  }
  // Variable: trace to initializer
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return tryStaticToNumber(ctx, decl.initializer);
    }
  }
  return undefined;
}

/** Get the static numeric return value of a simple function (single return statement) */
function getStaticReturnValue(ctx: CodegenContext, fn: ts.FunctionExpression | ts.ArrowFunction): number | undefined {
  const body = fn.body;
  if (!ts.isBlock(body)) {
    // Arrow with expression body: () => 42
    return tryStaticToNumber(ctx, body);
  }
  // Look for a single return statement
  for (const stmt of body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      return tryStaticToNumber(ctx, stmt.expression);
    }
  }
  return undefined;
}

/** Check if a function body returns void (no return statement or return without value) */
function returnsVoid(fn: ts.FunctionExpression | ts.ArrowFunction): boolean {
  const body = fn.body;
  if (!ts.isBlock(body)) return false; // expression body always has a value
  for (const stmt of body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression) return false;
  }
  return true; // No return with value found
}

function isStaticNaN(ctx: CodegenContext, expr: ts.Expression): boolean {
  // NaN identifier
  if (ts.isIdentifier(expr) && expr.text === "NaN") return true;
  // 0 / 0, 0.0 / 0.0
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.SlashToken &&
    ts.isNumericLiteral(expr.left) && Number(expr.left.text) === 0 &&
    ts.isNumericLiteral(expr.right) && Number(expr.right.text) === 0
  ) return true;
  // Variable initialized with NaN: trace to declaration
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return isStaticNaN(ctx, decl.initializer);
    }
  }
  return false;
}

function getLine(node: ts.Node): number {
  const sf = node.getSourceFile();
  if (!sf) return 0;
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  return line + 1;
}

function getCol(node: ts.Node): number {
  const sf = node.getSourceFile();
  if (!sf) return 0;
  const { character } = sf.getLineAndCharacterOfPosition(node.getStart());
  return character + 1;
}
