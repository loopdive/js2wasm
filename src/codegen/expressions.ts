import ts from "typescript";
import {
  isBooleanType,
  isExternalDeclaredClass,
  isGeneratorType,
  isHeterogeneousUnion,
  isIteratorResultType,
  isNumberType,
  isStringType,
  isVoidType,
  mapTsTypeToWasm,
  unwrapPromiseType,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import {
  compileArrayMethodCall,
  compileArrayPrototypeCall,
  emitBoundsCheckedArrayGet,
  resolveArrayInfo,
} from "./array-methods.js";
import {
  compileBinaryExpression,
  emitModulo,
  emitToInt32,
} from "./binary-ops.js";
import type {
  ClosureInfo,
  CodegenContext,
  FunctionContext,
  RestParamInfo,
} from "./index.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  allocLocal,
  allocTempLocal,
  ensureAnyHelpers,
  ensureExnTag,
  ensureI32Condition,
  ensureStructForType,
  getArrTypeIdxFromVec,
  getLocalType,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
  isAnyValue,
  localGlobalIdx,
  nativeStringType,
  pushBody,
  releaseTempLocal,
  resolveWasmType,
  hoistLetConstWithTdz,
  hoistVarDeclarations,
} from "./index.js";
import {
  compileArrayConstructorCall,
  compileArrayLiteral,
  compileObjectLiteral,
  compileSymbolCall,
  resolveComputedKeyExpression,
} from "./literals.js";
import {
  compileObjectDefineProperty,
  compileObjectKeysOrValues,
  compilePropertyIntrospection,
} from "./object-ops.js";
import type { InnerResult } from "./shared.js";
import {
  getCol,
  getLine,
  registerCompileExpression,
  registerEnsureLateImport,
  registerFlushLateImportShifts,
  valTypesMatch,
  VOID_RESULT,
} from "./shared.js";
import { compileStatement, emitTdzCheck, hoistFunctionDeclarations } from "./statements.js";
import {
  compileNativeStringMethodCall,
  compileStringLiteral,
  compileTaggedTemplateExpression,
  compileTemplateExpression,
  emitBoolToString,
} from "./string-ops.js";
import {
  coerceType as coerceTypeImpl,
  defaultValueInstrs,
  emitGuardedRefCast,
  emitSafeExternrefToF64,
  pushDefaultValue,
} from "./type-coercion.js";
import {
  compileDeleteExpression,
  compileRegExpLiteral,
  compileTypeofExpression,
} from "./typeof-delete.js";
import { walkInstructions } from "./walk-instructions.js";
export {
  compileArrayMethodCall,
  compileArrayPrototypeCall,
  emitBoundsCheckedArrayGet,
  emitClampIndex,
  emitClampNonNeg,
} from "./array-methods.js";
export { compileNumericBinaryOp } from "./binary-ops.js";
export {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
} from "./closures.js";
export {
  getWellKnownSymbolId,
  resolveComputedKeyExpression,
  resolveConstantExpression,
} from "./literals.js";
export {
  compileObjectDefineProperty,
  compileObjectKeysOrValues,
  compilePropertyIntrospection,
} from "./object-ops.js";
export {
  compileElementAccess,
  compileOptionalPropertyAccess,
  compilePropertyAccess,
  emitNullCheckThrow,
} from "./property-access.js";
export { getCol, getLine, valTypesMatch, VOID_RESULT } from "./shared.js";
export {
  compileNativeStringLiteral,
  compileNativeStringMethodCall,
  compileNativeTemplateExpression,
  compileStringBinaryOp,
  compileStringLiteral,
  compileTaggedTemplateExpression,
  compileTemplateExpression,
  emitBoolToString,
} from "./string-ops.js";
export {
  coercionInstrs,
  defaultValueInstrs,
  pushDefaultValue,
} from "./type-coercion.js";
export { compileInstanceOf, compileTypeofComparison } from "./typeof-delete.js";

/**
 * Emit a Wasm throw instruction with a string error message.
 * This replaces `unreachable` traps so that JS try/catch (and assert.throws)
 * can catch the error instead of getting an uncatchable RuntimeError.
 */
export function emitThrowString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  message: string,
): void {
  addStringConstantGlobal(ctx, message);
  const strIdx = ctx.stringGlobalMap.get(message)!;
  fctx.body.push({ op: "global.get", index: strIdx } as Instr);
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}

/**
 * Check if a TS return type is effectively void for Wasm purposes.
 * For async functions, the TS checker reports `Promise<void>` which is not
 * caught by `isVoidType`. This helper unwraps Promise types for async
 * functions before checking.
 *
 * Use this instead of bare `isVoidType(retType)` at all call-return-type
 * resolution points to prevent emitting `drop` on an empty stack.
 */
function isEffectivelyVoidReturn(
  ctx: CodegenContext,
  retType: ts.Type,
  funcName?: string,
): boolean {
  if (isVoidType(retType)) return true;
  // For async functions, unwrap Promise<T> and check if T is void
  if (funcName && ctx.asyncFunctions.has(funcName)) {
    const unwrapped = unwrapPromiseType(retType, ctx.checker);
    if (isVoidType(unwrapped)) return true;
  }
  return false;
}

/**
 * Check if a Wasm function (by index) has a void return type by inspecting
 * the actual function type in the module. This is the ground truth for whether
 * a `call` instruction pushes a value onto the stack.
 */
function wasmFuncReturnsVoid(ctx: CodegenContext, funcIdx: number): boolean {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          return (
            !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0
          );
        }
        importFuncCount++;
      }
    }
    return true; // not found — assume void to be safe
  }
  const localIdx = funcIdx - ctx.numImportFuncs;
  const func = ctx.mod.functions[localIdx];
  if (func) {
    const typeDef = ctx.mod.types[func.typeIdx];
    return !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0;
  }
  return true; // not found — assume void to be safe
}

/** Check whether a function *type* (by type index) has zero results. */
function wasmFuncTypeReturnsVoid(ctx: CodegenContext, typeIdx: number): boolean {
  const typeDef = ctx.mod.types[typeIdx];
  return !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0;
}

/**
 * Check whether the last instruction emitted since bodyLenBefore is a
 * void-returning call (call or call_ref). Used as a guard before emitting
 * `drop` to prevent stack underflows.
 */
function _isLastInstrVoidCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bodyLenBefore: number,
): boolean {
  if (fctx.body.length <= bodyLenBefore) return true; // nothing emitted — treat as void
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (!lastInstr) return false;
  const op = (lastInstr as any).op;
  if (op === "call" && (lastInstr as any).funcIdx !== undefined) {
    return wasmFuncReturnsVoid(ctx, (lastInstr as any).funcIdx);
  }
  if (op === "call_ref" && (lastInstr as any).typeIdx !== undefined) {
    return wasmFuncTypeReturnsVoid(ctx, (lastInstr as any).typeIdx);
  }
  return false;
}

/**
 * Get the actual Wasm return type of a function by inspecting its type definition.
 * Returns undefined if the function has void return or is not found.
 * Use this instead of resolveWasmType(retType) at call sites to avoid mismatches
 * when TS type says 'any' (→ externref) but the Wasm function returns f64/i32.
 */
function getWasmFuncReturnType(ctx: CodegenContext, funcIdx: number): ValType | undefined {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          if (typeDef?.kind === "func" && typeDef.results.length > 0) {
            return typeDef.results[0]!;
          }
          return undefined;
        }
        importFuncCount++;
      }
    }
    return undefined;
  }
  const localIdx = funcIdx - ctx.numImportFuncs;
  const func = ctx.mod.functions[localIdx];
  if (func) {
    const typeDef = ctx.mod.types[func.typeIdx];
    if (typeDef?.kind === "func" && typeDef.results.length > 0) {
      return typeDef.results[0]!;
    }
  }
  return undefined;
}

/**
 * Shift function indices after a late import addition. This must update all
 * already-compiled function bodies, the current function body, any saved bodies
 * from the savedBody swap pattern, and export descriptors.
 */
export function shiftLateImportIndices(
  ctx: CodegenContext,
  fctx: FunctionContext,
  importsBefore: number,
  added: number,
): void {
  if (added <= 0) return;
  function shiftInstrs(instrs: Instr[]): void {
    walkInstructions(instrs, (instr) => {
      if ("funcIdx" in instr && typeof (instr as any).funcIdx === "number") {
        if ((instr as any).funcIdx >= importsBefore) {
          (instr as any).funcIdx += added;
        }
      }
    });
  }
  // Track which body arrays have been shifted to prevent double-shifting.
  // Using a Set avoids reliance on reference equality between bodies that
  // may be the same logical array referenced from multiple places.
  const shifted = new Set<Instr[]>();
  for (const func of ctx.mod.functions) {
    if (!shifted.has(func.body)) {
      shiftInstrs(func.body);
      shifted.add(func.body);
    }
  }
  // Shift current function body (if not already shifted via mod.functions)
  const curBody = fctx.body;
  if (!shifted.has(curBody)) {
    shiftInstrs(curBody);
    shifted.add(curBody);
  }
  // Shift saved body arrays (if not already shifted)
  for (const sb of fctx.savedBodies) {
    if (shifted.has(sb)) continue;
    shiftInstrs(sb);
    shifted.add(sb);
  }
  // Shift parent function contexts on the funcStack (nested closure compilation)
  for (const parentFctx of ctx.funcStack) {
    if (!shifted.has(parentFctx.body)) {
      shiftInstrs(parentFctx.body);
      shifted.add(parentFctx.body);
    }
    for (const sb of parentFctx.savedBodies) {
      if (!shifted.has(sb)) {
        shiftInstrs(sb);
        shifted.add(sb);
      }
    }
  }
  // Shift parent function bodies on parentBodiesStack.
  // Use the same `shifted` set to avoid double-shifting bodies already
  // handled by the funcStack loop above (funcStack.body and
  // parentBodiesStack entries can be the same array).
  for (const pb of ctx.parentBodiesStack) {
    if (!shifted.has(pb)) {
      shiftInstrs(pb);
      shifted.add(pb);
    }
  }
  // Shift the pending init body (module-level init function compiled before
  // top-level functions, but not yet added to ctx.mod.functions).
  if (ctx.pendingInitBody && !shifted.has(ctx.pendingInitBody)) {
    shiftInstrs(ctx.pendingInitBody);
    shifted.add(ctx.pendingInitBody);
  }
  // Shift funcMap entries for defined functions (not import entries).
  // Defined functions had indices >= importsBefore (before the shift) and need
  // to move up by `added`. Import entries (indices < numImportFuncs after addition)
  // are already correct and must not be shifted.
  // Build set of import function names for fast lookup.
  const importNames = new Set<string>();
  for (const imp of ctx.mod.imports) {
    if (imp.desc.kind === "func") importNames.add(imp.name);
  }
  for (const [name, idx] of ctx.funcMap) {
    if (importNames.has(name)) continue; // skip all imports
    if (idx >= importsBefore) {
      ctx.funcMap.set(name, idx + added);
    }
  }
  // Shift export descriptors
  for (const exp of ctx.mod.exports) {
    if (exp.desc.kind === "func" && exp.desc.index >= importsBefore) {
      exp.desc.index += added;
    }
  }
  // Shift table elements
  for (const elem of ctx.mod.elements) {
    if (elem.funcIndices) {
      for (let i = 0; i < elem.funcIndices.length; i++) {
        if (elem.funcIndices[i]! >= importsBefore) {
          elem.funcIndices[i]! += added;
        }
      }
    }
  }
  // Shift declared func refs
  if (ctx.mod.declaredFuncRefs.length > 0) {
    ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) =>
      idx >= importsBefore ? idx + added : idx,
    );
  }
}

/**
 * Add a late import if it does not already exist, deferring the index shift.
 * Records ctx.pendingLateImportShift.importsBefore on the first deferred addition
 * so that flushLateImportShifts() can do a single O(B) traversal for all imports
 * added in the batch, instead of O(I*B) for I individual additions.
 * Returns the funcIdx of the import (looked up after addImport).
 */
export function ensureLateImport(
  ctx: CodegenContext,
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
): number | undefined {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  // Record importsBefore on the FIRST deferred addition in this batch
  if (ctx.pendingLateImportShift === null) {
    ctx.pendingLateImportShift = { importsBefore: ctx.numImportFuncs };
  }
  const typeIdx = addFuncType(ctx, paramTypes, resultTypes);
  addImport(ctx, "env", name, { kind: "func", typeIdx });
  return ctx.funcMap.get(name);
}

/**
 * Flush any pending late import shifts. Performs a single traversal of all
 * function bodies to shift indices, instead of one traversal per import.
 * Must be called after a batch of ensureLateImport() calls before any
 * funcIdx values are used in emitted instructions.
 */
export function flushLateImportShifts(
  ctx: CodegenContext,
  fctx: FunctionContext,
): void {
  const pending = ctx.pendingLateImportShift;
  if (pending === null) return;
  const added = ctx.numImportFuncs - pending.importsBefore;
  ctx.pendingLateImportShift = null;
  if (added <= 0) return;
  shiftLateImportIndices(ctx, fctx, pending.importsBefore, added);
}

/**
 * Ensure the __get_undefined host import exists, returning its funcIdx.
 * This import returns the actual JS `undefined` value as externref,
 * allowing Wasm to distinguish null from undefined at runtime.
 */
export function ensureGetUndefined(
  ctx: CodegenContext,
): number | undefined {
  return ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
}

/**
 * Emit instructions that push the JS `undefined` value onto the stack.
 * Uses the __get_undefined host import when available; falls back to
 * ref.null.extern (indistinguishable from null) in standalone mode.
 */
export function emitUndefined(
  ctx: CodegenContext,
  fctx: FunctionContext,
): void {
  const funcIdx = ensureGetUndefined(ctx);
  if (funcIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
}

/**
 * Ensure the __extern_is_undefined host import exists, returning its funcIdx.
 * This import checks if an externref value is JS `undefined` (not null).
 */
export function ensureExternIsUndefinedImport(
  ctx: CodegenContext,
): number | undefined {
  return ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
}

/**
 * After dynamically adding a field to a struct type, patch all existing
 * struct.new instructions for that type by inserting a default value
 * instruction immediately before each struct.new.  This ensures the
 * operand count matches the (now larger) field list.
 */
export function patchStructNewForAddedField(
  ctx: CodegenContext,
  fctx: FunctionContext,
  typeIdx: number,
  fieldType: ValType,
): void {
  function defaultInstrFor(ft: ValType): Instr {
    switch (ft.kind) {
      case "f64":
        return { op: "f64.const", value: 0 } as Instr;
      case "i32":
        return { op: "i32.const", value: 0 } as Instr;
      case "externref":
        return { op: "ref.null.extern" };
      case "ref":
      case "ref_null":
        return { op: "ref.null", typeIdx: (ft as { typeIdx: number }).typeIdx };
      default:
        if ((ft as any).kind === "i64") {
          return { op: "i64.const", value: 0n };
        }
        if ((ft as any).kind === "eqref") {
          return { op: "ref.null.eq" };
        }
        return { op: "i32.const", value: 0 } as Instr;
    }
  }

  function patchInstrs(instrs: Instr[]): void {
    for (let i = instrs.length - 1; i >= 0; i--) {
      const instr = instrs[i]!;
      if (instr.op === "struct.new" && (instr as any).typeIdx === typeIdx) {
        // Insert a default value right before the struct.new
        instrs.splice(i, 0, defaultInstrFor(fieldType));
      }
      // Recurse into nested blocks
      if ("body" in instr && Array.isArray((instr as any).body)) {
        patchInstrs((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        patchInstrs((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        patchInstrs((instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) patchInstrs(c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        patchInstrs((instr as any).catchAll);
      }
    }
  }

  // Patch all already-compiled function bodies
  const patched = new Set<Instr[]>();
  for (const func of ctx.mod.functions) {
    patchInstrs(func.body);
    patched.add(func.body);
  }
  // Patch current function body (if not already part of mod.functions)
  if (!patched.has(fctx.body)) {
    patchInstrs(fctx.body);
    patched.add(fctx.body);
  }
  // Patch saved bodies from the savedBody swap pattern
  for (const sb of fctx.savedBodies) {
    if (!patched.has(sb)) {
      patchInstrs(sb);
      patched.add(sb);
    }
  }
}

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
  // Guard: if the AST node is undefined/null, report an error and produce a
  // typed default value instead of crashing with "Cannot read 'kind' of undefined".
  if (!expr) {
    ctx.errors.push({
      message: "unexpected undefined AST node in compileExpression",
      line: 0,
      column: 0,
    });
    const fallbackType = expectedType ?? { kind: "f64" as const };
    pushDefaultValue(fctx, fallbackType);
    return fallbackType;
  }

  // Fast-path: null/undefined in numeric context — emit the correct constant
  // directly instead of going through externref + __unbox_number, because wasm's
  // ref.null.extern is indistinguishable between null and undefined at the JS
  // boundary (both become JS null), so Number(null)=0 but Number(undefined)=NaN
  // cannot be recovered after the externref roundtrip.
  // Unwrap type assertions and parenthesized expressions to detect the underlying
  // null/undefined keyword (e.g. `(null as any)`, `(undefined as any)`).
  if (expectedType?.kind === "f64" || expectedType?.kind === "i32") {
    let inner: ts.Expression = expr;
    while (
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined =
      inner.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined") ||
      ts.isOmittedExpression(inner);
    if (isNull || isUndefined) {
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: isNull ? 0 : NaN });
        return { kind: "f64" };
      }
      // i32 context: null → 0, undefined → 0 (ToInt32(NaN) = 0)
      if (expectedType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
    }
    // void expr in numeric context: evaluate operand for side effects, then
    // produce the correct undefined-as-number constant (NaN for f64, 0 for i32).
    // This avoids the externref roundtrip where null and undefined are
    // indistinguishable.
    if (ts.isVoidExpression(inner)) {
      const bodyLenBefore = fctx.body.length;
      const operandType = compileExpressionInner(ctx, fctx, inner.expression);
      if (operandType !== null && operandType !== VOID_RESULT) {
        if (!_isLastInstrVoidCall(ctx, fctx, bodyLenBefore)) {
          fctx.body.push({ op: "drop" });
        }
      }
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
  }

  // Fast-path: null/undefined in struct ref context — emit ref.null with the
  // correct struct type index instead of ref.null.extern (externref), which would
  // cause Wasm validation errors ("struct.get expected (ref null N), found ref.null").
  if (
    expectedType &&
    (expectedType.kind === "ref_null" || expectedType.kind === "ref")
  ) {
    let inner: ts.Expression = expr;
    while (
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined =
      inner.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined") ||
      ts.isOmittedExpression(inner);
    if (isNull || isUndefined) {
      const typeIdx = (expectedType as { typeIdx: number }).typeIdx;
      fctx.body.push({ op: "ref.null", typeIdx });
      return { kind: "ref_null", typeIdx };
    }
  }

  // Fast-path: null/undefined/boolean literals in AnyValue context — emit the
  // correct boxing call directly to avoid type mismatches and preserve type tags.
  if (expectedType && isAnyValue(expectedType, ctx)) {
    let inner: ts.Expression = expr;
    while (
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined =
      inner.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined") ||
      ts.isOmittedExpression(inner);
    if (isNull || isUndefined) {
      ensureAnyHelpers(ctx);
      const helperName = isNull ? "__any_box_null" : "__any_box_undefined";
      const funcIdx = ctx.funcMap.get(helperName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
    }
    // void expr in AnyValue context: evaluate operand for side effects, then
    // produce __any_box_undefined() to preserve the undefined tag.
    if (ts.isVoidExpression(inner)) {
      const bodyLenBefore2 = fctx.body.length;
      const operandType = compileExpressionInner(ctx, fctx, inner.expression);
      if (operandType !== null && operandType !== VOID_RESULT) {
        if (!_isLastInstrVoidCall(ctx, fctx, bodyLenBefore2)) {
          fctx.body.push({ op: "drop" });
        }
      }
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_undefined");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
    }
    // Boolean literals: box with __any_box_bool to preserve tag=4 for typeof checks
    if (
      inner.kind === ts.SyntaxKind.TrueKeyword ||
      inner.kind === ts.SyntaxKind.FalseKeyword
    ) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_bool");
      if (funcIdx !== undefined) {
        fctx.body.push({
          op: "i32.const",
          value: inner.kind === ts.SyntaxKind.TrueKeyword ? 1 : 0,
        });
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
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
  if (result === VOID_RESULT) {
    // void expression but caller expects a value — push a typed default
    // (JS coerces undefined/void to NaN for numbers, 0 for i32, etc.)
    if (expectedType) {
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: NaN });
      } else {
        pushDefaultValue(fctx, expectedType);
      }
      return expectedType;
    }
    return null; // void — no value on stack
  }
  // Safety net: if the inner compilation claims a value was produced but the
  // last instruction is a `call` to a Wasm function with void return, the TS
  // type was misleading (e.g. async functions returning Promise<void>). Correct
  // the result to avoid emitting `drop` on an empty stack.
  if (result !== null && fctx.body.length > bodyLenBefore) {
    const lastInstr = fctx.body[fctx.body.length - 1];
    if (lastInstr) {
      const op = (lastInstr as any).op;
      let isVoidCall = false;
      if (op === "call" && (lastInstr as any).funcIdx !== undefined) {
        isVoidCall = wasmFuncReturnsVoid(ctx, (lastInstr as any).funcIdx);
      } else if (op === "call_ref" && (lastInstr as any).typeIdx !== undefined) {
        isVoidCall = wasmFuncTypeReturnsVoid(ctx, (lastInstr as any).typeIdx);
      }
      if (isVoidCall) {
        if (expectedType) {
          pushDefaultValue(fctx, expectedType);
          return expectedType;
        }
        return null;
      }
    }
  }
  // Guard: if compileExpressionInner returned an unexpected non-null value
  // without a valid .kind property (e.g., undefined from a missing return path),
  // treat it as null to prevent crashes.
  if (
    result !== null &&
    result !== VOID_RESULT &&
    (typeof result !== "object" || result === null || !("kind" in result))
  ) {
    const fallbackType = expectedType ?? { kind: "f64" as const };
    pushDefaultValue(fctx, fallbackType);
    return fallbackType;
  }
  if (result !== null) {
    // Coerce to expected type if there's a mismatch
    if (expectedType && result.kind !== expectedType.kind) {
      // Special case: i32 → AnyValue with boolean TS type → use __any_box_bool
      // to preserve tag=4 for correct typeof checks at runtime.
      if (result.kind === "i32" && isAnyValue(expectedType, ctx)) {
        const tsType = ctx.checker.getTypeAtLocation(expr);
        if (tsType.flags & ts.TypeFlags.BooleanLike) {
          ensureAnyHelpers(ctx);
          const funcIdx = ctx.funcMap.get("__any_box_bool");
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return expectedType;
          }
        }
      }
      coerceType(ctx, fctx, result, expectedType);
      return expectedType;
    }
    // Also coerce when kinds match but ref typeIdx differs
    if (
      expectedType &&
      (result.kind === "ref" || result.kind === "ref_null") &&
      (expectedType.kind === "ref" || expectedType.kind === "ref_null")
    ) {
      const resultIdx = (result as { typeIdx: number }).typeIdx;
      const expectedIdx = (expectedType as { typeIdx: number }).typeIdx;
      if (resultIdx !== expectedIdx) {
        coerceType(ctx, fctx, result, expectedType);
        return expectedType;
      }
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
      wasmType = mapTsTypeToWasm(
        ctx.checker.getTypeAtLocation(expr),
        ctx.checker,
      );
    } catch {
      wasmType = { kind: "f64" };
    }
  }
  pushDefaultValue(fctx, wasmType);
  return wasmType;
}

// valTypesMatch is now imported from ./shared.js

/**
 * Emit a local.set with automatic type coercion.
 * If the value on the stack (stackType) doesn't match the local's declared type,
 * inserts coercion instructions before the local.set to prevent Wasm validation errors.
 */
export function emitCoercedLocalSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  localIdx: number,
  stackType: ValType,
): void {
  const localType = getLocalType(fctx, localIdx);
  if (localType && !valTypesMatch(stackType, localType)) {
    const sameRefTypeIdx =
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null") &&
      (stackType as { typeIdx: number }).typeIdx ===
        (localType as { typeIdx: number }).typeIdx;
    if (
      sameRefTypeIdx &&
      stackType.kind === "ref_null" &&
      localType.kind === "ref"
    ) {
      // ref_null -> ref: widen the local to ref_null instead of asserting non-null
      // This avoids trapping on null values while fixing Wasm validation
      widenLocalToNullable(fctx, localIdx);
    } else if (sameRefTypeIdx) {
      // ref -> ref_null: subtype, no coercion needed
    } else if (
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null")
    ) {
      // Different typeIdx: the local was declared for a different struct type than
      // what struct.new produced (e.g. var re-declaration with different object shape,
      // or subclass instance stored in parent-typed variable). Try coercion first;
      // if coerceType emits nothing (unrelated struct types), update the local's
      // declared type to match the stack type.
      const bodyLenBefore = fctx.body.length;
      coerceType(ctx, fctx, stackType, localType);
      if (fctx.body.length === bodyLenBefore) {
        // coerceType didn't emit anything -- update local type to match stack.
        updateLocalType(fctx, localIdx, stackType);
      }
    } else {
      coerceType(ctx, fctx, stackType, localType);
    }
  }
  fctx.body.push({ op: "local.set", index: localIdx });
}

/**
 * Update a local's declared type to a new type.
 * Used when a variable is reassigned to a value of a different struct type.
 */
function updateLocalType(
  fctx: FunctionContext,
  localIdx: number,
  newType: ValType,
): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param) param.type = newType;
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local) local.type = newType;
  }
}

/**
 * Widen a local's declared type from ref $X to ref_null $X.
 * This fixes Wasm validation errors when a nullable value is stored into a
 * non-nullable local, without inserting runtime assertions that would trap.
 */
function widenLocalToNullable(fctx: FunctionContext, localIdx: number): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param && param.type.kind === "ref") {
      param.type = {
        kind: "ref_null",
        typeIdx: (param.type as { typeIdx: number }).typeIdx,
      };
    }
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local && local.type.kind === "ref") {
      local.type = {
        kind: "ref_null",
        typeIdx: (local.type as { typeIdx: number }).typeIdx,
      };
    }
  }
}

/** Coerce a value on the stack from one type to another */
export function coerceType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
): void {
  return coerceTypeImpl(ctx, fctx, from, to, compileStringLiteral);
}

function compileExpressionInner(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): InnerResult {
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text.replace(/_/g, ""));
    if (
      ctx.fast &&
      Number.isInteger(value) &&
      value >= -2147483648 &&
      value <= 2147483647
    ) {
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

  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isIdentifier(expr) && expr.text === "undefined") {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // OmittedExpression — array hole/elision, equivalent to undefined
  if (ts.isOmittedExpression(expr)) {
    emitUndefined(ctx, fctx);
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
    // In module/global scope (strict mode), `this` is undefined.
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isIdentifier(expr)) {
    return compileIdentifier(ctx, fctx, expr);
  }

  if (ts.isBinaryExpression(expr)) {
    // Intercept instanceof for unresolvable right-hand classes (#738)
    // When the RHS class is not in our struct system (e.g., TypeError, Array,
    // Function, Promise), delegate to a __instanceof host import.
    if (expr.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const rhsResult = resolveInstanceOfRHS(ctx, expr.right);
      if (!rhsResult) {
        return compileHostInstanceOf(ctx, fctx, expr);
      }
    }
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
    const voidBodyLen = fctx.body.length;
    const operandType = compileExpressionInner(ctx, fctx, expr.expression);
    if (operandType !== null && operandType !== VOID_RESULT) {
      if (!_isLastInstrVoidCall(ctx, fctx, voidBodyLen)) {
        fctx.body.push({ op: "drop" });
      }
    }
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // delete expr — compile operand for side effects, return boolean
  if (ts.isDeleteExpression(expr)) {
    return compileDeleteExpression(ctx, fctx, expr);
  }

  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return compileArrowFunction(ctx, fctx, expr);
  }

  // MetaProperty: new.target
  if (
    ts.isMetaProperty(expr) &&
    expr.keywordToken === ts.SyntaxKind.NewKeyword &&
    expr.name.text === "target"
  ) {
    if (fctx.isConstructor) {
      // Inside a constructor, new.target is always the constructor (truthy).
      // Return i32 1 as a truthy sentinel since we don't have first-class
      // constructor references as values.
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    } else {
      // Outside a constructor, new.target is undefined.
      emitUndefined(ctx, fctx);
      return { kind: "externref" };
    }
  }

  // MetaProperty: import.meta — compile as an object with a `url` property.
  // Bare `import.meta` is rare; typically accessed as `import.meta.url`.
  // We return a string placeholder since the object shape is simple.
  if (
    ts.isMetaProperty(expr) &&
    expr.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expr.name.text === "meta"
  ) {
    // Return a non-null externref as a truthy object sentinel.
    // In most real usage, import.meta.url is accessed via PropertyAccess
    // which is handled separately in compilePropertyAccess.
    return compileStringLiteral(ctx, fctx, "[object Object]");
  }

  // MetaProperty catch-all: import.source, import.defer, and any future
  // import.* meta-properties that the TS parser recognizes but we don't
  // implement.  Emit null externref so compilation doesn't crash.
  if (
    ts.isMetaProperty(expr) &&
    expr.keywordToken === ts.SyntaxKind.ImportKeyword
  ) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // RegExp literal (/pattern/flags) → desugar to new RegExp(pattern, flags)
  if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return compileRegExpLiteral(ctx, fctx, expr);
  }

  // Tagged template expression: tag`hello ${x} world`
  if (ts.isTaggedTemplateExpression(expr)) {
    return compileTaggedTemplateExpression(ctx, fctx, expr);
  }

  // ClassExpression: class { ... } used as a value
  if (ts.isClassExpression(expr)) {
    return compileClassExpression(ctx, fctx, expr);
  }

  // PrivateIdentifier (e.g., `#x`) — when used as a standalone expression it
  // typically appears as the LHS of `#x in obj`.  As an expression it has no
  // runtime value; emit `i32.const 1` (truthy) so the surrounding `in`
  // operator can proceed.
  if (ts.isPrivateIdentifier(expr)) {
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32" };
  }

  // `super` as standalone expression — in remaining contexts, treat as `this` reference.
  // Primary super uses (super.prop, super[expr], super.method(), super()) are handled
  // earlier in their respective access/call compilers.
  if (expr.kind === ts.SyntaxKind.SuperKeyword) {
    const selfIdx = fctx.localMap.get("this");
    if (selfIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: selfIdx });
      const selfType = fctx.locals[selfIdx];
      if (selfType) return selfType;
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // SpreadElement encountered as a standalone expression (e.g. ...arr passed
  // through a code path that didn't filter spread).  Compile just the operand.
  if (ts.isSpreadElement(expr as any)) {
    return compileExpressionInner(
      ctx,
      fctx,
      (expr as any as ts.SpreadElement).expression,
    );
  }

  ctx.errors.push({
    message: `Unsupported expression: ${ts.SyntaxKind[expr.kind]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Delete expression, RegExp literal (extracted to ./typeof-delete.ts) ──

// ── Closures (extracted to ./closures.ts) ──────────────────────────────
import {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  compileArrowFunction,
  emitFuncRefAsClosure,
  getOrCreateFuncRefWrapperTypes,
} from "./closures.js";
function emitLocalTdzCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  _name: string,
  flagIdx: number,
): void {
  const tagIdx = ensureExnTag(ctx);
  // Throw with ref.null.extern as payload when accessing a let/const variable
  // before initialization (TDZ violation). The exception is catchable via
  // try/catch. We avoid using addStringConstantGlobal here to prevent
  // global index shifting during body compilation (#790).
  fctx.body.push({ op: "local.get", index: flagIdx });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx }],
    else: [],
  } as unknown as Instr);
}

/**
 * Static TDZ analysis: determine at compile time whether a let/const variable
 * access is guaranteed to be after initialization (safe) or before (TDZ violation).
 *
 * Returns:
 * - 'skip': access is after declaration in straight-line code — no check needed
 * - 'throw': access is before declaration in straight-line code — guaranteed TDZ error
 * - 'check': can't determine statically — keep runtime flag check
 */
function analyzeTdzAccess(
  ctx: CodegenContext,
  id: ts.Identifier,
): "skip" | "throw" | "check" {
  const symbol = ctx.checker.getSymbolAtLocation(id);
  if (!symbol) return "check";
  const decl = symbol.valueDeclaration;
  if (!decl) return "check";

  const accessPos = id.getStart();
  const declEnd = decl.getEnd(); // use end of declaration (after initializer)

  // Find the containing function of the access and the declaration.
  // If they differ, the access is in a nested closure — keep runtime check.
  const accessFunc = getContainingFunction(id);
  const declFunc = getContainingFunction(decl);
  if (accessFunc !== declFunc) return "check";

  // Check if the access is inside a loop that contains the declaration
  // (back-edge could reach access before re-initialization)
  if (isInsideLoopContaining(id, decl)) return "check";

  if (accessPos >= declEnd) {
    // Access is after the full declaration (including initializer) — safe
    return "skip";
  } else {
    // Access is before declaration — guaranteed TDZ violation
    // But only if not in a loop that wraps both (already checked above)
    return "throw";
  }
}

/** Walk up to find the nearest containing function (or source file for top-level). */
function getContainingFunction(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Check if the access node is inside a loop body that also contains (or is
 * an ancestor of) the declaration. In that case the access could run on a
 * subsequent iteration before the declaration re-initializes the variable.
 */
function isInsideLoopContaining(access: ts.Node, decl: ts.Node): boolean {
  let current = access.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      // Reached function boundary without finding a loop
      return false;
    }
    if (isLoopStatement(current)) {
      // Check if the declaration is also inside this loop
      if (isDescendantOf(decl, current)) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isLoopStatement(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/** Emit a static TDZ throw (guaranteed violation — no flag check needed). */
function emitStaticTdzThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
): void {
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  fctx.body.push({ op: "throw", tagIdx });
}

function compileIdentifier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
): ValType | null {
  const name = id.text;
  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    // TDZ check for function-local let/const variables
    const tdzFlagIdx = fctx.tdzFlagLocals?.get(name);
    if (tdzFlagIdx !== undefined) {
      const tdzResult = analyzeTdzAccess(ctx, id);
      if (tdzResult === "check") {
        emitLocalTdzCheck(ctx, fctx, name, tdzFlagIdx);
      } else if (tdzResult === "throw") {
        emitStaticTdzThrow(ctx, fctx);
      }
      // tdzResult === "skip" — no check needed, variable is guaranteed initialized
    }

    // Check if this is a boxed (ref cell) mutable capture
    const boxed = fctx.boxedCaptures?.get(name);
    if (boxed) {
      // Read through ref cell: local.get → null guard → struct.get $ref_cell 0
      // The ref cell local is ref_null — if the closure capture is uninitialized,
      // the local is null and struct.get would trap (#702).
      fctx.body.push({ op: "local.get", index: localIdx });
      emitNullGuardedStructGet(
        ctx,
        fctx,
        { kind: "ref_null", typeIdx: boxed.refCellTypeIdx },
        boxed.valType,
        boxed.refCellTypeIdx,
        0,
        undefined /* propName */,
        false /* throwOnNull — ref cells use default for uninitialized captures */,
      );
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

    // Null narrowing: if this variable is known non-null (e.g. inside `if (x !== null)`),
    // emit ref.as_non_null and return ref instead of ref_null to skip downstream null guards.
    if (declaredType.kind === "ref_null" && fctx.narrowedNonNull?.has(name)) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: (declaredType as any).typeIdx };
    }

    return declaredType;
  }

  // Check captured globals (variables promoted from enclosing scope for callbacks)
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined) {
    // TDZ check: throw ReferenceError if let/const variable accessed before initialization
    // Apply static analysis — captured globals are often accessed from closures,
    // but analyzeTdzAccess handles the cross-function case correctly (returns "check")
    const tdzResult = ctx.tdzGlobals.has(name) ? analyzeTdzAccess(ctx, id) : "skip";
    if (tdzResult === "check") {
      emitTdzCheck(ctx, fctx, name);
    } else if (tdzResult === "throw") {
      emitStaticTdzThrow(ctx, fctx);
    }
    fctx.body.push({ op: "global.get", index: capturedIdx });
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
    const gType = globalDef?.type ?? { kind: "f64" };
    // Globals widened from ref to ref_null for null init — narrow back
    if (
      gType.kind === "ref_null" &&
      (ctx.capturedGlobalsWidened.has(name) || fctx.narrowedNonNull?.has(name))
    ) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: gType.typeIdx };
    }
    return gType;
  }

  // Check module-level globals (top-level let/const declarations)
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined) {
    // TDZ check: throw ReferenceError if let/const variable accessed before initialization
    // Apply static analysis for module-level globals
    const tdzResult = ctx.tdzGlobals.has(name) ? analyzeTdzAccess(ctx, id) : "skip";
    if (tdzResult === "check") {
      emitTdzCheck(ctx, fctx, name);
    } else if (tdzResult === "throw") {
      emitStaticTdzThrow(ctx, fctx);
    }
    fctx.body.push({ op: "global.get", index: moduleIdx });
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    const mType = globalDef?.type ?? { kind: "f64" };
    // Null narrowing for module globals
    if (mType.kind === "ref_null" && fctx.narrowedNonNull?.has(name)) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: (mType as any).typeIdx };
    }
    return mType;
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

  // globalThis — no true global object in Wasm; emit undefined (ref.null extern)
  if (name === "globalThis") {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Function reference as value: when a known function name is used as an
  // expression (not called), wrap it in a closure struct so it can be stored
  // in a variable and later called via call_ref.
  // Only wrap user-defined functions (skip internal helpers and class constructors).
  const funcRefIdx = ctx.funcMap.get(name);
  if (
    funcRefIdx !== undefined &&
    !name.startsWith("__") &&
    !ctx.classSet.has(name)
  ) {
    // Check if there's already a closure registered (e.g. from closureMap)
    const existingClosure = ctx.closureMap.get(name);
    if (existingClosure) {
      // Already a closure — check if there's a module-level global for it
      const closureModGlobal = ctx.moduleGlobals.get(name);
      if (closureModGlobal !== undefined) {
        fctx.body.push({ op: "global.get", index: closureModGlobal });
        const globalDef =
          ctx.mod.globals[localGlobalIdx(ctx, closureModGlobal)];
        return (
          globalDef?.type ?? {
            kind: "ref",
            typeIdx: existingClosure.structTypeIdx,
          }
        );
      }
    }
    // Wrap the plain function in a closure struct
    const refType = emitFuncRefAsClosure(ctx, fctx, name, funcRefIdx);
    if (refType) return refType;
  }

  // Check if this is a truly undeclared variable (no TS symbol).
  // Accessing an undeclared variable should throw ReferenceError per JS strict mode.
  // However, known globals (Symbol, Object, Reflect, etc.) have TS symbols from
  // lib.d.ts and should use the fallback default instead.
  const sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) {
    // Truly undeclared variable — throw ReferenceError at runtime
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "throw", tagIdx } as unknown as Instr);
    return { kind: "externref" };
  }

  // Graceful fallback for known but unimplemented globals (Symbol, Object,
  // Reflect, etc.) — emit a type-appropriate default so compilation continues.
  const tsType = ctx.checker.getTypeAtLocation(id);
  const wasmType = resolveWasmType(ctx, tsType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }
  if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  if (wasmType.kind === "i64") {
    fctx.body.push({ op: "i64.const", value: 0n });
    return { kind: "i64" };
  }
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
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

// ── instanceof (extracted to ./typeof-delete.ts) ──

/**
 * Try to resolve the right-hand side of an instanceof expression to a known
 * class in our struct system. Returns the class name if found, undefined otherwise.
 * This mirrors resolveInstanceOfClassName in typeof-delete.ts but is used to
 * decide whether to use the host fallback.
 */
function resolveInstanceOfRHS(
  ctx: CodegenContext,
  rightExpr: ts.Expression,
): string | undefined {
  if (ts.isIdentifier(rightExpr)) {
    const name = rightExpr.text;
    if (ctx.classTagMap.has(name)) return name;
    const mapped = ctx.classExprNameMap.get(name);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }
  const tsType = ctx.checker.getTypeAtLocation(rightExpr);
  const constructSigs = tsType.getConstructSignatures?.();
  if (constructSigs && constructSigs.length > 0) {
    const instanceType = constructSigs[0]!.getReturnType();
    const symbolName = instanceType.getSymbol()?.name;
    if (symbolName) {
      if (ctx.classTagMap.has(symbolName)) return symbolName;
      const mapped = ctx.classExprNameMap.get(symbolName);
      if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    }
  }
  const symbolName = tsType.getSymbol()?.name;
  if (symbolName) {
    if (ctx.classTagMap.has(symbolName)) return symbolName;
    const mapped = ctx.classExprNameMap.get(symbolName);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }
  return undefined;
}

/**
 * Compile `expr instanceof RHS` using a host import when the RHS class is not
 * in our struct system (e.g., TypeError, Array, Function, Promise). (#738)
 * Passes the value as externref and the constructor name as a string constant,
 * delegating to `__instanceof(value, ctorName) -> i32` host import which
 * looks up the constructor on the global object.
 */
function compileHostInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // Resolve constructor name from the RHS expression (simple identifiers only)
  let ctorName: string | undefined;
  if (ts.isIdentifier(expr.right)) {
    ctorName = expr.right.text;
  }

  if (!ctorName) {
    // Cannot resolve constructor name — compile both sides, emit false
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Ensure the __instanceof host import exists
  const instanceofIdx = ensureLateImport(
    ctx,
    "__instanceof",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);

  if (instanceofIdx === undefined) {
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Compile left operand (the value to test)
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (leftType.kind !== "externref") {
    coerceType(ctx, fctx, leftType, { kind: "externref" });
  }

  // Push constructor name as a string constant
  addStringConstantGlobal(ctx, ctorName);
  const strGlobalIdx = ctx.stringGlobalMap.get(ctorName);
  if (strGlobalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: strGlobalIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Call __instanceof(value, ctorName) -> i32
  fctx.body.push({ op: "call", funcIdx: instanceofIdx });
  return { kind: "i32" };
}

// ── typeof (extracted to ./typeof-delete.ts) ──

export function compileLogicalAnd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // JS semantics: a && b → if a is falsy, return a; else return b
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    ensureI32Condition(fctx, leftType, ctx);
    return { kind: "i32" };
  }

  // Save LHS value for JS value semantics, then check truthiness
  const tmp = allocTempLocal(fctx, leftType);
  fctx.body.push({ op: "local.tee", index: tmp });
  ensureI32Condition(fctx, leftType, ctx);

  // Compile RHS in a side buffer to discover its natural type
  const savedBody = pushBody(fctx);
  const rightType = compileExpression(ctx, fctx, expr.right);
  let thenInstrs = fctx.body;
  fctx.body = savedBody;

  // If the RHS is void, push a default value so the if-block has a consistent result.
  // JS coerces undefined to NaN for numbers, null for externref, etc.
  if (!rightType) {
    // RHS produced no value — use the left type as the result and push a default
    // for the then-branch (RHS path). The else-branch returns the LHS value.
    const resultType = leftType;
    thenInstrs.push(...defaultValueInstrs(resultType));
    const elseInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: thenInstrs,
      else: elseInstrs,
    });
    releaseTempLocal(fctx, tmp);
    return resultType;
  }

  const rType: ValType = rightType;

  // Determine common result type (like conditional expression)
  let resultType: ValType = leftType;
  if (!valTypesMatch(leftType, rType)) {
    if (
      (leftType.kind === "i32" || leftType.kind === "f64") &&
      (rType.kind === "i32" || rType.kind === "f64")
    ) {
      resultType = { kind: "f64" };
    } else {
      resultType = { kind: "externref" };
    }
  }

  // Coerce then-branch (RHS) to common type if needed
  if (!valTypesMatch(rType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, rType, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }

  // Build else-branch (LHS value) with coercion if needed
  let elseInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
  if (!valTypesMatch(leftType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, leftType, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmp);

  return resultType;
}

export function compileLogicalOr(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // JS semantics: a || b → if a is truthy, return a; else return b
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    ensureI32Condition(fctx, leftType, ctx);
    return { kind: "i32" };
  }

  // Save LHS value for JS value semantics, then check truthiness
  const tmp = allocTempLocal(fctx, leftType);
  fctx.body.push({ op: "local.tee", index: tmp });
  ensureI32Condition(fctx, leftType, ctx);

  // Compile RHS in a side buffer to discover its natural type
  const savedBody = pushBody(fctx);
  const rightType = compileExpression(ctx, fctx, expr.right);
  let elseInstrs = fctx.body;
  fctx.body = savedBody;

  // If the RHS is void, push a default value so the if-block has a consistent result.
  if (!rightType) {
    const resultType = leftType;
    elseInstrs.push(...defaultValueInstrs(resultType));
    const thenInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: thenInstrs,
      else: elseInstrs,
    });
    releaseTempLocal(fctx, tmp);
    return resultType;
  }

  const rType: ValType = rightType;

  // Determine common result type (like conditional expression)
  let resultType: ValType = leftType;
  if (!valTypesMatch(leftType, rType)) {
    if (
      (leftType.kind === "i32" || leftType.kind === "f64") &&
      (rType.kind === "i32" || rType.kind === "f64")
    ) {
      resultType = { kind: "f64" };
    } else {
      resultType = { kind: "externref" };
    }
  }

  // Build then-branch (LHS value) with coercion if needed
  let thenInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
  if (!valTypesMatch(leftType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, leftType, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }

  // Coerce else-branch (RHS) to common type if needed
  if (!valTypesMatch(rType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, rType, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmp);

  return resultType;
}

/** Nullish coalescing: a ?? b → if a is null, return b, else return a */
export function compileNullishCoalescing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // Compile LHS and store in temp
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    ctx.errors.push({
      message: "Failed to compile nullish coalescing LHS",
      line: getLine(expr),
      column: getCol(expr),
    });
    return { kind: "externref" };
  }
  const resultKind: ValType = leftType ?? { kind: "externref" };
  const tmp = allocTempLocal(fctx, resultKind);
  fctx.body.push({ op: "local.tee", index: tmp });

  // If the left side is a value type (i32/f64), it can never be null — short-circuit
  if (resultKind.kind === "i32" || resultKind.kind === "f64") {
    releaseTempLocal(fctx, tmp);
    return resultKind;
  }

  // Check if null
  fctx.body.push({ op: "ref.is_null" });

  // Compile RHS in a side buffer to discover its natural type
  const savedBody = pushBody(fctx);
  const rhsType = compileExpression(ctx, fctx, expr.right);
  let thenInstrs = fctx.body;
  fctx.body = savedBody;

  // If the RHS is void, push a default value so the if-block has a consistent result.
  if (!rhsType) {
    thenInstrs.push(...defaultValueInstrs(resultKind));
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultKind },
      then: thenInstrs,
      else: [{ op: "local.get", index: tmp } as Instr],
    });
    releaseTempLocal(fctx, tmp);
    return resultKind;
  }

  const rType = rhsType;

  // Unify types: if LHS and RHS have different wasm types, pick a common type
  if (valTypesMatch(resultKind, rType)) {
    // Types match — use as-is
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultKind },
      then: thenInstrs,
      else: [{ op: "local.get", index: tmp } as Instr],
    });
    releaseTempLocal(fctx, tmp);
    return resultKind;
  }

  // Types differ — use externref as the unified type when both sides are
  // different types (e.g., struct ref vs f64). This ensures both branches
  // can produce a compatible wasm type. If the RHS is already externref
  // or a ref type, use externref; if both are numeric but different, prefer f64.
  let unifiedType: ValType;
  if (
    rType.kind === "f64" &&
    (resultKind.kind === "externref" ||
      resultKind.kind === "ref" ||
      resultKind.kind === "ref_null")
  ) {
    unifiedType = { kind: "externref" };
  } else if (
    resultKind.kind === "f64" &&
    (rType.kind === "externref" ||
      rType.kind === "ref" ||
      rType.kind === "ref_null")
  ) {
    unifiedType = { kind: "externref" };
  } else {
    unifiedType = rType;
  }

  // Coerce RHS (then branch) to unified type if needed (usually already matches)
  if (!valTypesMatch(rType, unifiedType)) {
    const coerceRhsBody: Instr[] = [];
    fctx.body = coerceRhsBody;
    coerceType(ctx, fctx, rType, unifiedType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceRhsBody];
  }

  // Coerce LHS (else branch) to unified type
  const elseInstrs: Instr[] = [{ op: "local.get", index: tmp } as Instr];
  const coerceLhsBody: Instr[] = [];
  fctx.body = coerceLhsBody;
  coerceType(ctx, fctx, resultKind, unifiedType);
  fctx.body = savedBody;
  elseInstrs.push(...coerceLhsBody);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: unifiedType },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmp);

  return unifiedType;
}

export function compileAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): InnerResult {
  // Unwrap parenthesized LHS: (x) = 1 → x = 1
  let lhs = expr.left;
  while (ts.isParenthesizedExpression(lhs)) {
    lhs = lhs.expression;
  }
  // If we unwrapped parentheses, create a synthetic-like view for the checks below
  // by rebinding the checks to use `lhs` instead of `expr.left`
  if (lhs !== expr.left) {
    // Recursively handle the unwrapped LHS by synthesizing a new expression-like object
    const synth = { ...expr, left: lhs } as ts.BinaryExpression;
    return compileAssignment(ctx, fctx, synth);
  }
  if (ts.isIdentifier(expr.left)) {
    const name = expr.left.text;
    // Named function expression name binding is read-only — assignments are
    // silently ignored in sloppy mode (the RHS is still evaluated for side effects)
    if (fctx.readOnlyBindings?.has(name)) {
      const rhsType = compileExpression(ctx, fctx, expr.right);
      // The assignment is a no-op, but the expression evaluates to the RHS value
      return rhsType;
    }
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) {
      // Check if this is a boxed (ref cell) mutable capture
      const boxed = fctx.boxedCaptures?.get(name);
      if (boxed) {
        // Write through ref cell: local.get ref_cell → value → struct.set $ref_cell 0
        // Null-guard: if ref cell local is null, skip struct.set (#702)
        const resultType = compileExpression(
          ctx,
          fctx,
          expr.right,
          boxed.valType,
        );
        if (!resultType) {
          ctx.errors.push({
            message: "Failed to compile assignment value",
            line: getLine(expr),
            column: getCol(expr),
          });
          return null;
        }
        const tmpVal = allocLocal(
          fctx,
          `__box_tmp_${fctx.locals.length}`,
          boxed.valType,
        );
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: localIdx });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [] as Instr[],
          else: [
            { op: "local.get", index: localIdx } as Instr,
            { op: "local.get", index: tmpVal } as Instr,
            {
              op: "struct.set",
              typeIdx: boxed.refCellTypeIdx,
              fieldIdx: 0,
            } as Instr,
          ],
        });
        // Return the assigned value (expression result)
        fctx.body.push({ op: "local.get", index: tmpVal });
        return resultType;
      }
      const localType =
        localIdx < fctx.params.length
          ? fctx.params[localIdx]!.type
          : fctx.locals[localIdx - fctx.params.length]?.type;

      // When assigning a function expression/arrow or a function reference
      // to a variable, don't pass externref type hint — let it compile to
      // its native closure struct ref type. Then update the local's type so
      // closure calls work correctly.
      const isFuncExprRHS =
        ts.isFunctionExpression(expr.right) || ts.isArrowFunction(expr.right);
      const isFuncRefRHS =
        ts.isIdentifier(expr.right) && ctx.funcMap.has(expr.right.text);
      const isCallableRHS = isFuncExprRHS || isFuncRefRHS;
      // Also detect when the local already has a closure type (reassignment case)
      const localIsClosureRef =
        localType &&
        (localType.kind === "ref" || localType.kind === "ref_null") &&
        ctx.closureInfoByTypeIdx.has(
          (localType as { typeIdx: number }).typeIdx,
        );
      const typeHint =
        (isCallableRHS || localIsClosureRef) && localType?.kind === "externref"
          ? undefined
          : localIsClosureRef
            ? undefined // Don't pass closure ref type as hint either — let RHS produce its own
            : localType;
      const resultType = compileExpression(ctx, fctx, expr.right, typeHint);
      if (!resultType) {
        ctx.errors.push({
          message: "Failed to compile assignment value",
          line: getLine(expr),
          column: getCol(expr),
        });
        return null;
      }

      // If a closure struct ref was assigned to an externref local, update the local's type
      if (
        (isCallableRHS || localIsClosureRef) &&
        resultType.kind === "ref" &&
        (localType?.kind === "externref" || localIsClosureRef)
      ) {
        if (localIdx < fctx.params.length) {
          fctx.params[localIdx]!.type = resultType;
        } else {
          const localEntry = fctx.locals[localIdx - fctx.params.length];
          if (localEntry) localEntry.type = resultType;
        }
      }

      // Re-read local type after potential update (func expr may have changed it)
      const effectiveLocalType =
        localIdx < fctx.params.length
          ? fctx.params[localIdx]!.type
          : fctx.locals[localIdx - fctx.params.length]?.type;

      // Safety coercion: if the expression produced a type that doesn't match
      // the local's declared type (e.g. compileExpression didn't have expectedType
      // or coercion was incomplete), coerce before local.tee
      if (
        effectiveLocalType &&
        !valTypesMatch(resultType, effectiveLocalType)
      ) {
        const bodyLenBeforeCoerce = fctx.body.length;
        coerceType(ctx, fctx, resultType, effectiveLocalType);
        if (
          fctx.body.length === bodyLenBeforeCoerce &&
          (resultType.kind === "ref" || resultType.kind === "ref_null") &&
          (effectiveLocalType.kind === "ref" ||
            effectiveLocalType.kind === "ref_null")
        ) {
          // coerceType didn't emit anything for different struct types --
          // update the local's type to match the stack type instead of
          // emitting an invalid local.tee with mismatched types.
          updateLocalType(fctx, localIdx, resultType);
          fctx.body.push({ op: "local.tee", index: localIdx });
          return resultType;
        }
        fctx.body.push({ op: "local.tee", index: localIdx });
        return effectiveLocalType;
      }
      fctx.body.push({ op: "local.tee", index: localIdx });
      return resultType;
    }
    // Check captured globals
    const capturedIdx = ctx.capturedGlobals.get(name);
    if (capturedIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
      const resultType = compileExpression(
        ctx,
        fctx,
        expr.right,
        globalDef?.type,
      );
      if (!resultType) {
        ctx.errors.push({
          message: "Failed to compile assignment value",
          line: getLine(expr),
          column: getCol(expr),
        });
        return null;
      }
      fctx.body.push({ op: "global.set", index: capturedIdx });
      // global.set consumes the value; re-push it for expression result
      fctx.body.push({ op: "global.get", index: capturedIdx });
      return resultType;
    }
    // Check module-level globals
    const moduleIdx = ctx.moduleGlobals.get(name);
    if (moduleIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
      const resultType = compileExpression(
        ctx,
        fctx,
        expr.right,
        globalDef?.type,
      );
      if (!resultType) {
        ctx.errors.push({
          message: "Failed to compile assignment value",
          line: getLine(expr),
          column: getCol(expr),
        });
        return null;
      }
      fctx.body.push({ op: "global.set", index: moduleIdx });
      fctx.body.push({ op: "global.get", index: moduleIdx });
      return resultType;
    }
    // Graceful fallback for unresolved identifiers: auto-allocate a local
    // so that compilation can continue. This handles class/object method bodies
    // that reference outer-scope variables not yet captured, and sloppy-mode
    // implicit globals from test262 tests.
    {
      const resultType = compileExpression(ctx, fctx, expr.right);
      if (!resultType) return null;
      const newLocalIdx = allocLocal(fctx, name, resultType);
      fctx.body.push({ op: "local.tee", index: newLocalIdx });
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

  if (ts.isArrayLiteralExpression(expr.left)) {
    return compileArrayDestructuringAssignment(
      ctx,
      fctx,
      expr.left,
      expr.right,
    );
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
  const symName = rhsType.symbol?.name;
  let typeName =
    symName &&
    symName !== "__type" &&
    symName !== "__object" &&
    ctx.structMap.has(symName)
      ? symName
      : (ctx.anonTypeMap.get(rhsType) ?? symName);

  // Auto-register anonymous object types (same as resolveWasmType logic)
  if (
    typeName &&
    (typeName === "__type" || typeName === "__object") &&
    !ctx.anonTypeMap.has(rhsType) &&
    rhsType.getProperties().length > 0
  ) {
    ensureStructForType(ctx, rhsType);
    typeName = ctx.anonTypeMap.get(rhsType) ?? typeName;
  }

  // When the RHS type is unknown or a primitive (boolean, number, string),
  // there is no struct to destructure from.  For empty patterns like `{} = val`
  // we just need the RHS value as the expression result.  For non-empty
  // patterns the bindings stay at their defaults (mimics JS behaviour for
  // destructuring primitives — the properties simply do not exist). (#379)
  if (
    !typeName ||
    !ctx.structMap.has(typeName) ||
    !ctx.structFields.get(typeName)
  ) {
    // Null/undefined check — throw TypeError (#783)
    // In JS, `{...} = null` and `{...} = undefined` always throw TypeError
    if (resultType.kind === "externref" || resultType.kind === "ref_null") {
      const typeErrMsg = "TypeError: Cannot destructure 'null' or 'undefined'";
      addStringConstantGlobal(ctx, typeErrMsg);
      const strIdx = ctx.stringGlobalMap.get(typeErrMsg)!;
      const tagIdx = ensureExnTag(ctx);
      const tmpNullChk = allocLocal(fctx, `__destruct_null_chk_${fctx.locals.length}`, resultType);
      fctx.body.push({ op: "local.tee", index: tmpNullChk });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: strIdx } as Instr,
          { op: "throw", tagIdx },
        ],
        else: [],
      });
      // Restore value on stack
      fctx.body.push({ op: "local.get", index: tmpNullChk });
    }

    // Ensure any target identifiers are allocated as locals
    for (const prop of target.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name.text;
        if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
          allocLocal(fctx, name, { kind: "externref" });
        }
      } else if (
        ts.isSpreadAssignment(prop) &&
        ts.isIdentifier(prop.expression)
      ) {
        const name = prop.expression.text;
        if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
          allocLocal(fctx, name, { kind: "externref" });
        }
      }
    }
    // RHS value is already on the stack — return it as the expression result
    return resultType;
  }

  const structTypeIdx = ctx.structMap.get(typeName)!;
  const fields = ctx.structFields.get(typeName)!;

  // Save the struct ref in a temp local
  const tmpLocal = allocLocal(
    fctx,
    `__destruct_assign_${fctx.locals.length}`,
    resultType,
  );
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard for ref_null types
  const isNullableDA = resultType.kind === "ref_null";
  const savedBodyDA = fctx.body;
  const destructInstrsDA: Instr[] = [];
  fctx.body = destructInstrsDA;

  // For each property in the destructuring pattern, set the existing local
  for (const prop of target.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      // { width } = ... → prop.name is "width"
      const propName = prop.name.text;
      let localIdx = fctx.localMap.get(propName);

      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) {
        ctx.errors.push({
          message: `Unknown field in destructuring: ${propName}`,
          line: getLine(prop),
          column: getCol(prop),
        });
        continue;
      }

      // Auto-allocate local if not declared (e.g. destructuring creates new binding)
      if (localIdx === undefined) {
        const fieldType = fields[fieldIdx]!.type;
        localIdx = allocLocal(fctx, propName, fieldType);
      }

      const fieldType = fields[fieldIdx]!.type;
      const localType = getLocalType(fctx, localIdx);

      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      // Handle default value: { x = defaultVal } = obj
      if (prop.objectAssignmentInitializer) {
        if (fieldType.kind === "externref") {
          const tmpField = allocLocal(
            fctx,
            `__dflt_${fctx.locals.length}`,
            fieldType,
          );
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "ref.is_null" } as Instr);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(() => {
                const saved = fctx.body;
                fctx.body = [];
                compileExpression(
                  ctx,
                  fctx,
                  prop.objectAssignmentInitializer!,
                  localType ?? fieldType,
                );
                fctx.body.push({ op: "local.set", index: localIdx! } as Instr);
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              })(),
            ],
            else: [
              { op: "local.get", index: tmpField } as Instr,
              ...(() => {
                if (localType && !valTypesMatch(fieldType, localType)) {
                  const saved = fctx.body;
                  fctx.body = [];
                  coerceType(ctx, fctx, fieldType, localType);
                  const instrs = fctx.body;
                  fctx.body = saved;
                  return instrs;
                }
                return [];
              })(),
              { op: "local.set", index: localIdx! } as Instr,
            ],
          });
        } else {
          // Coerce field type to local type if needed
          if (localType && !valTypesMatch(fieldType, localType)) {
            coerceType(ctx, fctx, fieldType, localType);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else {
        // Coerce field type to local type if needed
        if (localType && !valTypesMatch(fieldType, localType)) {
          coerceType(ctx, fctx, fieldType, localType);
        }
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    } else if (ts.isPropertyAssignment(prop)) {
      const propName = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isNumericLiteral(prop.name)
            ? prop.name.text
            : undefined;
      if (!propName) continue; // computed or unsupported property name — skip
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) continue;
      const fieldType = fields[fieldIdx]!.type;

      // Determine the target and optional default value
      let targetExpr = prop.initializer;
      let defaultExpr: ts.Expression | undefined;

      // { y: x = defaultVal } — BinaryExpression with EqualsToken
      if (
        ts.isBinaryExpression(targetExpr) &&
        targetExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(targetExpr.left)
      ) {
        defaultExpr = targetExpr.right;
        targetExpr = targetExpr.left;
      }

      if (ts.isIdentifier(targetExpr)) {
        // { prop: ident } or { prop: ident = default }
        const localName = targetExpr.text;
        let localIdx = fctx.localMap.get(localName);

        // Auto-allocate local if not declared
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, fieldType);
        }

        const localType = getLocalType(fctx, localIdx);

        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

        if (defaultExpr) {
          // Handle default value for property assignment target
          if (
            fieldType.kind === "externref" ||
            fieldType.kind === "ref" ||
            fieldType.kind === "ref_null"
          ) {
            const tmpField = allocLocal(
              fctx,
              `__dflt_${fctx.locals.length}`,
              fieldType,
            );
            fctx.body.push({ op: "local.tee", index: tmpField });
            fctx.body.push({ op: "ref.is_null" } as Instr);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...(() => {
                  const saved = fctx.body;
                  fctx.body = [];
                  compileExpression(
                    ctx,
                    fctx,
                    defaultExpr!,
                    localType ?? fieldType,
                  );
                  fctx.body.push({
                    op: "local.set",
                    index: localIdx!,
                  } as Instr);
                  const instrs = fctx.body;
                  fctx.body = saved;
                  return instrs;
                })(),
              ],
              else: [
                { op: "local.get", index: tmpField } as Instr,
                ...(() => {
                  if (localType && !valTypesMatch(fieldType, localType)) {
                    const saved = fctx.body;
                    fctx.body = [];
                    coerceType(ctx, fctx, fieldType, localType);
                    const instrs = fctx.body;
                    fctx.body = saved;
                    return instrs;
                  }
                  return [];
                })(),
                { op: "local.set", index: localIdx! } as Instr,
              ],
            });
          } else {
            // Numeric field — just set the value (no undefined check needed for primitives)
            if (localType && !valTypesMatch(fieldType, localType)) {
              coerceType(ctx, fctx, fieldType, localType);
            }
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        } else {
          // No default — just coerce and set
          if (localType && !valTypesMatch(fieldType, localType)) {
            coerceType(ctx, fctx, fieldType, localType);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else if (ts.isObjectLiteralExpression(targetExpr)) {
        // { prop: { nested } } — nested destructuring
        const tmpNested = allocLocal(
          fctx,
          `__nested_${fctx.locals.length}`,
          fieldType,
        );
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitObjectDestructureFromLocal(
          ctx,
          fctx,
          targetExpr,
          tmpNested,
          fieldType,
        );
      } else if (ts.isArrayLiteralExpression(targetExpr)) {
        // { prop: [a, b] } — nested array destructuring
        const tmpNested = allocLocal(
          fctx,
          `__nested_${fctx.locals.length}`,
          fieldType,
        );
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitArrayDestructureFromLocal(
          ctx,
          fctx,
          targetExpr,
          tmpNested,
          fieldType,
        );
      } else if (
        ts.isPropertyAccessExpression(targetExpr) ||
        ts.isElementAccessExpression(targetExpr)
      ) {
        // { prop: obj.field } or { prop: arr[0] } — member expression target
        const tmpElem = allocLocal(
          fctx,
          `__nested_elem_${fctx.locals.length}`,
          fieldType,
        );
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpElem });
        emitAssignToTarget(ctx, fctx, targetExpr, tmpElem, fieldType);
      }
      // else: unsupported target expression in property assignment — skip
    } else if (ts.isSpreadAssignment(prop)) {
      // { ...rest } = obj — rest element in object destructuring
      // Allocate the rest local but skip actual collection (would require
      // runtime object creation).  The variable just stays at its default. (#379)
      if (ts.isIdentifier(prop.expression)) {
        const restName = prop.expression.text;
        if (!fctx.localMap.has(restName) && !ctx.moduleGlobals.has(restName)) {
          allocLocal(fctx, restName, { kind: "externref" });
        }
      }
    }
  }

  // Close null guard — throw TypeError if null/undefined (#783)
  fctx.body = savedBodyDA;
  if (isNullableDA) {
    const typeErrMsg = "TypeError: Cannot destructure 'null' or 'undefined'";
    addStringConstantGlobal(ctx, typeErrMsg);
    const strIdx = ctx.stringGlobalMap.get(typeErrMsg)!;
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: strIdx } as Instr,
        { op: "throw", tagIdx },
      ],
      else: destructInstrsDA,
    });
  } else {
    fctx.body.push(...destructInstrsDA);
  }

  // The result of a destructuring assignment is the RHS value
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return resultType;
}

function compileArrayDestructuringAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
  value: ts.Expression,
): InnerResult {
  // Compile the RHS — should produce a struct ref (either tuple or vec)
  const resultType = compileExpression(ctx, fctx, value);
  if (!resultType) return null;

  // Externref fallback: use __extern_get(obj, boxed_index) for each element
  if (resultType.kind !== "ref" && resultType.kind !== "ref_null") {
    if (resultType.kind === "externref") {
      return compileExternrefArrayDestructuringAssignment(
        ctx,
        fctx,
        target,
        resultType,
      );
    }
    // For f64/i32 — box to externref and retry
    if (resultType.kind === "f64" || resultType.kind === "i32") {
      if (resultType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        return compileExternrefArrayDestructuringAssignment(ctx, fctx, target, {
          kind: "externref",
        });
      }
    }
    ctx.errors.push({
      message: "Cannot destructure: not an array type",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  const typeIdx = (resultType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  if (!typeDef || typeDef.kind !== "struct") {
    // Non-struct ref: convert to externref and use __extern_get fallback
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    return compileExternrefArrayDestructuringAssignment(ctx, fctx, target, {
      kind: "externref",
    });
  }

  // Detect whether RHS is a tuple struct (fields $_0, $_1, ...) or vec struct ({length, data})
  const isVecStruct =
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";

  let arrTypeIdx = -1;
  let arrDef: { kind: string; element: ValType } | undefined;

  if (isVecStruct) {
    arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const ad = ctx.mod.types[arrTypeIdx];
    if (!ad || ad.kind !== "array") {
      ctx.errors.push({
        message: "Cannot destructure: vec data is not array",
        line: getLine(target),
        column: getCol(target),
      });
      return null;
    }
    arrDef = ad as { kind: string; element: ValType };
  }

  // Store struct ref in temp local
  const tmpLocal = allocLocal(
    fctx,
    `__arr_destruct_${fctx.locals.length}`,
    resultType,
  );
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard for ref_null types
  const isNullableADA = resultType.kind === "ref_null";
  const savedBodyADA = fctx.body;
  const arrDestructInstrsADA: Instr[] = [];
  fctx.body = arrDestructInstrsADA;

  // Helper: get element type at index i
  const getElemType = (i: number): ValType => {
    if (isVecStruct) return arrDef!.element;
    // Tuple: field type at index i
    const field = typeDef.fields[i];
    return field ? field.type : { kind: "f64" };
  };

  // Helper: emit instructions to get element i onto the stack
  const emitElementGet = (i: number) => {
    fctx.body.push({ op: "local.get", index: tmpLocal });
    if (isVecStruct) {
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data array
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef!.element);
    } else {
      // Tuple: direct struct.get with field index
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: i });
    }
  };

  for (let i = 0; i < target.elements.length; i++) {
    const element = target.elements[i]!;

    // Skip holes: [a, , c] = arr
    if (ts.isOmittedExpression(element)) continue;

    // Handle rest element: [a, ...rest] = arr (only for vec structs)
    if (ts.isSpreadElement(element)) {
      if (isVecStruct) {
        const restTarget = element.expression;
        if (ts.isIdentifier(restTarget)) {
          const restName = restTarget.text;
          let restLocalIdx = fctx.localMap.get(restName);
          if (restLocalIdx === undefined) {
            restLocalIdx = allocLocal(fctx, restName, resultType);
          }
          const tmpLen = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, {
            kind: "i32",
          });
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.sub" } as Instr);
          fctx.body.push({ op: "local.tee", index: tmpLen });

          fctx.body.push({
            op: "array.new_default",
            typeIdx: arrTypeIdx,
          } as Instr);
          const tmpRestArr = allocLocal(
            fctx,
            `__rest_arr_${fctx.locals.length}`,
            { kind: "ref", typeIdx: arrTypeIdx },
          );
          fctx.body.push({ op: "local.set", index: tmpRestArr });

          const tmpJ = allocLocal(fctx, `__rest_j_${fctx.locals.length}`, {
            kind: "i32",
          });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.set", index: tmpJ });

          const loopBody: Instr[] = [
            { op: "local.get", index: tmpJ } as Instr,
            { op: "local.get", index: tmpLen } as Instr,
            { op: "i32.lt_s" } as Instr,
            { op: "i32.eqz" } as Instr,
            { op: "br_if", depth: 1 } as Instr,
            { op: "local.get", index: tmpRestArr } as Instr,
            { op: "local.get", index: tmpJ } as Instr,
            { op: "local.get", index: tmpLocal } as Instr,
            { op: "struct.get", typeIdx, fieldIdx: 1 } as Instr,
            { op: "local.get", index: tmpJ } as Instr,
            { op: "i32.const", value: i } as Instr,
            { op: "i32.add" } as Instr,
            { op: "array.get", typeIdx: arrTypeIdx } as Instr,
            { op: "array.set", typeIdx: arrTypeIdx } as Instr,
            { op: "local.get", index: tmpJ } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "local.set", index: tmpJ } as Instr,
            { op: "br", depth: 0 } as Instr,
          ];

          fctx.body.push({
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: loopBody,
              } as Instr,
            ],
          } as Instr);

          fctx.body.push({ op: "local.get", index: tmpLen });
          fctx.body.push({ op: "local.get", index: tmpRestArr });
          fctx.body.push({ op: "struct.new", typeIdx } as Instr);
          fctx.body.push({ op: "local.set", index: restLocalIdx });
        }
      }
      // Rest on tuples is not supported (would need type conversion)
      continue;
    }

    const elemType = getElemType(i);

    if (ts.isIdentifier(element)) {
      const localName = element.text;
      let localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, localName, elemType);
      }
      emitElementGet(i);
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(elemType, localType)) {
        coerceType(ctx, fctx, elemType, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (ts.isPropertyAccessExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(
        fctx,
        `__arr_elem_${fctx.locals.length}`,
        elemType,
      );
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isElementAccessExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(
        fctx,
        `__arr_elem_${fctx.locals.length}`,
        elemType,
      );
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isObjectLiteralExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(
        fctx,
        `__arr_elem_${fctx.locals.length}`,
        elemType,
      );
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitObjectDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isArrayLiteralExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(
        fctx,
        `__arr_elem_${fctx.locals.length}`,
        elemType,
      );
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitArrayDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (
      ts.isBinaryExpression(element) &&
      element.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const assignTarget = element.left;
      const defaultExpr = element.right;
      if (ts.isIdentifier(assignTarget)) {
        const localName = assignTarget.text;
        let localIdx = fctx.localMap.get(localName);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, elemType);
        }
        emitElementGet(i);
        if (
          elemType.kind === "externref" ||
          elemType.kind === "ref" ||
          elemType.kind === "ref_null"
        ) {
          const tmpElem = allocLocal(
            fctx,
            `__dflt_${fctx.locals.length}`,
            elemType,
          );
          fctx.body.push({ op: "local.tee", index: tmpElem });
          fctx.body.push({ op: "ref.is_null" } as Instr);
          const localType = getLocalType(fctx, localIdx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(() => {
                const saved = fctx.body;
                fctx.body = [];
                compileExpression(
                  ctx,
                  fctx,
                  defaultExpr,
                  localType ?? elemType,
                );
                fctx.body.push({ op: "local.set", index: localIdx! } as Instr);
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              })(),
            ],
            else: [
              { op: "local.get", index: tmpElem } as Instr,
              ...(() => {
                if (localType && !valTypesMatch(elemType, localType)) {
                  const saved = fctx.body;
                  fctx.body = [];
                  coerceType(ctx, fctx, elemType, localType);
                  const instrs = fctx.body;
                  fctx.body = saved;
                  return instrs;
                }
                return [];
              })(),
              { op: "local.set", index: localIdx! } as Instr,
            ],
          });
        } else {
          const localType = getLocalType(fctx, localIdx);
          if (localType && !valTypesMatch(elemType, localType)) {
            coerceType(ctx, fctx, elemType, localType);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }
    // else: unsupported element target — skip
  }

  // Close null guard — throw TypeError if null/undefined (#783)
  fctx.body = savedBodyADA;
  if (isNullableADA) {
    const typeErrMsg = "TypeError: Cannot destructure 'null' or 'undefined'";
    addStringConstantGlobal(ctx, typeErrMsg);
    const strIdx = ctx.stringGlobalMap.get(typeErrMsg)!;
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: strIdx } as Instr,
        { op: "throw", tagIdx },
      ],
      else: arrDestructInstrsADA,
    });
  } else {
    fctx.body.push(...arrDestructInstrsADA);
  }

  // The result of a destructuring assignment is the RHS value
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return resultType;
}

/**
 * Destructure an externref value using __extern_get(obj, boxed_index) for each element.
 * This handles cases where the RHS is dynamically typed (e.g. arguments, iterators, function returns).
 */
function compileExternrefArrayDestructuringAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
  resultType: ValType,
): InnerResult {
  // Store externref in temp local
  const tmpLocal = allocLocal(
    fctx,
    `__ext_arr_destruct_${fctx.locals.length}`,
    resultType,
  );
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null check — throw TypeError for null/undefined (#783)
  if (resultType.kind === "externref") {
    const typeErrMsg = "TypeError: Cannot destructure 'null' or 'undefined'";
    addStringConstantGlobal(ctx, typeErrMsg);
    const strIdx = ctx.stringGlobalMap.get(typeErrMsg)!;
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: strIdx } as Instr,
        { op: "throw", tagIdx },
      ],
      else: [],
    });
  }

  // Ensure __extern_get is available
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const getType = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    shiftLateImportIndices(
      ctx,
      fctx,
      importsBefore,
      ctx.numImportFuncs - importsBefore,
    );
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (getIdx === undefined) return null;

  // Ensure __box_number is available (needed to convert index to externref)
  let boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const boxType = addFuncType(
      ctx,
      [{ kind: "f64" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
    shiftLateImportIndices(
      ctx,
      fctx,
      importsBefore,
      ctx.numImportFuncs - importsBefore,
    );
    boxIdx = ctx.funcMap.get("__box_number");
    // Also refresh getIdx since it may have shifted
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (boxIdx === undefined || getIdx === undefined) return null;

  for (let i = 0; i < target.elements.length; i++) {
    const element = target.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;
    // Handle rest element: [a, ...rest] = externArr — use __extern_slice
    if (ts.isSpreadElement(element)) {
      const restTarget = element.expression;
      if (ts.isIdentifier(restTarget)) {
        const restName = restTarget.text;
        let restLocalIdx = fctx.localMap.get(restName);
        if (restLocalIdx === undefined) {
          restLocalIdx = allocLocal(fctx, restName, { kind: "externref" });
        }
        let sliceIdx = ctx.funcMap.get("__extern_slice");
        if (sliceIdx === undefined) {
          const importsBefore = ctx.numImportFuncs;
          const sliceType = addFuncType(ctx,
            [{ kind: "externref" }, { kind: "f64" }],
            [{ kind: "externref" }]);
          addImport(ctx, "env", "__extern_slice", { kind: "func", typeIdx: sliceType });
          shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
          sliceIdx = ctx.funcMap.get("__extern_slice");
          boxIdx = ctx.funcMap.get("__box_number");
          getIdx = ctx.funcMap.get("__extern_get");
        }
        if (sliceIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "f64.const", value: i });
          fctx.body.push({ op: "call", funcIdx: sliceIdx });
          fctx.body.push({ op: "local.set", index: restLocalIdx });
        }
      }
      continue;
    }

    // Emit: __extern_get(tmpLocal, box(i)) -> externref
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "f64.const", value: i });
    fctx.body.push({ op: "call", funcIdx: boxIdx! });
    fctx.body.push({ op: "call", funcIdx: getIdx! });

    const elemType: ValType = { kind: "externref" };

    if (ts.isIdentifier(element)) {
      const localName = element.text;
      let localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, localName, elemType);
      }
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(elemType, localType)) {
        coerceType(ctx, fctx, elemType, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (
      ts.isPropertyAccessExpression(element) ||
      ts.isElementAccessExpression(element)
    ) {
      const tmpElem = allocLocal(
        fctx,
        `__ext_arr_elem_${fctx.locals.length}`,
        elemType,
      );
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (
      ts.isBinaryExpression(element) &&
      element.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      // Default value: [a = default] = arr
      const assignTarget = element.left;
      const defaultExpr = element.right;
      if (ts.isIdentifier(assignTarget)) {
        const localName = assignTarget.text;
        let localIdx = fctx.localMap.get(localName);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, elemType);
        }
        const tmpElem = allocLocal(
          fctx,
          `__ext_dflt_${fctx.locals.length}`,
          elemType,
        );
        fctx.body.push({ op: "local.tee", index: tmpElem });
        fctx.body.push({ op: "ref.is_null" } as Instr);
        const localType = getLocalType(fctx, localIdx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...(() => {
              const saved = fctx.body;
              fctx.body = [];
              compileExpression(ctx, fctx, defaultExpr, localType ?? elemType);
              fctx.body.push({ op: "local.set", index: localIdx! } as Instr);
              const instrs = fctx.body;
              fctx.body = saved;
              return instrs;
            })(),
          ],
          else: [
            { op: "local.get", index: tmpElem } as Instr,
            ...(() => {
              if (localType && !valTypesMatch(elemType, localType)) {
                const saved = fctx.body;
                fctx.body = [];
                coerceType(ctx, fctx, elemType, localType);
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              }
              return [];
            })(),
            { op: "local.set", index: localIdx! } as Instr,
          ],
        });
      }
    } else if (ts.isArrayLiteralExpression(element) || ts.isObjectLiteralExpression(element)) {
      // Nested destructuring: [[x]] = arr or [{x}] = arr
      // Element value is on the stack (externref). If null/undefined, throw TypeError (#730).
      const tmpNested = allocLocal(
        fctx,
        `__ext_nested_${fctx.locals.length}`,
        elemType,
      );
      fctx.body.push({ op: "local.tee", index: tmpNested });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      const typeErrMsg = "TypeError: Cannot destructure 'null' or 'undefined'";
      addStringConstantGlobal(ctx, typeErrMsg);
      const strIdx = ctx.stringGlobalMap.get(typeErrMsg)!;
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: strIdx } as Instr,
          { op: "throw", tagIdx },
        ],
        else: [],
      });
      // Proceed with nested destructuring via externref path
      if (ts.isArrayLiteralExpression(element)) {
        fctx.body.push({ op: "local.get", index: tmpNested });
        const nestedResult = compileExternrefArrayDestructuringAssignment(ctx, fctx, element, elemType);
        if (nestedResult) {
          fctx.body.push({ op: "drop" });
        }
      }
      // Object nested destructuring via externref is not yet supported — skip for now
    }
  }

  // The result of a destructuring assignment is the RHS value
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return resultType;
}

/** Assign value from a local to a property access or element access target */
function emitAssignToTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  valueLocal: number,
  valueType: ValType,
): void {
  if (ts.isPropertyAccessExpression(target)) {
    // Compile-away: frozen object property writes throw TypeError
    if (ts.isIdentifier(target.expression) && ctx.frozenVars.has(target.expression.text)) {
      emitThrowString(ctx, fctx, "TypeError: Cannot assign to read only property of frozen object");
      return;
    }

    const objType = ctx.checker.getTypeAtLocation(target.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(target.expression)) {
      typeName = ctx.widenedVarStructMap.get(target.expression.text);
    }
    if (!typeName) return;

    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) return;

    const fieldName = target.name.text;
    const fieldIdx = fields.findIndex((f) => f.name === fieldName);
    if (fieldIdx === -1) return;

    const fieldType = fields[fieldIdx]!.type;
    // Push obj ref, then value
    compileExpression(ctx, fctx, target.expression);
    fctx.body.push({ op: "local.get", index: valueLocal });
    if (!valTypesMatch(valueType, fieldType)) {
      coerceType(ctx, fctx, valueType, fieldType);
    }
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
  } else if (ts.isElementAccessExpression(target)) {
    const arrType = compileExpression(ctx, fctx, target.expression);
    if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null"))
      return;
    const tIdx = (arrType as { typeIdx: number }).typeIdx;
    const tDef = ctx.mod.types[tIdx];
    // Handle vec struct
    if (
      tDef?.kind === "struct" &&
      tDef.fields.length === 2 &&
      tDef.fields[0]?.name === "length" &&
      tDef.fields[1]?.name === "data"
    ) {
      const aIdx = getArrTypeIdxFromVec(ctx, tIdx);
      // Save vec ref, compile index, then bounds-guard the write
      const vecTmp = allocLocal(
        fctx,
        `__dstr_vec_${fctx.locals.length}`,
        arrType,
      );
      fctx.body.push({ op: "local.set", index: vecTmp });
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression);
      if (!idxResult) return;
      if (idxResult.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" } as Instr);
      }
      const idxTmp = allocLocal(fctx, `__dstr_idx_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: idxTmp });
      // Bounds guard: only write if idx < array.len
      fctx.body.push({ op: "local.get", index: idxTmp });
      fctx.body.push({ op: "local.get", index: vecTmp });
      fctx.body.push({ op: "struct.get", typeIdx: tIdx, fieldIdx: 1 });
      fctx.body.push({ op: "array.len" });
      fctx.body.push({ op: "i32.lt_u" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" as const },
        then: [
          { op: "local.get", index: vecTmp } as Instr,
          { op: "struct.get", typeIdx: tIdx, fieldIdx: 1 } as Instr,
          { op: "local.get", index: idxTmp } as Instr,
          { op: "local.get", index: valueLocal } as Instr,
          { op: "array.set", typeIdx: aIdx } as Instr,
        ],
        else: [],
      } as Instr);
    }
  }
}

/** Destructure an object from a local variable (used for nested patterns) */
function emitObjectDestructureFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectLiteralExpression,
  srcLocal: number,
  srcType: ValType,
): void {
  if (srcType.kind !== "ref" && srcType.kind !== "ref_null") return;
  const srcTypeIdx = (srcType as { typeIdx: number }).typeIdx;

  // Find struct name from type index
  let structName: string | undefined;
  for (const [name, idx] of ctx.structMap) {
    if (idx === srcTypeIdx) {
      structName = name;
      break;
    }
  }
  if (!structName) return;

  const fields = ctx.structFields.get(structName);
  if (!fields) return;

  // Null guard for ref_null types
  const savedBodyODFL = fctx.body;
  const odflInstrs: Instr[] = [];
  fctx.body = odflInstrs;

  for (const prop of pattern.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      const propName = prop.name.text;
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) continue;

      let localIdx = fctx.localMap.get(propName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, propName, fields[fieldIdx]!.type);
      }

      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
      const fieldType = fields[fieldIdx]!.type;
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(fieldType, localType)) {
        coerceType(ctx, fctx, fieldType, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (ts.isPropertyAssignment(prop)) {
      const propName = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isNumericLiteral(prop.name)
            ? prop.name.text
            : undefined;
      if (!propName) continue; // computed or unsupported property name — skip
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) continue;
      const fieldType = fields[fieldIdx]!.type;

      const targetExpr = prop.initializer;
      if (ts.isIdentifier(targetExpr)) {
        let localIdx = fctx.localMap.get(targetExpr.text);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, targetExpr.text, fieldType);
        }
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        const localType = getLocalType(fctx, localIdx);
        if (localType && !valTypesMatch(fieldType, localType)) {
          coerceType(ctx, fctx, fieldType, localType);
        }
        emitCoercedLocalSet(ctx, fctx, localIdx, fieldType);
      } else if (ts.isObjectLiteralExpression(targetExpr)) {
        // Nested object: { x: { a, b } } = obj
        const tmpNested = allocLocal(
          fctx,
          `__nested_${fctx.locals.length}`,
          fieldType,
        );
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitObjectDestructureFromLocal(
          ctx,
          fctx,
          targetExpr,
          tmpNested,
          fieldType,
        );
      } else if (ts.isArrayLiteralExpression(targetExpr)) {
        // Nested array: { x: [a, b] } = obj
        const tmpNested = allocLocal(
          fctx,
          `__nested_${fctx.locals.length}`,
          fieldType,
        );
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitArrayDestructureFromLocal(
          ctx,
          fctx,
          targetExpr,
          tmpNested,
          fieldType,
        );
      } else if (
        ts.isPropertyAccessExpression(targetExpr) ||
        ts.isElementAccessExpression(targetExpr)
      ) {
        // Member expression target: { x: obj.prop } = obj2
        const tmpElem = allocLocal(
          fctx,
          `__nested_elem_${fctx.locals.length}`,
          fieldType,
        );
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpElem });
        emitAssignToTarget(ctx, fctx, targetExpr, tmpElem, fieldType);
      }
    }
  }

  // Close null guard — throw TypeError if null/undefined (#730)
  fctx.body = savedBodyODFL;
  if (srcType.kind === "ref_null") {
    const typeErrMsg = "TypeError: Cannot destructure 'null' or 'undefined'";
    addStringConstantGlobal(ctx, typeErrMsg);
    const strIdx = ctx.stringGlobalMap.get(typeErrMsg)!;
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: strIdx } as Instr,
        { op: "throw", tagIdx },
      ],
      else: odflInstrs,
    });
  } else {
    fctx.body.push(...odflInstrs);
  }
}

/** Destructure an array from a local variable (used for nested patterns) */
function emitArrayDestructureFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ArrayLiteralExpression,
  srcLocal: number,
  srcType: ValType,
): void {
  if (srcType.kind !== "ref" && srcType.kind !== "ref_null") return;
  const srcTypeIdx = (srcType as { typeIdx: number }).typeIdx;
  const srcDef = ctx.mod.types[srcTypeIdx];
  if (!srcDef || srcDef.kind !== "struct") return;

  const arrTypeIdx = getArrTypeIdxFromVec(ctx, srcTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return;

  const elemType = arrDef.element;

  // Null guard for ref_null types
  const savedBodyADFL = fctx.body;
  const adflInstrs: Instr[] = [];
  fctx.body = adflInstrs;

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;

    if (ts.isIdentifier(element)) {
      let localIdx = fctx.localMap.get(element.text);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, element.text, elemType);
      }
      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(elemType, localType)) {
        coerceType(ctx, fctx, elemType, localType);
      }
      emitCoercedLocalSet(ctx, fctx, localIdx, elemType);
    }
  }

  // Close null guard — throw TypeError if null/undefined (#730)
  fctx.body = savedBodyADFL;
  if (srcType.kind === "ref_null") {
    const typeErrMsg = "TypeError: Cannot destructure 'null' or 'undefined'";
    addStringConstantGlobal(ctx, typeErrMsg);
    const strIdx = ctx.stringGlobalMap.get(typeErrMsg)!;
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: strIdx } as Instr,
        { op: "throw", tagIdx },
      ],
      else: adflInstrs,
    });
  } else {
    fctx.body.push(...adflInstrs);
  }
}

function compilePropertyAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): InnerResult {
  const objType = ctx.checker.getTypeAtLocation(target.expression);

  // Compile-away: if the target object is frozen, emit TypeError throw
  if (ts.isIdentifier(target.expression) && ctx.frozenVars.has(target.expression.text)) {
    // Evaluate RHS for side effects, then throw
    const rhsType = compileExpression(ctx, fctx, value);
    if (rhsType) {
      fctx.body.push({ op: "drop" });
    }
    emitThrowString(ctx, fctx, "TypeError: Cannot assign to read only property of frozen object");
    return { kind: "f64" }; // unreachable, but need a type
  }

  // Handle static property assignment: ClassName.staticProp = value
  if (
    ts.isIdentifier(target.expression) &&
    ctx.classSet.has(target.expression.text)
  ) {
    const clsName = target.expression.text;
    const fullName = `${clsName}_${target.name.text}`;
    const globalIdx = ctx.staticProps.get(fullName);
    if (globalIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      const valType = compileExpression(ctx, fctx, value, globalDef?.type);
      if (!valType) return null;
      // Save value, set global, return value (assignment expression result)
      const tmpVal = allocLocal(
        fctx,
        `__prop_assign_${fctx.locals.length}`,
        valType,
      );
      fctx.body.push({ op: "local.tee", index: tmpVal });
      fctx.body.push({ op: "global.set", index: globalIdx });
      fctx.body.push({ op: "local.get", index: tmpVal });
      return valType;
    }
  }

  // Handle externref property set
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    const externSetResult = compileExternPropertySet(
      ctx,
      fctx,
      target,
      value,
      objType,
    );
    if (externSetResult !== null) return externSetResult;
    // Fall through to struct-based assignment if import is missing
  }

  // Handle shape-inferred array-like variables: obj.length = N
  if (ts.isIdentifier(target.expression)) {
    const shapeInfo = ctx.shapeMap.get(target.expression.text);
    if (shapeInfo) {
      const fieldName = target.name.text;
      const vecDef = ctx.mod.types[shapeInfo.vecTypeIdx];
      if (vecDef && vecDef.kind === "struct") {
        const fieldIdx = vecDef.fields.findIndex(
          (f: { name: string }) => f.name === fieldName,
        );
        if (fieldIdx >= 0) {
          const structObjResult = compileExpression(
            ctx,
            fctx,
            target.expression,
          );
          if (!structObjResult) return null;
          const valType = compileExpression(
            ctx,
            fctx,
            value,
            vecDef.fields[fieldIdx]!.type,
          );
          if (!valType) return null;
          const tmpVal = allocLocal(
            fctx,
            `__prop_assign_${fctx.locals.length}`,
            valType,
          );
          fctx.body.push({ op: "local.tee", index: tmpVal });
          fctx.body.push({
            op: "struct.set",
            typeIdx: shapeInfo.vecTypeIdx,
            fieldIdx,
          });
          fctx.body.push({ op: "local.get", index: tmpVal });
          return valType;
        }
      }
    }
  }

  // Handle arr.length = N on typed arrays (vec struct field 0 = length)
  if (target.name.text === "length") {
    const arrInfo = resolveArrayInfo(ctx, objType);
    if (arrInfo) {
      const { vecTypeIdx } = arrInfo;
      // Compile receiver (vec struct ref)
      const structObjResult = compileExpression(ctx, fctx, target.expression);
      if (!structObjResult) return null;
      const vecTmp = allocLocal(
        fctx,
        `__arr_len_set_vec_${fctx.locals.length}`,
        { kind: "ref_null", typeIdx: vecTypeIdx },
      );
      fctx.body.push({ op: "local.set", index: vecTmp });
      // Compile value (the new length)
      const valType = compileExpression(ctx, fctx, value);
      if (!valType) return null;
      // Convert f64 to i32 if needed
      const newLenTmp = allocLocal(
        fctx,
        `__arr_len_set_nl_${fctx.locals.length}`,
        { kind: "i32" },
      );
      if (valType.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" as any });
      }
      fctx.body.push({ op: "local.set", index: newLenTmp });
      // Set vec.length = newLen
      fctx.body.push({ op: "local.get", index: vecTmp });
      fctx.body.push({ op: "local.get", index: newLenTmp });
      fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });
      // Return the new length as the assignment expression result
      fctx.body.push({ op: "local.get", index: newLenTmp });
      if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }
  }

  let typeName = resolveStructName(ctx, objType);
  // Fallback: check widened variable struct map for empty objects that got properties added later
  if (!typeName && ts.isIdentifier(target.expression)) {
    typeName = ctx.widenedVarStructMap.get(target.expression.text);
  }
  if (!typeName) return null;

  // Check for setter accessor on user-defined classes
  const fieldName = ts.isPrivateIdentifier(target.name)
    ? "__priv_" + target.name.text.slice(1)
    : target.name.text;
  const accessorKey = `${typeName}_${fieldName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const setterName = `${typeName}_set_${fieldName}`;
    const funcIdx = ctx.funcMap.get(setterName);
    if (funcIdx !== undefined) {
      // Get setter's parameter types to provide type hints
      const setterParamTypes = getFuncParamTypes(ctx, funcIdx);
      const setterObjResult = compileExpression(ctx, fctx, target.expression, setterParamTypes?.[0]);
      if (!setterObjResult) {
        ctx.errors.push({
          message: "Failed to compile setter receiver",
          line: getLine(target),
          column: getCol(target),
        });
        return null;
      }
      const setterValExpectedType = setterParamTypes?.[1]; // param 0 = self, param 1 = value
      const setterValResult = compileExpression(
        ctx,
        fctx,
        value,
        setterValExpectedType,
      );
      if (!setterValResult) {
        ctx.errors.push({
          message: "Failed to compile setter value",
          line: getLine(target),
          column: getCol(target),
        });
        return null;
      }
      // Save value for assignment expression result
      const setterTmpVal = allocLocal(
        fctx,
        `__setter_assign_${fctx.locals.length}`,
        setterValResult,
      );
      fctx.body.push({ op: "local.tee", index: setterTmpVal });
      // If setter has no value parameter (only self), drop the value before calling
      const setterHasValueParam = setterParamTypes && setterParamTypes.length > 1;
      if (!setterHasValueParam) {
        fctx.body.push({ op: "drop" });
      }
      const finalSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalSetterIdx });
      fctx.body.push({ op: "local.get", index: setterTmpVal });
      return setterValResult;
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) return null;

  const fieldIdx = fields.findIndex((f) => f.name === fieldName);
  if (fieldIdx === -1) return null;

  const structSelfType: ValType = { kind: "ref_null", typeIdx: structTypeIdx };
  const structObjResult = compileExpression(ctx, fctx, target.expression, structSelfType);
  if (!structObjResult) {
    ctx.errors.push({
      message: "Failed to compile struct field receiver",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  const valType = compileExpression(ctx, fctx, value, fields[fieldIdx]!.type);
  if (!valType) return null;
  // Save value so assignment expression returns the RHS
  const tmpVal = allocLocal(
    fctx,
    `__prop_assign_${fctx.locals.length}`,
    valType,
  );
  fctx.body.push({ op: "local.tee", index: tmpVal });
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
  fctx.body.push({ op: "local.get", index: tmpVal });

  return valType;
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
  const resolvedInfo = findExternInfoForMember(
    ctx,
    className,
    propName,
    "property",
  );
  const propOwner = resolvedInfo ?? ctx.externClasses.get(className);
  if (!propOwner) return null;

  // Check if the import exists BEFORE compiling object+value to avoid dangling stack values
  const importName = `${propOwner.importPrefix}_set_${propName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    // Import not found — return null silently to let caller handle fallback
    return null;
  }

  // Push object, then value (with type hint from property type)
  const externObjResult = compileExpression(ctx, fctx, target.expression);
  if (!externObjResult) {
    ctx.errors.push({
      message: "Failed to compile extern property receiver",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  const propInfo = propOwner.properties.get(propName);
  const externValResult = compileExpression(ctx, fctx, value, propInfo?.type);
  if (!externValResult) {
    ctx.errors.push({
      message: "Failed to compile extern property value",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  // Save value for assignment expression result
  const externTmpVal = allocLocal(
    fctx,
    `__extern_assign_${fctx.locals.length}`,
    externValResult,
  );
  fctx.body.push({ op: "local.tee", index: externTmpVal });
  fctx.body.push({ op: "call", funcIdx });
  fctx.body.push({ op: "local.get", index: externTmpVal });
  return externValResult;
}

function compileElementAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
): InnerResult {
  // Push array ref
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType) {
    ctx.errors.push({
      message: "Assignment to non-array",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  // Non-ref types (externref, f64, i32): fallback to __extern_set(obj, key, val)
  if (arrType.kind !== "ref" && arrType.kind !== "ref_null") {
    return compileExternSetFallback(ctx, fctx, target, value, arrType);
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Bracket assignment on struct: obj["prop"] = value → struct.set
  // Resolve field name from string/numeric literal, const variable, or constant expression
  if (typeDef?.kind === "struct") {
    const isVecStructAssign =
      typeDef.fields.length === 2 &&
      typeDef.fields[0]?.name === "length" &&
      typeDef.fields[1]?.name === "data";
    if (!isVecStructAssign) {
      let fieldName: string | undefined;
      if (ts.isStringLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isNumericLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isIdentifier(target.argumentExpression)) {
        // Const variable reference: const key = "x"; obj[key] = val
        const sym = ctx.checker.getSymbolAtLocation(target.argumentExpression);
        if (sym) {
          const decl = sym.valueDeclaration;
          if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            const declList = decl.parent;
            if (
              ts.isVariableDeclarationList(declList) &&
              (declList.flags & ts.NodeFlags.Const) !== 0
            ) {
              if (ts.isStringLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              } else if (ts.isNumericLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              }
            }
          }
        }
      }
      // Also handle computed key expressions (well-known symbols, enums, binary exprs)
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(
          ctx,
          target.argumentExpression,
        );
      }
      if (fieldName !== undefined) {
        // Check for setter accessor first
        const objTsType = ctx.checker.getTypeAtLocation(target.expression);
        const sName = resolveStructName(ctx, objTsType);
        if (sName) {
          const accessorKey = `${sName}_${fieldName}`;
          if (ctx.classAccessorSet.has(accessorKey)) {
            const setterName = `${sName}_set_${fieldName}`;
            const funcIdx = ctx.funcMap.get(setterName);
            if (funcIdx !== undefined) {
              // Get setter's parameter types to provide type hint for value argument
              const eaSetterParamTypes = getFuncParamTypes(ctx, funcIdx);
              const eaSetterValType = eaSetterParamTypes?.[1]; // param 0 = self, param 1 = value
              const setValResult = compileExpression(
                ctx,
                fctx,
                value,
                eaSetterValType,
              );
              if (!setValResult) return null;
              const setValLocal = allocLocal(
                fctx,
                `__setter_assign_${fctx.locals.length}`,
                setValResult,
              );
              fctx.body.push({ op: "local.tee", index: setValLocal });
              // If setter has no value parameter (only self), drop the value before calling
              if (!eaSetterParamTypes || eaSetterParamTypes.length <= 1) {
                fctx.body.push({ op: "drop" });
              }
              const finalEaSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;
              fctx.body.push({ op: "call", funcIdx: finalEaSetterIdx });
              fctx.body.push({ op: "local.get", index: setValLocal });
              return setValResult;
            }
          }
        }

        const fieldIdx = typeDef.fields.findIndex(
          (f: { name?: string }) => f.name === fieldName,
        );
        if (fieldIdx !== -1) {
          const valType = compileExpression(
            ctx,
            fctx,
            value,
            typeDef.fields[fieldIdx]!.type,
          );
          if (!valType) return null;
          const tmpVal = allocLocal(
            fctx,
            `__elem_assign_${fctx.locals.length}`,
            valType,
          );
          fctx.body.push({ op: "local.tee", index: tmpVal });
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
          fctx.body.push({ op: "local.get", index: tmpVal });
          return valType;
        }
      }
    }
  }

  // Handle vec struct (array wrapped in {length, data}) — only for actual __vec_* types
  const isVecStruct =
    typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      ctx.errors.push({
        message: "Assignment: vec data is not array",
        line: 0,
        column: 0,
      });
      return null;
    }
    // Save vec ref and index in locals for reuse
    const vecLocal = allocLocal(fctx, `__vec_${fctx.locals.length}`, arrType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    // Null guard: throw TypeError if vec is null (#441)
    if (arrType.kind === "ref_null") {
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "ref.null.extern" } as Instr,
          { op: "throw", tagIdx } as Instr,
        ],
        else: [],
      });
    }
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "f64",
    });
    if (!idxResult) {
      ctx.errors.push({
        message: "Failed to compile element index",
        line: getLine(target),
        column: getCol(target),
      });
      return null;
    }
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const idxLocal = allocLocal(fctx, `__idx_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: idxLocal });
    // Compile value
    const elemValResult = compileExpression(ctx, fctx, value, arrDef.element);
    if (!elemValResult) {
      ctx.errors.push({
        message: "Failed to compile element value",
        line: getLine(target),
        column: getCol(target),
      });
      return null;
    }
    const valLocal = allocLocal(
      fctx,
      `__val_${fctx.locals.length}`,
      arrDef.element,
    );
    fctx.body.push({ op: "local.set", index: valLocal });

    // Get data array into a local so we can update it after potential grow
    const dataLocal = allocLocal(fctx, `__vec_data_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data
    fctx.body.push({ op: "local.set", index: dataLocal });

    // Ensure capacity: if idx >= array.len(data), grow backing array
    const newCapLocal = allocLocal(fctx, `__vec_ncap_${fctx.locals.length}`, {
      kind: "i32",
    });
    const newDataLocal = allocLocal(fctx, `__vec_ndata_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    const oldCapLocal = allocLocal(fctx, `__vec_ocap_${fctx.locals.length}`, {
      kind: "i32",
    });

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
          op: "if",
          blockType: { kind: "empty" },
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
          op: "if",
          blockType: { kind: "empty" },
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
        {
          op: "array.copy",
          dstTypeIdx: arrTypeIdx,
          srcTypeIdx: arrTypeIdx,
        } as Instr,

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
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: vecLocal },
        { op: "local.get", index: idxLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx, fieldIdx: 0 },
      ],
    });
    // Return the assigned value (assignment expression result)
    fctx.body.push({ op: "local.get", index: valLocal });
    return elemValResult;
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
          if (
            ts.isVariableDeclarationList(declList) &&
            (declList.flags & ts.NodeFlags.Const) !== 0
          ) {
            if (ts.isStringLiteral(decl.initializer))
              fieldName = decl.initializer.text;
            else if (ts.isNumericLiteral(decl.initializer))
              fieldName = decl.initializer.text;
          }
        }
      }
    }
    if (fieldName === undefined) {
      fieldName = resolveComputedKeyExpression(ctx, target.argumentExpression);
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
            const objLocal = allocLocal(
              fctx,
              `__struct_obj_${fctx.locals.length}`,
              arrType,
            );
            fctx.body.push({ op: "local.set", index: objLocal });
            const valResult = compileExpression(ctx, fctx, value);
            if (!valResult) return null;
            const valLocal = allocLocal(
              fctx,
              `__struct_val_${fctx.locals.length}`,
              valResult,
            );
            fctx.body.push({ op: "local.set", index: valLocal });
            fctx.body.push({ op: "local.get", index: objLocal });
            // If setter has a value parameter (2+ params), push the value
            const eaSetterPTypes = getFuncParamTypes(ctx, funcIdx);
            if (eaSetterPTypes && eaSetterPTypes.length > 1) {
              fctx.body.push({ op: "local.get", index: valLocal });
            }
            fctx.body.push({ op: "call", funcIdx });
            // Return the assigned value (assignment expression result)
            fctx.body.push({ op: "local.get", index: valLocal });
            return valResult;
          }
        }
      }

      const fieldIdx = typeDef.fields.findIndex(
        (f: { name?: string }) => f.name === fieldName,
      );
      if (fieldIdx >= 0) {
        // struct ref is already on stack; save it, compile value, then struct.set
        const objLocal = allocLocal(
          fctx,
          `__struct_obj_${fctx.locals.length}`,
          arrType,
        );
        fctx.body.push({ op: "local.set", index: objLocal });
        const fieldType = typeDef.fields[fieldIdx]!.type;
        const valResult = compileExpression(ctx, fctx, value, fieldType);
        if (!valResult) return null;
        const valLocal = allocLocal(
          fctx,
          `__struct_val_${fctx.locals.length}`,
          fieldType,
        );
        fctx.body.push({ op: "local.set", index: valLocal });
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "local.get", index: valLocal });
        fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
        // Return the assigned value (assignment expression result)
        fctx.body.push({ op: "local.get", index: valLocal });
        return valResult;
      }
    }
  }

  if (!typeDef || typeDef.kind !== "array") {
    // Fallback: convert struct/unknown ref to externref and use __extern_set
    return compileExternSetFallback(ctx, fctx, target, value, arrType);
  }
  // Push index (as i32)
  const plainIdxResult = compileExpression(
    ctx,
    fctx,
    target.argumentExpression,
    { kind: "f64" },
  );
  if (!plainIdxResult) {
    ctx.errors.push({
      message: "Failed to compile element index",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  // Push value
  const plainValResult = compileExpression(ctx, fctx, value, typeDef.element);
  if (!plainValResult) {
    ctx.errors.push({
      message: "Failed to compile element value",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  // Save value for assignment expression result
  const plainValLocal = allocLocal(
    fctx,
    `__arr_assign_${fctx.locals.length}`,
    plainValResult,
  );
  fctx.body.push({ op: "local.tee", index: plainValLocal });
  fctx.body.push({ op: "array.set", typeIdx });
  fctx.body.push({ op: "local.get", index: plainValLocal });
  return plainValResult;
}

/**
 * Fallback for element assignment on non-array types.
 * Converts the object to externref and calls __extern_set(obj, key, val).
 * The object value is already on the stack.
 */
function compileExternSetFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
  objType: ValType,
): InnerResult {
  // Convert object on stack to externref
  if (objType.kind === "externref") {
    // Already externref, nothing to do
  } else if (objType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else if (objType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else if (objType.kind === "ref" || objType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else {
    ctx.errors.push({
      message: "Unsupported element assignment target type",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  // Save obj externref to local
  const objLocal = allocLocal(fctx, `__eset_obj_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compile value first so we can save it for return
  const valResult = compileExpression(ctx, fctx, value, { kind: "externref" });
  if (!valResult) return null;
  const valLocal = allocLocal(fctx, `__eset_val_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: valLocal });

  // Push args: obj, key, val
  fctx.body.push({ op: "local.get", index: objLocal });
  compileExpression(ctx, fctx, target.argumentExpression, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.get", index: valLocal });

  // Lazily register __extern_set if not already registered
  let funcIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
  }

  // Return the assigned value
  fctx.body.push({ op: "local.get", index: valLocal });
  return { kind: "externref" };
}

/**
 * Compile logical assignment operators: ??=, ||=, &&=
 *
 * Desugars to value-preserving semantics:
 *   a ??= b  →  if (a is null) a = b; result = a
 *   a ||= b  →  if (!a) a = b; result = a
 *   a &&= b  →  if (a) a = b; result = a
 */
export function compileLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Handle property access logical assignment: obj.prop ??= default
  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyLogicalAssignment(
      ctx,
      fctx,
      expr.left,
      expr.right,
      op,
    );
  }

  // Handle element access logical assignment: arr[i] ||= default
  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementLogicalAssignment(
      ctx,
      fctx,
      expr.left,
      expr.right,
      op,
    );
  }

  if (!ts.isIdentifier(expr.left)) {
    ctx.errors.push({
      message:
        "Logical assignment only supported for simple identifiers, property access, or element access",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  const name = expr.left.text;

  // Resolve the variable storage location
  let storage:
    | { kind: "local"; index: number; type: ValType }
    | { kind: "captured"; index: number; type: ValType }
    | { kind: "module"; index: number; type: ValType }
    | null = null;

  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    const localType =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : fctx.locals[localIdx - fctx.params.length]?.type;
    storage = {
      kind: "local",
      index: localIdx,
      type: localType ?? { kind: "f64" },
    };
  }
  if (!storage) {
    const capturedIdx = ctx.capturedGlobals.get(name);
    if (capturedIdx !== undefined) {
      const globalDef = ctx.mod.globals[capturedIdx];
      storage = {
        kind: "captured",
        index: capturedIdx,
        type: globalDef?.type ?? { kind: "f64" },
      };
    }
  }
  if (!storage) {
    const moduleIdx = ctx.moduleGlobals.get(name);
    if (moduleIdx !== undefined) {
      const globalDef = ctx.mod.globals[moduleIdx];
      storage = {
        kind: "module",
        index: moduleIdx,
        type: globalDef?.type ?? { kind: "f64" },
      };
    }
  }

  if (!storage) {
    // Graceful fallback: compile the RHS for side effects, then return externref
    const rhsFallback = compileExpression(ctx, fctx, expr.right);
    if (rhsFallback) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  const varType = storage.type;

  // Emit: read current value
  const emitGet = () => {
    if (storage!.kind === "local")
      fctx.body.push({ op: "local.get", index: storage!.index });
    else fctx.body.push({ op: "global.get", index: storage!.index });
  };
  const emitSet = () => {
    if (storage!.kind === "local")
      fctx.body.push({ op: "local.tee", index: storage!.index });
    else {
      fctx.body.push({ op: "global.set", index: storage!.index });
      fctx.body.push({ op: "global.get", index: storage!.index });
    }
  };

  if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    // a ??= b  →  if (a is null/undefined) { a = b }; result = a
    // For value types (i32, i64, f32, f64, etc.), values can never be null/undefined,
    // so just return the current value without evaluating RHS (short-circuit).
    if (!isRefType(varType)) {
      emitGet();
      return varType;
    }
    emitGet();
    fctx.body.push({ op: "ref.is_null" });

    // Compile the RHS in a separate body
    const savedBody = pushBody(fctx);
    const nullishRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!nullishRhsResult) {
      fctx.body = savedBody;
      return null;
    }
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
    const savedBody = pushBody(fctx);
    emitGet();
    const thenInstrs = fctx.body;

    // Else (falsy): assign RHS
    fctx.body = [];
    const orRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!orRhsResult) {
      fctx.body = savedBody;
      return null;
    }
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
    const savedBody = pushBody(fctx);
    const andRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!andRhsResult) {
      fctx.body = savedBody;
      return null;
    }
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

/**
 * Compile logical assignment on property access: obj.prop ??= default, obj.prop ||= default, obj.prop &&= default
 * Uses short-circuit semantics: RHS is only evaluated if the condition is met.
 */
function compilePropertyLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name)
    ? "__priv_" + target.name.text.slice(1)
    : target.name.text;

  // Resolve struct type
  let typeName = resolveStructName(ctx, objType);
  if (!typeName && ts.isIdentifier(target.expression)) {
    typeName = ctx.widenedVarStructMap.get(target.expression.text);
  }
  if (!typeName) {
    // Fallback: treat as externref property access via __extern_get / __extern_set
    return compilePropertyLogicalAssignmentExternref(
      ctx,
      fctx,
      target,
      rhs,
      op,
      propName,
    );
  }

  // Check for accessor properties (get/set) before looking up struct fields
  const accessorKey = `${typeName}_${propName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const getterName = `${typeName}_get_${propName}`;
    const setterName = `${typeName}_set_${propName}`;
    const getterIdx = ctx.funcMap.get(getterName);
    const setterIdx = ctx.funcMap.get(setterName);
    if (getterIdx !== undefined && setterIdx !== undefined) {
      // Compile obj and save to a local for reuse, coercing to getter's self type
      const getterPTypes = getFuncParamTypes(ctx, getterIdx);
      const objResult = compileExpression(ctx, fctx, target.expression, getterPTypes?.[0]);
      if (!objResult) return null;
      const objLocal = allocLocal(
        fctx,
        `__logprop_acc_obj_${fctx.locals.length}`,
        objResult,
      );
      fctx.body.push({ op: "local.set", index: objLocal });

      const propType = ctx.checker.getTypeAtLocation(target);
      const fieldType = resolveWasmType(ctx, propType);

      const emitFieldGet = () => {
        // Re-lookup funcIdx at emission time — addUnionImports may have shifted indices
        const gIdx = ctx.funcMap.get(getterName)!;
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "call", funcIdx: gIdx });
      };
      const emitFieldSet = () => {
        // Re-lookup funcIdx at emission time — addUnionImports may have shifted indices
        const sIdx = ctx.funcMap.get(setterName)!;
        const tmpVal = allocLocal(
          fctx,
          `__logprop_acc_val_${fctx.locals.length}`,
          fieldType,
        );
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: objLocal });
        // If setter has a value parameter (2+ params), push the value
        const logSetterPTypes = getFuncParamTypes(ctx, sIdx);
        if (logSetterPTypes && logSetterPTypes.length > 1) {
          fctx.body.push({ op: "local.get", index: tmpVal });
        }
        fctx.body.push({ op: "call", funcIdx: sIdx });
        fctx.body.push({ op: "local.get", index: tmpVal });
      };

      return emitLogicalAssignmentPattern(
        ctx,
        fctx,
        rhs,
        op,
        fieldType,
        emitFieldGet,
        emitFieldSet,
      );
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    // Struct name resolved but type not in structMap — fall back to externref path
    return compilePropertyLogicalAssignmentExternref(
      ctx,
      fctx,
      target,
      rhs,
      op,
      propName,
    );
  }

  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — gracefully emit NaN (reading undefined property in numeric context)
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }

  const fieldType = fields[fieldIdx]!.type;

  // Compile obj and save to a local for reuse
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objLocal = allocLocal(
    fctx,
    `__logprop_obj_${fctx.locals.length}`,
    objResult,
  );
  fctx.body.push({ op: "local.set", index: objLocal });

  // Create helpers that read/write the field
  const emitFieldGet = () => {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
  };
  const emitFieldSet = () => {
    // After RHS is on stack, save it, load obj, load value, struct.set, load value again for result
    const tmpVal = allocLocal(
      fctx,
      `__logprop_val_${fctx.locals.length}`,
      fieldType,
    );
    fctx.body.push({ op: "local.set", index: tmpVal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: tmpVal });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    fctx.body.push({ op: "local.get", index: tmpVal });
  };

  return emitLogicalAssignmentPattern(
    ctx,
    fctx,
    rhs,
    op,
    fieldType,
    emitFieldGet,
    emitFieldSet,
  );
}

/**
 * Fallback for logical assignment on a property access target when the
 * struct type cannot be resolved statically.
 *
 * Strategy:
 * 1. Compile the object expression to discover its runtime Wasm type.
 * 2. If the result is a struct ref, look up the field by name and use struct.get/struct.set.
 * 3. Otherwise, convert to externref and use __extern_get / __extern_set.
 */
function compilePropertyLogicalAssignmentExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  propName: string,
): ValType | null {
  // Compile the object expression to discover its runtime type
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;

  // --- Path A: The object compiled to a struct ref ---
  if (objResult.kind === "ref" || objResult.kind === "ref_null") {
    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    let resolvedTypeName: string | undefined;
    for (const [name, idx] of ctx.structMap.entries()) {
      if (idx === typeIdx) {
        resolvedTypeName = name;
        break;
      }
    }
    if (resolvedTypeName) {
      const fields = ctx.structFields.get(resolvedTypeName);
      if (fields) {
        let fieldIdx = fields.findIndex((f) => f.name === propName);

        // If the field doesn't exist yet, try to add it dynamically from TS type info
        // but NEVER for class struct types — their fields are fixed at collection time
        if (fieldIdx === -1 && !ctx.classSet.has(resolvedTypeName)) {
          const objTsType = ctx.checker.getTypeAtLocation(target.expression);
          const tsProps = objTsType.getProperties?.();
          if (tsProps) {
            const tsProp = tsProps.find((p) => p.name === propName);
            if (tsProp) {
              const propTsType = ctx.checker.getTypeOfSymbolAtLocation(
                tsProp,
                target,
              );
              const propWasmType = resolveWasmType(ctx, propTsType);
              const newField: FieldDef = {
                name: propName,
                type: propWasmType,
                mutable: true,
              };
              fields.push(newField);
              // fields === typeDef.fields (same array ref from structFields map)
              patchStructNewForAddedField(ctx, fctx, typeIdx, propWasmType);
              const typeDef = ctx.mod.types[typeIdx];
              if (typeDef?.kind === "struct" && typeDef.fields !== fields) {
                typeDef.fields.push(newField);
              }
              // Patch existing struct.new instructions to include the new field
              patchStructNewForDynamicField(ctx, typeIdx, propWasmType);
              fieldIdx = fields.length - 1;
            }
          }
        }

        if (fieldIdx !== -1) {
          const fieldType = fields[fieldIdx]!.type;
          const objTmp = allocLocal(
            fctx,
            `__logprop_ext_obj_${fctx.locals.length}`,
            objResult,
          );
          fctx.body.push({ op: "local.set", index: objTmp });

          const emitGet = () => {
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          };
          const emitSet = () => {
            const tmpVal = allocLocal(
              fctx,
              `__logprop_ext_val_${fctx.locals.length}`,
              fieldType,
            );
            fctx.body.push({ op: "local.set", index: tmpVal });
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
            fctx.body.push({ op: "local.get", index: tmpVal });
          };

          return emitLogicalAssignmentPattern(
            ctx,
            fctx,
            rhs,
            op,
            fieldType,
            emitGet,
            emitSet,
          );
        }
      }
    }

    // Struct ref but field not found — convert to externref and fall through to path B
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objResult.kind !== "externref") {
    // For f64/i32, box to externref
    if (objResult.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else if (objResult.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else {
      // Unknown type — emit NaN as graceful fallback
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }
  }

  // --- Path B: externref-based property logical assignment ---
  const objLocal = allocLocal(fctx, `__logprop_pobj_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compile propName as externref string key
  addStringConstantGlobal(ctx, propName);
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (!keyResult) return null;
  if (keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyLocal = allocLocal(fctx, `__logprop_pkey_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Ensure __extern_get is available
  let getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (getIdx === undefined) return null;

  // Ensure __extern_set is available
  let setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx === undefined) return null;

  // Ensure union imports (including __unbox_number, __box_number) are registered
  addUnionImports(ctx);

  const varType: ValType = { kind: "externref" };

  // Capture final getIdx/setIdx values for closures
  const finalGetIdx = getIdx;
  const finalSetIdx = setIdx;

  const emitGet = () => {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "call", funcIdx: finalGetIdx });
  };

  const emitSet = () => {
    // Stack has the new value (externref) on top
    const tmpVal = allocLocal(fctx, `__logprop_pval_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: tmpVal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: tmpVal });
    fctx.body.push({ op: "call", funcIdx: finalSetIdx });
    fctx.body.push({ op: "local.get", index: tmpVal });
  };

  return emitLogicalAssignmentPattern(
    ctx,
    fctx,
    rhs,
    op,
    varType,
    emitGet,
    emitSet,
  );
}

/**
 * Compile logical assignment on element access: arr[i] ??= default, arr[i] ||= default, arr[i] &&= default
 * Uses short-circuit semantics.
 */
function compileElementLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  // Compile object expression
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) {
    ctx.errors.push({
      message: "Logical assignment on non-array element access",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle struct bracket notation: obj["prop"] ??= default
  if (typeDef?.kind === "struct") {
    const isVecStruct =
      typeDef.fields.length === 2 &&
      typeDef.fields[0]?.name === "length" &&
      typeDef.fields[1]?.name === "data";
    if (!isVecStruct) {
      let fieldName: string | undefined;
      if (ts.isStringLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isNumericLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      }
      if (fieldName !== undefined) {
        const fieldIdx = typeDef.fields.findIndex(
          (f: { name?: string }) => f.name === fieldName,
        );
        if (fieldIdx !== -1) {
          const fieldType = typeDef.fields[fieldIdx]!.type;

          // Save obj ref
          const objLocal = allocLocal(
            fctx,
            `__logelem_obj_${fctx.locals.length}`,
            arrType,
          );
          fctx.body.push({ op: "local.set", index: objLocal });

          const emitFieldGet = () => {
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          };
          const emitFieldSet = () => {
            const tmpVal = allocLocal(
              fctx,
              `__logelem_val_${fctx.locals.length}`,
              fieldType,
            );
            fctx.body.push({ op: "local.set", index: tmpVal });
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
            fctx.body.push({ op: "local.get", index: tmpVal });
          };

          return emitLogicalAssignmentPattern(
            ctx,
            fctx,
            rhs,
            op,
            fieldType,
            emitFieldGet,
            emitFieldSet,
          );
        }
      }
    }

    // Vec struct: array[i] ??= default
    if (isVecStruct) {
      const arrLocal = allocLocal(
        fctx,
        `__logelem_arr_${fctx.locals.length}`,
        arrType,
      );
      fctx.body.push({ op: "local.set", index: arrLocal });

      // Compile index
      const idxResult = compileExpression(
        ctx,
        fctx,
        target.argumentExpression,
        { kind: "f64" },
      );
      if (!idxResult) return null;
      if (idxResult.kind !== "i32") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      const idxLocal = allocLocal(fctx, `__logelem_idx_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: idxLocal });

      const dataField = typeDef.fields[1]!;
      const dataTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
      const dataDef = ctx.mod.types[dataTypeIdx];
      if (!dataDef || dataDef.kind !== "array") {
        ctx.errors.push({
          message: "Vec struct data field is not an array",
          line: getLine(target),
          column: getCol(target),
        });
        return null;
      }
      const elemType = dataDef.element;

      const emitElemGet = () => {
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.get", index: idxLocal });
        emitBoundsCheckedArrayGet(fctx, dataTypeIdx, elemType);
      };
      const emitElemSet = () => {
        const tmpVal = allocLocal(
          fctx,
          `__logelem_aval_${fctx.locals.length}`,
          elemType,
        );
        fctx.body.push({ op: "local.set", index: tmpVal });
        // Bounds-guarded write: only set if idx < array.len
        fctx.body.push({ op: "local.get", index: idxLocal });
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "array.len" });
        fctx.body.push({ op: "i32.lt_u" } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" as const },
          then: [
            { op: "local.get", index: arrLocal } as Instr,
            { op: "struct.get", typeIdx, fieldIdx: 1 } as Instr,
            { op: "local.get", index: idxLocal } as Instr,
            { op: "local.get", index: tmpVal } as Instr,
            { op: "array.set", typeIdx: dataTypeIdx } as Instr,
          ],
          else: [],
        } as Instr);
        fctx.body.push({ op: "local.get", index: tmpVal });
      };

      return emitLogicalAssignmentPattern(
        ctx,
        fctx,
        rhs,
        op,
        elemType,
        emitElemGet,
        emitElemSet,
      );
    }
  }

  ctx.errors.push({
    message: "Unsupported element access logical assignment target",
    line: getLine(target),
    column: getCol(target),
  });
  return null;
}

/**
 * Check if a ValType is a reference type (can be used with ref.is_null).
 * Value types (i32, i64, f32, f64, v128, i16) are never null/undefined.
 */
function isRefType(t: ValType): boolean {
  return (
    t.kind === "ref" ||
    t.kind === "ref_null" ||
    t.kind === "funcref" ||
    t.kind === "externref" ||
    t.kind === "ref_extern" ||
    t.kind === "eqref"
  );
}

/**
 * Common logic for logical assignment patterns (??=, ||=, &&=).
 * Given emitGet/emitSet closures for the target, emit the if/else with short-circuit semantics.
 */
function emitLogicalAssignmentPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  varType: ValType,
  emitGet: () => void,
  emitSet: () => void,
): ValType | null {
  if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    // target ??= rhs  →  if (target is null/undefined) { target = rhs }; result = target
    // For value types (i32, i64, f32, f64, etc.), values can never be null/undefined,
    // so just return the current value without evaluating RHS (short-circuit).
    if (!isRefType(varType)) {
      emitGet();
      return varType;
    }
    emitGet();
    fctx.body.push({ op: "ref.is_null" });

    const savedBody = pushBody(fctx);
    const rhsResult = compileExpression(ctx, fctx, rhs, varType);
    if (!rhsResult) {
      fctx.body = savedBody;
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

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
    // target ||= rhs  →  if (target is truthy) { keep } else { target = rhs }
    emitGet();
    ensureI32Condition(fctx, varType, ctx);

    const savedBody = pushBody(fctx);
    emitGet();
    const thenInstrs = fctx.body;

    fctx.body = [];
    const rhsResult = compileExpression(ctx, fctx, rhs, varType);
    if (!rhsResult) {
      fctx.body = savedBody;
      return null;
    }
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
    // target &&= rhs  →  if (target is truthy) { target = rhs } else { keep }
    emitGet();
    ensureI32Condition(fctx, varType, ctx);

    const savedBody = pushBody(fctx);
    const rhsResult = compileExpression(ctx, fctx, rhs, varType);
    if (!rhsResult) {
      fctx.body = savedBody;
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

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

export function isCompoundAssignment(op: ts.SyntaxKind): boolean {
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
    // Graceful fallback: compile RHS for side effects, return externref
    const rhsFallback = compileExpression(ctx, fctx, expr.right);
    if (rhsFallback) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
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
    const rhsTsType = ctx.checker.getTypeAtLocation(expr.right);
    if (isBooleanType(rhsTsType) && rhsType.kind === "i32") {
      emitBoolToString(ctx, fctx);
    } else {
      if (rhsType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
    }
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

/**
 * Check if a variable named `name` is assigned a string value anywhere
 * in the enclosing function/block scope. This handles the test262 pattern:
 *   var __str;     // type: any
 *   __str = ""     // string assignment
 *   __str += index // should be string concat, not numeric add
 */
function hasStringAssignment(name: string, fromExpr: ts.Node): boolean {
  // Walk up to the enclosing function body or source file
  let scope: ts.Node = fromExpr;
  while (
    scope &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  if (!scope) return false;

  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    // Check: name = "stringLiteral" or name = `template`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      if (
        ts.isStringLiteral(node.right) ||
        ts.isNoSubstitutionTemplateLiteral(node.right) ||
        ts.isTemplateExpression(node.right)
      ) {
        found = true;
        return;
      }
    }
    // Check: var name = "stringLiteral"
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      if (
        ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
        ts.isTemplateExpression(node.initializer)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(scope, visit);
  return found;
}

/**
 * Like hasStringAssignment but searches from the source file root, not just
 * the immediate function. This catches the pattern where a closure captures
 * a variable that was assigned a string in a parent scope (#795).
 */
function hasStringAssignmentInParentScopes(name: string, fromExpr: ts.Node): boolean {
  // Walk up to the source file root
  let root: ts.Node = fromExpr;
  while (root.parent) root = root.parent;
  if (!ts.isSourceFile(root)) return false;
  // Search the entire source file for string assignments to this name
  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      if (
        ts.isStringLiteral(node.right) ||
        ts.isNoSubstitutionTemplateLiteral(node.right) ||
        ts.isTemplateExpression(node.right)
      ) {
        found = true;
        return;
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      if (
        ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
        ts.isTemplateExpression(node.initializer)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(root, visit);
  return found;
}

export function compileCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Handle property access compound assignment: obj.prop += value
  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyCompoundAssignment(
      ctx,
      fctx,
      expr.left,
      expr.right,
      op,
    );
  }

  // Handle element access compound assignment: arr[i] += value
  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementCompoundAssignment(
      ctx,
      fctx,
      expr.left,
      expr.right,
      op,
    );
  }

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
    let isStr = isStringType(leftTsType);
    if (!isStr && (leftTsType.flags & ts.TypeFlags.Any) !== 0) {
      // For `any`-typed variables (e.g. `var __str; __str=""`), check if
      // the variable is ever assigned a string value in the enclosing scope.
      // This handles the common test262 pattern where `var x; x=""` followed
      // by `x += numericVar` should do string concatenation.
      isStr = hasStringAssignment(name, expr);
    }
    if (isStr) {
      return compileStringCompoundAssignment(ctx, fctx, expr, name);
    }
  }

  // Check captured globals first
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined && fctx.localMap.get(name) === undefined) {
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
    const globalType: ValType = globalDef?.type ?? { kind: "f64" };
    const needsCoerce = globalType.kind !== "f64";

    fctx.body.push({ op: "global.get", index: capturedIdx });
    if (needsCoerce) coerceType(ctx, fctx, globalType, { kind: "f64" });

    const compoundRhsType1 = compileExpression(ctx, fctx, expr.right, {
      kind: "f64",
    });
    if (!compoundRhsType1) {
      ctx.errors.push({
        message: "Failed to compile compound assignment RHS",
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }
    if (compoundRhsType1.kind !== "f64")
      coerceType(ctx, fctx, compoundRhsType1, { kind: "f64" });

    emitCompoundOp(ctx, fctx, op);

    if (needsCoerce) coerceType(ctx, fctx, { kind: "f64" }, globalType);
    fctx.body.push({ op: "global.set", index: capturedIdx });
    fctx.body.push({ op: "global.get", index: capturedIdx });
    return globalType;
  }

  // Check module-level globals
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined && fctx.localMap.get(name) === undefined) {
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    const globalType: ValType = globalDef?.type ?? { kind: "f64" };
    const needsCoerce = globalType.kind !== "f64";

    fctx.body.push({ op: "global.get", index: moduleIdx });
    if (needsCoerce) coerceType(ctx, fctx, globalType, { kind: "f64" });

    const compoundRhsType2 = compileExpression(ctx, fctx, expr.right, {
      kind: "f64",
    });
    if (!compoundRhsType2) {
      ctx.errors.push({
        message: "Failed to compile compound assignment RHS",
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }
    if (compoundRhsType2.kind !== "f64")
      coerceType(ctx, fctx, compoundRhsType2, { kind: "f64" });

    emitCompoundOp(ctx, fctx, op);

    if (needsCoerce) coerceType(ctx, fctx, { kind: "f64" }, globalType);
    fctx.body.push({ op: "global.set", index: moduleIdx });
    fctx.body.push({ op: "global.get", index: moduleIdx });
    return globalType;
  }

  let localIdx = fctx.localMap.get(name);
  if (localIdx === undefined) {
    // Graceful fallback: auto-allocate a local for the unknown identifier
    // so compound assignments work correctly (the variable is initialized
    // to the appropriate zero value).
    const tsType = ctx.checker.getTypeAtLocation(expr.left);
    const wasmType = resolveWasmType(ctx, tsType);
    localIdx = allocLocal(fctx, name, wasmType);
  }

  // Handle boxed (ref cell) mutable captures
  const boxed = fctx.boxedCaptures?.get(name);
  if (boxed) {
    // Read current value from ref cell (null-guarded: if ref cell is null,
    // use default value for the compound op instead of trapping #702)
    fctx.body.push({ op: "local.get", index: localIdx });
    emitNullGuardedStructGet(
      ctx,
      fctx,
      { kind: "ref_null", typeIdx: boxed.refCellTypeIdx },
      boxed.valType,
      boxed.refCellTypeIdx,
      0,
      undefined /* propName */,
      false /* throwOnNull — ref cells use default for uninitialized captures */,
    );

    // For externref boxed captures, check if += should be string concat (#795)
    if (boxed.valType.kind === "externref" && op === ts.SyntaxKind.PlusEqualsToken) {
      const rightTsType = ctx.checker.getTypeAtLocation(expr.right);
      const rhsIsString = isStringType(rightTsType);
      // Also check if the variable was assigned a string in any enclosing scope
      const varHasStringAssign = hasStringAssignment(name, expr) ||
        hasStringAssignmentInParentScopes(name, expr);
      if (rhsIsString || varHasStringAssign) {
        // String concat path: current value (externref) is on stack
        addStringImports(ctx);
        const concatIdx = ctx.funcMap.get("concat");
        if (concatIdx !== undefined) {
          const compoundRhsStr = compileExpression(ctx, fctx, expr.right);
          if (!compoundRhsStr) {
            ctx.errors.push({
              message: "Failed to compile compound assignment RHS",
              line: getLine(expr),
              column: getCol(expr),
            });
            return null;
          }
          // Coerce RHS to externref if needed (e.g. number → string)
          if (compoundRhsStr.kind === "f64" || compoundRhsStr.kind === "i32") {
            if (compoundRhsStr.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
            const toStr = ctx.funcMap.get("number_toString");
            if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
          }
          fctx.body.push({ op: "call", funcIdx: concatIdx });
          // Write back to ref cell
          const tmpStrResult = allocLocal(fctx, `__box_cmp_${fctx.locals.length}`, boxed.valType);
          fctx.body.push({ op: "local.set", index: tmpStrResult });
          fctx.body.push({ op: "local.get", index: localIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [] as Instr[],
            else: [
              { op: "local.get", index: localIdx } as Instr,
              { op: "local.get", index: tmpStrResult } as Instr,
              { op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 } as Instr,
            ],
          });
          fctx.body.push({ op: "local.get", index: tmpStrResult });
          return boxed.valType;
        }
      }
    }

    // For externref boxed captures with arithmetic ops, unbox to f64 first (#795)
    const boxedNeedsUnbox = boxed.valType.kind === "externref";
    if (boxedNeedsUnbox) {
      addUnionImports(ctx);
      const unboxIdx = ctx.funcMap.get("__unbox_number")!;
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    }

    const compoundRhsBoxed = compileExpression(
      ctx,
      fctx,
      expr.right,
      boxedNeedsUnbox ? { kind: "f64" } : boxed.valType,
    );
    if (!compoundRhsBoxed) {
      ctx.errors.push({
        message: "Failed to compile compound assignment RHS",
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }
    // Coerce RHS to f64 if externref (#795)
    if (boxedNeedsUnbox && compoundRhsBoxed.kind === "externref") {
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__unbox_number")! });
    } else if (boxedNeedsUnbox && compoundRhsBoxed.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }

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
      case ts.SyntaxKind.SlashEqualsToken:
        fctx.body.push({ op: "f64.div" });
        break;
      case ts.SyntaxKind.PercentEqualsToken:
        emitModulo(fctx);
        break;
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

    // Box result back to externref if the ref cell stores externref (#795)
    if (boxedNeedsUnbox) {
      addUnionImports(ctx);
      const boxIdx = ctx.funcMap.get("__box_number")!;
      fctx.body.push({ op: "call", funcIdx: boxIdx });
    }

    // Write back to ref cell (skip if ref cell is null #702)
    const tmpResult = allocLocal(
      fctx,
      `__box_cmp_${fctx.locals.length}`,
      boxed.valType,
    );
    fctx.body.push({ op: "local.set", index: tmpResult });
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [] as Instr[],
      else: [
        { op: "local.get", index: localIdx } as Instr,
        { op: "local.get", index: tmpResult } as Instr,
        {
          op: "struct.set",
          typeIdx: boxed.refCellTypeIdx,
          fieldIdx: 0,
        } as Instr,
      ],
    });
    fctx.body.push({ op: "local.get", index: tmpResult });
    return boxed.valType;
  }

  const localType = getLocalType(fctx, localIdx) ?? { kind: "f64" as const };
  const needsLocalCoerce = localType.kind !== "f64";

  fctx.body.push({ op: "local.get", index: localIdx });
  if (needsLocalCoerce) coerceType(ctx, fctx, localType, { kind: "f64" });

  const compoundRhsType3 = compileExpression(ctx, fctx, expr.right, {
    kind: "f64",
  });
  if (!compoundRhsType3) {
    ctx.errors.push({
      message: "Failed to compile compound assignment RHS",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }
  if (compoundRhsType3.kind !== "f64")
    coerceType(ctx, fctx, compoundRhsType3, { kind: "f64" });

  emitCompoundOp(ctx, fctx, op);

  if (needsLocalCoerce) {
    coerceType(ctx, fctx, { kind: "f64" }, localType);
    fctx.body.push({ op: "local.tee", index: localIdx });
    return localType;
  }
  fctx.body.push({ op: "local.tee", index: localIdx });
  return { kind: "f64" };
}

/** Emit bitwise compound op: stack has [left_f64, right_f64], replaces with result f64 */
function emitBitwiseCompoundOp(fctx: FunctionContext, op: ts.SyntaxKind): void {
  const opMap: Record<
    number,
    {
      i32op:
        | "i32.and"
        | "i32.or"
        | "i32.xor"
        | "i32.shl"
        | "i32.shr_s"
        | "i32.shr_u";
      unsigned: boolean;
    }
  > = {
    [ts.SyntaxKind.AmpersandEqualsToken]: { i32op: "i32.and", unsigned: false },
    [ts.SyntaxKind.BarEqualsToken]: { i32op: "i32.or", unsigned: false },
    [ts.SyntaxKind.CaretEqualsToken]: { i32op: "i32.xor", unsigned: false },
    [ts.SyntaxKind.LessThanLessThanEqualsToken]: {
      i32op: "i32.shl",
      unsigned: false,
    },
    [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: {
      i32op: "i32.shr_s",
      unsigned: false,
    },
    [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: {
      i32op: "i32.shr_u",
      unsigned: true,
    },
  };
  const entry = opMap[op]!;
  const tmpR = allocLocal(fctx, `__bw_r_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: "local.get", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: entry.i32op });
  fctx.body.push({
    op: entry.unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s",
  });
}

/** Emit the arithmetic/bitwise operation for a compound assignment operator.
 *  Stack must contain [left_f64, right_f64]. Replaces with result f64. */
function emitCompoundOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
): void {
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
      if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
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
}

/**
 * Compile compound assignment on a property access target: obj.prop += value
 * Pattern: read obj.prop, compile RHS, apply op, store back into obj.prop
 */
function compilePropertyCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name)
    ? "__priv_" + target.name.text.slice(1)
    : target.name.text;

  // Handle static property compound assignment: ClassName.staticProp += value
  if (
    ts.isIdentifier(target.expression) &&
    ctx.classSet.has(target.expression.text)
  ) {
    const clsName = target.expression.text;
    const fullName = `${clsName}_${propName}`;
    const globalIdx = ctx.staticProps.get(fullName);
    if (globalIdx !== undefined) {
      // Read current value
      fctx.body.push({ op: "global.get", index: globalIdx });
      // Compile RHS
      const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
      if (!rhsType) return null;
      // Apply op
      emitCompoundOp(ctx, fctx, op);
      // Store back
      fctx.body.push({ op: "global.set", index: globalIdx });
      fctx.body.push({ op: "global.get", index: globalIdx });
      return { kind: "f64" };
    }
  }

  // Resolve struct type
  let typeName = resolveStructName(ctx, objType);
  if (!typeName && ts.isIdentifier(target.expression)) {
    typeName = ctx.widenedVarStructMap.get(target.expression.text);
  }
  if (!typeName) {
    // Fallback: treat as externref property access via __extern_get / __extern_set
    return compilePropertyCompoundAssignmentExternref(
      ctx,
      fctx,
      target,
      rhs,
      op,
      propName,
    );
  }

  // Check for accessor properties (get/set) before looking up struct fields
  const accessorKey = `${typeName}_${propName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const getterName = `${typeName}_get_${propName}`;
    const setterName = `${typeName}_set_${propName}`;
    const getterIdx = ctx.funcMap.get(getterName);
    const setterIdx = ctx.funcMap.get(setterName);
    if (getterIdx !== undefined && setterIdx !== undefined) {
      // Compile the object expression and save to a temp local, coercing to getter's self type
      const cmpGetterPTypes = getFuncParamTypes(ctx, getterIdx);
      const objResult = compileExpression(ctx, fctx, target.expression, cmpGetterPTypes?.[0]);
      if (!objResult) return null;
      const objTmp = allocLocal(
        fctx,
        `__cmpd_acc_obj_${fctx.locals.length}`,
        objResult,
      );
      fctx.body.push({ op: "local.set", index: objTmp });

      // Read current value via getter: obj.get_prop()
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "call", funcIdx: getterIdx });

      // Compile RHS as f64
      const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
      if (!rhsType) return null;

      // Apply compound operation
      emitCompoundOp(ctx, fctx, op);

      // Save result
      const resultTmp = allocLocal(
        fctx,
        `__cmpd_acc_res_${fctx.locals.length}`,
        { kind: "f64" },
      );
      fctx.body.push({ op: "local.set", index: resultTmp });

      // Store back via setter: obj.set_prop(result)
      fctx.body.push({ op: "local.get", index: objTmp });
      // Coerce f64 result to setter's expected value param type
      const cmpSetterParamTypes = getFuncParamTypes(ctx, setterIdx);
      const cmpSetterValType = cmpSetterParamTypes?.[1]; // param 0 = self, param 1 = value
      if (cmpSetterValType) {
        fctx.body.push({ op: "local.get", index: resultTmp });
        if (cmpSetterValType.kind === "externref") {
          // f64 → externref: box the number
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
      }
      // If setter has no value parameter (only self), don't push value
      const finalCmpSetterIdx = ctx.funcMap.get(setterName) ?? setterIdx;
      fctx.body.push({ op: "call", funcIdx: finalCmpSetterIdx });

      // Return the result
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "f64" };
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    // Struct not found — fall back to externref property access
    return compilePropertyCompoundAssignmentExternref(
      ctx,
      fctx,
      target,
      rhs,
      op,
      propName,
    );
  }

  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — fall back to externref property access
    return compilePropertyCompoundAssignmentExternref(
      ctx,
      fctx,
      target,
      rhs,
      op,
      propName,
    );
  }

  const fieldType = fields[fieldIdx]!.type;

  // Compile the object expression and save to a temp local
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objTmp = allocLocal(
    fctx,
    `__cmpd_obj_${fctx.locals.length}`,
    objResult,
  );
  fctx.body.push({ op: "local.set", index: objTmp });

  // Read current value: obj.prop
  fctx.body.push({ op: "local.get", index: objTmp });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

  // Coerce field value to f64 for arithmetic
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, fieldType, { kind: "f64" });
  }

  // Compile RHS as f64
  const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
  if (!rhsType) return null;

  // Apply compound operation
  emitCompoundOp(ctx, fctx, op);

  // Save result
  const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: resultTmp });

  // Store back: obj.prop = result (coerced to field type)
  fctx.body.push({ op: "local.get", index: objTmp });
  fctx.body.push({ op: "local.get", index: resultTmp });
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, { kind: "f64" }, fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  // Return the result (as f64)
  fctx.body.push({ op: "local.get", index: resultTmp });
  return { kind: "f64" };
}

/**
 * Fallback for compound assignment on a property access target when the
 * struct type cannot be resolved statically.
 *
 * Strategy:
 * 1. Compile the object expression to discover its runtime Wasm type.
 * 2. If the result is a struct ref, look up the field by name in that struct
 *    and perform struct.get / struct.set.
 * 3. If the result is externref, use __extern_get / __extern_set with the
 *    property name as a string key (same pattern as element access compound).
 */
function compilePropertyCompoundAssignmentExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  propName: string,
): ValType | null {
  // Compile the object expression to discover its runtime type
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;

  // --- Path A: The object compiled to a struct ref ---
  if (objResult.kind === "ref" || objResult.kind === "ref_null") {
    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    // Find the struct fields by looking up which typeName maps to this typeIdx
    let resolvedTypeName: string | undefined;
    for (const [name, idx] of ctx.structMap.entries()) {
      if (idx === typeIdx) {
        resolvedTypeName = name;
        break;
      }
    }
    if (resolvedTypeName) {
      const fields = ctx.structFields.get(resolvedTypeName);
      if (fields) {
        let fieldIdx = fields.findIndex((f) => f.name === propName);

        // If the field doesn't exist yet, try to add it dynamically from TS type info
        // but NEVER for class struct types — their fields are fixed at collection time
        if (fieldIdx === -1 && !ctx.classSet.has(resolvedTypeName)) {
          const objTsType = ctx.checker.getTypeAtLocation(target.expression);
          const tsProps = objTsType.getProperties?.();
          if (tsProps) {
            const tsProp = tsProps.find((p) => p.name === propName);
            if (tsProp) {
              const propTsType = ctx.checker.getTypeOfSymbolAtLocation(
                tsProp,
                target,
              );
              const propWasmType = resolveWasmType(ctx, propTsType);
              const newField: FieldDef = {
                name: propName,
                type: propWasmType,
                mutable: true,
              };
              fields.push(newField);
              // fields === typeDef.fields (same array ref from structFields map)
              patchStructNewForAddedField(ctx, fctx, typeIdx, propWasmType);
              const typeDef = ctx.mod.types[typeIdx];
              if (typeDef?.kind === "struct" && typeDef.fields !== fields) {
                typeDef.fields.push(newField);
              }
              // Patch existing struct.new instructions to include the new field
              patchStructNewForDynamicField(ctx, typeIdx, propWasmType);
              fieldIdx = fields.length - 1;
            }
          }
        }

        if (fieldIdx !== -1) {
          const fieldType = fields[fieldIdx]!.type;
          // Save object to temp local
          const objTmp = allocLocal(
            fctx,
            `__cmpd_obj_${fctx.locals.length}`,
            objResult,
          );
          fctx.body.push({ op: "local.set", index: objTmp });

          // Read current value
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });

          // Coerce field value to f64 for arithmetic
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, fieldType, { kind: "f64" });
          }

          // Compile RHS as f64
          const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
          if (!rhsType) return null;

          // Apply compound operation
          emitCompoundOp(ctx, fctx, op);

          // Save result
          const resultTmp = allocLocal(
            fctx,
            `__cmpd_res_${fctx.locals.length}`,
            { kind: "f64" },
          );
          fctx.body.push({ op: "local.set", index: resultTmp });

          // Store back
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "local.get", index: resultTmp });
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, { kind: "f64" }, fieldType);
          }
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });

          // Return the result as f64
          fctx.body.push({ op: "local.get", index: resultTmp });
          return { kind: "f64" };
        }
      }
    }

    // Struct ref but field not found — convert to externref and fall through to path B
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objResult.kind !== "externref") {
    // For f64/i32, box to externref
    if (objResult.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else if (objResult.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else {
      // Unknown type — emit NaN as graceful fallback
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }
  }

  // --- Path B: externref-based property compound assignment ---
  // Save obj to local
  const objLocal = allocLocal(fctx, `__cmpd_pobj_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Ensure the property name string constant is registered
  addStringConstantGlobal(ctx, propName);

  // Compile propName as externref string and save to local
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (!keyResult) return null;
  if (keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyLocal = allocLocal(fctx, `__cmpd_pkey_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Read current value: __extern_get(obj, key) -> externref
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  let getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: getIdx });

  // Ensure union imports (including __unbox_number, __box_number) are registered
  addUnionImports(ctx);

  // Unbox to f64: __unbox_number(externref) -> f64
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (unboxIdx === undefined) {
    ctx.errors.push({
      message:
        "Missing __unbox_number for compound externref property assignment",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  fctx.body.push({ op: "call", funcIdx: unboxIdx });

  // Compile RHS as f64
  const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
  if (!rhsType) return null;

  // Apply compound operation (stack: [lhs_f64, rhs_f64] -> result_f64)
  emitCompoundOp(ctx, fctx, op);

  // Save result for return value
  const resultLocal = allocLocal(fctx, `__cmpd_pres_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Box result to externref: __box_number(f64) -> externref
  fctx.body.push({ op: "local.get", index: resultLocal });
  const boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    ctx.errors.push({
      message:
        "Missing __box_number for compound externref property assignment",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  const boxedLocal = allocLocal(fctx, `__cmpd_pboxed_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: boxedLocal });

  // Write back: __extern_set(obj, key, boxed_result)
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  fctx.body.push({ op: "local.get", index: boxedLocal });
  let setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: setIdx });
  }

  // Return the result as f64
  fctx.body.push({ op: "local.get", index: resultLocal });
  return { kind: "f64" };
}

/**
 * Compile compound assignment on an element access target: arr[i] += value
 * Handles both vec structs (arrays) and plain structs (bracket notation).
 */
function compileElementCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  // Compile the object expression
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;

  // Externref element access compound assignment
  // Pattern: read via __extern_get, unbox, operate, box, write via __extern_set
  if (objResult.kind === "externref") {
    // Save obj to local
    const objLocal = allocLocal(fctx, `__cmpd_eobj_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: objLocal });

    // Compile key as externref and save to local
    const keyResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "externref",
    });
    if (!keyResult) return null;
    const keyLocal = allocLocal(fctx, `__cmpd_ekey_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // Read current value: __extern_get(obj, key) -> externref
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    let getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: getIdx });

    // Ensure union imports (including __unbox_number, __box_number) are registered
    addUnionImports(ctx);

    // Unbox to f64: __unbox_number(externref) -> f64
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx === undefined) {
      ctx.errors.push({
        message: "Missing __unbox_number for compound externref assignment",
        line: getLine(target),
        column: getCol(target),
      });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: unboxIdx });

    // Compile RHS as f64
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
    if (!rhsType) return null;

    // Apply compound operation (stack: [lhs_f64, rhs_f64] -> result_f64)
    emitCompoundOp(ctx, fctx, op);

    // Save result for return value
    const resultLocal = allocLocal(fctx, `__cmpd_eres_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.set", index: resultLocal });

    // Box result to externref: __box_number(f64) -> externref
    fctx.body.push({ op: "local.get", index: resultLocal });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      ctx.errors.push({
        message: "Missing __box_number for compound externref assignment",
        line: getLine(target),
        column: getCol(target),
      });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    const boxedLocal = allocLocal(fctx, `__cmpd_eboxed_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: boxedLocal });

    // Write back: __extern_set(obj, key, boxed_result)
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    let setIdx = ensureLateImport(
      ctx,
      "__extern_set",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
    );
    flushLateImportShifts(ctx, fctx);
    if (setIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }

    // Return the result as f64
    fctx.body.push({ op: "local.get", index: resultLocal });
    return { kind: "f64" };
  }

  // For primitive targets (f64, i32, i64), box to externref and re-enter via the externref path
  if (
    objResult.kind === "f64" ||
    objResult.kind === "i32" ||
    objResult.kind === "i64"
  ) {
    coerceType(ctx, fctx, objResult, { kind: "externref" });

    // Save obj as externref local
    const objLocal = allocLocal(fctx, `__cmpd_eobj_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: objLocal });

    // Compile key as externref and save to local
    const keyResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "externref",
    });
    if (!keyResult) return null;
    const keyLocal = allocLocal(fctx, `__cmpd_ekey_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // Read current value: __extern_get(obj, key) -> externref
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    let getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: getIdx });

    // Ensure union imports (including __unbox_number, __box_number) are registered
    addUnionImports(ctx);

    // Unbox to f64
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx === undefined) {
      ctx.errors.push({
        message: "Missing __unbox_number for compound element assignment",
        line: getLine(target),
        column: getCol(target),
      });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: unboxIdx });

    // Compile RHS as f64
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
    if (!rhsType) return null;

    // Apply compound operation
    emitCompoundOp(ctx, fctx, op);

    // Save result
    const resultLocal = allocLocal(fctx, `__cmpd_eres_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.set", index: resultLocal });

    // Box result to externref
    fctx.body.push({ op: "local.get", index: resultLocal });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      ctx.errors.push({
        message: "Missing __box_number for compound element assignment",
        line: getLine(target),
        column: getCol(target),
      });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    const boxedLocal = allocLocal(fctx, `__cmpd_eboxed_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: boxedLocal });

    // Write back: __extern_set(obj, key, boxed_result)
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    let setIdx = ensureLateImport(
      ctx,
      "__extern_set",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
    );
    flushLateImportShifts(ctx, fctx);
    if (setIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }

    // Return the result as f64
    fctx.body.push({ op: "local.get", index: resultLocal });
    return { kind: "f64" };
  }

  if (objResult.kind !== "ref" && objResult.kind !== "ref_null") {
    ctx.errors.push({
      message: "Compound assignment on non-ref element access",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  const typeIdx = (objResult as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle plain struct: obj["prop"] += value → struct.get + op + struct.set
  if (typeDef?.kind === "struct") {
    const isVec =
      typeDef.fields.length === 2 &&
      typeDef.fields[0]?.name === "length" &&
      typeDef.fields[1]?.name === "data";

    if (!isVec) {
      // Resolve field name from literal or const variable
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
            if (
              ts.isVariableDeclarationList(declList) &&
              (declList.flags & ts.NodeFlags.Const) !== 0
            ) {
              if (ts.isStringLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              } else if (ts.isNumericLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              }
            }
          }
        }
      }
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(
          ctx,
          target.argumentExpression,
        );
      }

      if (fieldName !== undefined) {
        const fieldIdx = typeDef.fields.findIndex(
          (f: { name?: string }) => f.name === fieldName,
        );
        if (fieldIdx !== -1) {
          const fieldType = typeDef.fields[fieldIdx]!.type;
          const objTmp = allocLocal(
            fctx,
            `__cmpd_obj_${fctx.locals.length}`,
            objResult,
          );
          fctx.body.push({ op: "local.set", index: objTmp });

          // Read current value
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, fieldType, { kind: "f64" });
          }

          // Compile RHS as f64
          const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
          if (!rhsType) return null;

          // Apply compound operation
          emitCompoundOp(ctx, fctx, op);

          // Save result
          const resultTmp = allocLocal(
            fctx,
            `__cmpd_res_${fctx.locals.length}`,
            { kind: "f64" },
          );
          fctx.body.push({ op: "local.set", index: resultTmp });

          // Store back
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "local.get", index: resultTmp });
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, { kind: "f64" }, fieldType);
          }
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });

          fctx.body.push({ op: "local.get", index: resultTmp });
          return { kind: "f64" };
        }
      }
    }

    // Vec struct: arr[i] += value
    if (isVec) {
      const objTmp = allocLocal(
        fctx,
        `__cmpd_arr_${fctx.locals.length}`,
        objResult,
      );
      fctx.body.push({ op: "local.set", index: objTmp });

      // Compile index
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression);
      if (!idxResult) return null;
      if (idxResult.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      const idxTmp = allocLocal(fctx, `__cmpd_idx_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: idxTmp });

      // Get the data array type
      const dataFieldType = typeDef.fields[1]!.type;
      const arrayTypeIdx = (dataFieldType as { typeIdx: number }).typeIdx;
      const arrayDef = ctx.mod.types[arrayTypeIdx];
      const elemType =
        arrayDef && arrayDef.kind === "array"
          ? arrayDef.element
          : { kind: "f64" as const };

      // Read current value: arr.data[idx] (bounds-checked)
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "local.get", index: idxTmp });
      emitBoundsCheckedArrayGet(fctx, arrayTypeIdx, elemType);

      // Coerce to f64 for arithmetic
      if (elemType.kind !== "f64") {
        coerceType(ctx, fctx, elemType, { kind: "f64" });
      }

      // Compile RHS as f64
      const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
      if (!rhsType) return null;

      // Apply compound operation
      emitCompoundOp(ctx, fctx, op);

      // Save result
      const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: resultTmp });

      // Store back: arr.data[idx] = result (bounds-guarded)
      fctx.body.push({ op: "local.get", index: idxTmp });
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "array.len" });
      fctx.body.push({ op: "i32.lt_u" } as Instr);
      {
        const setInstrs: Instr[] = [
          { op: "local.get", index: objTmp } as Instr,
          { op: "struct.get", typeIdx, fieldIdx: 1 } as Instr,
          { op: "local.get", index: idxTmp } as Instr,
          { op: "local.get", index: resultTmp } as Instr,
        ];
        if (elemType.kind !== "f64") {
          const savedBody = fctx.body;
          fctx.body = setInstrs as any;
          coerceType(ctx, fctx, { kind: "f64" }, elemType);
          fctx.body = savedBody;
        }
        setInstrs.push({ op: "array.set", typeIdx: arrayTypeIdx } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" as const },
          then: setInstrs,
          else: [],
        } as Instr);
      }

      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "f64" };
    }
  }

  ctx.errors.push({
    message: `Unsupported compound assignment on element access`,
    line: getLine(target),
    column: getCol(target),
  });
  return null;
}

/** Unwrap parenthesized expressions: (x) -> x, ((x)) -> x, etc. */
function unwrapParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return node;
}

/**
 * Compile prefix/postfix increment/decrement on member expressions:
 *   ++obj.x, obj.x++, --obj[i], obj[i]--, etc.
 *
 * For prefix: evaluates new value (old +/- 1), stores, returns new value.
 * For postfix: evaluates old value, stores new value (old +/- 1), returns old value.
 */
function compileMemberIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  arithOp: "add" | "sub",
  mode: "prefix" | "postfix",
): ValType | null {
  const f64Op = arithOp === "add" ? "f64.add" : "f64.sub";
  const i32Op = arithOp === "add" ? "i32.add" : "i32.sub";

  // Unwrap parenthesized expressions: ++(obj.x) -> ++obj.x
  operand = unwrapParens(operand);

  // Handle obj.prop
  if (ts.isPropertyAccessExpression(operand)) {
    const objType = ctx.checker.getTypeAtLocation(operand.expression);
    const propName = ts.isPrivateIdentifier(operand.name)
      ? "__priv_" + operand.name.text.slice(1)
      : operand.name.text;
    // Ensure anonymous types are registered as structs before resolving
    ensureStructForType(ctx, objType);
    let typeName = resolveStructName(ctx, objType);
    // Fallback: check widened variable struct map (matches compilePropertyAssignment)
    if (!typeName && ts.isIdentifier(operand.expression)) {
      typeName = ctx.widenedVarStructMap.get(operand.expression.text);
    }
    if (!typeName) {
      // Unresolvable type (e.g. this.x in module scope, new Object().prop)
      // Gracefully emit NaN — incrementing an unresolvable property is NaN in JS
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    // Check for accessor properties (get/set) before looking up struct fields
    const accessorKey = `${typeName}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${typeName}_get_${propName}`;
      const setterName = `${typeName}_set_${propName}`;
      const getterIdx = ctx.funcMap.get(getterName);
      const setterIdx = ctx.funcMap.get(setterName);
      if (getterIdx !== undefined && setterIdx !== undefined) {
        // Compile the object expression and save to a temp local, coercing to getter's self type
        const incGetterPTypes = getFuncParamTypes(ctx, getterIdx);
        const objResult = compileExpression(ctx, fctx, operand.expression, incGetterPTypes?.[0]);
        if (!objResult) return null;
        const objTmp = allocLocal(
          fctx,
          `__incdec_acc_obj_${fctx.locals.length}`,
          objResult,
        );
        fctx.body.push({ op: "local.set", index: objTmp });

        // Read current value via getter
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "call", funcIdx: getterIdx });

        if (mode === "postfix") {
          // Save old value, compute new, store via setter, return old
          const oldTmp = allocLocal(
            fctx,
            `__incdec_acc_old_${fctx.locals.length}`,
            { kind: "f64" },
          );
          fctx.body.push({ op: "local.tee", index: oldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: f64Op });
          const newTmp = allocLocal(
            fctx,
            `__incdec_acc_new_${fctx.locals.length}`,
            { kind: "f64" },
          );
          fctx.body.push({ op: "local.set", index: newTmp });
          fctx.body.push({ op: "local.get", index: objTmp });
          // Coerce f64 to setter's expected value param type (if setter has value param)
          {
            const idParamTypes = getFuncParamTypes(ctx, setterIdx);
            const idValType = idParamTypes?.[1];
            if (idValType) {
              fctx.body.push({ op: "local.get", index: newTmp });
              if (idValType.kind === "externref") {
                addUnionImports(ctx);
                const bIdx = ctx.funcMap.get("__box_number");
                if (bIdx !== undefined)
                  fctx.body.push({ op: "call", funcIdx: bIdx });
              }
            }
          }
          {
            const fs = ctx.funcMap.get(setterName) ?? setterIdx;
            fctx.body.push({ op: "call", funcIdx: fs });
          }
          fctx.body.push({ op: "local.get", index: oldTmp });
        } else {
          // Compute new, store via setter, return new
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: f64Op });
          const newTmp = allocLocal(
            fctx,
            `__incdec_acc_new_${fctx.locals.length}`,
            { kind: "f64" },
          );
          fctx.body.push({ op: "local.tee", index: newTmp });
          // Store: setter expects [obj, val] (or just [obj] if setter ignores value)
          const valTmp = allocLocal(
            fctx,
            `__incdec_acc_val_${fctx.locals.length}`,
            { kind: "f64" },
          );
          fctx.body.push({ op: "local.set", index: valTmp });
          fctx.body.push({ op: "local.get", index: objTmp });
          // Coerce f64 to setter's expected value param type (if setter has value param)
          {
            const idParamTypes = getFuncParamTypes(ctx, setterIdx);
            const idValType = idParamTypes?.[1];
            if (idValType) {
              fctx.body.push({ op: "local.get", index: valTmp });
              if (idValType.kind === "externref") {
                addUnionImports(ctx);
                const bIdx = ctx.funcMap.get("__box_number");
                if (bIdx !== undefined)
                  fctx.body.push({ op: "call", funcIdx: bIdx });
              }
            }
          }
          {
            const fs = ctx.funcMap.get(setterName) ?? setterIdx;
            fctx.body.push({ op: "call", funcIdx: fs });
          }
          fctx.body.push({ op: "local.get", index: newTmp });
        }
        return { kind: "f64" };
      }
    }

    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) {
      // Struct not found — gracefully emit NaN
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    const fieldIdx = fields.findIndex((f) => f.name === propName);
    if (fieldIdx === -1) {
      // Unknown field — gracefully emit NaN (reading undefined property in numeric context)
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    const fieldType = fields[fieldIdx]!.type;

    // Compile the object expression and save to a temp local
    const objResult = compileExpression(ctx, fctx, operand.expression);
    if (!objResult) return null;
    const objTmp = allocLocal(
      fctx,
      `__incdec_obj_${fctx.locals.length}`,
      objResult,
    );
    fctx.body.push({ op: "local.set", index: objTmp });

    // Read current value: obj.prop
    fctx.body.push({ op: "local.get", index: objTmp });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

    if (ctx.fast && fieldType.kind === "i32") {
      if (mode === "postfix") {
        // Save old value, compute new, store new, return old
        const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.tee", index: oldTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: i32Op });
        const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: newTmp });
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "local.get", index: newTmp });
        fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.get", index: oldTmp });
        return { kind: "i32" };
      } else {
        // Compute new, store, return new
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: i32Op });
        const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: newTmp });
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "local.get", index: newTmp });
        fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.get", index: newTmp });
        return { kind: "i32" };
      }
    }

    // Default: f64 arithmetic
    // Coerce field value to f64 if needed
    if (fieldType.kind !== "f64") {
      coerceType(ctx, fctx, fieldType, { kind: "f64" });
    }

    if (mode === "postfix") {
      // Save old value, compute new, store, return old
      const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: oldTmp });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: f64Op });
      // Coerce back to field type if needed
      if (fieldType.kind !== "f64") {
        coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      }
      const newTmp = allocLocal(
        fctx,
        `__incdec_new_${fctx.locals.length}`,
        fieldType,
      );
      fctx.body.push({ op: "local.set", index: newTmp });
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "local.get", index: newTmp });
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: oldTmp });
      return { kind: "f64" };
    } else {
      // Compute new, store, return new
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: f64Op });
      const newF64Tmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: newF64Tmp });
      // Store: obj.prop = new (coerced back to field type)
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "local.get", index: newF64Tmp });
      if (fieldType.kind !== "f64") {
        coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      }
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: newF64Tmp });
      return { kind: "f64" };
    }
  }

  // Handle obj[idx] — element access increment/decrement on arrays
  if (ts.isElementAccessExpression(operand)) {
    const objTsType = ctx.checker.getTypeAtLocation(operand.expression);
    const objResult = compileExpression(ctx, fctx, operand.expression);
    if (!objResult) return null;

    // Externref element access: cannot do struct.get/struct.set on externref,
    // gracefully emit NaN (incrementing a dynamic property produces NaN)
    if (objResult.kind === "externref") {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    if (objResult.kind !== "ref" && objResult.kind !== "ref_null") {
      // Non-ref element access: gracefully emit NaN
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    // Save object to a temp local early so the stack is clean for fallback paths
    const elemObjTmp = allocLocal(
      fctx,
      `__incdec_eobj_${fctx.locals.length}`,
      objResult,
    );
    fctx.body.push({ op: "local.set", index: elemObjTmp });

    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[typeIdx];

    // String/numeric literal index on a plain struct — resolve to field
    if (typeDef?.kind === "struct") {
      const isVec =
        typeDef.fields.length === 2 &&
        typeDef.fields[0]?.name === "length" &&
        typeDef.fields[1]?.name === "data";

      if (!isVec) {
        // Plain struct: resolve field by name
        let fieldName: string | undefined;
        if (ts.isStringLiteral(operand.argumentExpression)) {
          fieldName = operand.argumentExpression.text;
        } else if (ts.isNumericLiteral(operand.argumentExpression)) {
          fieldName = operand.argumentExpression.text;
        }

        if (fieldName) {
          const fieldIdx = typeDef.fields.findIndex(
            (f: { name: string }) => f.name === fieldName,
          );
          if (fieldIdx !== -1) {
            const fieldType = typeDef.fields[fieldIdx]!.type;

            // Read current value
            fctx.body.push({ op: "local.get", index: elemObjTmp });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });

            if (fieldType.kind !== "f64") {
              coerceType(ctx, fctx, fieldType, { kind: "f64" });
            }

            if (mode === "postfix") {
              const oldTmp = allocLocal(
                fctx,
                `__incdec_old_${fctx.locals.length}`,
                { kind: "f64" },
              );
              fctx.body.push({ op: "local.tee", index: oldTmp });
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: f64Op });
              if (fieldType.kind !== "f64")
                coerceType(ctx, fctx, { kind: "f64" }, fieldType);
              const newTmp = allocLocal(
                fctx,
                `__incdec_new_${fctx.locals.length}`,
                fieldType,
              );
              fctx.body.push({ op: "local.set", index: newTmp });
              fctx.body.push({ op: "local.get", index: elemObjTmp });
              fctx.body.push({ op: "local.get", index: newTmp });
              fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
              fctx.body.push({ op: "local.get", index: oldTmp });
              return { kind: "f64" };
            } else {
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: f64Op });
              const newTmp = allocLocal(
                fctx,
                `__incdec_new_${fctx.locals.length}`,
                { kind: "f64" },
              );
              fctx.body.push({ op: "local.set", index: newTmp });
              fctx.body.push({ op: "local.get", index: elemObjTmp });
              fctx.body.push({ op: "local.get", index: newTmp });
              if (fieldType.kind !== "f64")
                coerceType(ctx, fctx, { kind: "f64" }, fieldType);
              fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
              fctx.body.push({ op: "local.get", index: newTmp });
              return { kind: "f64" };
            }
          }
        }
      }

      // Vec struct: arr[i]++ — array element increment/decrement
      if (isVec) {
        const objTmp = elemObjTmp;

        // Compile index
        const idxResult = compileExpression(
          ctx,
          fctx,
          operand.argumentExpression,
        );
        if (!idxResult) return null;
        // Convert index to i32
        if (idxResult.kind === "f64") {
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        }
        const idxTmp = allocLocal(fctx, `__incdec_idx_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: idxTmp });

        // Get the data array
        const dataFieldType = typeDef.fields[1]!.type;
        const arrayTypeIdx = (dataFieldType as { typeIdx: number }).typeIdx;
        const arrayDef = ctx.mod.types[arrayTypeIdx];
        const elemType =
          arrayDef && arrayDef.kind === "array"
            ? arrayDef.element
            : { kind: "f64" as const };

        // Read current value: arr.data[idx] (bounds-checked)
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.get", index: idxTmp });
        emitBoundsCheckedArrayGet(fctx, arrayTypeIdx, elemType);

        // Coerce to f64 for arithmetic if needed
        if (elemType.kind !== "f64" && elemType.kind !== "i32") {
          coerceType(ctx, fctx, elemType, { kind: "f64" });
        }

        const numType =
          ctx.fast && elemType.kind === "i32"
            ? ("i32" as const)
            : ("f64" as const);
        const op = numType === "i32" ? i32Op : f64Op;

        if (mode === "postfix") {
          const oldTmp = allocLocal(
            fctx,
            `__incdec_old_${fctx.locals.length}`,
            { kind: numType },
          );
          fctx.body.push({ op: "local.tee", index: oldTmp });
          if (numType === "i32") {
            fctx.body.push({ op: "i32.const", value: 1 });
          } else {
            fctx.body.push({ op: "f64.const", value: 1 });
          }
          fctx.body.push({ op });
          const newTmp = allocLocal(
            fctx,
            `__incdec_new_${fctx.locals.length}`,
            { kind: numType },
          );
          fctx.body.push({ op: "local.set", index: newTmp });
          // Store: arr.data[idx] = new (bounds-guarded)
          emitBoundsGuardedArraySet(
            fctx,
            objTmp,
            typeIdx,
            idxTmp,
            newTmp,
            arrayTypeIdx,
          );
          fctx.body.push({ op: "local.get", index: oldTmp });
          return { kind: numType };
        } else {
          if (numType === "i32") {
            fctx.body.push({ op: "i32.const", value: 1 });
          } else {
            fctx.body.push({ op: "f64.const", value: 1 });
          }
          fctx.body.push({ op });
          const newTmp = allocLocal(
            fctx,
            `__incdec_new_${fctx.locals.length}`,
            { kind: numType },
          );
          fctx.body.push({ op: "local.set", index: newTmp });
          // Store: arr.data[idx] = new (bounds-guarded)
          emitBoundsGuardedArraySet(
            fctx,
            objTmp,
            typeIdx,
            idxTmp,
            newTmp,
            arrayTypeIdx,
          );
          fctx.body.push({ op: "local.get", index: newTmp });
          return { kind: numType };
        }
      }
    }
  }

  // Unsupported operand kind — gracefully emit NaN instead of hard error
  fctx.body.push({ op: "f64.const", value: NaN });
  return { kind: "f64" };
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
        // String → number: use __unbox_number (Number() semantics, not parseFloat)
        // Number("") = 0, Number("123") = 123, Number("abc") = NaN
        // parseFloat("") = NaN which is wrong for unary +
        const unboxIdx = ctx.funcMap.get("__unbox_number");
        if (unboxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: unboxIdx });
          return { kind: "f64" };
        }
        // Fallback to parseFloat if __unbox_number not available
        const pfIdx = ctx.funcMap.get("parseFloat");
        if (pfIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: pfIdx });
          return { kind: "f64" };
        }
      }
      // Struct ref → f64: coerce via valueOf (JS ToNumber semantics)
      if (
        operandType &&
        (operandType.kind === "ref" || operandType.kind === "ref_null")
      ) {
        coerceType(ctx, fctx, operandType, { kind: "f64" });
        return { kind: "f64" };
      }
      // i32 (boolean) → f64 conversion for ToNumber
      if (operandType?.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
        return { kind: "f64" };
      }
      // Already numeric — no-op
      return operandType;
    }
    case ts.SyntaxKind.MinusToken: {
      // Try static resolution first (handles strings, null, undefined, booleans, etc.)
      const staticVal = tryStaticToNumber(ctx, expr.operand);
      if (staticVal !== undefined) {
        fctx.body.push({ op: "f64.const", value: -staticVal });
        return { kind: "f64" };
      }
      const operandType = compileExpression(ctx, fctx, expr.operand);
      if (!operandType) return null;
      // any-typed negate: call __any_neg
      if (isAnyValue(operandType, ctx)) {
        ensureAnyHelpers(ctx);
        const negIdx = ctx.funcMap.get("__any_neg");
        if (negIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: negIdx });
          return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
        }
      }
      if (ctx.fast && operandType?.kind === "i32") {
        // Check if operand is literal 0 — must produce -0 (IEEE 754 negative zero)
        // Integer subtraction (0 - 0) gives 0, not -0, so use f64 path
        // Unwrap parenthesized expressions to handle -(0)
        let innerOperand: ts.Expression = expr.operand;
        while (ts.isParenthesizedExpression(innerOperand)) {
          innerOperand = innerOperand.expression;
        }
        if (
          ts.isNumericLiteral(innerOperand) &&
          Number(innerOperand.text) === 0
        ) {
          // Pop the i32.const 0 already on stack, push f64.const -0 directly
          fctx.body.pop();
          fctx.body.push({ op: "f64.const", value: -0 });
          return { kind: "f64" };
        }
        // For non-zero i32 values, integer negation is fine (no -0 concern)
        const tmp = allocLocal(fctx, `__neg_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: tmp });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "i32.sub" });
        return { kind: "i32" };
      }
      if (operandType?.kind === "i64") {
        // i64 negate: 0 - x
        const tmp = allocLocal(fctx, `__neg_${fctx.locals.length}`, {
          kind: "i64",
        });
        fctx.body.push({ op: "local.set", index: tmp });
        fctx.body.push({ op: "i64.const", value: 0n });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "i64.sub" });
        return { kind: "i64" };
      }
      // Non-f64 operand → coerce to f64 before negating
      if (operandType?.kind !== "f64") {
        coerceType(ctx, fctx, operandType!, { kind: "f64" });
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
        if (operandType?.kind !== "i32")
          coerceType(ctx, fctx, operandType!, { kind: "i32" });
        fctx.body.push({ op: "i32.const", value: -1 });
        fctx.body.push({ op: "i32.xor" });
        return { kind: "i32" };
      }
      // ~x => f64.convert_i32_s(i32.xor(ToInt32(x), -1))
      if (operandType?.kind !== "f64")
        coerceType(ctx, fctx, operandType!, { kind: "f64" });
      emitToInt32(fctx);
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.xor" });
      fctx.body.push({ op: "f64.convert_i32_s" });
      return { kind: "f64" };
    }
    case ts.SyntaxKind.PlusPlusToken: {
      // Unwrap parenthesized expressions: ++(x) -> ++x
      const ppOperand = unwrapParens(expr.operand);
      if (ts.isIdentifier(ppOperand)) {
        const idx = fctx.localMap.get(ppOperand.text);
        if (idx !== undefined) {
          const boxedPP = fctx.boxedCaptures?.get(ppOperand.text);
          if (boxedPP) {
            // ++x through ref cell (null-guarded #702)
            const ppTmp = allocLocal(
              fctx,
              `__pp_${fctx.locals.length}`,
              boxedPP.valType,
            );
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: boxedPP.valType },
              then: defaultValueInstrs(boxedPP.valType),
              else: [
                { op: "local.get", index: idx } as Instr,
                { op: "local.get", index: idx } as Instr,
                {
                  op: "struct.get",
                  typeIdx: boxedPP.refCellTypeIdx,
                  fieldIdx: 0,
                } as Instr,
                ...(boxedPP.valType.kind === "i32"
                  ? [{ op: "i32.const", value: 1 } as Instr, { op: "i32.add" } as Instr]
                  : [{ op: "f64.const", value: 1 } as Instr, { op: "f64.add" } as Instr]),
                { op: "local.tee", index: ppTmp } as Instr,
                {
                  op: "struct.set",
                  typeIdx: boxedPP.refCellTypeIdx,
                  fieldIdx: 0,
                } as Instr,
                { op: "local.get", index: ppTmp } as Instr,
              ],
            });
            return boxedPP.valType;
          }
          const localType = getLocalType(fctx, idx);
          if (localType?.kind === "i32") {
            // Use i32 ops for i32 locals (both fast mode and i32-inferred loop counters)
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: "i32.add" });
            fctx.body.push({ op: "local.tee", index: idx });
            return { kind: "i32" };
          }
          if (localType?.kind === "externref") {
            fctx.body.push({ op: "local.get", index: idx });
            emitSafeExternrefToF64(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "local.tee", index: idx });
            return { kind: "externref" };
          }
          // ref/ref_null: struct/array reference — coerce via valueOf, then add 1
          if (localType?.kind === "ref" || localType?.kind === "ref_null") {
            fctx.body.push({ op: "local.get", index: idx });
            coerceType(ctx, fctx, localType!, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.tee", index: idx });
          return { kind: "f64" };
        }
        // Check module globals for prefix ++
        const ppModIdx = ctx.moduleGlobals.get(ppOperand.text);
        if (ppModIdx !== undefined) {
          const ppModGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, ppModIdx)];
          if (ppModGlobalDef?.type.kind === "externref") {
            // externref global: safe unbox to f64, add 1, box back
            fctx.body.push({ op: "global.get", index: ppModIdx });
            emitSafeExternrefToF64(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: ppModIdx });
            fctx.body.push({ op: "global.get", index: ppModIdx });
            return { kind: "externref" };
          }
          if (
            ppModGlobalDef &&
            (ppModGlobalDef.type.kind === "ref" ||
              ppModGlobalDef.type.kind === "ref_null")
          ) {
            // ref global: coerce via valueOf, result is NaN+1 = NaN for plain objects
            fctx.body.push({ op: "global.get", index: ppModIdx });
            coerceType(ctx, fctx, ppModGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: ppModIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          const ppTmp = allocLocal(fctx, `__pp_mod_${fctx.locals.length}`, {
            kind: "f64",
          });
          fctx.body.push({ op: "local.tee", index: ppTmp });
          fctx.body.push({ op: "global.set", index: ppModIdx });
          fctx.body.push({ op: "local.get", index: ppTmp });
          return { kind: "f64" };
        }
        // Check captured globals for prefix ++
        const ppCapIdx = ctx.capturedGlobals.get(ppOperand.text);
        if (ppCapIdx !== undefined) {
          const ppCapGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, ppCapIdx)];
          if (ppCapGlobalDef?.type.kind === "externref") {
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            emitSafeExternrefToF64(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: ppCapIdx });
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            return { kind: "externref" };
          }
          if (
            ppCapGlobalDef &&
            (ppCapGlobalDef.type.kind === "ref" ||
              ppCapGlobalDef.type.kind === "ref_null")
          ) {
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            coerceType(ctx, fctx, ppCapGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: ppCapIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          const ppTmp = allocLocal(fctx, `__pp_cap_${fctx.locals.length}`, {
            kind: "f64",
          });
          fctx.body.push({ op: "local.tee", index: ppTmp });
          fctx.body.push({ op: "global.set", index: ppCapIdx });
          fctx.body.push({ op: "local.get", index: ppTmp });
          return { kind: "f64" };
        }
      }
      // ++obj.prop or ++obj[idx] — delegate to member increment helper
      return compileMemberIncDec(ctx, fctx, expr.operand, "add", "prefix");
    }
    case ts.SyntaxKind.MinusMinusToken: {
      const isIncrement = expr.operator === ts.SyntaxKind.PlusPlusToken;
      const arithOp = isIncrement ? "f64.add" : "f64.sub";
      const arithOpI32 = isIncrement ? "i32.add" : "i32.sub";

      // Unwrap parenthesized expressions: --(x) -> --x
      const mmOperand = unwrapParens(expr.operand);
      if (ts.isIdentifier(mmOperand)) {
        const idx = fctx.localMap.get(mmOperand.text);
        if (idx !== undefined) {
          const boxed = fctx.boxedCaptures?.get(mmOperand.text);
          if (boxed) {
            // ++x / --x through ref cell (null-guarded #702)
            const tmp = allocLocal(
              fctx,
              `__pp_${fctx.locals.length}`,
              boxed.valType,
            );
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: boxed.valType },
              then: defaultValueInstrs(boxed.valType),
              else: [
                { op: "local.get", index: idx } as Instr,
                { op: "local.get", index: idx } as Instr,
                {
                  op: "struct.get",
                  typeIdx: boxed.refCellTypeIdx,
                  fieldIdx: 0,
                } as Instr,
                ...(boxed.valType.kind === "i32"
                  ? [{ op: "i32.const", value: 1 } as Instr, { op: arithOpI32 } as Instr]
                  : [{ op: "f64.const", value: 1 } as Instr, { op: arithOp } as Instr]),
                { op: "local.tee", index: tmp } as Instr,
                {
                  op: "struct.set",
                  typeIdx: boxed.refCellTypeIdx,
                  fieldIdx: 0,
                } as Instr,
                { op: "local.get", index: tmp } as Instr,
              ],
            });
            return boxed.valType;
          }
          const localType = getLocalType(fctx, idx);
          if (localType?.kind === "i32") {
            // Use i32 ops for i32 locals (both fast mode and i32-inferred loop counters)
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: arithOpI32 });
            fctx.body.push({ op: "local.tee", index: idx });
            return { kind: "i32" };
          }
          if (localType?.kind === "externref") {
            fctx.body.push({ op: "local.get", index: idx });
            emitSafeExternrefToF64(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "local.tee", index: idx });
            return { kind: "externref" };
          }
          // ref/ref_null: struct/array reference — coerce via valueOf, then sub 1
          if (localType?.kind === "ref" || localType?.kind === "ref_null") {
            fctx.body.push({ op: "local.get", index: idx });
            coerceType(ctx, fctx, localType!, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          fctx.body.push({ op: "local.tee", index: idx });
          return { kind: "f64" };
        }
        // Check module globals for prefix --
        const mmModIdx = ctx.moduleGlobals.get(mmOperand.text);
        if (mmModIdx !== undefined) {
          const mmModGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, mmModIdx)];
          if (mmModGlobalDef?.type.kind === "externref") {
            fctx.body.push({ op: "global.get", index: mmModIdx });
            emitSafeExternrefToF64(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: mmModIdx });
            fctx.body.push({ op: "global.get", index: mmModIdx });
            return { kind: "externref" };
          }
          if (
            mmModGlobalDef &&
            (mmModGlobalDef.type.kind === "ref" ||
              mmModGlobalDef.type.kind === "ref_null")
          ) {
            fctx.body.push({ op: "global.get", index: mmModIdx });
            coerceType(ctx, fctx, mmModGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: mmModIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          const mmTmp = allocLocal(fctx, `__mm_mod_${fctx.locals.length}`, {
            kind: "f64",
          });
          fctx.body.push({ op: "local.tee", index: mmTmp });
          fctx.body.push({ op: "global.set", index: mmModIdx });
          fctx.body.push({ op: "local.get", index: mmTmp });
          return { kind: "f64" };
        }
        // Check captured globals for prefix --
        const mmCapIdx = ctx.capturedGlobals.get(mmOperand.text);
        if (mmCapIdx !== undefined) {
          const mmCapGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, mmCapIdx)];
          if (mmCapGlobalDef?.type.kind === "externref") {
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            emitSafeExternrefToF64(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: mmCapIdx });
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            return { kind: "externref" };
          }
          if (
            mmCapGlobalDef &&
            (mmCapGlobalDef.type.kind === "ref" ||
              mmCapGlobalDef.type.kind === "ref_null")
          ) {
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            coerceType(ctx, fctx, mmCapGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: mmCapIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          const mmTmp = allocLocal(fctx, `__mm_cap_${fctx.locals.length}`, {
            kind: "f64",
          });
          fctx.body.push({ op: "local.tee", index: mmTmp });
          fctx.body.push({ op: "global.set", index: mmCapIdx });
          fctx.body.push({ op: "local.get", index: mmTmp });
          return { kind: "f64" };
        }
      }
      // --obj.prop or --obj[idx] — delegate to member decrement helper
      return compileMemberIncDec(ctx, fctx, expr.operand, "sub", "prefix");
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
  const isIncrement = expr.operator === ts.SyntaxKind.PlusPlusToken;
  const arithOp = isIncrement ? "f64.add" : "f64.sub";
  const arithOpI32 = isIncrement ? "i32.add" : "i32.sub";

  // Unwrap parenthesized expressions: (x)++ -> x++
  const postOperand = unwrapParens(expr.operand);

  if (!ts.isIdentifier(postOperand)) {
    // obj.prop++ or obj[idx]++ — delegate to member increment helper
    const memberOp = isIncrement ? "add" : "sub";
    return compileMemberIncDec(ctx, fctx, expr.operand, memberOp, "postfix");
  }

  if (ts.isIdentifier(postOperand)) {
    const idx = fctx.localMap.get(postOperand.text);
    if (idx === undefined) {
      // Check module globals for postfix ++/--
      const postModIdx = ctx.moduleGlobals.get(postOperand.text);
      if (postModIdx !== undefined) {
        const postModGlobalDef =
          ctx.mod.globals[localGlobalIdx(ctx, postModIdx)];
        if (postModGlobalDef?.type.kind === "externref") {
          // externref global: safe unbox old value, compute new, box and store back
          fctx.body.push({ op: "global.get", index: postModIdx });
          emitSafeExternrefToF64(ctx, fctx);
          const postOldTmp = allocLocal(
            fctx,
            `__post_old_${fctx.locals.length}`,
            { kind: "f64" },
          );
          fctx.body.push({ op: "local.tee", index: postOldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          addUnionImports(ctx);
          fctx.body.push({
            op: "call",
            funcIdx: ctx.funcMap.get("__box_number")!,
          });
          fctx.body.push({ op: "global.set", index: postModIdx });
          fctx.body.push({ op: "local.get", index: postOldTmp });
          return { kind: "f64" };
        }
        if (
          postModGlobalDef &&
          (postModGlobalDef.type.kind === "ref" ||
            postModGlobalDef.type.kind === "ref_null")
        ) {
          // ref global: coerce via valueOf, postfix returns old numeric value
          fctx.body.push({ op: "global.get", index: postModIdx });
          coerceType(ctx, fctx, postModGlobalDef.type, { kind: "f64" });
          return { kind: "f64" };
        }
        // Postfix: return old value, store new value
        fctx.body.push({ op: "global.get", index: postModIdx });
        fctx.body.push({ op: "global.get", index: postModIdx });
        fctx.body.push({ op: "f64.const", value: 1 });
        fctx.body.push({ op: arithOp });
        fctx.body.push({ op: "global.set", index: postModIdx });
        return { kind: "f64" };
      }
      // Check captured globals for postfix ++/--
      const postCapIdx = ctx.capturedGlobals.get(postOperand.text);
      if (postCapIdx !== undefined) {
        const postCapGlobalDef =
          ctx.mod.globals[localGlobalIdx(ctx, postCapIdx)];
        if (postCapGlobalDef?.type.kind === "externref") {
          fctx.body.push({ op: "global.get", index: postCapIdx });
          emitSafeExternrefToF64(ctx, fctx);
          const postCapOldTmp = allocLocal(
            fctx,
            `__post_cap_old_${fctx.locals.length}`,
            { kind: "f64" },
          );
          fctx.body.push({ op: "local.tee", index: postCapOldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          addUnionImports(ctx);
          fctx.body.push({
            op: "call",
            funcIdx: ctx.funcMap.get("__box_number")!,
          });
          fctx.body.push({ op: "global.set", index: postCapIdx });
          fctx.body.push({ op: "local.get", index: postCapOldTmp });
          return { kind: "f64" };
        }
        if (
          postCapGlobalDef &&
          (postCapGlobalDef.type.kind === "ref" ||
            postCapGlobalDef.type.kind === "ref_null")
        ) {
          fctx.body.push({ op: "global.get", index: postCapIdx });
          coerceType(ctx, fctx, postCapGlobalDef.type, { kind: "f64" });
          return { kind: "f64" };
        }
        fctx.body.push({ op: "global.get", index: postCapIdx });
        fctx.body.push({ op: "global.get", index: postCapIdx });
        fctx.body.push({ op: "f64.const", value: 1 });
        fctx.body.push({ op: arithOp });
        fctx.body.push({ op: "global.set", index: postCapIdx });
        return { kind: "f64" };
      }
      // Graceful fallback: emit 0 for unknown postfix increment/decrement
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }

    // Handle boxed (ref cell) mutable captures for postfix (null-guarded #702)
    const boxedPost = fctx.boxedCaptures?.get(postOperand.text);
    if (boxedPost) {
      const oldTmp = allocLocal(
        fctx,
        `__postbox_${fctx.locals.length}`,
        boxedPost.valType,
      );
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val" as const, type: boxedPost.valType },
        then: defaultValueInstrs(boxedPost.valType),
        else: [
          { op: "local.get", index: idx } as Instr,
          {
            op: "struct.get",
            typeIdx: boxedPost.refCellTypeIdx,
            fieldIdx: 0,
          } as Instr,
          { op: "local.tee", index: oldTmp } as Instr,
          ...(boxedPost.valType.kind === "i32"
            ? [{ op: "i32.const", value: 1 } as Instr, { op: arithOpI32 } as Instr]
            : [{ op: "f64.const", value: 1 } as Instr, { op: arithOp } as Instr]),
          ...(() => {
            const newTmp = allocLocal(
              fctx,
              `__postnew_${fctx.locals.length}`,
              boxedPost.valType,
            );
            return [
              { op: "local.set", index: newTmp } as Instr,
              { op: "local.get", index: idx } as Instr,
              { op: "local.get", index: newTmp } as Instr,
              {
                op: "struct.set",
                typeIdx: boxedPost.refCellTypeIdx,
                fieldIdx: 0,
              } as Instr,
              { op: "local.get", index: oldTmp } as Instr,
            ];
          })(),
        ],
      });
      return boxedPost.valType;
    }

    const localType = getLocalType(fctx, idx);
    if (localType?.kind === "i32") {
      // Use i32 ops for i32 locals (both fast mode and i32-inferred loop counters)
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: arithOpI32 });
      fctx.body.push({ op: "local.set", index: idx });
      return { kind: "i32" };
    }

    if (localType?.kind === "externref") {
      // Postfix on externref: return old value (unboxed), store incremented (boxed)
      fctx.body.push({ op: "local.get", index: idx });
      emitSafeExternrefToF64(ctx, fctx);
      const tmpOld = allocLocal(fctx, `__postfix_old_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: tmpOld });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: arithOp });
      addUnionImports(ctx);
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
      fctx.body.push({ op: "local.set", index: idx });
      fctx.body.push({ op: "local.get", index: tmpOld });
      return { kind: "f64" };
    }

    // ref/ref_null: struct/array reference — coerce via valueOf, postfix returns old numeric value
    if (localType?.kind === "ref" || localType?.kind === "ref_null") {
      fctx.body.push({ op: "local.get", index: idx });
      coerceType(ctx, fctx, localType!, { kind: "f64" });
      return { kind: "f64" };
    }

    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: arithOp });
    fctx.body.push({ op: "local.set", index: idx });
    return { kind: "f64" };
  }

  // obj.prop++ / obj.prop-- (property access target)
  if (ts.isPropertyAccessExpression(expr.operand)) {
    return compilePostfixIncrementProperty(
      ctx,
      fctx,
      expr.operand,
      isIncrement,
    );
  }

  // arr[i]++ / arr[i]-- (element access target)
  if (ts.isElementAccessExpression(expr.operand)) {
    return compilePostfixIncrementElement(ctx, fctx, expr.operand, isIncrement);
  }

  ctx.errors.push({
    message: "Unsupported postfix unary target",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Prefix/postfix increment helpers for property/element access ────

/**
 * ++obj.prop / --obj.prop: get field, increment, set field, return NEW value
 */
function compilePrefixIncrementProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  isIncrement: boolean,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name)
    ? "__priv_" + target.name.text.slice(1)
    : target.name.text;
  const typeName = resolveStructName(ctx, objType);
  if (!typeName) {
    ctx.errors.push({
      message: `Cannot resolve struct for prefix increment on property: ${propName}`,
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    ctx.errors.push({
      message: `Unknown struct type for prefix increment: ${typeName}`,
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — gracefully emit NaN (reading undefined property in numeric context)
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }

  // Compile object ref and save it (we need it twice: once to get, once to set)
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objLocal = allocLocal(
    fctx,
    `__inc_obj_${fctx.locals.length}`,
    objResult,
  );
  fctx.body.push({ op: "local.set", index: objLocal });

  // Get current field value
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

  // Coerce to f64 if needed
  const fieldType = fields[fieldIdx]!.type;
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, fieldType, { kind: "f64" });
  }

  // Increment/decrement
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });

  // Save new value
  const newVal = allocLocal(fctx, `__inc_new_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: newVal });

  // Set field: obj, newValue -> struct.set
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: newVal });
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, { kind: "f64" }, fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  // Return new value (prefix returns the new value)
  fctx.body.push({ op: "local.get", index: newVal });
  return { kind: "f64" };
}

/**
 * ++arr[i] / --arr[i]: get element, increment, set element, return NEW value
 */
function compilePrefixIncrementElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  isIncrement: boolean,
): ValType | null {
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) {
    ctx.errors.push({
      message: "Prefix increment on non-array element access",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // String-literal bracket access on struct: ++obj["prop"]
  if (
    typeDef?.kind === "struct" &&
    ts.isStringLiteral(target.argumentExpression)
  ) {
    const propName = target.argumentExpression.text;
    const fieldIdx = typeDef.fields.findIndex(
      (f: { name: string }) => f.name === propName,
    );
    if (fieldIdx !== -1) {
      const objLocal = allocLocal(
        fctx,
        `__inc_obj_${fctx.locals.length}`,
        arrType,
      );
      fctx.body.push({ op: "local.set", index: objLocal });

      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
      const fieldType = typeDef.fields[fieldIdx]!.type;
      if (fieldType.kind !== "f64")
        coerceType(ctx, fctx, fieldType, { kind: "f64" });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });
      const newVal = allocLocal(fctx, `__inc_new_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: newVal });
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newVal });
      if (fieldType.kind !== "f64")
        coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: newVal });
      return { kind: "f64" };
    }
  }

  // Vec struct (array wrapped in {length, data})
  const isVecStruct =
    typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      ctx.errors.push({
        message: "Prefix increment: vec data is not array",
        line: getLine(target),
        column: getCol(target),
      });
      return null;
    }
    const vecLocal = allocLocal(
      fctx,
      `__inc_vec_${fctx.locals.length}`,
      arrType,
    );
    fctx.body.push({ op: "local.set", index: vecLocal });
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "f64",
    });
    if (!idxResult) return null;
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const idxLocal = allocLocal(fctx, `__inc_idx_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: idxLocal });

    const elemType = arrDef.element;

    // Bounds check: if idx < array.len, do read-modify-write; else produce NaN
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // data field
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "i32.lt_u" } as Instr);

    // Build the in-bounds branch: read, modify, write, return new value
    const thenInstrs: Instr[] = [];
    thenInstrs.push({ op: "local.get", index: vecLocal } as Instr);
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 } as Instr);
    thenInstrs.push({ op: "local.get", index: idxLocal } as Instr);
    thenInstrs.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, elemType, { kind: "f64" });
      fctx.body = savedBody;
    }
    thenInstrs.push({ op: "f64.const", value: 1 } as Instr);
    thenInstrs.push({ op: isIncrement ? "f64.add" : "f64.sub" } as Instr);
    const newVal = allocLocal(fctx, `__inc_new_${fctx.locals.length}`, {
      kind: "f64",
    });
    thenInstrs.push({ op: "local.tee", index: newVal } as Instr);
    // Coerce back for array.set if needed
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, { kind: "f64" }, elemType);
      fctx.body = savedBody;
    }
    const coercedNewVal = allocLocal(
      fctx,
      `__inc_cval_${fctx.locals.length}`,
      elemType,
    );
    thenInstrs.push({ op: "local.set", index: coercedNewVal } as Instr);
    thenInstrs.push({ op: "local.get", index: vecLocal } as Instr);
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 } as Instr);
    thenInstrs.push({ op: "local.get", index: idxLocal } as Instr);
    thenInstrs.push({ op: "local.get", index: coercedNewVal } as Instr);
    thenInstrs.push({ op: "array.set", typeIdx: arrTypeIdx } as Instr);
    thenInstrs.push({ op: "local.get", index: newVal } as Instr);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val" as const, type: { kind: "f64" as const } },
      then: thenInstrs,
      else: [{ op: "f64.const", value: NaN } as Instr],
    } as Instr);

    return { kind: "f64" };
  }

  ctx.errors.push({
    message: "Unsupported prefix increment element access target",
    line: getLine(target),
    column: getCol(target),
  });
  return null;
}

/**
 * obj.prop++ / obj.prop--: get field, save OLD, increment, set field, return OLD value
 */
function compilePostfixIncrementProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  isIncrement: boolean,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name)
    ? "__priv_" + target.name.text.slice(1)
    : target.name.text;
  const typeName = resolveStructName(ctx, objType);
  if (!typeName) {
    ctx.errors.push({
      message: `Cannot resolve struct for postfix increment on property: ${propName}`,
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    ctx.errors.push({
      message: `Unknown struct type for postfix increment: ${typeName}`,
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — gracefully emit NaN (reading undefined property in numeric context)
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }

  // Compile object ref and save
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objLocal = allocLocal(
    fctx,
    `__postinc_obj_${fctx.locals.length}`,
    objResult,
  );
  fctx.body.push({ op: "local.set", index: objLocal });

  // Get current field value
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

  // Coerce to f64 if needed
  const fieldType = fields[fieldIdx]!.type;
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, fieldType, { kind: "f64" });
  }

  // Save OLD value
  const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: oldVal });

  // Compute new value
  fctx.body.push({ op: "local.get", index: oldVal });
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });

  // Save new value for struct.set
  const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: newVal });

  // Set field: obj, newValue -> struct.set
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: newVal });
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, { kind: "f64" }, fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  // Return OLD value (postfix returns old value)
  fctx.body.push({ op: "local.get", index: oldVal });
  return { kind: "f64" };
}

/**
 * arr[i]++ / arr[i]--: get element, save OLD, increment, set element, return OLD value
 */
function compilePostfixIncrementElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  isIncrement: boolean,
): ValType | null {
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) {
    ctx.errors.push({
      message: "Postfix increment on non-array element access",
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // String-literal bracket access on struct: obj["prop"]++
  if (
    typeDef?.kind === "struct" &&
    ts.isStringLiteral(target.argumentExpression)
  ) {
    const propName = target.argumentExpression.text;
    const fieldIdx = typeDef.fields.findIndex(
      (f: { name: string }) => f.name === propName,
    );
    if (fieldIdx !== -1) {
      const objLocal = allocLocal(
        fctx,
        `__postinc_obj_${fctx.locals.length}`,
        arrType,
      );
      fctx.body.push({ op: "local.set", index: objLocal });

      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
      const fieldType = typeDef.fields[fieldIdx]!.type;
      if (fieldType.kind !== "f64")
        coerceType(ctx, fctx, fieldType, { kind: "f64" });
      const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: oldVal });
      fctx.body.push({ op: "local.get", index: oldVal });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });
      const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: newVal });
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newVal });
      if (fieldType.kind !== "f64")
        coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: oldVal });
      return { kind: "f64" };
    }
  }

  // Vec struct (array wrapped in {length, data})
  const isVecStruct =
    typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      ctx.errors.push({
        message: "Postfix increment: vec data is not array",
        line: getLine(target),
        column: getCol(target),
      });
      return null;
    }
    const vecLocal = allocLocal(
      fctx,
      `__postinc_vec_${fctx.locals.length}`,
      arrType,
    );
    fctx.body.push({ op: "local.set", index: vecLocal });
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "f64",
    });
    if (!idxResult) return null;
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const idxLocal = allocLocal(fctx, `__postinc_idx_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: idxLocal });

    const elemType = arrDef.element;

    // Bounds check: if idx < array.len, do read-modify-write; else produce NaN
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "i32.lt_u" } as Instr);

    // Build the in-bounds branch: read old, compute new, write, return old
    const thenInstrs: Instr[] = [];
    thenInstrs.push({ op: "local.get", index: vecLocal } as Instr);
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 } as Instr);
    thenInstrs.push({ op: "local.get", index: idxLocal } as Instr);
    thenInstrs.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, elemType, { kind: "f64" });
      fctx.body = savedBody;
    }
    const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, {
      kind: "f64",
    });
    thenInstrs.push({ op: "local.set", index: oldVal } as Instr);
    // Compute new value
    thenInstrs.push({ op: "local.get", index: oldVal } as Instr);
    thenInstrs.push({ op: "f64.const", value: 1 } as Instr);
    thenInstrs.push({ op: isIncrement ? "f64.add" : "f64.sub" } as Instr);
    // Coerce and write back
    const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, {
      kind: "f64",
    });
    thenInstrs.push({ op: "local.set", index: newVal } as Instr);
    thenInstrs.push({ op: "local.get", index: vecLocal } as Instr);
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 } as Instr);
    thenInstrs.push({ op: "local.get", index: idxLocal } as Instr);
    thenInstrs.push({ op: "local.get", index: newVal } as Instr);
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, { kind: "f64" }, elemType);
      fctx.body = savedBody;
    }
    thenInstrs.push({ op: "array.set", typeIdx: arrTypeIdx } as Instr);
    // Return old value
    thenInstrs.push({ op: "local.get", index: oldVal } as Instr);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val" as const, type: { kind: "f64" as const } },
      then: thenInstrs,
      else: [{ op: "f64.const", value: NaN } as Instr],
    } as Instr);

    return { kind: "f64" };
  }

  ctx.errors.push({
    message: "Unsupported postfix increment element access target",
    line: getLine(target),
    column: getCol(target),
  });
  return null;
}

// ── Call expressions ─────────────────────────────────────────────────

/** Look up parameter types for a function by its index */
export function getFuncParamTypes(
  ctx: CodegenContext,
  funcIdx: number,
): ValType[] | undefined {
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
): InnerResult {
  const localIdx = fctx.localMap.get(varName);
  const moduleIdx =
    localIdx === undefined ? ctx.moduleGlobals.get(varName) : undefined;
  if (localIdx === undefined && moduleIdx === undefined) return null;

  // Determine how to push the closure ref (local vs module global).
  // If the local is externref (e.g. captured in a __cb_N callback), we need to
  // convert to the expected struct ref type before struct.get can be used.
  let effectiveLocalIdx = localIdx;
  if (localIdx !== undefined) {
    const localType =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]?.type
        : fctx.locals[localIdx - fctx.params.length]?.type;
    if (localType?.kind === "externref") {
      // Convert externref → anyref → ref $closure_struct, store in a new local
      const castType: ValType = { kind: "ref_null", typeIdx: info.structTypeIdx };
      const castLocal = allocLocal(fctx, `__closure_cast_${fctx.locals.length}`, castType);
      fctx.body.push({ op: "local.get", index: localIdx });
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast_null", typeIdx: info.structTypeIdx } as Instr);
      fctx.body.push({ op: "local.set", index: castLocal });
      effectiveLocalIdx = castLocal;
    }
  }

  const pushClosureRef = () => {
    if (effectiveLocalIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: effectiveLocalIdx });
    } else {
      fctx.body.push({ op: "global.get", index: moduleIdx! });
    }
    // Null-check → TypeError instead of trap on struct.get (#728, #441)
    emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: info.structTypeIdx });
  };

  // Stack for call_ref needs: [closure_ref, ...args, funcref]
  // where the lifted func type is (ref $closure_struct, ...arrowParams) → results

  // Push closure ref as first arg (self param of the lifted function)
  pushClosureRef();

  // Push call arguments (only up to the closure's declared parameter count)
  const paramCount = info.paramTypes.length;
  for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
    compileExpression(ctx, fctx, expr.arguments[i]!, info.paramTypes[i]);
  }

  // Drop excess arguments beyond the closure's parameter count (evaluate for side effects)
  for (let i = paramCount; i < expr.arguments.length; i++) {
    const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
    if (extraType !== null && extraType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
  }

  // Pad missing arguments with defaults (arity mismatch)
  for (let i = expr.arguments.length; i < info.paramTypes.length; i++) {
    pushDefaultValue(fctx, info.paramTypes[i]!);
  }

  // Push the funcref from the closure struct (field 0) and cast to typed ref
  pushClosureRef();
  fctx.body.push({
    op: "struct.get",
    typeIdx: info.structTypeIdx,
    fieldIdx: 0,
  });
  fctx.body.push({ op: "ref.cast", typeIdx: info.funcTypeIdx });
  emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: info.funcTypeIdx });

  // call_ref with the lifted function's type index
  fctx.body.push({ op: "call_ref", typeIdx: info.funcTypeIdx });

  // Return VOID_RESULT for void closures so compileExpression doesn't treat
  // the null return as a compilation failure and roll back the emitted instructions
  return info.returnType ?? VOID_RESULT;
}

/**
 * Handle calls to callable struct fields: obj.callback() where callback
 * is a function-typed property stored in a struct field (not a method).
 * Returns undefined if the property is not a callable struct field,
 * allowing the caller to fall through to other handling.
 */
function compileCallablePropertyCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  className: string,
): InnerResult | undefined {
  const methodName = ts.isPrivateIdentifier(propAccess.name)
    ? "__priv_" + propAccess.name.text.slice(1)
    : propAccess.name.text;

  // Check if this property name is a struct field
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return undefined;

  const fieldIdx = fields.findIndex((f) => f.name === methodName);
  if (fieldIdx === -1) return undefined;

  const fieldType = fields[fieldIdx]!.type;

  // The field must be a callable type — check via TS type checker
  const propTsType = ctx.checker.getTypeAtLocation(propAccess);
  const callSigs = propTsType.getCallSignatures?.();
  if (!callSigs || callSigs.length === 0) return undefined;

  const sig = callSigs[0]!;
  const sigParamCount = sig.parameters.length;
  const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
  const sigRetWasm = isVoidType(sigRetType)
    ? null
    : resolveWasmType(ctx, sigRetType);
  const sigParamWasmTypes: ValType[] = [];
  for (let i = 0; i < sigParamCount; i++) {
    const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
    sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
  }

  // If the field is a ref type, check if it's a known closure struct
  if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
    const closureInfo = ctx.closureInfoByTypeIdx.get(
      (fieldType as { typeIdx: number }).typeIdx,
    );
    if (closureInfo) {
      // Compile receiver, get field value (closure struct ref)
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      const closureLocal = allocLocal(
        fctx,
        `__cprop_${fctx.locals.length}`,
        fieldType,
      );
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as first arg (self param) — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }

      // Push call arguments (only up to declared param count)
      {
        const cpParamCount = closureInfo.paramTypes.length;
        for (
          let i = 0;
          i < Math.min(expr.arguments.length, cpParamCount);
          i++
        ) {
          compileExpression(
            ctx,
            fctx,
            expr.arguments[i]!,
            closureInfo.paramTypes[i],
          );
        }
        // Drop excess arguments beyond param count (side effects only)
        for (let i = cpParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null && extraType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      // Pad missing arguments
      for (
        let i = expr.arguments.length;
        i < closureInfo.paramTypes.length;
        i++
      ) {
        pushDefaultValue(fctx, closureInfo.paramTypes[i]!);
      }

      // Get funcref from closure struct field 0 and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }
      fctx.body.push({
        op: "struct.get",
        typeIdx: (fieldType as { typeIdx: number }).typeIdx,
        fieldIdx: 0,
      });
      fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.funcTypeIdx });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
      fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

      return closureInfo.returnType ?? VOID_RESULT;
    }
  }

  // Field is externref — try to find or create matching closure wrapper types
  if (fieldType.kind === "externref") {
    const resultTypes = sigRetWasm ? [sigRetWasm] : [];
    const wrapperTypes = getOrCreateFuncRefWrapperTypes(
      ctx,
      sigParamWasmTypes,
      resultTypes,
    );

    if (wrapperTypes) {
      const {
        structTypeIdx: wrapperStructIdx,
        closureInfo: matchedClosureInfo,
      } = wrapperTypes;

      // Compile receiver, get field value (externref)
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      // Convert externref -> closure struct ref (guarded to avoid illegal cast)
      const closureRefType: ValType = {
        kind: "ref_null",
        typeIdx: wrapperStructIdx,
      };
      const closureLocal = allocLocal(
        fctx,
        `__cprop_ext_${fctx.locals.length}`,
        closureRefType,
      );
      fctx.body.push({ op: "any.convert_extern" });
      emitGuardedRefCast(fctx, wrapperStructIdx);
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as first arg (self param) — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, closureRefType);

      // Push call arguments (only up to declared param count)
      {
        const wpParamCount = matchedClosureInfo.paramTypes.length;
        for (
          let i = 0;
          i < Math.min(expr.arguments.length, wpParamCount);
          i++
        ) {
          compileExpression(
            ctx,
            fctx,
            expr.arguments[i]!,
            matchedClosureInfo.paramTypes[i],
          );
        }
        for (let i = wpParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null && extraType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      // Pad missing arguments
      for (
        let i = expr.arguments.length;
        i < matchedClosureInfo.paramTypes.length;
        i++
      ) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
      }

      // Get funcref from closure struct and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, closureRefType);
      fctx.body.push({
        op: "struct.get",
        typeIdx: wrapperStructIdx,
        fieldIdx: 0,
      });
      fctx.body.push({
        op: "ref.cast",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  // For ref types that aren't known closures, try matching against registered closure types
  if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
    // Try to find a matching closure type by signature
    let matchedClosureInfo: ClosureInfo | undefined;
    let matchedStructTypeIdx: number | undefined;

    for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
      if (info.paramTypes.length !== sigParamCount) continue;
      if (sigRetWasm === null && info.returnType !== null) continue;
      if (sigRetWasm !== null && info.returnType === null) continue;
      if (
        sigRetWasm !== null &&
        info.returnType !== null &&
        sigRetWasm.kind !== info.returnType.kind
      )
        continue;
      let paramsMatch = true;
      for (let i = 0; i < sigParamCount; i++) {
        if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
          paramsMatch = false;
          break;
        }
      }
      if (paramsMatch) {
        matchedClosureInfo = info;
        matchedStructTypeIdx = typeIdx;
        break;
      }
    }

    if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
      // Compile receiver, get field value
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      const closureLocal = allocLocal(
        fctx,
        `__cprop_ref_${fctx.locals.length}`,
        fieldType,
      );
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as self — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }
      // May need to cast to matching struct type
      if ((fieldType as { typeIdx: number }).typeIdx !== matchedStructTypeIdx) {
        fctx.body.push({ op: "ref.cast", typeIdx: matchedStructTypeIdx });
      }

      // Push call arguments (only up to declared param count)
      {
        const cpRefParamCount = matchedClosureInfo.paramTypes.length;
        for (
          let i = 0;
          i < Math.min(expr.arguments.length, cpRefParamCount);
          i++
        ) {
          compileExpression(
            ctx,
            fctx,
            expr.arguments[i]!,
            matchedClosureInfo.paramTypes[i],
          );
        }
        for (let i = cpRefParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null && extraType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      for (
        let i = expr.arguments.length;
        i < matchedClosureInfo.paramTypes.length;
        i++
      ) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
      }

      // Get funcref and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }
      if ((fieldType as { typeIdx: number }).typeIdx !== matchedStructTypeIdx) {
        fctx.body.push({ op: "ref.cast", typeIdx: matchedStructTypeIdx });
      }
      fctx.body.push({
        op: "struct.get",
        typeIdx: matchedStructTypeIdx,
        fieldIdx: 0,
      });
      fctx.body.push({
        op: "ref.cast",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  return undefined;
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

  // Optional chaining on direct call: fn?.()
  if (expr.questionDotToken && ts.isIdentifier(expr.expression)) {
    return compileOptionalDirectCall(ctx, fctx, expr);
  }

  // Dynamic import() — not supported in AOT Wasm compilation.
  // Emit unreachable so compilation succeeds; the call will trap at runtime.
  if (expr.expression.kind === ts.SyntaxKind.ImportKeyword) {
    ctx.errors.push({
      message: "Dynamic import() is not supported in AOT Wasm compilation",
      line: getLine(expr),
      column: getCol(expr),
      severity: "warning",
    });
    fctx.body.push({ op: "unreachable" });
    return null;
  }

  // Unwrap parenthesized callee: (fn)(...), ((obj.method))(...) etc.
  // This handles patterns like (0, fn)() which are already handled below,
  // but also (fn)(), ((fn))(), (obj.method)() etc. which would otherwise fail.
  if (ts.isParenthesizedExpression(expr.expression)) {
    let unwrapped: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(unwrapped)) {
      unwrapped = unwrapped.expression;
    }
    // Only unwrap if it's NOT a function expression or arrow (those are IIFEs, handled later)
    // and NOT a binary/comma expression (handled separately below)
    if (
      !ts.isFunctionExpression(unwrapped) &&
      !ts.isArrowFunction(unwrapped) &&
      !(
        ts.isBinaryExpression(unwrapped) &&
        unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
      )
    ) {
      // Handle conditional callee inline: (cond ? fn1 : fn2)(args)
      // Cannot create a synthetic call because ts.factory wraps non-LeftHandSide
      // expressions in ParenthesizedExpression, causing infinite recursion.
      if (ts.isConditionalExpression(unwrapped)) {
        return compileConditionalCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle assignment/binary expressions as callee: (x = fn)(), (a || fn)()
      // These are non-LeftHandSideExpressions, so ts.factory.createCallExpression
      // would re-wrap them in ParenthesizedExpression, causing infinite recursion.
      // Instead, compile the expression for its side effects and value, then use
      // the generic closure-matching path to call the result.
      if (ts.isBinaryExpression(unwrapped)) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle prefix/postfix unary as callee (rare but possible)
      if (
        ts.isPrefixUnaryExpression(unwrapped) ||
        ts.isPostfixUnaryExpression(unwrapped)
      ) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      const syntheticCall = ts.factory.createCallExpression(
        unwrapped as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(
        ctx,
        fctx,
        syntheticCall as ts.CallExpression,
      );
    }
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

    // Handle fn.call(thisArg, ...args) and fn.apply(thisArg, argsArray)
    // For standalone functions (no `this`), drop thisArg and call directly.
    // For class methods, use thisArg as the receiver.
    if (propAccess.name.text === "call" || propAccess.name.text === "apply") {
      const isCall = propAccess.name.text === "call";
      const innerExpr = propAccess.expression;

      // Case 1: identifier.call(thisArg, args...) — standalone function
      if (ts.isIdentifier(innerExpr)) {
        const funcName = innerExpr.text;
        let closureInfo = ctx.closureMap.get(funcName);
        const funcIdx = ctx.funcMap.get(funcName);

        // Fallback: if the variable is a local with a ref type, look up closure info
        // by struct type index. This handles cases like:
        //   const f = makeAdder(5); f.call(null, 10);
        if (!closureInfo && funcIdx === undefined) {
          const localIdx = fctx.localMap.get(funcName);
          if (localIdx !== undefined) {
            const localType =
              localIdx < fctx.params.length
                ? fctx.params[localIdx]?.type
                : fctx.locals[localIdx - fctx.params.length]?.type;
            if (
              localType &&
              (localType.kind === "ref" || localType.kind === "ref_null")
            ) {
              closureInfo = ctx.closureInfoByTypeIdx.get(localType.typeIdx);
            }
          }
        }

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate and drop thisArg (first argument) if present
          if (expr.arguments.length > 0) {
            const thisType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (thisType && thisType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }

          if (isCall) {
            // .call(thisArg, arg1, arg2, ...) — remaining args are positional
            const remainingArgs = expr.arguments.slice(1);

            if (closureInfo) {
              // Create a synthetic call expression with remaining args
              const syntheticCall = ts.factory.createCallExpression(
                innerExpr,
                undefined,
                remainingArgs as unknown as readonly ts.Expression[],
              );
              // Copy source file info for error reporting
              (syntheticCall as any).parent = expr.parent;
              return compileClosureCall(
                ctx,
                fctx,
                syntheticCall as ts.CallExpression,
                funcName,
                closureInfo,
              );
            }

            // Check for rest parameters on the callee
            const callRestInfo = ctx.funcRestParams.get(funcName);

            if (callRestInfo) {
              // Calling a rest-param function via .call(): pack trailing args into a GC array
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              // Compile non-rest arguments
              for (let i = 0; i < callRestInfo.restIndex; i++) {
                if (i < remainingArgs.length) {
                  compileExpression(
                    ctx,
                    fctx,
                    remainingArgs[i]!,
                    paramTypes?.[i],
                  );
                } else {
                  pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
                }
              }
              // Pack remaining arguments into a vec struct (array + length)
              const restArgCount = Math.max(
                0,
                remainingArgs.length - callRestInfo.restIndex,
              );
              fctx.body.push({ op: "i32.const", value: restArgCount });
              for (
                let i = callRestInfo.restIndex;
                i < remainingArgs.length;
                i++
              ) {
                compileExpression(
                  ctx,
                  fctx,
                  remainingArgs[i]!,
                  callRestInfo.elemType,
                );
              }
              fctx.body.push({
                op: "array.new_fixed",
                typeIdx: callRestInfo.arrayTypeIdx,
                length: restArgCount,
              });
              fctx.body.push({
                op: "struct.new",
                typeIdx: callRestInfo.vecTypeIdx,
              });
            } else {
              // Regular function call
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              for (let i = 0; i < remainingArgs.length; i++) {
                compileExpression(
                  ctx,
                  fctx,
                  remainingArgs[i]!,
                  paramTypes?.[i],
                );
              }

              // Supply defaults for missing optional params
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                const numProvided = remainingArgs.length;
                for (const opt of optInfo) {
                  if (opt.index >= numProvided) {
                    pushDefaultValue(fctx, opt.type);
                  }
                }
              }

              // Pad any remaining missing arguments with defaults
              if (paramTypes) {
                const providedCount = Math.min(
                  remainingArgs.length,
                  paramTypes.length,
                );
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams
                      .get(funcName)!
                      .filter((o) => o.index >= remainingArgs.length).length
                  : 0;
                const totalPushed = providedCount + optFilledCount;
                for (let i = totalPushed; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!);
                }
              }
            }

            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

            // Use actual Wasm return type — TS checker reports `any` for .call()/.apply()
            // which resolves to externref, but the actual function may return f64/i32/ref.
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
          }
          // .apply(thisArg, argsArray) — spread array literal elements as positional args
          if (!isCall && expr.arguments.length >= 2) {
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const elements = argsExpr.elements;
              if (closureInfo) {
                const syntheticCall = ts.factory.createCallExpression(
                  innerExpr,
                  undefined,
                  elements as unknown as readonly ts.Expression[],
                );
                (syntheticCall as any).parent = expr.parent;
                return compileClosureCall(
                  ctx,
                  fctx,
                  syntheticCall as ts.CallExpression,
                  funcName,
                  closureInfo,
                );
              }
              const applyRestInfo = ctx.funcRestParams.get(funcName);
              if (applyRestInfo) {
                // Rest-param function via .apply(): pack trailing elements into vec
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < applyRestInfo.restIndex; i++) {
                  if (i < elements.length) {
                    compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                  } else {
                    pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
                  }
                }
                const restArgCount = Math.max(
                  0,
                  elements.length - applyRestInfo.restIndex,
                );
                fctx.body.push({ op: "i32.const", value: restArgCount });
                for (
                  let i = applyRestInfo.restIndex;
                  i < elements.length;
                  i++
                ) {
                  compileExpression(
                    ctx,
                    fctx,
                    elements[i]!,
                    applyRestInfo.elemType,
                  );
                }
                fctx.body.push({
                  op: "array.new_fixed",
                  typeIdx: applyRestInfo.arrayTypeIdx,
                  length: restArgCount,
                });
                fctx.body.push({
                  op: "struct.new",
                  typeIdx: applyRestInfo.vecTypeIdx,
                });
              } else {
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < elements.length; i++) {
                  compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                }
                const optInfo = ctx.funcOptionalParams.get(funcName);
                if (optInfo) {
                  for (const opt of optInfo) {
                    if (opt.index >= elements.length)
                      pushDefaultValue(fctx, opt.type);
                  }
                }
                // Pad any remaining missing arguments with defaults
                if (paramTypes) {
                  const providedCount = Math.min(
                    elements.length,
                    paramTypes.length,
                  );
                  const optFilledCount = ctx.funcOptionalParams.get(funcName)
                    ? ctx.funcOptionalParams
                        .get(funcName)!
                        .filter((o) => o.index >= elements.length).length
                    : 0;
                  const totalPushed = providedCount + optFilledCount;
                  for (let i = totalPushed; i < paramTypes.length; i++) {
                    pushDefaultValue(fctx, paramTypes[i]!);
                  }
                }
              }
              const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
              fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
              // Use actual Wasm return type for .apply()
              if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
              return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
            }
          }
          // .apply() with no args array — call with no args
          if (!isCall) {
            if (closureInfo) {
              const syntheticCall = ts.factory.createCallExpression(
                innerExpr,
                undefined,
                [],
              );
              (syntheticCall as any).parent = expr.parent;
              return compileClosureCall(
                ctx,
                fctx,
                syntheticCall as ts.CallExpression,
                funcName,
                closureInfo,
              );
            }
            const applyNoArgsRestInfo = ctx.funcRestParams.get(funcName);
            if (applyNoArgsRestInfo) {
              // Rest-param function with no args: push empty vec
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              for (let i = 0; i < applyNoArgsRestInfo.restIndex; i++) {
                pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
              }
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({
                op: "array.new_fixed",
                typeIdx: applyNoArgsRestInfo.arrayTypeIdx,
                length: 0,
              });
              fctx.body.push({
                op: "struct.new",
                typeIdx: applyNoArgsRestInfo.vecTypeIdx,
              });
            } else {
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                for (const opt of optInfo) pushDefaultValue(fctx, opt.type);
              }
              // Pad any remaining missing arguments with defaults
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              if (paramTypes) {
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams.get(funcName)!.length
                  : 0;
                for (let i = optFilledCount; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!);
                }
              }
            }
            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
            // Use actual Wasm return type for .apply() with no args
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
          }
        }
      }

      // Case 2: obj.method.call/apply — method call with different receiver
      if (ts.isPropertyAccessExpression(innerExpr)) {
        const methodName = innerExpr.name.text;
        const objExpr = innerExpr.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        // Case 2a: Type.prototype.method.call(receiver, ...args)
        // Rewrite as receiver.method(...args) — create a synthetic call expression
        if (
          ts.isPropertyAccessExpression(objExpr) &&
          objExpr.name.text === "prototype" &&
          ts.isIdentifier(objExpr.expression) &&
          isCall &&
          expr.arguments.length >= 1
        ) {
          const typeName = objExpr.expression.text;
          // Rewrite Type.prototype.method.call(receiver, ...args) as a synthetic
          // property access call on the receiver: receiver.method(...args).
          // This handles String.prototype.slice.call("hello", 0, 2) → "hello".slice(0, 2)
          // and Array.prototype.push.call(arr, 1) → arr.push(1), etc.
          if (
            (typeName === "String" ||
              typeName === "Number" ||
              typeName === "Array" ||
              typeName === "Boolean" ||
              typeName === "Object") &&
            expr.arguments.length >= 1
          ) {
            const receiverArg = expr.arguments[0]!;
            const remainingArgs = Array.from(expr.arguments).slice(1);
            const syntheticPropAccess =
              ts.factory.createPropertyAccessExpression(
                receiverArg as ts.Expression,
                methodName,
              );
            const syntheticCall = ts.factory.createCallExpression(
              syntheticPropAccess,
              expr.typeArguments,
              remainingArgs as unknown as readonly ts.Expression[],
            );
            ts.setTextRange(syntheticCall, expr);
            (syntheticCall as any).parent = expr.parent;
            return compileCallExpression(
              ctx,
              fctx,
              syntheticCall as ts.CallExpression,
            );
          }
        }

        // Resolve class name from the object's type
        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }

        // Also try struct name
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (
          className &&
          (ctx.classSet.has(className) ||
            ctx.funcMap.has(`${className}_${methodName}`))
        ) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && expr.arguments.length > 0) {
            // First argument is the thisArg (receiver)
            compileExpression(ctx, fctx, expr.arguments[0]!);

            if (isCall) {
              // .call(thisArg, arg1, arg2, ...) — remaining args are positional
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              // User-visible param count excludes self (param 0);
              // .call() args start at index 1 (index 0 is thisArg)
              const callParamCount = paramTypes
                ? paramTypes.length - 1
                : expr.arguments.length - 1;
              for (let i = 1; i < expr.arguments.length; i++) {
                if (i - 1 < callParamCount) {
                  compileExpression(
                    ctx,
                    fctx,
                    expr.arguments[i]!,
                    paramTypes?.[i],
                  );
                } else {
                  // Extra argument beyond method's parameter count — evaluate for
                  // side effects (JS semantics) and discard the result
                  const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                  if (extraType !== null && extraType !== VOID_RESULT) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
              // Pad missing arguments with defaults (skip self at index 0)
              if (paramTypes) {
                for (let i = expr.arguments.length; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!);
                }
              }
            } else if (
              expr.arguments.length >= 2 &&
              ts.isArrayLiteralExpression(expr.arguments[1]!)
            ) {
              // .apply(thisArg, [arg1, arg2, ...]) — spread array literal
              const elements = (expr.arguments[1] as ts.ArrayLiteralExpression)
                .elements;
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              // User-visible param count excludes self (param 0)
              const applyParamCount = paramTypes
                ? paramTypes.length - 1
                : elements.length;
              for (let i = 0; i < elements.length; i++) {
                if (i < applyParamCount) {
                  compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i + 1]); // param 0 = self
                } else {
                  // Extra argument beyond method's parameter count — evaluate for
                  // side effects (JS semantics) and discard the result
                  const extraType = compileExpression(ctx, fctx, elements[i]!);
                  if (extraType !== null && extraType !== VOID_RESULT) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
              // Pad missing arguments with defaults (skip self at index 0)
              if (paramTypes) {
                for (let i = elements.length + 1; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!);
                }
              }
            }

            // Re-lookup funcIdx: argument compilation may trigger addUnionImports
            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            // Use actual Wasm return type for .call()/.apply() on class methods
            if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalCallIdx) ?? VOID_RESULT;
          }
        }
      }
    }

    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "console" &&
      (propAccess.name.text === "log" ||
        propAccess.name.text === "warn" ||
        propAccess.name.text === "error")
    ) {
      return compileConsoleCall(ctx, fctx, expr, propAccess.name.text);
    }

    // WASI mode: process.exit(code) -> proc_exit(code)
    if (
      ctx.wasi &&
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "process" &&
      propAccess.name.text === "exit" &&
      ctx.wasiProcExitIdx >= 0
    ) {
      if (expr.arguments.length >= 1) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" });
        // The expression might produce f64 — truncate to i32
        const argType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
        if (isNumberType(argType)) {
          fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
        }
      } else {
        fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      }
      fctx.body.push({ op: "call", funcIdx: ctx.wasiProcExitIdx });
      return VOID_RESULT;
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
        const tmp = allocLocal(fctx, `__isnan_${fctx.locals.length}`, {
          kind: "f64",
        });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.ne" } as Instr);
        return { kind: "i32" };
      }
      if (method === "isInteger" && expr.arguments.length >= 1) {
        // n === Math.trunc(n) && isFinite(n)
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        const tmp = allocLocal(fctx, `__isint_${fctx.locals.length}`, {
          kind: "f64",
        });
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
        const tmp = allocLocal(fctx, `__isfin_${fctx.locals.length}`, {
          kind: "f64",
        });
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
        const tmp = allocLocal(fctx, `__issafe_${fctx.locals.length}`, {
          kind: "f64",
        });
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
      if (
        (method === "parseFloat" || method === "parseInt") &&
        expr.arguments.length >= 1
      ) {
        // Delegate to the global parseInt / parseFloat host import
        const funcIdx = ctx.funcMap.get(
          method === "parseFloat" ? "parseFloat" : "parseInt",
        );
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
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
      const isArr =
        argWasmType.kind === "ref" || argWasmType.kind === "ref_null";
      // Still compile the argument for side effects, then drop it
      const argSideType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argSideType) fctx.body.push({ op: "drop" });
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
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, {
          kind: "f64",
        });
        if (argType && argType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        fctx.body.push({ op: "call", funcIdx });
        // In fast mode, marshal externref string to native string
        if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
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
          const srcVec = allocLocal(
            fctx,
            `__arrfrom_src_${fctx.locals.length}`,
            { kind: "ref_null", typeIdx: vecTypeIdx },
          );
          const srcData = allocLocal(
            fctx,
            `__arrfrom_sdata_${fctx.locals.length}`,
            { kind: "ref_null", typeIdx: arrTypeIdx },
          );
          const lenTmp = allocLocal(
            fctx,
            `__arrfrom_len_${fctx.locals.length}`,
            { kind: "i32" },
          );
          const dstData = allocLocal(
            fctx,
            `__arrfrom_ddata_${fctx.locals.length}`,
            { kind: "ref_null", typeIdx: arrTypeIdx },
          );

          fctx.body.push({ op: "local.set", index: srcVec });
          // Get length
          fctx.body.push({ op: "local.get", index: srcVec });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({ op: "local.set", index: lenTmp });
          // Get source data
          fctx.body.push({ op: "local.get", index: srcVec });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "local.set", index: srcData });
          // Create new data array with default value
          const defaultVal =
            elemType.kind === "f64"
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
          fctx.body.push({
            op: "array.copy",
            dstTypeIdx: arrTypeIdx,
            srcTypeIdx: arrTypeIdx,
          } as Instr);
          // Create new vec struct with copied data
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "local.get", index: dstData });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref", typeIdx: vecTypeIdx };
        }
      }
    }

    // Handle Object.keys(obj), Object.values(obj), and Object.entries(obj)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "keys" ||
        propAccess.name.text === "values" ||
        propAccess.name.text === "entries") &&
      expr.arguments.length === 1
    ) {
      return compileObjectKeysOrValues(ctx, fctx, propAccess.name.text, expr);
    }

    // Handle Object.freeze/seal/preventExtensions — compile-away strategy
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "freeze" ||
        propAccess.name.text === "seal" ||
        propAccess.name.text === "preventExtensions") &&
      expr.arguments.length >= 1
    ) {
      const method = propAccess.name.text;
      const arg0 = expr.arguments[0]!;

      // Compile-time tracking: mark variable by freeze/seal/preventExtensions state
      if (ts.isIdentifier(arg0)) {
        ctx.nonExtensibleVars.add(arg0.text);
        if (method === "freeze") {
          ctx.frozenVars.add(arg0.text);
          ctx.sealedVars.add(arg0.text); // frozen implies sealed
        } else if (method === "seal") {
          ctx.sealedVars.add(arg0.text);
        }
      }

      // Compile the argument — returns the object itself (freeze/seal return their arg)
      let argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (!argType) return null;

      // For externref objects, delegate to host import for runtime enforcement
      if (argType.kind === "externref") {
        const objLocal = allocLocal(
          fctx,
          `__freeze_obj_${fctx.locals.length}`,
          { kind: "externref" },
        );
        fctx.body.push({ op: "local.set", index: objLocal });

        // Use the actual JS Object.freeze/seal/preventExtensions via host import
        const importName = method === "freeze" ? "__object_freeze"
          : method === "seal" ? "__object_seal"
          : "__object_preventExtensions";
        const hostIdx = ensureLateImport(
          ctx,
          importName,
          [{ kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);

        if (hostIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "call", funcIdx: hostIdx });
          return { kind: "externref" };
        }

        // Fallback: just return the object as-is
        fctx.body.push({ op: "local.get", index: objLocal });
        return { kind: "externref" };
      }

      // For struct/ref types, compile-time tracking is sufficient — return as-is
      return argType;
    }

    // Handle Object.isFrozen/isSealed — check compile-time state
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "isFrozen" ||
        propAccess.name.text === "isSealed") &&
      expr.arguments.length >= 1
    ) {
      const arg0 = expr.arguments[0]!;
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      // Check compile-time tracking
      let result = 0;
      if (ts.isIdentifier(arg0)) {
        if (propAccess.name.text === "isFrozen" && ctx.frozenVars.has(arg0.text)) {
          result = 1;
        } else if (propAccess.name.text === "isSealed" && ctx.sealedVars.has(arg0.text)) {
          result = 1;
        }
      }
      fctx.body.push({ op: "i32.const", value: result });
      return { kind: "i32" };
    }

    // Handle Object.isExtensible — check compile-time state
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "isExtensible" &&
      expr.arguments.length >= 1
    ) {
      const arg0 = expr.arguments[0]!;
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      // Non-extensible vars return false
      let result = 1;
      if (ts.isIdentifier(arg0) && ctx.nonExtensibleVars.has(arg0.text)) {
        result = 0;
      }
      fctx.body.push({ op: "i32.const", value: result });
      return { kind: "i32" };
    }

    // Handle Object.setPrototypeOf(obj, proto) — stub: compile both args, drop proto, return obj
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "setPrototypeOf" &&
      expr.arguments.length >= 2
    ) {
      const objType = compileExpression(ctx, fctx, expr.arguments[0]!);
      const protoType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (protoType) {
        fctx.body.push({ op: "drop" });
      }
      return objType;
    }

    // Handle Object.getPrototypeOf(obj) — return prototype as externref
    // For class instances, creates a struct representing the prototype and returns
    // it as externref via extern.convert_any. For plain objects, returns null.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "getPrototypeOf" &&
      expr.arguments.length >= 1
    ) {
      const arg0 = expr.arguments[0]!;

      // For Object.getPrototypeOf(Child.prototype), return Parent's prototype singleton
      // Must check BEFORE the general class instance check, because TS types
      // Child.prototype as Child (the instance type).
      if (
        ts.isPropertyAccessExpression(arg0) &&
        ts.isIdentifier(arg0.expression) &&
        arg0.name.text === "prototype" &&
        ctx.classSet.has(arg0.expression.text)
      ) {
        const childClassName = arg0.expression.text;
        const parentClassName = ctx.classParentMap.get(childClassName);
        if (parentClassName && emitLazyProtoGet(ctx, fctx, parentClassName)) {
          return { kind: "externref" };
        }
        // Base class with no parent: return null (Object.prototype not modeled)
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }

      const argTsType = ctx.checker.getTypeAtLocation(arg0);
      const className = resolveStructName(ctx, argTsType);

      // For known class instances, return the class prototype singleton
      if (className && ctx.classSet.has(className)) {
        // Compile and drop the argument (for side effects)
        const argType = compileExpression(ctx, fctx, arg0);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
        if (emitLazyProtoGet(ctx, fctx, className)) {
          return { kind: "externref" };
        }
      }

      // Fallback: compile and drop arg, return null
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Object.create(proto) — create instances for known prototypes
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "create" &&
      expr.arguments.length >= 1
    ) {
      const arg0 = expr.arguments[0]!;

      // Object.create(null) → empty object (externref null)
      if (arg0.kind === ts.SyntaxKind.NullKeyword) {
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }

      // Object.create(Foo.prototype) → struct.new with default fields
      if (
        ts.isPropertyAccessExpression(arg0) &&
        ts.isIdentifier(arg0.expression) &&
        arg0.name.text === "prototype"
      ) {
        const protoClassName = arg0.expression.text;
        if (ctx.classSet.has(protoClassName)) {
          const structTypeIdx = ctx.structMap.get(protoClassName);
          const fields = ctx.structFields.get(protoClassName);
          if (structTypeIdx !== undefined && fields) {
            // Push default values for all fields, then struct.new
            for (const field of fields) {
              pushDefaultValue(fctx, field.type);
            }
            fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
            return { kind: "ref", typeIdx: structTypeIdx };
          }
        }
      }

      // Fallback: compile and drop arg, return null externref
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Object.defineProperty(obj, prop, descriptor) — stub
    // If descriptor is an object literal with a `value` property, sets obj[prop] = value via __extern_set.
    // Otherwise compiles all args for side effects and returns obj.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "defineProperty" &&
      expr.arguments.length >= 3
    ) {
      return compileObjectDefineProperty(ctx, fctx, expr);
    }

    // Handle Object.defineProperties(obj, props) — stub: compile both args, drop props, return obj
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "defineProperties" &&
      expr.arguments.length >= 2
    ) {
      const objType = compileExpression(ctx, fctx, expr.arguments[0]!);
      const propsType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (propsType) {
        fctx.body.push({ op: "drop" });
      }
      return objType;
    }

    // Handle Object.getOwnPropertyDescriptor(obj, prop)
    // Fast path: known struct type + string literal prop → inline struct.get + __create_descriptor
    // Fallback: __getOwnPropertyDescriptor host import for dynamic cases
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "getOwnPropertyDescriptor" &&
      expr.arguments.length >= 2
    ) {
      const arg0 = expr.arguments[0]!;
      const arg1 = expr.arguments[1]!;

      // Try compile-time fast path: known struct + literal property name
      const arg0TsType = ctx.checker.getTypeAtLocation(arg0);
      const structName = resolveStructName(ctx, arg0TsType);
      const propLiteral = ts.isStringLiteral(arg1) ? arg1.text : undefined;

      if (structName && propLiteral !== undefined) {
        const structTypeIdx = ctx.structMap.get(structName);
        const fields = ctx.structFields.get(structName);

        if (structTypeIdx !== undefined && fields) {
          // Find the field index for the property name
          const userFields = fields
            .map((f, idx) => ({ field: f, fieldIdx: idx }))
            .filter((e) => !e.field.name.startsWith("__"));
          const entry = userFields.find((e) => e.field.name === propLiteral);

          if (entry) {
            // Look up flags from shapePropFlags
            const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
            const userFieldIdx = userFields.indexOf(entry);
            const flags = flagsArr && userFieldIdx >= 0 ? flagsArr[userFieldIdx]! : 0x07; // default WEC

            // Compile the object expression
            const objType = compileExpression(ctx, fctx, arg0);
            if (!objType) {
              fctx.body.push({ op: "ref.null.extern" });
              return { kind: "externref" };
            }

            // Cast to struct type if needed
            if (objType.kind === "externref") {
              fctx.body.push({ op: "any.convert_extern" } as unknown as Instr);
              fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as unknown as Instr);
            } else if (objType.kind === "ref_null" && objType.typeIdx !== structTypeIdx) {
              fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as unknown as Instr);
            }

            // Save obj ref for struct.get
            const objLocal = allocLocal(fctx, `__gopd_obj_${fctx.locals.length}`,
              { kind: "ref", typeIdx: structTypeIdx });
            fctx.body.push({ op: "local.set", index: objLocal });

            // Get field value: struct.get → coerce to externref
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });

            // Coerce field value to externref for __create_descriptor
            const fieldType = entry.field.type;
            if (fieldType.kind === "f64") {
              const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
              if (boxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: boxIdx });
              }
            } else if (fieldType.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
              const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
              if (boxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: boxIdx });
              }
            } else if (fieldType.kind === "i64") {
              fctx.body.push({ op: "f64.convert_i64_s" } as unknown as Instr);
              const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
              if (boxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: boxIdx });
              }
            } else if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
              fctx.body.push({ op: "extern.convert_any" });
            } else if (fieldType.kind !== "externref") {
              // Other types: try extern.convert_any
              fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
            }

            // Push flags as i32 constant
            fctx.body.push({ op: "i32.const", value: flags });

            // Call __create_descriptor(value, flags) → externref
            const createIdx = ensureLateImport(ctx, "__create_descriptor",
              [{ kind: "externref" }, { kind: "i32" }],
              [{ kind: "externref" }]);
            flushLateImportShifts(ctx, fctx);
            if (createIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: createIdx });
            }
            return { kind: "externref" };
          }
          // Property not found in struct — return undefined
          // (own property doesn't exist on this shape)
          const argResult = compileExpression(ctx, fctx, arg0);
          if (argResult) fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }

      // Fallback: dynamic case — delegate to __getOwnPropertyDescriptor host import
      const objType = compileExpression(ctx, fctx, arg0, { kind: "externref" });
      if (!objType) {
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (objType.kind !== "externref") {
        coerceType(ctx, fctx, objType, { kind: "externref" });
      }
      const propType = compileExpression(ctx, fctx, arg1, { kind: "externref" });
      if (!propType) {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (propType.kind !== "externref") {
        coerceType(ctx, fctx, propType, { kind: "externref" });
      }
      let funcIdx = ensureLateImport(ctx, "__getOwnPropertyDescriptor",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      return { kind: "externref" };
    }

    // ── Reflect API — compile-time rewrites to equivalent operations ──────
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Reflect"
    ) {
      const reflectMethod = propAccess.name.text;

      // Reflect.get(obj, prop) → obj[prop]
      if (reflectMethod === "get" && expr.arguments.length >= 2) {
        const syntheticElemAccess = ts.factory.createElementAccessExpression(
          expr.arguments[0] as ts.Expression,
          expr.arguments[1] as ts.Expression,
        );
        ts.setTextRange(syntheticElemAccess, expr);
        (syntheticElemAccess as any).parent = expr.parent;
        return compileExpression(ctx, fctx, syntheticElemAccess);
      }

      // Reflect.set(obj, prop, val) → (obj[prop] = val, true)
      if (reflectMethod === "set" && expr.arguments.length >= 3) {
        const syntheticElemAccess = ts.factory.createElementAccessExpression(
          expr.arguments[0] as ts.Expression,
          expr.arguments[1] as ts.Expression,
        );
        const syntheticAssign = ts.factory.createBinaryExpression(
          syntheticElemAccess,
          ts.factory.createToken(ts.SyntaxKind.EqualsToken),
          expr.arguments[2] as ts.Expression,
        );
        ts.setTextRange(syntheticAssign, expr);
        (syntheticAssign as any).parent = expr.parent;
        const assignType = compileExpression(ctx, fctx, syntheticAssign);
        if (assignType) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.has(obj, prop) → prop in obj
      if (reflectMethod === "has" && expr.arguments.length >= 2) {
        const syntheticIn = ts.factory.createBinaryExpression(
          expr.arguments[1] as ts.Expression,
          ts.factory.createToken(ts.SyntaxKind.InKeyword),
          expr.arguments[0] as ts.Expression,
        );
        ts.setTextRange(syntheticIn, expr);
        (syntheticIn as any).parent = expr.parent;
        return compileExpression(ctx, fctx, syntheticIn);
      }

      // Reflect.apply(fn, thisArg, args) → fn.apply(thisArg, args)
      if (reflectMethod === "apply" && expr.arguments.length >= 3) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          expr.arguments[0] as ts.Expression as ts.LeftHandSideExpression,
          "apply",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          [
            expr.arguments[1] as ts.Expression,
            expr.arguments[2] as ts.Expression,
          ],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(
          ctx,
          fctx,
          syntheticCall as ts.CallExpression,
        );
      }

      // Reflect.construct(C, args) → new C(...args)
      // For now, only handle array literal args: Reflect.construct(C, [a, b])
      if (reflectMethod === "construct" && expr.arguments.length >= 2) {
        const ctorExpr = expr
          .arguments[0] as ts.Expression as ts.LeftHandSideExpression;
        const argsExpr = expr.arguments[1]!;
        // If args is an array literal, spread it as positional args
        let newArgs: readonly ts.Expression[];
        if (ts.isArrayLiteralExpression(argsExpr)) {
          newArgs = argsExpr.elements;
        } else {
          // Fallback: pass args array as-is (single arg)
          newArgs = [argsExpr as ts.Expression];
        }
        const syntheticNew = ts.factory.createNewExpression(
          ctorExpr,
          undefined,
          newArgs as ts.Expression[],
        );
        ts.setTextRange(syntheticNew, expr);
        (syntheticNew as any).parent = expr.parent;
        return compileExpression(ctx, fctx, syntheticNew);
      }

      // Reflect.ownKeys(obj) → Object.keys(obj)
      if (reflectMethod === "ownKeys" && expr.arguments.length >= 1) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "keys",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          [expr.arguments[0] as ts.Expression],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(
          ctx,
          fctx,
          syntheticCall as ts.CallExpression,
        );
      }

      // Reflect.defineProperty(obj, prop, desc) → (Object.defineProperty(obj, prop, desc), true)
      if (reflectMethod === "defineProperty" && expr.arguments.length >= 3) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "defineProperty",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          Array.from(expr.arguments) as ts.Expression[],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        const resultType = compileCallExpression(
          ctx,
          fctx,
          syntheticCall as ts.CallExpression,
        );
        if (resultType) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.getPrototypeOf(obj) → Object.getPrototypeOf(obj)
      if (reflectMethod === "getPrototypeOf" && expr.arguments.length >= 1) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "getPrototypeOf",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          [expr.arguments[0] as ts.Expression],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(
          ctx,
          fctx,
          syntheticCall as ts.CallExpression,
        );
      }

      // Reflect.setPrototypeOf(obj, proto) → (Object.setPrototypeOf(obj, proto), true)
      if (reflectMethod === "setPrototypeOf" && expr.arguments.length >= 2) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "setPrototypeOf",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          [
            expr.arguments[0] as ts.Expression,
            expr.arguments[1] as ts.Expression,
          ],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        const resultType = compileCallExpression(
          ctx,
          fctx,
          syntheticCall as ts.CallExpression,
        );
        if (resultType) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.deleteProperty(obj, prop) → (delete obj[prop], result as boolean)
      if (reflectMethod === "deleteProperty" && expr.arguments.length >= 2) {
        const syntheticElemAccess = ts.factory.createElementAccessExpression(
          expr.arguments[0] as ts.Expression,
          expr.arguments[1] as ts.Expression,
        );
        const syntheticDelete = ts.factory.createDeleteExpression(
          syntheticElemAccess as ts.UnaryExpression,
        );
        ts.setTextRange(syntheticDelete, expr);
        (syntheticDelete as any).parent = expr.parent;
        return compileExpression(ctx, fctx, syntheticDelete);
      }

      // Reflect.isExtensible(obj) → check compile-time non-extensible state
      if (reflectMethod === "isExtensible" && expr.arguments.length >= 1) {
        const arg0 = expr.arguments[0]!;
        const argType = compileExpression(ctx, fctx, arg0);
        if (argType) fctx.body.push({ op: "drop" });
        let result = 1;
        if (ts.isIdentifier(arg0) && ctx.nonExtensibleVars.has(arg0.text)) {
          result = 0;
        }
        fctx.body.push({ op: "i32.const", value: result });
        return { kind: "i32" };
      }

      // Reflect.preventExtensions(obj) → mark non-extensible, return true
      if (reflectMethod === "preventExtensions" && expr.arguments.length >= 1) {
        const arg0 = expr.arguments[0]!;
        if (ts.isIdentifier(arg0)) {
          ctx.nonExtensibleVars.add(arg0.text);
        }
        const argType = compileExpression(ctx, fctx, arg0);
        if (argType) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.getOwnPropertyDescriptor(obj, prop) → rewrite to Object.getOwnPropertyDescriptor
      if (reflectMethod === "getOwnPropertyDescriptor" && expr.arguments.length >= 2) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "getOwnPropertyDescriptor",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          [expr.arguments[0] as ts.Expression, expr.arguments[1] as ts.Expression],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
      }
    }

    // Handle Promise.all / Promise.race / Promise.resolve / Promise.reject — host-delegated static calls
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Promise" &&
      (propAccess.name.text === "all" ||
        propAccess.name.text === "race" ||
        propAccess.name.text === "resolve" ||
        propAccess.name.text === "reject")
    ) {
      const methodName = propAccess.name.text;
      const importName = `Promise_${methodName}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        if (expr.arguments.length >= 1) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
        } else {
          // Promise.resolve() with no args — pass undefined (ref.null extern)
          fctx.body.push({ op: "ref.null.extern" });
        }
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
      if (
        (method === "stringify" || method === "parse") &&
        expr.arguments.length >= 1
      ) {
        const importName = `JSON_${method}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          // Compile argument and coerce to externref if needed
          const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
          if (argType && argType.kind !== "externref") {
            coerceType(ctx, fctx, argType, { kind: "externref" });
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
    }

    // Handle Date.now() and Date.UTC() — pure Wasm static methods
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Date"
    ) {
      const method = propAccess.name.text;
      if (method === "now") {
        // Date.now() — no clock in pure Wasm, return 0
        fctx.body.push({ op: "f64.const", value: 0 } as Instr);
        return { kind: "f64" };
      }
      if (method === "UTC") {
        // Date.UTC(year, month, day?, hours?, minutes?, seconds?, ms?)
        // Same as new Date(y,m,d,...).getTime() but without the year 0-99 quirk
        const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);
        const args = expr.arguments;

        // year
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 1970 } as Instr);
        }
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        const yearL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: yearL } as Instr);

        // month (0-indexed) + 1
        if (args.length >= 2) {
          compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
          fctx.body.push({ op: "i64.const", value: 1n } as Instr);
          fctx.body.push({ op: "i64.add" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 1n } as Instr);
        }
        const monthL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: monthL } as Instr);

        // day (default 1)
        if (args.length >= 3) {
          compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 1n } as Instr);
        }
        const dayL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: dayL } as Instr);

        // hours (default 0)
        if (args.length >= 4) {
          compileExpression(ctx, fctx, args[3]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const hoursL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: hoursL } as Instr);

        // minutes (default 0)
        if (args.length >= 5) {
          compileExpression(ctx, fctx, args[4]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const minutesL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: minutesL } as Instr);

        // seconds (default 0)
        if (args.length >= 6) {
          compileExpression(ctx, fctx, args[5]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const secondsL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: secondsL } as Instr);

        // ms (default 0)
        if (args.length >= 7) {
          compileExpression(ctx, fctx, args[6]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const msL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: msL } as Instr);

        // days_from_civil(year, month, day) * 86400000 + h*3600000 + m*60000 + s*1000 + ms
        fctx.body.push(
          { op: "local.get", index: yearL } as Instr,
          { op: "local.get", index: monthL } as Instr,
          { op: "local.get", index: dayL } as Instr,
          { op: "call", funcIdx: daysFromCivilIdx } as Instr,
          { op: "i64.const", value: 86400000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "local.get", index: hoursL } as Instr,
          { op: "i64.const", value: 3600000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "i64.add" } as Instr,
          { op: "local.get", index: minutesL } as Instr,
          { op: "i64.const", value: 60000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "i64.add" } as Instr,
          { op: "local.get", index: secondsL } as Instr,
          { op: "i64.const", value: 1000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "i64.add" } as Instr,
          { op: "local.get", index: msL } as Instr,
          { op: "i64.add" } as Instr,
          { op: "f64.convert_i64_s" } as Instr,
        );

        releaseTempLocal(fctx, msL);
        releaseTempLocal(fctx, secondsL);
        releaseTempLocal(fctx, minutesL);
        releaseTempLocal(fctx, hoursL);
        releaseTempLocal(fctx, dayL);
        releaseTempLocal(fctx, monthL);
        releaseTempLocal(fctx, yearL);

        return { kind: "f64" };
      }
      // Date.parse — stub: return NaN
      if (method === "parse") {
        // Drop argument if any
        for (const arg of expr.arguments) {
          const t = compileExpression(ctx, fctx, arg);
          if (t) fctx.body.push({ op: "drop" } as Instr);
        }
        fctx.body.push({ op: "f64.const", value: NaN } as Instr);
        return { kind: "f64" };
      }
    }

    // Check if this is a static method call: ClassName.staticMethod(args)
    if (
      ts.isIdentifier(propAccess.expression) &&
      ctx.classSet.has(propAccess.expression.text)
    ) {
      const clsName = propAccess.expression.text;
      const methodName = propAccess.name.text;
      const fullName = `${clsName}_${methodName}`;
      if (ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          // No self parameter for static methods
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const staticParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < staticParamCount) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null && extraType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          // Pad missing arguments with defaults
          if (paramTypes) {
            for (let i = expr.arguments.length; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          // Re-lookup funcIdx: argument compilation may trigger addUnionImports
          const finalStaticIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalStaticIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName))
              return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalStaticIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalStaticIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }
    }

    // Check if receiver is an externref object
    const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);

    // Handle Date instance method calls BEFORE extern class dispatch,
    // because Date is declared in lib.d.ts (so isExternalDeclaredClass returns true)
    // but we implement it natively as a WasmGC struct.
    {
      const dateResult = compileDateMethodCall(
        ctx,
        fctx,
        propAccess,
        expr,
        receiverType,
      );
      if (dateResult !== undefined) return dateResult;
    }

    if (isExternalDeclaredClass(receiverType, ctx.checker)) {
      return compileExternMethodCall(ctx, fctx, propAccess, expr);
    }

    // Property introspection: hasOwnProperty / propertyIsEnumerable
    if (
      propAccess.name.text === "hasOwnProperty" ||
      propAccess.name.text === "propertyIsEnumerable"
    ) {
      return compilePropertyIntrospection(ctx, fctx, propAccess, expr);
    }

    // Generator method calls: gen.next(), gen.return(value), gen.throw(error)
    if (isGeneratorType(receiverType)) {
      const methodName = propAccess.name.text;
      if (methodName === "next") {
        compileExpression(ctx, fctx, propAccess.expression);
        const funcIdx = ctx.funcMap.get("__gen_next");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      } else if (methodName === "return") {
        compileExpression(ctx, fctx, propAccess.expression);
        // Push the argument (value to return), default to ref.null if none
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const funcIdx = ctx.funcMap.get("__gen_return");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      } else if (methodName === "throw") {
        compileExpression(ctx, fctx, propAccess.expression);
        // Push the argument (error to throw), default to ref.null if none
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const funcIdx = ctx.funcMap.get("__gen_throw");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      }
    }

    // Handle Promise instance methods: .then(cb1, cb2?), .catch(cb)
    // Promise values are externref; delegate to host imports
    {
      const method = propAccess.name.text;
      if (
        (method === "then" || method === "catch") &&
        expr.arguments.length >= 1
      ) {
        const importName = `Promise_${method}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          // Compile the Promise value (receiver)
          compileExpression(ctx, fctx, propAccess.expression, {
            kind: "externref",
          });
          // Compile the first callback argument, coercing to externref
          const cbType = compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
          if (cbType && cbType.kind !== "externref") {
            coerceType(ctx, fctx, cbType, { kind: "externref" });
          }
          // For .then(): push second callback (onRejected) or null
          if (method === "then") {
            if (expr.arguments.length >= 2) {
              const cb2Type = compileExpression(ctx, fctx, expr.arguments[1]!, {
                kind: "externref",
              });
              if (cb2Type && cb2Type.kind !== "externref") {
                coerceType(ctx, fctx, cb2Type, { kind: "externref" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          }
          // Re-lookup funcIdx after compiling args (addUnionImports may shift)
          const finalIdx = ctx.funcMap.get(importName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalIdx });
          return { kind: "externref" };
        }
      }
    }

    // Handle wrapper type method calls: new Number(x).valueOf(), etc.
    // Since wrapper constructors now return primitives, valueOf() is a no-op identity.
    {
      const wrapperMethodName = propAccess.name.text;
      const recvSymName = receiverType.getSymbol()?.name;
      if (recvSymName === "Number" && wrapperMethodName === "valueOf") {
        compileExpression(ctx, fctx, propAccess.expression, { kind: "f64" });
        return { kind: "f64" };
      }
      if (recvSymName === "String" && wrapperMethodName === "valueOf") {
        const strType = ctx.nativeStrings
          ? nativeStringType(ctx)
          : ({ kind: "externref" } as ValType);
        compileExpression(ctx, fctx, propAccess.expression, strType);
        return strType;
      }
      if (recvSymName === "Boolean" && wrapperMethodName === "valueOf") {
        compileExpression(ctx, fctx, propAccess.expression, { kind: "i32" });
        return { kind: "i32" };
      }
    }

    // Check if receiver is a local class instance
    let receiverClassName = receiverType.getSymbol()?.name;
    // Map class expression symbol names to their synthetic names
    if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
      receiverClassName =
        ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
    }
    // Fallback for union types, interfaces, abstract classes:
    // When the direct symbol name is not a known class, try to resolve via
    // union members, apparent type, or base types.
    if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
      const methodName = ts.isPrivateIdentifier(propAccess.name)
        ? "__priv_" + propAccess.name.text.slice(1)
        : propAccess.name.text;
      // Try union type members: for `A | B`, check each member for a known class
      if (receiverType.isUnion()) {
        for (const memberType of (receiverType as ts.UnionType).types) {
          let memberName = memberType.getSymbol()?.name;
          if (memberName && !ctx.classSet.has(memberName)) {
            memberName = ctx.classExprNameMap.get(memberName) ?? memberName;
          }
          if (memberName && ctx.classSet.has(memberName)) {
            const fullName = `${memberName}_${methodName}`;
            if (ctx.funcMap.has(fullName)) {
              receiverClassName = memberName;
              break;
            }
            // Walk inheritance chain
            let ancestor = ctx.classParentMap.get(memberName);
            while (ancestor) {
              if (ctx.funcMap.has(`${ancestor}_${methodName}`)) {
                receiverClassName = memberName;
                break;
              }
              ancestor = ctx.classParentMap.get(ancestor);
            }
            if (receiverClassName && ctx.classSet.has(receiverClassName)) break;
          }
        }
      }
      // Try apparent type (handles interfaces, abstract classes)
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const apparentType = ctx.checker.getApparentType(receiverType);
        if (apparentType !== receiverType) {
          let apparentName = apparentType.getSymbol()?.name;
          if (apparentName && !ctx.classSet.has(apparentName)) {
            apparentName =
              ctx.classExprNameMap.get(apparentName) ?? apparentName;
          }
          if (
            apparentName &&
            ctx.classSet.has(apparentName) &&
            ctx.funcMap.has(`${apparentName}_${methodName}`)
          ) {
            receiverClassName = apparentName;
          }
        }
      }
      // Try base types: if the receiver type has base types (e.g. abstract class → concrete class)
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const baseTypes = receiverType.getBaseTypes?.();
        if (baseTypes) {
          for (const baseType of baseTypes) {
            let baseName = baseType.getSymbol()?.name;
            if (baseName && !ctx.classSet.has(baseName)) {
              baseName = ctx.classExprNameMap.get(baseName) ?? baseName;
            }
            if (
              baseName &&
              ctx.classSet.has(baseName) &&
              ctx.funcMap.has(`${baseName}_${methodName}`)
            ) {
              receiverClassName = baseName;
              break;
            }
          }
        }
      }
      // Try struct name from the receiver's wasm type
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const structName = resolveStructName(ctx, receiverType);
        if (
          structName &&
          ctx.classSet.has(structName) &&
          ctx.funcMap.has(`${structName}_${methodName}`)
        ) {
          receiverClassName = structName;
        }
      }
      // Final fallback: scan all known classes for one that has the method.
      // This handles interface types and abstract classes where we can't determine
      // the implementing class from the type alone. We pick the first class that
      // has the method and whose struct fields are a superset of the receiver type's properties.
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const recvProps = receiverType.getProperties?.() ?? [];
        const recvPropNames = new Set(recvProps.map((p) => p.name));
        for (const className of ctx.classSet) {
          if (!ctx.funcMap.has(`${className}_${methodName}`)) continue;
          // Quick heuristic: check that the class has at least the same property names
          // as the interface (structural compatibility check)
          const classFields = ctx.structFields.get(className);
          if (classFields && recvPropNames.size > 0) {
            const classFieldNames = new Set(classFields.map((f) => f.name));
            let compatible = true;
            for (const prop of recvPropNames) {
              // Methods won't be in struct fields, so skip function-typed properties
              const propSymbol = recvProps.find((p) => p.name === prop);
              const propType = propSymbol
                ? ctx.checker.getTypeOfSymbol(propSymbol)
                : undefined;
              const isMethod =
                propType && (propType.getCallSignatures?.()?.length ?? 0) > 0;
              if (!isMethod && !classFieldNames.has(prop)) {
                compatible = false;
                break;
              }
            }
            if (!compatible) continue;
          }
          receiverClassName = className;
          break;
        }
      }
    }
    if (receiverClassName && ctx.classSet.has(receiverClassName)) {
      const methodName = ts.isPrivateIdentifier(propAccess.name)
        ? "__priv_" + propAccess.name.text.slice(1)
        : propAccess.name.text;
      let fullName = `${receiverClassName}_${methodName}`;
      let funcIdx = ctx.funcMap.get(fullName);
      // Walk inheritance chain to find the method in a parent class
      if (funcIdx === undefined) {
        let ancestor = ctx.classParentMap.get(receiverClassName);
        while (ancestor && funcIdx === undefined) {
          fullName = `${ancestor}_${methodName}`;
          funcIdx = ctx.funcMap.get(fullName);
          ancestor = ctx.classParentMap.get(ancestor);
        }
      }
      // Walk child classes (handles abstract class → concrete subclass)
      if (funcIdx === undefined) {
        for (const [childClass, parentClass] of ctx.classParentMap) {
          if (
            parentClass === receiverClassName ||
            parentClass === fullName.split("_")[0]
          ) {
            const childFullName = `${childClass}_${methodName}`;
            const childFuncIdx = ctx.funcMap.get(childFullName);
            if (childFuncIdx !== undefined) {
              fullName = childFullName;
              funcIdx = childFuncIdx;
              break;
            }
          }
        }
      }
      // If no method found, check if the property is a callable struct field
      // (e.g. this.callback() where callback is a function-typed property)
      if (funcIdx === undefined) {
        const callablePropResult = compileCallablePropertyCall(
          ctx,
          fctx,
          expr,
          propAccess,
          receiverClassName,
        );
        if (callablePropResult !== undefined) return callablePropResult;
      }
      if (funcIdx !== undefined) {
        const isStaticMethod = ctx.staticMethodSet.has(fullName);
        // Static methods: evaluate receiver for side effects, drop, call directly
        if (isStaticMethod) {
          const recvType = compileExpression(ctx, fctx, propAccess.expression);
          if (recvType !== null && recvType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const paramCount = paramTypes ? paramTypes.length : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < paramCount) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null && extraType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          if (paramTypes) {
            for (let i = expr.arguments.length; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          const finalMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalMethodIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
        // Push self (the receiver) as first argument, with type hint from method's first param
        const methodParamTypes0 = getFuncParamTypes(ctx, funcIdx);
        let recvType = compileExpression(ctx, fctx, propAccess.expression, methodParamTypes0?.[0]);
        // Track whether receiver went through emitGuardedRefCast — if so, null
        // means "wrong struct type" (not genuinely null), so we should NOT throw
        // TypeError on null after cast.
        let receiverWasCast = false;
        // If receiver is externref but the method expects a struct ref, coerce
        if (recvType && recvType.kind === "externref") {
          const structTypeIdx = ctx.structMap.get(receiverClassName);
          if (structTypeIdx !== undefined) {
            // Check for null BEFORE the guarded cast — only genuine null should throw TypeError
            emitNullCheckThrow(ctx, fctx, { kind: "externref" });
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            emitGuardedRefCast(fctx, structTypeIdx);
            recvType = { kind: "ref_null", typeIdx: structTypeIdx };
            receiverWasCast = true;
          }
        }
        // Null-guard: if receiver is ref_null, check for null before calling method
        if (recvType && recvType.kind === "ref_null") {
          // Determine return type early so we can build null-guard
          const sig = ctx.checker.getResolvedSignature(expr);
          let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (!isEffectivelyVoidReturn(ctx, retType, fullName))
              callReturnType = getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
          }
          const tmp = allocLocal(
            fctx,
            `__ng_recv_${fctx.locals.length}`,
            recvType,
          );
          fctx.body.push({ op: "local.tee", index: tmp });
          fctx.body.push({ op: "ref.is_null" });

          // Build the else branch (non-null path) with the full call
          const savedBody = pushBody(fctx);
          fctx.body.push({ op: "local.get", index: tmp });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          // Coerce receiver (self param) if ref type doesn't match function's first param
          if (paramTypes?.[0]) {
            const recvRefType: ValType = { kind: "ref", typeIdx: (recvType as any).typeIdx };
            if (!valTypesMatch(recvRefType, paramTypes[0])) {
              coerceType(ctx, fctx, recvRefType, paramTypes[0]);
            }
          }
          // User-visible param count excludes self (param 0)
          const ngParamCount = paramTypes
            ? paramTypes.length - 1
            : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < ngParamCount) {
              compileExpression(
                ctx,
                fctx,
                expr.arguments[i]!,
                paramTypes?.[i + 1],
              );
            } else {
              // Extra argument beyond method's parameter count — evaluate for
              // side effects (JS semantics) and discard the result
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null && extraType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          if (paramTypes) {
            for (
              let i = expr.arguments.length + 1;
              i < paramTypes.length;
              i++
            ) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          const finalMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
          const elseInstrs = fctx.body;
          fctx.body = savedBody;

          if (callReturnType === VOID_RESULT) {
            // Void method: if null after cast, skip (wrong type); if genuinely null, throw TypeError
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: receiverWasCast ? ([] as Instr[]) : typeErrorThrowInstrs(ctx),
              else: elseInstrs,
            });
            return VOID_RESULT;
          } else {
            const resultType: ValType =
              callReturnType.kind === "ref"
                ? { kind: "ref_null", typeIdx: (callReturnType as any).typeIdx }
                : callReturnType;
            // throw is divergent, so the then branch is valid without producing a value
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: resultType },
              then: receiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
              else: elseInstrs,
            });
            return resultType;
          }
        }
        // Non-nullable receiver: emit call directly
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        // User-visible param count excludes self (param 0)
        const methodParamCount = paramTypes
          ? paramTypes.length - 1
          : expr.arguments.length;
        for (let i = 0; i < expr.arguments.length; i++) {
          if (i < methodParamCount) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
          } else {
            // Extra argument beyond method's parameter count — evaluate for
            // side effects (JS semantics) and discard the result
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null && extraType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
        // Pad missing arguments with defaults (skip self param at index 0)
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!);
          }
        }
        // Re-lookup funcIdx: argument compilation may trigger addUnionImports
        const finalMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
        fctx.body.push({ op: "call", funcIdx: finalMethodIdx });

        // Determine return type
        const sig = ctx.checker.getResolvedSignature(expr);
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (isEffectivelyVoidReturn(ctx, retType, fullName))
            return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
          return getWasmFuncReturnType(ctx, finalMethodIdx) ?? resolveWasmType(ctx, retType);
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
        // If no method found, check callable property on struct
        if (funcIdx === undefined) {
          const callablePropResult = compileCallablePropertyCall(
            ctx,
            fctx,
            expr,
            propAccess,
            structTypeName,
          );
          if (callablePropResult !== undefined) return callablePropResult;
        }
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument, with type hint from method's first param
          const structMethodPTypes = getFuncParamTypes(ctx, funcIdx);
          const recvType = compileExpression(ctx, fctx, propAccess.expression, structMethodPTypes?.[0]);
          // Module globals produce ref_null but method params expect ref — null-guard
          if (recvType && recvType.kind === "ref_null") {
            const sig = ctx.checker.getResolvedSignature(expr);
            let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (!isEffectivelyVoidReturn(ctx, retType, fullName))
                callReturnType = getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
            }
            const tmp = allocLocal(
              fctx,
              `__ng_srecv_${fctx.locals.length}`,
              recvType,
            );
            fctx.body.push({ op: "local.tee", index: tmp });
            fctx.body.push({ op: "ref.is_null" });

            const savedBody = pushBody(fctx);
            fctx.body.push({ op: "local.get", index: tmp });
            fctx.body.push({ op: "ref.as_non_null" } as Instr);
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            // Coerce receiver (self param) if ref type doesn't match function's first param
            if (paramTypes?.[0]) {
              const recvRefType: ValType = { kind: "ref", typeIdx: (recvType as any).typeIdx };
              if (!valTypesMatch(recvRefType, paramTypes[0])) {
                coerceType(ctx, fctx, recvRefType, paramTypes[0]);
              }
            }
            const smMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
            for (let i = 0; i < expr.arguments.length; i++) {
              if (i < smMethodParamCount) {
                compileExpression(
                  ctx,
                  fctx,
                  expr.arguments[i]!,
                  paramTypes?.[i + 1],
                );
              } else {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null && extraType !== VOID_RESULT) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            if (paramTypes) {
              for (
                let i = Math.min(expr.arguments.length, smMethodParamCount) + 1;
                i < paramTypes.length;
                i++
              ) {
                pushDefaultValue(fctx, paramTypes[i]!);
              }
            }
            const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });
            const elseInstrs = fctx.body;
            fctx.body = savedBody;

            if (callReturnType === VOID_RESULT) {
              // Void method: if genuinely null, throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return VOID_RESULT;
            } else {
              const resultType: ValType =
                callReturnType.kind === "ref"
                  ? {
                      kind: "ref_null",
                      typeIdx: (callReturnType as any).typeIdx,
                    }
                  : callReturnType;
              // throw is divergent, valid without producing a value (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: resultType },
                then: typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return resultType;
            }
          }
          // Non-nullable receiver
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const nnMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < nnMethodParamCount) {
              compileExpression(
                ctx,
                fctx,
                expr.arguments[i]!,
                paramTypes?.[i + 1],
              ); // +1 to skip self
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null && extraType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          // Pad missing arguments with defaults (skip self param at index 0)
          if (paramTypes) {
            for (
              let i = Math.min(expr.arguments.length, nnMethodParamCount) + 1;
              i < paramTypes.length;
              i++
            ) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          // Re-lookup funcIdx: argument compilation may trigger addUnionImports
          const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName))
              return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalStructMethodIdx))
              return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalStructMethodIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }
    }

    // Array method calls
    {
      const arrMethodResult = compileArrayMethodCall(
        ctx,
        fctx,
        propAccess,
        expr,
        receiverType,
      );
      if (arrMethodResult !== undefined) return arrMethodResult;
    }

    // Primitive method calls: number.toString(), number.toFixed()
    if (isNumberType(receiverType) && propAccess.name.text === "toString") {
      // RangeError: if radix argument is provided, must be integer 2-36
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        // Floor the radix (ToInteger semantics: NaN→0, 2.5→2, etc.)
        fctx.body.push({ op: "f64.floor" } as unknown as Instr);
        const radixLocal = allocLocal(fctx, `__radix_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: radixLocal });
        // Check radix < 2 (also catches NaN since NaN < 2 after floor(NaN)=NaN is still false)
        fctx.body.push({ op: "f64.const", value: 2 });
        fctx.body.push({ op: "f64.lt" });
        // Check radix > 36
        fctx.body.push({ op: "local.get", index: radixLocal });
        fctx.body.push({ op: "f64.const", value: 36 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        // Check radix is NaN (NaN != NaN)
        fctx.body.push({ op: "local.get", index: radixLocal });
        fctx.body.push({ op: "local.get", index: radixLocal });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: strIdx } as Instr,
              { op: "throw", tagIdx } as Instr,
            ],
            else: [],
          });
        }
        fctx.body.push({ op: "drop" }); // drop radix, toString still uses base-10
      }
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
        // RangeError: fractionDigits must be 0-100
        const digitsLocal = allocLocal(fctx, `__toFixed_digits_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: digitsLocal });
        // Check digits < 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check digits > 100
        fctx.body.push({ op: "local.get", index: digitsLocal });
        fctx.body.push({ op: "f64.const", value: 100 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: toFixed() digits argument must be between 0 and 100";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: strIdx } as Instr,
              { op: "throw", tagIdx } as Instr,
            ],
            else: [],
          });
        }
        fctx.body.push({ op: "local.get", index: digitsLocal });
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      const funcIdx = ctx.funcMap.get("number_toFixed");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    // number.toPrecision(precision)
    if (isNumberType(receiverType) && propAccess.name.text === "toPrecision") {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
        // RangeError: precision must be 1-100 (NaN → 0 → invalid since 0 < 1)
        const precLocal = allocLocal(fctx, `__toPrecision_prec_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: precLocal });
        fctx.body.push({ op: "f64.const", value: 1 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: precLocal });
        fctx.body.push({ op: "f64.const", value: 100 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        // NaN check: NaN != NaN
        fctx.body.push({ op: "local.get", index: precLocal });
        fctx.body.push({ op: "local.get", index: precLocal });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: toPrecision() argument must be between 1 and 100";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: strIdx } as Instr,
              { op: "throw", tagIdx } as Instr,
            ],
            else: [],
          });
        }
        fctx.body.push({ op: "local.get", index: precLocal });
      } else {
        // No argument → same as number.toString()
        const funcIdx = ctx.funcMap.get("number_toString");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
      const funcIdx = ctx.funcMap.get("number_toPrecision");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    // number.toExponential(fractionDigits)
    if (isNumberType(receiverType) && propAccess.name.text === "toExponential") {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
        // RangeError: fractionDigits must be 0-100
        const digitsLocal = allocLocal(fctx, `__toExponential_digits_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: digitsLocal });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: digitsLocal });
        fctx.body.push({ op: "f64.const", value: 100 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: toExponential() argument must be between 0 and 100";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: strIdx } as Instr,
              { op: "throw", tagIdx } as Instr,
            ],
            else: [],
          });
        }
        fctx.body.push({ op: "local.get", index: digitsLocal });
      } else {
        // No argument → pass NaN as sentinel for "no argument provided"
        fctx.body.push({ op: "f64.const", value: NaN });
      }
      const funcIdx = ctx.funcMap.get("number_toExponential");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // String method calls
    if (isStringType(receiverType)) {
      const method = propAccess.name.text;

      // string.toString() and string.valueOf() — identity, just return the string itself
      if (method === "toString" || method === "valueOf") {
        return compileExpression(ctx, fctx, propAccess.expression);
      }

      // Fast mode: native string method dispatch
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        return compileNativeStringMethodCall(
          ctx,
          fctx,
          expr,
          propAccess,
          method,
        );
      }

      // charCodeAt: uses wasm:js-string charCodeAt import (not string_charCodeAt)
      if (method === "charCodeAt") {
        const charCodeAtIdx = ctx.funcMap.get("charCodeAt");
        if (charCodeAtIdx !== undefined) {
          compileExpression(ctx, fctx, propAccess.expression);
          if (expr.arguments.length > 0) {
            const argType = compileExpression(ctx, fctx, expr.arguments[0]!, {
              kind: "f64",
            });
            if (!argType || argType === VOID_RESULT) {
              fctx.body.push({ op: "i32.const", value: 0 });
            } else if (argType.kind === "f64") {
              fctx.body.push({ op: "i32.trunc_sat_f64_s" });
            }
          } else {
            fctx.body.push({ op: "i32.const", value: 0 });
          }
          fctx.body.push({ op: "call", funcIdx: charCodeAtIdx });
          return { kind: "i32" };
        }
      }

      const importName = `string_${method}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        compileExpression(ctx, fctx, propAccess.expression);
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const args = expr.arguments;
        // Cap at declared param count (excluding self) to avoid pushing extra values
        const userParamCount = paramTypes ? paramTypes.length - 1 : args.length;
        for (let ai = 0; ai < args.length; ai++) {
          if (ai < userParamCount) {
            const expectedArgType = paramTypes?.[ai + 1]; // +1 for self param
            const argResult = compileExpression(
              ctx,
              fctx,
              args[ai]!,
              expectedArgType,
            );
            if (!argResult || argResult === VOID_RESULT) {
              // void/null result — push a default value for the expected type
              pushDefaultValue(fctx, expectedArgType ?? { kind: "f64" });
            } else if (
              expectedArgType &&
              argResult.kind !== expectedArgType.kind
            ) {
              coerceType(ctx, fctx, argResult, expectedArgType);
            }
          } else {
            // Extra argument beyond function's parameter count — evaluate for
            // side effects and drop the result
            const extraType = compileExpression(ctx, fctx, args[ai]!);
            if (extraType !== null && extraType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
        // Pad missing optional args with defaults (e.g. indexOf 2nd arg)
        if (paramTypes && args.length + 1 < paramTypes.length) {
          for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
            const pt = paramTypes[pi]!;
            if (pt.kind === "externref")
              fctx.body.push({ op: "ref.null.extern" });
            else if (pt.kind === "f64")
              fctx.body.push({ op: "f64.const", value: 0 });
            else if (pt.kind === "i32")
              fctx.body.push({ op: "i32.const", value: 0 });
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        const returnsBool =
          method === "includes" ||
          method === "startsWith" ||
          method === "endsWith";
        const returnsNum =
          method === "indexOf" ||
          method === "lastIndexOf" ||
          method === "codePointAt" ||
          method === "search";
        return returnsBool
          ? { kind: "i32" }
          : returnsNum
            ? { kind: "f64" }
            : { kind: "externref" };
      }
    }

    // Boolean method calls: bool.toString(), bool.valueOf()
    if (isBooleanType(receiverType)) {
      const method = propAccess.name.text;
      if (method === "toString") {
        compileExpression(ctx, fctx, propAccess.expression);
        emitBoolToString(ctx, fctx);
        return { kind: "externref" };
      }
      if (method === "valueOf") {
        // Boolean.valueOf() returns the boolean primitive — just compile the expression
        return compileExpression(ctx, fctx, propAccess.expression);
      }
    }

    // number.valueOf() — return the number itself
    if (isNumberType(receiverType) && propAccess.name.text === "valueOf") {
      return compileExpression(ctx, fctx, propAccess.expression);
    }

    // Fallback .toString() for any type not already handled above
    // Handles: function.toString(), object.toString(), array.toString(), class instance.toString()
    if (propAccess.name.text === "toString" && expr.arguments.length === 0) {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      // For arrays, emit "[object Array]"; for everything else, "[object Object]"
      const tsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const wasm = resolveWasmType(ctx, tsType);
      // Check if it's an array type (ref to vec struct)
      let isArray = false;
      if (wasm.kind === "ref" || wasm.kind === "ref_null") {
        const arrInfo = resolveArrayInfo(ctx, tsType);
        if (arrInfo) isArray = true;
      }
      // Check if this is a function type (has call signatures, is not a class/interface)
      const callSigs = tsType.getCallSignatures?.();
      const isFunc =
        callSigs && callSigs.length > 0 && !tsType.getProperties?.()?.length;

      if (isFunc) {
        addStringConstantGlobal(ctx, "function () { [native code] }");
        const idx = ctx.stringGlobalMap.get("function () { [native code] }")!;
        fctx.body.push({ op: "global.get", index: idx });
      } else {
        const str = isArray ? "[object Array]" : "[object Object]";
        addStringConstantGlobal(ctx, str);
        const idx = ctx.stringGlobalMap.get(str)!;
        fctx.body.push({ op: "global.get", index: idx });
      }
      return { kind: "externref" };
    }

    // Fallback .valueOf() for any type not already handled above
    // valueOf() on non-primitive types typically returns the object itself
    if (propAccess.name.text === "valueOf" && expr.arguments.length === 0) {
      return compileExpression(ctx, fctx, propAccess.expression);
    }

    // Fallback for method calls on any-typed / externref / unresolvable receivers.
    // This handles patterns like: ref(args).next(), anyObj.someMethod(), etc.
    // Common in test262 where variables are typed as `any` or inferred as `any`.
    {
      const recvTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const recvWasm = resolveWasmType(ctx, recvTsType);
      const isAnyOrExternref =
        (recvTsType.flags & ts.TypeFlags.Any) !== 0 ||
        recvWasm.kind === "externref";

      if (isAnyOrExternref) {
        const methodName = propAccess.name.text;

        // Generator protocol: .next(), .return(value), .throw(error) on any/externref
        // These are very common in test262 generator tests where variables are typed as `any`.
        if (methodName === "next") {
          const genNextIdx = ctx.funcMap.get("__gen_next");
          if (genNextIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            // Drop any arguments (generator .next() with args not yet supported)
            for (const arg of expr.arguments) {
              const argType = compileExpression(ctx, fctx, arg);
              if (argType && argType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
            fctx.body.push({ op: "call", funcIdx: genNextIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "return") {
          const genReturnIdx = ctx.funcMap.get("__gen_return");
          if (genReturnIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            if (expr.arguments.length > 0) {
              compileExpression(ctx, fctx, expr.arguments[0]!, {
                kind: "externref",
              });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "call", funcIdx: genReturnIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "throw") {
          const genThrowIdx = ctx.funcMap.get("__gen_throw");
          if (genThrowIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            if (expr.arguments.length > 0) {
              compileExpression(ctx, fctx, expr.arguments[0]!, {
                kind: "externref",
              });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "call", funcIdx: genThrowIdx });
            return { kind: "externref" };
          }
        }

        // General fallback for any method call on any/externref receiver:
        // compile the receiver and all arguments for side effects, then throw
        // TypeError (calling a non-function). This matches JS semantics where
        // accessing an unknown property returns undefined and calling it throws.
        {
          const recvType = compileExpression(ctx, fctx, propAccess.expression);
          if (recvType && recvType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
          for (const arg of expr.arguments) {
            const argType = compileExpression(ctx, fctx, arg);
            if (argType && argType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }
          // Unresolvable method call — return externref null as fallback.
          // Don't throw TypeError: many built-in/prototype methods can't be
          // resolved at compile time but work fine at runtime via host imports.
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
    }
  }

  // Handle global isNaN(n) / isFinite(n) — inline wasm
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;

    if (funcName === "isNaN" && expr.arguments.length >= 1) {
      // isNaN(n) → n !== n
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isnan_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.ne" } as Instr);
      return { kind: "i32" };
    }

    if (funcName === "isFinite" && expr.arguments.length >= 1) {
      // isFinite(n) → n - n === 0.0  (Infinity - Infinity = NaN, NaN - NaN = NaN, finite - finite = 0)
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isfin_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.sub" } as Instr);
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" } as Instr);
      return { kind: "i32" };
    }

    // parseInt(s, radix?) and parseFloat(s) — host imports
    if (
      (funcName === "parseInt" || funcName === "parseFloat") &&
      expr.arguments.length >= 1
    ) {
      const importFuncIdx = ctx.funcMap.get(funcName);
      if (importFuncIdx !== undefined) {
        const arg0 = expr.arguments[0]!;
        const arg0Type = compileExpression(ctx, fctx, arg0);
        // Coerce to externref, preserving boolean identity (not boxing as number)
        if (arg0Type && arg0Type.kind !== "externref") {
          if (
            arg0Type.kind === "i32" &&
            (arg0.kind === ts.SyntaxKind.TrueKeyword ||
              arg0.kind === ts.SyntaxKind.FalseKeyword)
          ) {
            // Boolean literal: box as boolean so String(true) → "true"
            addUnionImports(ctx);
            const boxIdx = ctx.funcMap.get("__box_boolean");
            if (boxIdx !== undefined)
              fctx.body.push({ op: "call", funcIdx: boxIdx });
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
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
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
      fctx.body.push({
        op: ctx.fast ? "i32.const" : "f64.const",
        value: 0,
      } as Instr);
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }

    // Symbol() / Symbol('description') — create unique i32 symbol ID
    if (funcName === "Symbol") {
      return compileSymbolCall(ctx, fctx, expr.arguments);
    }

    // String(x) — ToString coercion
    if (funcName === "String") {
      if (expr.arguments.length === 0) {
        // String() with no args → ""
        addStringConstantGlobal(ctx, "");
        const emptyIdx = ctx.stringGlobalMap.get("")!;
        fctx.body.push({ op: "global.get", index: emptyIdx });
        return { kind: "externref" };
      }

      // Check if argument is a null/undefined literal before compiling
      const strArg0 = expr.arguments[0]!;
      const strArg0IsNull = strArg0.kind === ts.SyntaxKind.NullKeyword;
      const strArg0IsUndefined =
        strArg0.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(strArg0) && strArg0.text === "undefined") ||
        ts.isVoidExpression(strArg0);

      if (strArg0IsNull) {
        // String(null) → "null"
        addStringConstantGlobal(ctx, "null");
        const nullGIdx = ctx.stringGlobalMap.get("null")!;
        fctx.body.push({ op: "global.get", index: nullGIdx });
        return { kind: "externref" };
      }

      if (strArg0IsUndefined) {
        // String(undefined) → "undefined"
        addStringConstantGlobal(ctx, "undefined");
        const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
        fctx.body.push({ op: "global.get", index: undefGIdx });
        return { kind: "externref" };
      }

      const argType = compileExpression(ctx, fctx, strArg0);

      if (argType === VOID_RESULT || argType === null) {
        // String(void-expr) → "undefined"
        addStringConstantGlobal(ctx, "undefined");
        const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
        fctx.body.push({ op: "global.get", index: undefGIdx });
        return { kind: "externref" };
      }

      if (argType?.kind === "i32") {
        // Check if it's a boolean type → "true"/"false"
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (isBooleanType(argTsType)) {
          emitBoolToString(ctx, fctx);
          return { kind: "externref" };
        }
        // number (i32) → string via f64 conversion
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }

      if (argType?.kind === "f64") {
        // number → string
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }

      if (argType?.kind === "externref") {
        // Check TS type to determine what this externref actually is
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (argTsType.flags & ts.TypeFlags.Null) {
          // Drop the ref.null.extern, push "null" constant
          fctx.body.push({ op: "drop" });
          addStringConstantGlobal(ctx, "null");
          const nullGIdx = ctx.stringGlobalMap.get("null")!;
          fctx.body.push({ op: "global.get", index: nullGIdx });
          return { kind: "externref" };
        }
        if (argTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
          fctx.body.push({ op: "drop" });
          addStringConstantGlobal(ctx, "undefined");
          const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
          fctx.body.push({ op: "global.get", index: undefGIdx });
          return { kind: "externref" };
        }
        if (isStringType(argTsType)) {
          // Already a string — return as-is
          return { kind: "externref" };
        }
        // Other externref — try extern_toString if available
        const toStrIdx = ctx.funcMap.get("extern_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
        }
        return { kind: "externref" };
      }

      if (
        (argType?.kind === "ref" || argType?.kind === "ref_null") &&
        ctx.fast
      ) {
        // Check if it's a native string type
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (isStringType(argTsType)) {
          // Already a native string — return as-is
          return argType;
        }
        // Object ref → "[object Object]"
        fctx.body.push({ op: "drop" });
        addStringConstantGlobal(ctx, "[object Object]");
        const objGIdx = ctx.stringGlobalMap.get("[object Object]")!;
        fctx.body.push({ op: "global.get", index: objGIdx });
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
      // void / undefined → always false
      if (argType === VOID_RESULT || argType === null) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      if (argType?.kind === "f64") {
        // f64: truthy if != 0 and != NaN
        const tmp = allocLocal(fctx, `__bool_${fctx.locals.length}`, {
          kind: "f64",
        });
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
      // String: truthy if length > 0
      if (
        (argType?.kind === "ref" || argType?.kind === "ref_null") &&
        ctx.nativeStrings &&
        ctx.anyStrTypeIdx >= 0 &&
        isStringType(ctx.checker.getTypeAtLocation(expr.arguments[0]!))
      ) {
        // Get length (field 0 of $AnyString) and check != 0
        fctx.body.push({
          op: "struct.get",
          typeIdx: ctx.anyStrTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ne" } as Instr);
        return { kind: "i32" };
      }
      if (argType?.kind === "externref") {
        // Check if this is a string type — use string length > 0 for truthiness
        const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
        if (isStringType(argTsType)) {
          addStringImports(ctx);
          const lenIdx = ctx.funcMap.get("length");
          if (lenIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: lenIdx });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "i32.ne" } as Instr);
            return { kind: "i32" };
          }
        }
        // externref: truthy if non-null (and not "" or 0 — but we can't check that without host)
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.xor" } as Instr);
        return { kind: "i32" };
      }
      // Ref types (objects, arrays): always truthy — drop the ref, push 1
      if (argType?.kind === "ref" || argType?.kind === "ref_null") {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
      // fallback: treat as truthy (non-null ref)
      return { kind: "i32" };
    }

    // Array(n) — create array of length n, or Array(a,b,c) → [a,b,c]
    // Treat Array() the same as new Array() — they have identical semantics in JS.
    if (funcName === "Array") {
      return compileArrayConstructorCall(ctx, fctx, expr);
    }
  }

  // Regular function call
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;

    // Check if this is a closure call
    let closureInfo = ctx.closureMap.get(funcName);
    if (!closureInfo) {
      // Fallback: if the variable is a local with a ref type, look up closure info
      // by struct type index. This handles cases like:
      //   var f; f = function() { ... }; f();
      const localIdx = fctx.localMap.get(funcName);
      if (localIdx !== undefined) {
        const localType =
          localIdx < fctx.params.length
            ? fctx.params[localIdx]?.type
            : fctx.locals[localIdx - fctx.params.length]?.type;
        if (
          localType &&
          (localType.kind === "ref" || localType.kind === "ref_null")
        ) {
          closureInfo = ctx.closureInfoByTypeIdx.get(localType.typeIdx);
        }
      }
    }
    if (closureInfo) {
      return compileClosureCall(ctx, fctx, expr, funcName, closureInfo);
    }

    const funcIdx = ctx.funcMap.get(funcName);
    if (funcIdx === undefined) {
      // Before giving up, check if this identifier is a local/param with callable TS type
      // (e.g. function parameter `fn: (x: number) => number` stored as externref).
      // If so, create or find a matching closure wrapper type and dispatch via call_ref.
      // Only attempt this for actual locals/params — not for unknown imported functions.
      const calleeLocalIdx = fctx.localMap.get(funcName);
      const calleeModGlobal =
        calleeLocalIdx === undefined
          ? ctx.moduleGlobals.get(funcName)
          : undefined;
      const calleeCapturedGlobal =
        calleeLocalIdx === undefined && calleeModGlobal === undefined
          ? ctx.capturedGlobals.get(funcName)
          : undefined;
      const isKnownVariable =
        calleeLocalIdx !== undefined ||
        calleeModGlobal !== undefined ||
        calleeCapturedGlobal !== undefined;
      const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
      const callSigs = isKnownVariable
        ? calleeTsType.getCallSignatures?.()
        : undefined;
      if (callSigs && callSigs.length > 0) {
        const sig = callSigs[0]!;
        const sigParamCount = sig.parameters.length;
        const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
        const sigRetWasm = isVoidType(sigRetType)
          ? null
          : resolveWasmType(ctx, sigRetType);
        const sigParamWasmTypes: ValType[] = [];
        for (let i = 0; i < sigParamCount; i++) {
          const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
          sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
        }

        // Eagerly create the closure wrapper types for this signature so the
        // lookup succeeds even when no actual closure with this signature has
        // been compiled yet (compilation order issue).
        // All callers must wrap their closures into this wrapper type before
        // passing them (see coercion in compileExpression and compileAssignment).
        const resultTypes = sigRetWasm ? [sigRetWasm] : [];
        const wrapperTypes = getOrCreateFuncRefWrapperTypes(
          ctx,
          sigParamWasmTypes,
          resultTypes,
        );

        if (wrapperTypes) {
          const matchedClosureInfo = wrapperTypes.closureInfo;
          const matchedStructTypeIdx = wrapperTypes.structTypeIdx;

          // Compile the callee to get the value on the stack
          const innerResultType = compileExpression(ctx, fctx, expr.expression);

          // Save closure ref to a local
          let closureLocal: number;
          if (innerResultType?.kind === "externref") {
            const closureRefType: ValType = {
              kind: "ref_null",
              typeIdx: matchedStructTypeIdx,
            };
            closureLocal = allocLocal(
              fctx,
              `__callable_param_${fctx.locals.length}`,
              closureRefType,
            );
            fctx.body.push({ op: "any.convert_extern" });
            emitGuardedRefCast(fctx, matchedStructTypeIdx);
            fctx.body.push({ op: "local.set", index: closureLocal });
          } else {
            const closureRefType: ValType = innerResultType ?? {
              kind: "ref",
              typeIdx: matchedStructTypeIdx,
            };
            closureLocal = allocLocal(
              fctx,
              `__callable_param_${fctx.locals.length}`,
              closureRefType,
            );
            fctx.body.push({ op: "local.set", index: closureLocal });
          }

          // Push closure ref as first arg (self param) — null-check → TypeError (#728)
          fctx.body.push({ op: "local.get", index: closureLocal });
          emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });

          // Push call arguments with type coercion (only up to declared param count)
          {
            const cpParamCnt = matchedClosureInfo.paramTypes.length;
            for (
              let i = 0;
              i < Math.min(expr.arguments.length, cpParamCnt);
              i++
            ) {
              compileExpression(
                ctx,
                fctx,
                expr.arguments[i]!,
                matchedClosureInfo.paramTypes[i],
              );
            }
            for (let i = cpParamCnt; i < expr.arguments.length; i++) {
              const extraType = compileExpression(
                ctx,
                fctx,
                expr.arguments[i]!,
              );
              if (extraType !== null && extraType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
          }

          // Pad missing arguments with defaults
          for (
            let i = expr.arguments.length;
            i < matchedClosureInfo.paramTypes.length;
            i++
          ) {
            pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
          }

          // Push the funcref from the closure struct (field 0) and call_ref — null-check → TypeError (#728)
          fctx.body.push({ op: "local.get", index: closureLocal });
          emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
          fctx.body.push({
            op: "struct.get",
            typeIdx: matchedStructTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({
            op: "ref.cast",
            typeIdx: matchedClosureInfo.funcTypeIdx,
          });
          emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
          fctx.body.push({
            op: "call_ref",
            typeIdx: matchedClosureInfo.funcTypeIdx,
          });

          return matchedClosureInfo.returnType ?? VOID_RESULT;
        }
      }

      // Graceful fallback for unknown functions — compile arguments (for side effects)
      // then emit ref.null extern (undefined) as the return value.
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Check if this function is eligible for call-site inlining
    const inlineInfo = ctx.inlinableFunctions.get(funcName);
    if (inlineInfo && !expr.arguments.some((a: any) => ts.isSpreadElement(a))) {
      // Inline the function body: compile arguments into temp locals, then emit body
      const argLocals: number[] = [];
      for (let i = 0; i < inlineInfo.paramCount; i++) {
        if (i < expr.arguments.length) {
          compileExpression(
            ctx,
            fctx,
            expr.arguments[i]!,
            inlineInfo.paramTypes[i],
          );
        } else {
          pushDefaultValue(fctx, inlineInfo.paramTypes[i]!);
        }
        const tmpLocal = allocLocal(
          fctx,
          `__inline_${funcName}_p${i}_${fctx.locals.length}`,
          inlineInfo.paramTypes[i]!,
        );
        fctx.body.push({ op: "local.set", index: tmpLocal });
        argLocals.push(tmpLocal);
      }
      // Drop extra arguments (evaluate for side effects)
      for (let i = inlineInfo.paramCount; i < expr.arguments.length; i++) {
        const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
        if (extraType !== null) {
          fctx.body.push({ op: "drop" });
        }
      }
      // Emit the inlined body, remapping local.get indices to the temp locals
      for (const instr of inlineInfo.body) {
        if (instr.op === "local.get") {
          const mapped = argLocals[(instr as any).index];
          if (mapped !== undefined) {
            fctx.body.push({ op: "local.get", index: mapped });
          } else {
            fctx.body.push(instr); // should not happen for valid inline candidates
          }
        } else {
          fctx.body.push(instr);
        }
      }
      return inlineInfo.returnType ?? VOID_RESULT;
    }

    // Prepend captured values for nested functions with captures
    const nestedCaptures = ctx.nestedFuncCaptures.get(funcName);
    if (nestedCaptures) {
      // Get param types early so we can coerce captures to expected types
      const captureParamTypes = getFuncParamTypes(ctx, funcIdx);
      for (let capIdx = 0; capIdx < nestedCaptures.length; capIdx++) {
        const cap = nestedCaptures[capIdx]!;
        if (cap.mutable && cap.valType) {
          // Mutable capture: wrap in a ref cell so writes propagate back
          const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.valType);
          // Check if this local is already boxed (from a previous call to the same or another closure)
          if (fctx.boxedCaptures?.has(cap.name)) {
            // Already a ref cell — pass the ref cell reference directly
            const currentLocalIdx = fctx.localMap.get(cap.name)!;
            fctx.body.push({ op: "local.get", index: currentLocalIdx });
          } else {
            // Create a ref cell, store the current value, keep ref on stack
            fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
            fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
            // Also box the outer local so subsequent reads/writes go through the ref cell
            const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
              kind: "ref",
              typeIdx: refCellTypeIdx,
            });
            // Duplicate: need the ref cell for the call AND for the outer local
            fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
            // Re-register the original name to point to the boxed local
            fctx.localMap.set(cap.name, boxedLocalIdx);
            if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
            fctx.boxedCaptures.set(cap.name, {
              refCellTypeIdx,
              valType: cap.valType,
            });
          }
          // Coerce mutable capture (ref cell) to expected param type if they differ
          const expectedMutCapType = captureParamTypes?.[capIdx];
          if (expectedMutCapType) {
            const refCellType: ValType = { kind: "ref", typeIdx: refCellTypeIdx };
            if (!valTypesMatch(refCellType, expectedMutCapType)) {
              coerceType(ctx, fctx, refCellType, expectedMutCapType);
            }
          }
        } else {
          // TDZ check for captured let/const variables
          const capTdzIdx = fctx.tdzFlagLocals?.get(cap.name);
          if (capTdzIdx !== undefined) {
            emitLocalTdzCheck(ctx, fctx, cap.name, capTdzIdx);
          }
          fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
          // Coerce capture value to expected param type if they differ
          const expectedCapType = captureParamTypes?.[capIdx];
          if (expectedCapType) {
            const actualType = getLocalType(fctx, cap.outerLocalIdx);
            if (actualType && !valTypesMatch(actualType, expectedCapType)) {
              coerceType(ctx, fctx, actualType, expectedCapType);
            }
          }
        }
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
      const restArgCount = Math.max(
        0,
        expr.arguments.length - restInfo.restIndex,
      );
      // Push length first (for struct.new order: length, data)
      fctx.body.push({ op: "i32.const", value: restArgCount });
      // Push elements, then array.new_fixed
      for (let i = restInfo.restIndex; i < expr.arguments.length; i++) {
        compileExpression(ctx, fctx, expr.arguments[i]!, restInfo.elemType);
      }
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: restInfo.arrayTypeIdx,
        length: restArgCount,
      });
      // Wrap in vec struct: { length, data }
      fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
    } else if (hasSpreadArg) {
      // Spread in function call: fn(...arr) — unpack array elements as positional args
      compileSpreadCallArgs(ctx, fctx, expr, funcIdx, restInfo);
    } else {
      // Normal call — compile provided arguments with type hints from function signature
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      const captureCount = nestedCaptures ? nestedCaptures.length : 0;
      // User-visible param count excludes capture params (which are prepended internally)
      const paramCount = paramTypes
        ? paramTypes.length - captureCount
        : expr.arguments.length;
      for (let i = 0; i < expr.arguments.length; i++) {
        if (i < paramCount) {
          // Offset into paramTypes by captureCount since captures are the leading params
          compileExpression(
            ctx,
            fctx,
            expr.arguments[i]!,
            paramTypes?.[i + captureCount],
          );
        } else {
          // Extra argument beyond function's parameter count — evaluate for
          // side effects (JS semantics) and discard the result
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null) {
            fctx.body.push({ op: "drop" });
          }
        }
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

      // Pad any remaining missing arguments with defaults
      // (handles arity mismatch: calling f(a, b) with just f(1))
      if (paramTypes) {
        // Count how many args were actually pushed: provided args (capped at paramCount)
        // plus optional param defaults already pushed
        // plus capture params already pushed by nestedCaptures loop above
        const providedCount =
          Math.min(expr.arguments.length, paramCount) + captureCount;
        const optFilledCount = optInfo
          ? optInfo.filter((o) => o.index >= expr.arguments.length).length
          : 0;
        const totalPushed = providedCount + optFilledCount;
        for (let i = totalPushed; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!);
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
      if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
      // Safety check: if the Wasm function actually has void return (e.g. async
      // functions with Promise<void>), the TS type may be misleading
      if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
      // Use actual Wasm return type to avoid TS 'any' → externref mismatch
      return getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType);
    }
    return getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
  }

  // Handle IIFE: (function() { ... })() or (() => expr)() — inline the function body
  {
    // Unwrap parenthesized expression to find the function/arrow
    let callee = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
      // Generator function expressions (function*) must NOT be inlined as IIFEs
      // because their body contains `yield` which requires a generator context.
      // Let them fall through to the normal closure compilation path (#657).
      const isGeneratorIIFE =
        ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined;
      if (isGeneratorIIFE) {
        // Fall through to normal call compilation below
      } else {
        const params = callee.parameters;
        const args = expr.arguments;
        // Check if the IIFE body references `arguments` (only for function expressions, not arrows)
        const iifeNeedsArguments = ts.isFunctionExpression(callee)
          && callee.body
          && usesArguments(callee.body);
        // Support IIFEs with matching parameter/argument counts
        if (params.length <= args.length) {
          // Allocate locals for parameters and compile arguments
          const paramLocals: number[] = [];
          const allArgLocals: { idx: number; type: ValType }[] = [];
          for (let i = 0; i < params.length; i++) {
            const paramName = ts.isIdentifier(params[i]!.name)
              ? params[i]!.name.text
              : `__iife_p${i}`;
            const argType = compileExpression(ctx, fctx, args[i]!);
            const localType = argType ?? { kind: "f64" as const };
            const idx = allocLocal(fctx, paramName, localType);
            fctx.body.push({ op: "local.set", index: idx });
            paramLocals.push(idx);
            if (iifeNeedsArguments) {
              allArgLocals.push({ idx, type: localType });
            }
          }
          // Extra arguments beyond declared params
          if (iifeNeedsArguments) {
            // Store extra args in locals for the arguments object
            for (let i = params.length; i < args.length; i++) {
              const t = compileExpression(ctx, fctx, args[i]!);
              const localType = t && t !== VOID_RESULT ? t : { kind: "f64" as const };
              if (t === null || t === VOID_RESULT) {
                // No value produced — push a default
                fctx.body.push({ op: "f64.const", value: 0 });
              }
              const idx = allocLocal(fctx, `__iife_extra_${i}`, localType as ValType);
              fctx.body.push({ op: "local.set", index: idx });
              allArgLocals.push({ idx, type: localType as ValType });
            }
          } else {
            // Drop extra arguments (evaluate for side effects)
            for (let i = params.length; i < args.length; i++) {
              const t = compileExpression(ctx, fctx, args[i]!);
              if (t && t !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
          }

          // Set up `arguments` vec for the IIFE if needed
          if (iifeNeedsArguments && allArgLocals.length > 0) {
            // Ensure __box_number is available for boxing numeric args
            const hasNumeric = allArgLocals.some(
              (a) => a.type.kind === "f64" || a.type.kind === "i32",
            );
            if (hasNumeric) {
              ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
            }

            const vti = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
            const ati = getArrTypeIdxFromVec(ctx, vti);
            const vecRef: ValType = { kind: "ref", typeIdx: vti };
            const argsLocal = allocLocal(fctx, "arguments", vecRef);
            const arrTmp = allocLocal(fctx, "__iife_args_arr", { kind: "ref", typeIdx: ati });

            for (const { idx, type } of allArgLocals) {
              fctx.body.push({ op: "local.get", index: idx });
              if (type.kind === "f64") {
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (type.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (type.kind === "ref" || type.kind === "ref_null") {
                fctx.body.push({ op: "extern.convert_any" });
              }
              // externref: already correct
            }
            fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: allArgLocals.length });
            fctx.body.push({ op: "local.set", index: arrTmp });
            fctx.body.push({ op: "i32.const", value: allArgLocals.length });
            fctx.body.push({ op: "local.get", index: arrTmp });
            fctx.body.push({ op: "struct.new", typeIdx: vti });
            fctx.body.push({ op: "local.set", index: argsLocal });
          } else if (iifeNeedsArguments) {
            // No arguments at all — create empty arguments vec
            const vti = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
            const ati = getArrTypeIdxFromVec(ctx, vti);
            const vecRef: ValType = { kind: "ref", typeIdx: vti };
            const argsLocal = allocLocal(fctx, "arguments", vecRef);
            const arrTmp = allocLocal(fctx, "__iife_args_arr", { kind: "ref", typeIdx: ati });
            fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: 0 });
            fctx.body.push({ op: "local.set", index: arrTmp });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "local.get", index: arrTmp });
            fctx.body.push({ op: "struct.new", typeIdx: vti });
            fctx.body.push({ op: "local.set", index: argsLocal });
          }

          // Compile body
          if (ts.isArrowFunction(callee) && !ts.isBlock(callee.body)) {
            // Concise body: expression — no return issue
            return compileExpression(ctx, fctx, callee.body);
          }

          // Block body (arrow or function expression) — need to handle return
          const bodyStmts = ts.isArrowFunction(callee)
            ? (callee.body as ts.Block).statements
            : callee.body.statements;
          if (bodyStmts.length === 0) {
            return VOID_RESULT;
          }

          // Determine return type from TS
          const iifeRetType = ctx.checker.getTypeAtLocation(expr);
          const iifeWasmRetType = isVoidType(iifeRetType)
            ? null
            : resolveWasmType(ctx, iifeRetType);

          if (iifeWasmRetType) {
            // Returning IIFE: allocate a result local, compile body into a block,
            // and replace `return` with `local.set + br` to exit the block
            const retLocal = allocLocal(
              fctx,
              `__iife_ret_${fctx.locals.length}`,
              iifeWasmRetType,
            );
            const savedBody = fctx.body;
            fctx.savedBodies.push(savedBody);
            const blockBody: Instr[] = [];
            fctx.body = blockBody;

            // Save and override returnType so that return statements inside the
            // IIFE coerce to the IIFE's own return type, not the outer function's.
            // Without this, a boolean-returning IIFE inside an f64-returning
            // function would coerce i32→f64 before local.set into an i32 local.
            const savedReturnType = fctx.returnType;
            fctx.returnType = iifeWasmRetType;

            // Hoist let/const with TDZ flags so accesses before init throw (#790)
            hoistLetConstWithTdz(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
            // Hoist function declarations so they're available before textual position
            hoistFunctionDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);

            // Increase block depth so return→br targets the right level
            fctx.blockDepth++;
            for (const stmt of bodyStmts) {
              compileStatement(ctx, fctx, stmt);
            }
            fctx.blockDepth--;

            // Restore outer function's return type
            fctx.returnType = savedReturnType;
            fctx.savedBodies.pop();
            fctx.body = savedBody;

            // Post-process: replace `return` / `return_call` / `return_call_ref` ops
            // with `local.set retLocal + br <depth>`.  Tail-call optimization in
            // compileReturnStatement may have merged call+return into return_call;
            // inside an IIFE we must undo that since we need local.set + br instead.
            function patchReturns(instrs: Instr[], depth: number): void {
              for (let i = 0; i < instrs.length; i++) {
                const op = instrs[i]!.op;
                if (op === "return") {
                  // The instruction before `return` is the return value expression.
                  // Replace `return` with `local.set + br`
                  instrs[i] = { op: "local.set", index: retLocal } as Instr;
                  instrs.splice(i + 1, 0, { op: "br", depth } as Instr);
                  i++; // skip the inserted br
                } else if (op === "return_call" || op === "return_call_ref") {
                  // Undo tail-call: return_call funcIdx → call funcIdx + local.set + br
                  const instr = instrs[i] as any;
                  instr.op = op === "return_call" ? "call" : "call_ref";
                  instrs.splice(
                    i + 1,
                    0,
                    { op: "local.set", index: retLocal } as Instr,
                    { op: "br", depth } as Instr,
                  );
                  i += 2; // skip inserted instructions
                }
                // Recurse into sub-blocks (if/then/else/block/loop)
                const instr = instrs[i] as any;
                if (instr.then) patchReturns(instr.then, depth + 1);
                if (instr.else) patchReturns(instr.else, depth + 1);
                if (instr.body && Array.isArray(instr.body))
                  patchReturns(instr.body, depth + 1);
              }
            }
            patchReturns(blockBody, 0);

            // Emit: block { <body> } local.get retLocal
            fctx.body.push({
              op: "block",
              blockType: { kind: "empty" },
              body: blockBody,
            } as Instr);
            fctx.body.push({ op: "local.get", index: retLocal });
            return iifeWasmRetType;
          } else {
            // Void IIFE — just compile inline
            // Hoist let/const with TDZ flags so accesses before init throw (#790)
            hoistLetConstWithTdz(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
            // Hoist function declarations so they're available before textual position
            hoistFunctionDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
            for (const stmt of bodyStmts) {
              compileStatement(ctx, fctx, stmt);
            }
            return VOID_RESULT;
          }
        }
      } // end else (non-generator IIFE)
    }
  }

  // Handle standalone super() calls (constructor chaining) — normally handled by
  // compileClassBodies, but handle here as fallback
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    // super() call in constructor — already handled by compileClassBodies inline
    // Just return void since the work is done there
    return null;
  }

  // Handle IIFE: (function(...) { ... })(...) — immediately invoked function expression
  {
    const iifeResult = compileIIFE(ctx, fctx, expr);
    if (iifeResult !== undefined) return iifeResult;
  }

  // Handle comma-operator indirect calls: (0, foo)() or (expr, fn)()
  // Unwrap parenthesized comma expression, evaluate left for side effects, call right.
  {
    let callee = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (
      ts.isBinaryExpression(callee) &&
      callee.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      // Evaluate left side for side effects and drop
      const leftType = compileExpression(ctx, fctx, callee.left);
      if (leftType && leftType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      // Create a synthetic call with the right side as callee
      const syntheticCall = ts.factory.createCallExpression(
        callee.right as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      // Preserve parent for type checker resolution
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(
        ctx,
        fctx,
        syntheticCall as ts.CallExpression,
      );
    }
  }

  // Handle ElementAccessExpression calls: obj['method']() or obj[0]() or obj[constKey]()
  // Convert to equivalent property access method call when the index resolves to a static key.
  if (ts.isElementAccessExpression(expr.expression)) {
    const elemAccess = expr.expression;
    const argExpr = elemAccess.argumentExpression;
    // Resolve the key to a static string: string literals, numeric literals, const variables, etc.
    let resolvedMethodName: string | undefined;
    if (argExpr) {
      if (ts.isStringLiteral(argExpr)) {
        resolvedMethodName = argExpr.text;
      } else if (ts.isNumericLiteral(argExpr)) {
        resolvedMethodName = String(Number(argExpr.text));
      } else {
        resolvedMethodName = resolveComputedKeyExpression(ctx, argExpr);
      }
    }

    // Handle super['method']() calls — resolve to ParentClass_method with this as first arg
    if (
      elemAccess.expression.kind === ts.SyntaxKind.SuperKeyword &&
      resolvedMethodName !== undefined
    ) {
      return compileSuperElementMethodCall(ctx, fctx, expr, resolvedMethodName);
    }

    if (resolvedMethodName !== undefined) {
      const methodName = resolvedMethodName;
      const receiverType = ctx.checker.getTypeAtLocation(elemAccess.expression);

      // Try class instance method: ClassName_methodName
      let receiverClassName = receiverType.getSymbol()?.name;
      if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
        receiverClassName =
          ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
      }
      if (receiverClassName && ctx.classSet.has(receiverClassName)) {
        const fullName = `${receiverClassName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument
          compileExpression(ctx, fctx, elemAccess.expression);
          // Push remaining arguments with type hints
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const eaMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < eaMethodParamCount) {
              compileExpression(
                ctx,
                fctx,
                expr.arguments[i]!,
                paramTypes?.[i + 1],
              ); // +1 to skip self
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null && extraType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          // Pad missing arguments with defaults (skip self param at index 0)
          if (paramTypes) {
            for (
              let i = Math.min(expr.arguments.length, eaMethodParamCount) + 1;
              i < paramTypes.length;
              i++
            ) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName))
              return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }

      // Try struct method: structName_methodName
      const structTypeName = resolveStructName(ctx, receiverType);
      if (structTypeName) {
        const fullName = `${structTypeName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          const recvType = compileExpression(ctx, fctx, elemAccess.expression);
          // Null-guard: if receiver is ref_null, check for null before calling method
          if (recvType && recvType.kind === "ref_null") {
            const sig = ctx.checker.getResolvedSignature(expr);
            let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (!isEffectivelyVoidReturn(ctx, retType, fullName))
                callReturnType = getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
            }
            const tmp = allocLocal(
              fctx,
              `__ng_ea_recv_${fctx.locals.length}`,
              recvType,
            );
            fctx.body.push({ op: "local.tee", index: tmp });
            fctx.body.push({ op: "ref.is_null" });

            const savedBody = pushBody(fctx);
            fctx.body.push({ op: "local.get", index: tmp });
            fctx.body.push({ op: "ref.as_non_null" } as Instr);
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            const eaNgParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
            for (let i = 0; i < expr.arguments.length; i++) {
              if (i < eaNgParamCount) {
                compileExpression(
                  ctx,
                  fctx,
                  expr.arguments[i]!,
                  paramTypes?.[i + 1],
                );
              } else {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null && extraType !== VOID_RESULT) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            if (paramTypes) {
              for (
                let i = Math.min(expr.arguments.length, eaNgParamCount) + 1;
                i < paramTypes.length;
                i++
              ) {
                pushDefaultValue(fctx, paramTypes[i]!);
              }
            }
            fctx.body.push({ op: "call", funcIdx });
            const elseInstrs = fctx.body;
            fctx.body = savedBody;

            if (callReturnType === VOID_RESULT) {
              // Genuinely null receiver: throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return VOID_RESULT;
            } else {
              const resultType: ValType =
                callReturnType.kind === "ref"
                  ? {
                      kind: "ref_null",
                      typeIdx: (callReturnType as any).typeIdx,
                    }
                  : callReturnType;
              // throw is divergent, valid without producing a value (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: resultType },
                then: typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return resultType;
            }
          }
          // Non-nullable receiver
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const eaNnParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < eaNnParamCount) {
              compileExpression(
                ctx,
                fctx,
                expr.arguments[i]!,
                paramTypes?.[i + 1],
              );
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null && extraType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          if (paramTypes) {
            for (
              let i = Math.min(expr.arguments.length, eaNnParamCount) + 1;
              i < paramTypes.length;
              i++
            ) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName))
              return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }

      // Try static method: ClassName.staticMethod via element access
      if (
        ts.isIdentifier(elemAccess.expression) &&
        ctx.classSet.has(elemAccess.expression.text)
      ) {
        const clsName = elemAccess.expression.text;
        const fullName = `${clsName}_${methodName}`;
        if (ctx.staticMethodSet.has(fullName)) {
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined) {
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            const eaStaticParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
            for (let i = 0; i < expr.arguments.length; i++) {
              if (i < eaStaticParamCount) {
                compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
              } else {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null && extraType !== VOID_RESULT) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            if (paramTypes) {
              for (let i = expr.arguments.length; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!);
              }
            }
            fctx.body.push({ op: "call", funcIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName))
                return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
              return getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
            }
            return VOID_RESULT;
          }
        }
      }

      // Try string method: string_methodName
      if (isStringType(receiverType)) {
        const importName = `string_${methodName}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, elemAccess.expression);
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const args = expr.arguments;
          for (let ai = 0; ai < args.length; ai++) {
            const argResult = compileExpression(ctx, fctx, args[ai]!);
            const expectedType = paramTypes?.[ai + 1];
            if (
              argResult &&
              expectedType &&
              argResult.kind !== expectedType.kind
            ) {
              coerceType(ctx, fctx, argResult, expectedType);
            }
          }
          if (paramTypes && args.length + 1 < paramTypes.length) {
            for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
              const pt = paramTypes[pi]!;
              if (pt.kind === "externref")
                fctx.body.push({ op: "ref.null.extern" });
              else if (pt.kind === "f64")
                fctx.body.push({ op: "f64.const", value: 0 });
              else if (pt.kind === "i32")
                fctx.body.push({ op: "i32.const", value: 0 });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          const returnsBool =
            methodName === "includes" ||
            methodName === "startsWith" ||
            methodName === "endsWith";
          return returnsBool
            ? { kind: "i32" }
            : methodName === "indexOf" || methodName === "lastIndexOf" || methodName === "search"
              ? { kind: "f64" }
              : { kind: "externref" };
        }
      }

      // Try number method: number.toString(), number.toFixed(), toPrecision(), toExponential()
      if (
        isNumberType(receiverType) &&
        (methodName === "toString" || methodName === "toFixed" || methodName === "toPrecision" || methodName === "toExponential")
      ) {
        // RangeError validation for toString(radix) — radix must be integer 2-36
        if (methodName === "toString" && expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
          // Floor the radix (ToInteger semantics)
          fctx.body.push({ op: "f64.floor" } as unknown as Instr);
          const radixLocal = allocLocal(fctx, `__radix_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: radixLocal });
          fctx.body.push({ op: "f64.const", value: 2 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "f64.const", value: 36 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          // Check radix is NaN (NaN != NaN)
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
            addStringConstantGlobal(ctx, rangeErrMsg);
            const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
            const tagIdx = ensureExnTag(ctx);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "global.get", index: strIdx } as Instr,
                { op: "throw", tagIdx } as Instr,
              ],
              else: [],
            });
          }
          fctx.body.push({ op: "drop" }); // drop radix, toString still uses base-10
        }
        const exprType = compileExpression(ctx, fctx, elemAccess.expression);
        if (exprType && exprType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        if (methodName === "toFixed" && expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!);
          // RangeError: fractionDigits must be 0-100
          const digitsLocal = allocLocal(fctx, `__toFixed_digits_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: digitsLocal });
          fctx.body.push({ op: "f64.const", value: 0 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: digitsLocal });
          fctx.body.push({ op: "f64.const", value: 100 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toFixed() digits argument must be between 0 and 100";
            addStringConstantGlobal(ctx, rangeErrMsg);
            const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
            const tagIdx = ensureExnTag(ctx);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "global.get", index: strIdx } as Instr,
                { op: "throw", tagIdx } as Instr,
              ],
              else: [],
            });
          }
          fctx.body.push({ op: "local.get", index: digitsLocal });
        } else if (methodName === "toFixed") {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        if (methodName === "toPrecision" && expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!);
          // RangeError: precision must be 1-100 (NaN → 0 → invalid since 0 < 1)
          const precLocal = allocLocal(fctx, `__toPrecision_prec_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: precLocal });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: precLocal });
          fctx.body.push({ op: "f64.const", value: 100 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          // NaN check: NaN != NaN
          fctx.body.push({ op: "local.get", index: precLocal });
          fctx.body.push({ op: "local.get", index: precLocal });
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toPrecision() argument must be between 1 and 100";
            addStringConstantGlobal(ctx, rangeErrMsg);
            const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
            const tagIdx = ensureExnTag(ctx);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "global.get", index: strIdx } as Instr,
                { op: "throw", tagIdx } as Instr,
              ],
              else: [],
            });
          }
          fctx.body.push({ op: "local.get", index: precLocal });
        } else if (methodName === "toPrecision") {
          // No argument → same as toString()
          const funcIdx = ctx.funcMap.get("number_toString");
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "toExponential" && expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!);
          // RangeError: fractionDigits must be 0-100
          const digitsLocal2 = allocLocal(fctx, `__toExponential_digits_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: digitsLocal2 });
          fctx.body.push({ op: "f64.const", value: 0 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: digitsLocal2 });
          fctx.body.push({ op: "f64.const", value: 100 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toExponential() argument must be between 0 and 100";
            addStringConstantGlobal(ctx, rangeErrMsg);
            const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
            const tagIdx = ensureExnTag(ctx);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "global.get", index: strIdx } as Instr,
                { op: "throw", tagIdx } as Instr,
              ],
              else: [],
            });
          }
          fctx.body.push({ op: "local.get", index: digitsLocal2 });
        } else if (methodName === "toExponential") {
          // No argument → pass NaN sentinel
          fctx.body.push({ op: "f64.const", value: NaN });
        }
        const funcName = methodName === "toFixed" ? "number_toFixed"
          : methodName === "toPrecision" ? "number_toPrecision"
          : methodName === "toExponential" ? "number_toExponential"
          : "number_toString";
        const funcIdx = ctx.funcMap.get(funcName);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }

      // Try array method calls
      {
        const arrMethodResult = compileArrayMethodCall(
          ctx,
          fctx,
          elemAccess,
          expr,
          receiverType,
          methodName,
        );
        if (arrMethodResult !== undefined) return arrMethodResult;
      }

      // Fallback for resolved element access calls that didn't match any known method:
      // compile receiver, discard; compile each argument for side effects; return externref.
      {
        const recvType = compileExpression(ctx, fctx, elemAccess.expression);
        if (recvType && recvType !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
        for (const arg of expr.arguments) {
          const argType = compileExpression(ctx, fctx, arg);
          if (argType && argType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // Fallback for element access calls where the key couldn't be resolved statically:
    // compile receiver + index expression + arguments for side effects; return externref.
    {
      const recvType = compileExpression(ctx, fctx, elemAccess.expression);
      if (recvType && recvType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      if (argExpr) {
        const keyType = compileExpression(ctx, fctx, argExpr);
        if (keyType && keyType !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
      }
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType && argType !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle fn.bind(thisArg, ...partialArgs)(...remainingArgs) — immediate bind+call
  // Transform to fn(...partialArgs, ...remainingArgs), dropping thisArg.
  if (ts.isCallExpression(expr.expression)) {
    const bindCall = expr.expression;
    if (
      ts.isPropertyAccessExpression(bindCall.expression) &&
      bindCall.expression.name.text === "bind"
    ) {
      const bindTarget = bindCall.expression.expression;

      // Case: identifier.bind(thisArg, ...partialArgs)(...args)
      if (ts.isIdentifier(bindTarget)) {
        const funcName = bindTarget.text;
        const closureInfo = ctx.closureMap.get(funcName);
        const funcIdx = ctx.funcMap.get(funcName);

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate and drop thisArg (first bind argument) for side effects
          if (bindCall.arguments.length > 0) {
            const thisType = compileExpression(
              ctx,
              fctx,
              bindCall.arguments[0]!,
            );
            if (thisType && thisType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }

          // Collect all effective arguments: partial args from bind + remaining args from outer call
          const partialArgs =
            bindCall.arguments.length > 1
              ? Array.from(bindCall.arguments).slice(1)
              : [];
          const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

          if (closureInfo) {
            const syntheticCall = ts.factory.createCallExpression(
              bindTarget,
              undefined,
              allArgs as unknown as readonly ts.Expression[],
            );
            (syntheticCall as any).parent = expr.parent;
            return compileClosureCall(
              ctx,
              fctx,
              syntheticCall as ts.CallExpression,
              funcName,
              closureInfo,
            );
          }

          // Regular function call
          const paramTypes = getFuncParamTypes(ctx, funcIdx!);
          for (let i = 0; i < allArgs.length; i++) {
            compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i]);
          }

          // Supply defaults for missing optional params
          const optInfo = ctx.funcOptionalParams.get(funcName);
          if (optInfo) {
            for (const opt of optInfo) {
              if (opt.index >= allArgs.length) {
                pushDefaultValue(fctx, opt.type);
              }
            }
          }

          // Pad remaining missing params
          if (paramTypes) {
            const optFilledCount = optInfo
              ? optInfo.filter((o) => o.index >= allArgs.length).length
              : 0;
            const totalPushed = allArgs.length + optFilledCount;
            for (let i = totalPushed; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }

          const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
          fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, funcName))
              return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType);
          }
          return getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
        }
      }

      // Case: obj.method.bind(thisArg)(...args) — method call with different receiver
      if (ts.isPropertyAccessExpression(bindTarget)) {
        const methodName = bindTarget.name.text;
        const objExpr = bindTarget.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (
          className &&
          (ctx.classSet.has(className) ||
            ctx.funcMap.has(`${className}_${methodName}`))
        ) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && bindCall.arguments.length > 0) {
            // First bind argument is the thisArg (receiver)
            compileExpression(ctx, fctx, bindCall.arguments[0]!);

            // Remaining bind args + outer call args
            const partialArgs =
              bindCall.arguments.length > 1
                ? Array.from(bindCall.arguments).slice(1)
                : [];
            const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            // User-visible param count excludes self (param 0)
            const bindParamCount = paramTypes
              ? paramTypes.length - 1
              : allArgs.length;
            for (let i = 0; i < allArgs.length; i++) {
              if (i < bindParamCount) {
                compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i + 1]);
              } else {
                // Extra argument beyond method's parameter count — evaluate for
                // side effects (JS semantics) and discard the result
                const extraType = compileExpression(ctx, fctx, allArgs[i]!);
                if (extraType !== null && extraType !== VOID_RESULT) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            // Pad missing arguments with defaults (skip self at index 0)
            if (paramTypes) {
              for (let i = allArgs.length + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!);
              }
            }

            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName))
                return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
              return getWasmFuncReturnType(ctx, finalCallIdx) ?? resolveWasmType(ctx, retType);
            }
            return VOID_RESULT;
          }
        }
      }
    }
  }

  // Handle CallExpression as callee: fn()(), makeAdder(10)(32), etc.
  // The inner call returns a closure struct (possibly coerced to externref),
  // and we need to call the returned closure with the outer arguments.
  if (ts.isCallExpression(expr.expression)) {
    // Get the TS type of the inner call result — should be a callable type
    const innerResultTsType = ctx.checker.getTypeAtLocation(expr.expression);
    const callSigs = innerResultTsType.getCallSignatures?.();

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      // Find matching closure info by comparing param types and return type
      // against all registered closure types
      let matchedClosureInfo: ClosureInfo | undefined;
      let matchedStructTypeIdx: number | undefined;

      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType)
        ? null
        : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
        if (info.paramTypes.length !== sigParamCount) continue;
        // Check return type match
        if (sigRetWasm === null && info.returnType !== null) continue;
        if (sigRetWasm !== null && info.returnType === null) continue;
        if (
          sigRetWasm !== null &&
          info.returnType !== null &&
          sigRetWasm.kind !== info.returnType.kind
        )
          continue;
        // Check param types match
        let paramsMatch = true;
        for (let i = 0; i < sigParamCount; i++) {
          if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
            paramsMatch = false;
            break;
          }
        }
        if (paramsMatch) {
          matchedClosureInfo = info;
          matchedStructTypeIdx = typeIdx;
          break;
        }
      }

      if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
        // Compile the inner call expression to get the closure on the stack
        const innerResultType = compileExpression(ctx, fctx, expr.expression);

        // Save closure ref to a local so we can extract both args and funcref
        let closureLocal: number;
        if (innerResultType?.kind === "externref") {
          // Need to convert externref back to the closure struct ref (guarded)
          const closureRefType: ValType = {
            kind: "ref_null",
            typeIdx: matchedStructTypeIdx,
          };
          closureLocal = allocLocal(
            fctx,
            `__call_ret_${fctx.locals.length}`,
            closureRefType,
          );
          fctx.body.push({ op: "any.convert_extern" });
          emitGuardedRefCast(fctx, matchedStructTypeIdx);
          fctx.body.push({ op: "local.set", index: closureLocal });
        } else {
          const closureRefType: ValType = innerResultType ?? {
            kind: "ref",
            typeIdx: matchedStructTypeIdx,
          };
          closureLocal = allocLocal(
            fctx,
            `__call_ret_${fctx.locals.length}`,
            closureRefType,
          );
          fctx.body.push({ op: "local.set", index: closureLocal });
        }

        // Push closure ref as first arg (self param) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });

        // Push call arguments (only up to declared param count)
        {
          const crParamCnt = matchedClosureInfo.paramTypes.length;
          for (
            let i = 0;
            i < Math.min(expr.arguments.length, crParamCnt);
            i++
          ) {
            compileExpression(
              ctx,
              fctx,
              expr.arguments[i]!,
              matchedClosureInfo.paramTypes[i],
            );
          }
          for (let i = crParamCnt; i < expr.arguments.length; i++) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null && extraType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }
        }

        // Pad missing arguments with defaults
        for (
          let i = expr.arguments.length;
          i < matchedClosureInfo.paramTypes.length;
          i++
        ) {
          pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
        }

        // Push the funcref from the closure struct (field 0) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
        fctx.body.push({
          op: "struct.get",
          typeIdx: matchedStructTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({
          op: "ref.cast",
          typeIdx: matchedClosureInfo.funcTypeIdx,
        });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });

        // call_ref with the lifted function's type index
        fctx.body.push({
          op: "call_ref",
          typeIdx: matchedClosureInfo.funcTypeIdx,
        });

        // Return VOID_RESULT for void closures so compileExpression doesn't
        // treat the null return as a compilation failure and roll back instructions
        return matchedClosureInfo.returnType ?? VOID_RESULT;
      }
    }
  }

  // Handle ConditionalExpression as callee (not wrapped in parens):
  // (cond ? fn1 : fn2)(args) — handled directly
  if (ts.isConditionalExpression(expr.expression)) {
    return compileConditionalCallee(ctx, fctx, expr, expr.expression);
  }

  // Generic fallback: compile the callee expression to get a value on the stack,
  // then try to use it as a closure call. This handles patterns like
  // accessing function values from complex expressions.
  {
    const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
    const callSigs = calleeTsType.getCallSignatures?.();

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      // Look for a matching closure type
      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType)
        ? null
        : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      let matchedClosureInfo: ClosureInfo | undefined;
      let matchedStructTypeIdx: number | undefined;

      for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
        if (info.paramTypes.length !== sigParamCount) continue;
        if (sigRetWasm === null && info.returnType !== null) continue;
        if (sigRetWasm !== null && info.returnType === null) continue;
        if (
          sigRetWasm !== null &&
          info.returnType !== null &&
          sigRetWasm.kind !== info.returnType.kind
        )
          continue;
        let paramsMatch = true;
        for (let i = 0; i < sigParamCount; i++) {
          if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
            paramsMatch = false;
            break;
          }
        }
        if (paramsMatch) {
          matchedClosureInfo = info;
          matchedStructTypeIdx = typeIdx;
          break;
        }
      }

      if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
        // Compile the callee expression to get the closure on the stack
        const innerResultType = compileExpression(ctx, fctx, expr.expression);

        // Save closure ref to a local
        let closureLocal: number;
        if (innerResultType?.kind === "externref") {
          const closureRefType: ValType = {
            kind: "ref_null",
            typeIdx: matchedStructTypeIdx,
          };
          closureLocal = allocLocal(
            fctx,
            `__cond_call_${fctx.locals.length}`,
            closureRefType,
          );
          fctx.body.push({ op: "any.convert_extern" });
          emitGuardedRefCast(fctx, matchedStructTypeIdx);
          fctx.body.push({ op: "local.set", index: closureLocal });
        } else {
          const closureRefType: ValType = innerResultType ?? {
            kind: "ref",
            typeIdx: matchedStructTypeIdx,
          };
          closureLocal = allocLocal(
            fctx,
            `__cond_call_${fctx.locals.length}`,
            closureRefType,
          );
          fctx.body.push({ op: "local.set", index: closureLocal });
        }

        // Push closure ref as first arg (self param) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });

        // Push call arguments (only up to declared param count)
        {
          const ccParamCnt = matchedClosureInfo.paramTypes.length;
          for (
            let i = 0;
            i < Math.min(expr.arguments.length, ccParamCnt);
            i++
          ) {
            compileExpression(
              ctx,
              fctx,
              expr.arguments[i]!,
              matchedClosureInfo.paramTypes[i],
            );
          }
          for (let i = ccParamCnt; i < expr.arguments.length; i++) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null && extraType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }
        }

        // Pad missing arguments
        for (
          let i = expr.arguments.length;
          i < matchedClosureInfo.paramTypes.length;
          i++
        ) {
          pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
        }

        // Push the funcref from closure struct and call_ref — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
        fctx.body.push({
          op: "struct.get",
          typeIdx: matchedStructTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({
          op: "ref.cast",
          typeIdx: matchedClosureInfo.funcTypeIdx,
        });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
        fctx.body.push({
          op: "call_ref",
          typeIdx: matchedClosureInfo.funcTypeIdx,
        });

        return matchedClosureInfo.returnType ?? VOID_RESULT;
      }
    }
  }

  // Graceful fallback: compile the callee expression and all arguments for side effects,
  // then push ref.null.extern. This avoids hard compile errors for unrecognized call patterns
  // (e.g. chained calls, dynamic dispatch, uncommon AST shapes).
  {
    const calleeType = compileExpression(ctx, fctx, expr.expression);
    if (calleeType && calleeType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType && argType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
}

/**
 * Compile a call with a ConditionalExpression callee: (cond ? fn1 : fn2)(args)
 *
 * We compile the condition, then emit an if/else where each branch makes
 * the call with the respective callee.
 *
 * Cannot create synthetic CallExpression via ts.factory because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler above.
 */
function compileConditionalCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  condExpr: ts.ConditionalExpression,
): InnerResult {
  // Compile condition
  const condType = compileExpression(ctx, fctx, condExpr.condition);
  if (!condType) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    ensureI32Condition(fctx, condType, ctx);
  }

  // Determine the expected return type of the call from the original expression
  const callSig = ctx.checker.getResolvedSignature(expr);
  let callRetType: ValType | null = null;
  if (callSig) {
    const retTsType = ctx.checker.getReturnTypeOfSignature(callSig);
    if (!isVoidType(retTsType)) {
      callRetType = resolveWasmType(ctx, retTsType);
    }
  }

  // Helper: compile a call branch by constructing the call inline
  // Uses the branch expression (whenTrue or whenFalse) as the callee.
  function compileBranchCall(branchExpr: ts.Expression): InnerResult {
    // If the branch is an identifier referencing a known function, call it directly
    if (ts.isIdentifier(branchExpr)) {
      const funcName = branchExpr.text;
      let closureInfo = ctx.closureMap.get(funcName);
      // Fallback: if variable is a local with ref type, look up closure info by type idx
      if (!closureInfo) {
        const localIdx = fctx.localMap.get(funcName);
        if (localIdx !== undefined) {
          const localType =
            localIdx < fctx.params.length
              ? fctx.params[localIdx]?.type
              : fctx.locals[localIdx - fctx.params.length]?.type;
          if (
            localType &&
            (localType.kind === "ref" || localType.kind === "ref_null")
          ) {
            closureInfo = ctx.closureInfoByTypeIdx.get(localType.typeIdx);
          }
        }
      }
      if (closureInfo) {
        // Use the original expr's arguments but with this identifier as callee
        // Create a minimal synthetic object that mimics a CallExpression
        // for compileClosureCall
        const syntheticCall = Object.create(expr);
        syntheticCall.expression = branchExpr;
        return compileClosureCall(
          ctx,
          fctx,
          syntheticCall as ts.CallExpression,
          funcName,
          closureInfo,
        );
      }
      const funcIdx = ctx.funcMap.get(funcName);
      if (funcIdx !== undefined) {
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const ccParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
        for (let i = 0; i < expr.arguments.length; i++) {
          if (i < ccParamCount) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          } else {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null && extraType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
        // Pad missing arguments with defaults
        if (paramTypes) {
          for (let i = expr.arguments.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!);
          }
        }
        const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx;
        fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
        if (callRetType) return callRetType;
        // Try to determine return type from the branch function's signature
        const branchType = ctx.checker.getTypeAtLocation(branchExpr);
        const branchSigs = branchType.getCallSignatures?.();
        if (branchSigs && branchSigs.length > 0) {
          const retType = ctx.checker.getReturnTypeOfSignature(branchSigs[0]!);
          if (isEffectivelyVoidReturn(ctx, retType, funcName))
            return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
          return getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType);
        }
        return callRetType ?? getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
      }
    }

    // If the branch is itself a conditional, recurse
    if (ts.isConditionalExpression(branchExpr)) {
      return compileConditionalCallee(ctx, fctx, expr, branchExpr);
    }

    // If the branch is wrapped in parens, unwrap
    if (ts.isParenthesizedExpression(branchExpr)) {
      let inner: ts.Expression = branchExpr;
      while (ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
      }
      return compileBranchCall(inner);
    }

    // If the branch is a property access, try method call
    if (ts.isPropertyAccessExpression(branchExpr)) {
      // Create a synthetic call with the property access as callee
      // PropertyAccessExpression IS a LeftHandSideExpression so no infinite recursion
      const syntheticCall = ts.factory.createCallExpression(
        branchExpr,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(
        ctx,
        fctx,
        syntheticCall as ts.CallExpression,
      );
    }

    // Fallback: compile expression value and try to use as closure call
    const calleeType = compileExpression(ctx, fctx, branchExpr);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    if (callRetType) {
      pushDefaultValue(fctx, callRetType);
      return callRetType;
    }
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }

  // Compile then-branch call
  const savedBody = fctx.body;
  fctx.body = [];
  let thenType = compileBranchCall(condExpr.whenTrue);
  let thenInstrs = fctx.body;

  // Compile else-branch call
  fctx.body = [];
  let elseType = compileBranchCall(condExpr.whenFalse);
  let elseInstrs = fctx.body;

  fctx.body = savedBody;

  // Determine result type
  if (thenType === VOID_RESULT && elseType === VOID_RESULT) {
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: elseInstrs,
    });
    return VOID_RESULT;
  }

  // Coerce branches to a common type
  const thenVal: ValType =
    thenType && thenType !== VOID_RESULT
      ? thenType
      : (callRetType ?? { kind: "f64" });
  const elseVal: ValType =
    elseType && elseType !== VOID_RESULT
      ? elseType
      : (callRetType ?? { kind: "f64" });
  let resultType: ValType = callRetType ?? thenVal;

  // If types don't match, coerce both to the result type
  if (thenVal.kind !== resultType.kind) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, thenVal, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }
  if (elseVal.kind !== resultType.kind) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, elseVal, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  // Handle void branches that need to produce a value
  if (thenType === VOID_RESULT || thenType === null) {
    thenInstrs = [...thenInstrs, ...defaultValueInstrs(resultType)];
  }
  if (elseType === VOID_RESULT || elseType === null) {
    elseInstrs = [...elseInstrs, ...defaultValueInstrs(resultType)];
  }

  // Widen ref to ref_null when a branch uses defaultValueInstrs (which produces ref.null)
  if (
    resultType.kind === "ref" &&
    (thenType === VOID_RESULT ||
      thenType === null ||
      elseType === VOID_RESULT ||
      elseType === null)
  ) {
    resultType = { kind: "ref_null", typeIdx: (resultType as any).typeIdx };
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  return resultType;
}

/**
 * Compile a call where the callee is an arbitrary expression that is not a
 * LeftHandSideExpression (e.g. assignment: `(x = fn)()`, logical: `(a || fn)()`).
 *
 * We cannot use ts.factory.createCallExpression for these because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler.
 *
 * Strategy: compile the callee expression to get its value on the stack,
 * then try to use the result as a closure call (closure-matching by type),
 * or as a direct function call if the expression resolves to a known function.
 */
function compileExpressionCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  calleeExpr: ts.Expression,
): InnerResult {
  // For assignment expressions, we can look at the RHS to identify the function
  // being called, while still compiling the full assignment for side effects.
  if (
    ts.isBinaryExpression(calleeExpr) &&
    calleeExpr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    calleeExpr.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    calleeExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    // For simple assignment (x = fn)(), compile the assignment for side effects
    // then call the RHS function directly if it's identifiable.
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs)) {
      const funcIdx = ctx.funcMap.get(rhs.text);
      const closureInfo = ctx.closureMap.get(rhs.text);
      if (funcIdx !== undefined || closureInfo) {
        // Compile the full assignment for side effects (stores value in LHS)
        const assignResult = compileExpression(ctx, fctx, calleeExpr);
        if (assignResult && assignResult !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
        // Now make a direct call using the RHS identifier as callee
        const syntheticCall = ts.factory.createCallExpression(
          rhs,
          expr.typeArguments,
          expr.arguments,
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(
          ctx,
          fctx,
          syntheticCall as ts.CallExpression,
        );
      }
    }
  }

  // Generic path: compile the callee expression and try closure-matching
  const calleeTsType = ctx.checker.getTypeAtLocation(calleeExpr);
  const callSigs = calleeTsType.getCallSignatures?.();

  if (callSigs && callSigs.length > 0) {
    const sig = callSigs[0]!;

    // Look for a matching closure type
    const sigParamCount = sig.parameters.length;
    const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
    const sigRetWasm = isVoidType(sigRetType)
      ? null
      : resolveWasmType(ctx, sigRetType);
    const sigParamWasmTypes: ValType[] = [];
    for (let i = 0; i < sigParamCount; i++) {
      const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
      sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
    }

    let matchedClosureInfo: ClosureInfo | undefined;
    let matchedStructTypeIdx: number | undefined;

    for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
      if (info.paramTypes.length !== sigParamCount) continue;
      if (sigRetWasm === null && info.returnType !== null) continue;
      if (sigRetWasm !== null && info.returnType === null) continue;
      if (
        sigRetWasm !== null &&
        info.returnType !== null &&
        sigRetWasm.kind !== info.returnType.kind
      )
        continue;
      let paramsMatch = true;
      for (let i = 0; i < sigParamCount; i++) {
        if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
          paramsMatch = false;
          break;
        }
      }
      if (paramsMatch) {
        matchedClosureInfo = info;
        matchedStructTypeIdx = typeIdx;
        break;
      }
    }

    if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
      // Compile the callee expression to get the closure on the stack
      const innerResultType = compileExpression(ctx, fctx, calleeExpr);

      // Save closure ref to a local
      let closureLocal: number;
      if (innerResultType?.kind === "externref") {
        const closureRefType: ValType = {
          kind: "ref_null",
          typeIdx: matchedStructTypeIdx,
        };
        closureLocal = allocLocal(
          fctx,
          `__expr_call_${fctx.locals.length}`,
          closureRefType,
        );
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, matchedStructTypeIdx);
        fctx.body.push({ op: "local.set", index: closureLocal });
      } else {
        const closureRefType: ValType = innerResultType ?? {
          kind: "ref",
          typeIdx: matchedStructTypeIdx,
        };
        closureLocal = allocLocal(
          fctx,
          `__expr_call_${fctx.locals.length}`,
          closureRefType,
        );
        fctx.body.push({ op: "local.set", index: closureLocal });
      }

      // Push closure ref as first arg (self param) — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });

      // Push call arguments (only up to declared param count)
      {
        const ecParamCnt = matchedClosureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, ecParamCnt); i++) {
          compileExpression(
            ctx,
            fctx,
            expr.arguments[i]!,
            matchedClosureInfo.paramTypes[i],
          );
        }
        for (let i = ecParamCnt; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null && extraType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
      }

      // Pad missing arguments
      for (
        let i = expr.arguments.length;
        i < matchedClosureInfo.paramTypes.length;
        i++
      ) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
      }

      // Push the funcref from closure struct and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
      fctx.body.push({
        op: "struct.get",
        typeIdx: matchedStructTypeIdx,
        fieldIdx: 0,
      });
      fctx.body.push({
        op: "ref.cast",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  // Last resort: compile the callee for side effects and try to resolve
  // the call via the RHS of an assignment or the last operand
  if (ts.isBinaryExpression(calleeExpr)) {
    const assignResult = compileExpression(ctx, fctx, calleeExpr);
    if (assignResult && assignResult !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    // Try calling the RHS (for assignment) or right operand (for logical)
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs) || ts.isPropertyAccessExpression(rhs)) {
      const syntheticCall = ts.factory.createCallExpression(
        rhs as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(
        ctx,
        fctx,
        syntheticCall as ts.CallExpression,
      );
    }
  }

  // Graceful fallback for non-LHSE callee: compile callee and args for side effects,
  // return externref null. Avoids hard compile errors for uncommon callee shapes.
  {
    const calleeType = compileExpression(ctx, fctx, calleeExpr);
    if (calleeType && calleeType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType && argType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
}

/**
 * Compile an IIFE (Immediately Invoked Function Expression):
 *   (function(params) { body })(args)
 *
 * Strategy: compile the function expression as a named module-level function
 * with a unique synthetic name, then emit a direct call to it.
 * Captures from the enclosing scope are passed as extra leading parameters.
 *
 * Returns undefined if the expression is not an IIFE pattern.
 */
function compileIIFE(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  // Unwrap parenthesized expression to find the function expression
  let callee = expr.expression;
  while (ts.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }
  if (!ts.isFunctionExpression(callee) && !ts.isArrowFunction(callee)) {
    return undefined; // not an IIFE
  }
  // Generator function expressions (function*) cannot be inlined as IIFEs
  // because their body uses `yield` which requires a generator FunctionContext (#657).
  if (ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined) {
    return undefined;
  }
  const funcExpr = callee as ts.FunctionExpression | ts.ArrowFunction;

  // Determine parameter types from the function's declared parameters
  const paramTypes: ValType[] = [];
  for (const p of funcExpr.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    paramTypes.push(resolveWasmType(ctx, paramType));
  }

  // Determine return type
  const sig = ctx.checker.getSignatureFromDeclaration(funcExpr);
  let returnType: ValType | null = null;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      returnType = resolveWasmType(ctx, retType);
    }
  }

  // Analyze captured variables from the enclosing scope
  const body = funcExpr.body;
  const referencedNames = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames);
  }

  // Detect which captured variables are written inside the IIFE body
  const writtenInIIFE = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectWrittenIdentifiers(stmt, writtenInIIFE);
    }
  } else {
    collectWrittenIdentifiers(body, writtenInIIFE);
  }

  const ownParamNames = new Set(
    funcExpr.parameters
      .filter((p) => ts.isIdentifier(p.name))
      .map((p) => (p.name as ts.Identifier).text),
  );

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
  }[] = [];
  for (const name of referencedNames) {
    if (ownParamNames.has(name)) continue;
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    const isMutable = writtenInIIFE.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable });
  }

  // Generate a unique name for the IIFE
  const iifeName = `__iife_${ctx.closureCounter++}`;
  const results: ValType[] = returnType ? [returnType] : [];

  // Build parameter types: for mutable captures use ref cells, others pass by value
  // Use ref_null for ref types to allow null default initialization (var hoisting)
  const captureParamTypes = captures.map((c) => {
    if (c.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
      return { kind: "ref_null" as const, typeIdx: refCellTypeIdx };
    }
    // Widen ref to ref_null so hoisted vars initialized to null can be passed
    if (c.type.kind === "ref") {
      return {
        kind: "ref_null" as const,
        typeIdx: (c.type as { typeIdx: number }).typeIdx,
      };
    }
    return c.type;
  });
  const allParamTypes = [...captureParamTypes, ...paramTypes];
  const funcTypeIdx = addFuncType(
    ctx,
    allParamTypes,
    results,
    `${iifeName}_type`,
  );

  const liftedFctx: FunctionContext = {
    name: iifeName,
    params: [
      ...captures.map((c, i) => ({
        name: c.name,
        type: captureParamTypes[i]!,
      })),
      ...funcExpr.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: paramTypes[i] ?? ({ kind: "f64" } as ValType),
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // For mutable captures, register them as boxed so read/write uses struct.get/set.
  // Also register non-mutable captures that are already boxed in the outer scope.
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, {
        refCellTypeIdx,
        valType: cap.type,
      });
    } else {
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx: outerBoxed.refCellTypeIdx, valType: outerBoxed.valType });
      }
    }
  }

  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;

  if (ts.isBlock(body)) {
    // Hoist var declarations and let/const with TDZ flags (#790)
    hoistVarDeclarations(ctx, liftedFctx, body.statements);
    hoistLetConstWithTdz(ctx, liftedFctx, body.statements);
    hoistFunctionDeclarations(ctx, liftedFctx, body.statements);
    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    // Concise arrow body — expression is the return value
    const exprType = compileExpression(ctx, liftedFctx, body);
    if (exprType === null && returnType) {
      // Push default return value
      if (returnType.kind === "f64")
        liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32")
        liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref")
        liftedFctx.body.push({ op: "ref.null.extern" });
    }
  }

  // Append default return if needed
  if (returnType) {
    const lastInstr = liftedFctx.body[liftedFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (returnType.kind === "f64")
        liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32")
        liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref")
        liftedFctx.body.push({ op: "ref.null.extern" });
    }
  }

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // Register the lifted function
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: iifeName,
    typeIdx: funcTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(iifeName, funcIdx);

  // Emit the call: push captures (with ref cells for mutable ones), then arguments, then call
  for (const cap of captures) {
    if (cap.mutable) {
      // Wrap the current value in a ref cell for mutable capture
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      // Check if the outer local is already boxed
      if (fctx.boxedCaptures?.has(cap.name)) {
        // Already a ref cell — pass directly
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        // Create a ref cell, store value, keep ref on stack
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        // Also box the outer local so subsequent reads/writes go through the ref cell
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref",
          typeIdx: refCellTypeIdx,
        });
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

  // Compile call arguments, matching to declared params; extras are evaluated and dropped
  // Flatten spread elements on array literals into individual expressions
  const flatIIFEArgs =
    flattenCallArgs(expr.arguments) ??
    (expr.arguments as unknown as ts.Expression[]);
  const paramCount = paramTypes.length;
  for (let i = 0; i < flatIIFEArgs.length; i++) {
    const arg = flatIIFEArgs[i]!;
    // Skip any remaining spread elements that couldn't be flattened
    if (ts.isSpreadElement(arg)) continue;
    if (i < paramCount) {
      compileExpression(ctx, fctx, arg, paramTypes[i]);
    } else {
      // Extra argument — evaluate for side effects, drop result
      const extraType = compileExpression(ctx, fctx, arg);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }

  // Supply defaults for missing params (use NaN sentinel for f64, #787)
  for (let i = flatIIFEArgs.length; i < paramCount; i++) {
    const pt = paramTypes[i] ?? { kind: "f64" as const };
    if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: NaN });
    else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
    else if (pt.kind === "ref" || pt.kind === "ref_null")
      fctx.body.push({ op: "ref.null", typeIdx: pt.typeIdx });
  }

  // Re-lookup in case addUnionImports shifted indices
  const finalFuncIdx = ctx.funcMap.get(iifeName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

  if (returnType) return returnType;
  return VOID_RESULT;
}

// ── New expressions ──────────────────────────────────────────────────

/** Resolve the enclosing class name from a FunctionContext.
 *  Uses enclosingClassName if set (e.g. closures), otherwise parses ClassName from "ClassName_methodName". */
function resolveEnclosingClassName(fctx: FunctionContext): string | undefined {
  if (fctx.enclosingClassName) return fctx.enclosingClassName;
  const underscoreIdx = fctx.name.indexOf("_");
  if (underscoreIdx > 0) return fctx.name.substring(0, underscoreIdx);
  return undefined;
}

/** Compile super.method(args) — resolve to ParentClass_method and call with this */
function compileSuperMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const methodName = propAccess.name.text;

  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) return null;

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
  // User-visible param count excludes self (param 0)
  const superParamCount = paramTypes
    ? paramTypes.length - 1
    : expr.arguments.length;
  for (let i = 0; i < expr.arguments.length; i++) {
    if (i < superParamCount) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
    } else {
      // Extra argument beyond method's parameter count — evaluate for
      // side effects (JS semantics) and discard the result
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null && extraType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  // Pad missing arguments with defaults (skip self param at index 0)
  if (paramTypes) {
    for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!);
    }
  }
  // Re-lookup funcIdx: argument compilation may trigger addUnionImports
  const resolvedName = `${ancestor}_${methodName}`;
  const finalSuperIdx = ctx.funcMap.get(resolvedName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalSuperIdx });

  // Determine return type
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isEffectivelyVoidReturn(ctx, retType, resolvedName)) return null;
    if (wasmFuncReturnsVoid(ctx, finalSuperIdx)) return null;
    return getWasmFuncReturnType(ctx, finalSuperIdx) ?? resolveWasmType(ctx, retType);
  }
  return null;
}

/**
 * Compile `super['method'](args)` — resolve to ParentClass_method and call with this.
 * Same logic as compileSuperMethodCall but the method name comes from a computed key.
 */
function compileSuperElementMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  methodName: string,
): ValType | null {
  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) return null;

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
  // User-visible param count excludes self (param 0)
  const superElemParamCount = paramTypes
    ? paramTypes.length - 1
    : expr.arguments.length;
  for (let i = 0; i < expr.arguments.length; i++) {
    if (i < superElemParamCount) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
    } else {
      // Extra argument beyond method's parameter count — evaluate for
      // side effects (JS semantics) and discard the result
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null && extraType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  // Pad missing arguments with defaults (skip self param at index 0)
  if (paramTypes) {
    for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!);
    }
  }
  // Re-lookup funcIdx: argument compilation may trigger addUnionImports
  const resolvedName = `${ancestor}_${methodName}`;
  const finalSuperIdx = ctx.funcMap.get(resolvedName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalSuperIdx });

  // Determine return type
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isEffectivelyVoidReturn(ctx, retType, resolvedName)) return VOID_RESULT;
    if (wasmFuncReturnsVoid(ctx, finalSuperIdx)) return VOID_RESULT;
    return getWasmFuncReturnType(ctx, finalSuperIdx) ?? resolveWasmType(ctx, retType);
  }
  return VOID_RESULT;
}

/**
 * Compile `super.prop` — access a parent class property or getter via `this`.
 * For getter accessors, calls the parent's getter function.
 * For struct fields, accesses the field on `this` (child struct inherits parent fields).
 */
export function compileSuperPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | null {
  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    ctx.errors.push({
      message: `Cannot use super outside of a class method: ${fctx.name}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

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

  // Check for parent getter accessor — walk up inheritance chain
  let ancestor: string | undefined = parentClassName;
  while (ancestor) {
    const accessorKey = `${ancestor}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${ancestor}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        // Push this as argument to the getter
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({ op: "call", funcIdx });
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fall back to struct field access on `this` — child struct includes parent fields
  // Walk up to find which ancestor defines this field
  ancestor = parentClassName;
  while (ancestor) {
    const structTypeIdx = ctx.structMap.get(ancestor);
    const fields = ctx.structFields.get(ancestor);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        // Use the current class's struct since it inherits all parent fields
        const currentStructTypeIdx = ctx.structMap.get(currentClassName);
        const currentFields = ctx.structFields.get(currentClassName);
        if (currentStructTypeIdx !== undefined && currentFields) {
          const currentFieldIdx = currentFields.findIndex(
            (f) => f.name === propName,
          );
          if (currentFieldIdx !== -1) {
            const selfIdx = fctx.localMap.get("this");
            if (selfIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: selfIdx });
            }
            fctx.body.push({
              op: "struct.get",
              typeIdx: currentStructTypeIdx,
              fieldIdx: currentFieldIdx,
            });
            return currentFields[currentFieldIdx]!.type;
          }
        }
        // If not found in current, try parent struct directly
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx,
        });
        return fields[fieldIdx]!.type;
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fallback: could be a method reference (not a call) — try to find a parent method
  // For now, emit a default based on the TypeScript type at the access site
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const wasmType = resolveWasmType(ctx, accessType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return wasmType;
}

/**
 * Compile `super[expr]` — access a parent class property via computed key on `this`.
 * Resolves the key at compile time if possible and delegates to compileSuperPropertyAccess logic.
 * For dynamic keys, falls back to default value for the access type.
 */
export function compileSuperElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  const argExpr = expr.argumentExpression;
  // Try to resolve the key to a static string
  let propName: string | undefined;
  if (argExpr) {
    if (ts.isStringLiteral(argExpr)) {
      propName = argExpr.text;
    } else if (ts.isNumericLiteral(argExpr)) {
      propName = String(Number(argExpr.text));
    } else {
      propName = resolveComputedKeyExpression(ctx, argExpr);
    }
  }

  if (propName === undefined) {
    // Dynamic key on super — cannot resolve at compile time
    // Emit default value for the access type
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const wasmType = resolveWasmType(ctx, accessType);
    if (wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType;
  }

  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    ctx.errors.push({
      message: `Cannot use super outside of a class method: ${fctx.name}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

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

  // Check for parent getter accessor — walk up inheritance chain
  let ancestor: string | undefined = parentClassName;
  while (ancestor) {
    const accessorKey = `${ancestor}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${ancestor}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({ op: "call", funcIdx });
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fall back to struct field access on `this`
  ancestor = parentClassName;
  while (ancestor) {
    const structTypeIdx = ctx.structMap.get(ancestor);
    const fields = ctx.structFields.get(ancestor);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        const currentStructTypeIdx = ctx.structMap.get(currentClassName);
        const currentFields = ctx.structFields.get(currentClassName);
        if (currentStructTypeIdx !== undefined && currentFields) {
          const currentFieldIdx = currentFields.findIndex(
            (f) => f.name === propName,
          );
          if (currentFieldIdx !== -1) {
            const selfIdx = fctx.localMap.get("this");
            if (selfIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: selfIdx });
            }
            fctx.body.push({
              op: "struct.get",
              typeIdx: currentStructTypeIdx,
              fieldIdx: currentFieldIdx,
            });
            return currentFields[currentFieldIdx]!.type;
          }
        }
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx,
        });
        return fields[fieldIdx]!.type;
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fallback: emit default value based on TypeScript type
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const wasmType = resolveWasmType(ctx, accessType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return wasmType;
}

/**
 * Infer the element type of an untyped `new Array()` by scanning how the
 * target variable is used. Walks the enclosing function body for element
 * assignments (arr[i] = value) and push calls (arr.push(value)), then
 * returns the TS element type of the first concrete (non-any) value found.
 */
function inferArrayElementType(
  ctx: CodegenContext,
  expr: ts.NewExpression,
): ts.Type | null {
  // Find the variable name this `new Array()` is assigned to.
  // Pattern: `var x = new Array()` or `var x: T = new Array()`
  const parent = expr.parent;
  let varName: string | null = null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    varName = parent.name.text;
  } else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    varName = parent.left.text;
  }
  if (!varName) return null;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = expr;
  while (
    scope &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;

  function visit(node: ts.Node) {
    if (inferredElemType) return; // already found

    // arr[i] = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === varName
    ) {
      const valType = ctx.checker.getTypeAtLocation(node.right);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    // arr.push(value)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      node.arguments.length >= 1
    ) {
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

/**
 * Check if a node tree references the `arguments` identifier
 * (skipping nested functions/arrows which have their own scope).
 */
function usesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return false;
  }
  return ts.forEachChild(node, usesArguments) ?? false;
}

/**
 * Flatten call-site arguments, expanding spread elements on array literals
 * into individual expressions. Returns the flat list of expressions.
 * For spread on non-literal arrays, returns null (cannot flatten at compile time).
 */
function flattenCallArgs(
  args: readonly ts.Expression[],
): ts.Expression[] | null {
  const result: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      if (ts.isArrayLiteralExpression(arg.expression)) {
        // Spread on array literal: inline elements
        for (const el of arg.expression.elements) {
          result.push(el);
        }
      } else {
        // Spread on non-literal — can't flatten at compile time
        return null;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

/**
 * Compile `new FunctionExpression(args)` — treats the function expression
 * as an immediately-invoked constructor. The function body is compiled
 * as a lifted closure function and called with the provided arguments.
 * Supports spread arguments and the `arguments` object.
 */
function compileNewFunctionExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  funcExpr: ts.FunctionExpression,
): ValType | null {
  const closureId = ctx.closureCounter++;
  const closureName = `__new_ctor_${closureId}`;
  const body = funcExpr.body;
  if (!body || !ts.isBlock(body)) return null;

  // 1. Flatten call-site arguments (resolve spread on array literals)
  const rawArgs = expr.arguments ?? [];
  const flatArgs = flattenCallArgs(rawArgs);
  if (!flatArgs) {
    // Can't flatten spread at compile time — unsupported
    ctx.errors.push({
      message: "new FunctionExpression with non-literal spread not supported",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  const needsArguments = usesArguments(body);

  // 2. Determine the parameter list for the lifted function
  //    Use the function's formal params if it has them, otherwise
  //    create f64 params matching the flattened call-site args.
  const formalParams: ValType[] = [];
  if (funcExpr.parameters.length > 0) {
    for (const p of funcExpr.parameters) {
      const paramType = ctx.checker.getTypeAtLocation(p);
      formalParams.push(resolveWasmType(ctx, paramType));
    }
  } else {
    // No formal params — create f64 params for each call-site arg
    for (let i = 0; i < flatArgs.length; i++) {
      formalParams.push({ kind: "f64" });
    }
  }

  // 3. Analyze captured variables
  const referencedNames = new Set<string>();
  for (const stmt of body.statements) {
    collectReferencedIdentifiers(stmt, referencedNames);
  }
  const writtenInClosure = new Set<string>();
  for (const stmt of body.statements) {
    collectWrittenIdentifiers(stmt, writtenInClosure);
  }

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
  }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const isOwnParam = funcExpr.parameters.some(
      (p) => ts.isIdentifier(p.name) && p.name.text === name,
    );
    if (isOwnParam) continue;
    if (name === "arguments") continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    const isMutable = writtenInClosure.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable });
  }

  // 4. Build the closure struct type
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
      return { name: c.name, type: c.type, mutable: false };
    }),
  ];

  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
  });

  // 5. Build the lifted function
  //    Params: (ref $closure_struct, arg0: f64, arg1: f64, ...)
  const liftedParams: ValType[] = [
    { kind: "ref", typeIdx: structTypeIdx },
    ...formalParams,
  ];

  const liftedFuncTypeIdx = addFuncType(
    ctx,
    liftedParams,
    [],
    `${closureName}_type`,
  );

  // Create the lifted function context
  const paramDefs: { name: string; type: ValType }[] = [
    { name: "__self", type: { kind: "ref", typeIdx: structTypeIdx } },
  ];
  if (funcExpr.parameters.length > 0) {
    for (let i = 0; i < funcExpr.parameters.length; i++) {
      const p = funcExpr.parameters[i]!;
      paramDefs.push({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: formalParams[i] ?? { kind: "f64" },
      });
    }
  } else {
    for (let i = 0; i < flatArgs.length; i++) {
      paramDefs.push({ name: `__arg${i}`, type: { kind: "f64" } });
    }
  }

  const liftedFctx: FunctionContext = {
    name: closureName,
    params: paramDefs,
    locals: [],
    localMap: new Map(),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // Initialize locals for captured variables from struct fields
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      const refCellType: ValType = {
        kind: "ref_null",
        typeIdx: refCellTypeIdx,
      };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      liftedFctx.body.push({ op: "local.get", index: 0 });
      liftedFctx.body.push({
        op: "struct.get",
        typeIdx: structTypeIdx,
        fieldIdx: i + 1,
      });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, {
        refCellTypeIdx,
        valType: cap.type,
      });
    } else {
      // Check if this capture is an already-boxed ref cell from the outer scope
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        const refCellType: ValType = { kind: "ref_null", typeIdx: outerBoxed.refCellTypeIdx };
        const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
        liftedFctx.body.push({ op: "local.get", index: 0 });
        liftedFctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: i + 1,
        });
        liftedFctx.body.push({ op: "local.set", index: localIdx });
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx: outerBoxed.refCellTypeIdx, valType: outerBoxed.valType });
      } else {
        const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
        liftedFctx.body.push({ op: "local.get", index: 0 });
        liftedFctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: i + 1,
        });
        liftedFctx.body.push({ op: "local.set", index: localIdx });
      }
    }
  }

  // Set up `arguments` if the body references it
  if (needsArguments) {
    // Ensure __box_number is available for boxing numeric params
    const hasNumericFormal = formalParams.some(
      (pt) => pt.kind === "f64" || pt.kind === "i32",
    );
    if (hasNumericFormal) {
      ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
    }

    const numArgs = formalParams.length;
    const elemType: ValType = { kind: "externref" };
    const vti = getOrRegisterVecType(ctx, "externref", elemType);
    const ati = getArrTypeIdxFromVec(ctx, vti);
    const vecRef: ValType = { kind: "ref", typeIdx: vti };
    const argsLocal = allocLocal(liftedFctx, "arguments", vecRef);
    const arrTmp = allocLocal(liftedFctx, "__args_arr_tmp", {
      kind: "ref",
      typeIdx: ati,
    });

    // Push each param coerced to externref
    for (let i = 0; i < numArgs; i++) {
      liftedFctx.body.push({ op: "local.get", index: i + 1 }); // skip __self
      const pt = formalParams[i]!;
      if (pt.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          liftedFctx.body.push({ op: "call", funcIdx: boxIdx });
        } else {
          liftedFctx.body.push({ op: "drop" });
          liftedFctx.body.push({ op: "ref.null.extern" });
        }
      } else if (pt.kind === "i32") {
        liftedFctx.body.push({ op: "f64.convert_i32_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          liftedFctx.body.push({ op: "call", funcIdx: boxIdx });
        } else {
          liftedFctx.body.push({ op: "drop" });
          liftedFctx.body.push({ op: "ref.null.extern" });
        }
      } else if (pt.kind === "ref" || pt.kind === "ref_null") {
        liftedFctx.body.push({ op: "extern.convert_any" });
      }
      // externref params are already externref — no conversion needed
    }
    liftedFctx.body.push({
      op: "array.new_fixed",
      typeIdx: ati,
      length: numArgs,
    });
    liftedFctx.body.push({ op: "local.set", index: arrTmp });
    liftedFctx.body.push({ op: "i32.const", value: numArgs });
    liftedFctx.body.push({ op: "local.get", index: arrTmp });
    liftedFctx.body.push({ op: "struct.new", typeIdx: vti });
    liftedFctx.body.push({ op: "local.set", index: argsLocal });
  }

  // 6. Compile the function body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;
  for (const stmt of body.statements) {
    compileStatement(ctx, liftedFctx, stmt);
  }
  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // 7. Register the lifted function
  const liftedFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: closureName,
    typeIdx: liftedFuncTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(closureName, liftedFuncIdx);

  // 8. At the call site: build closure struct, push args, call
  fctx.body.push({ op: "ref.func", funcIdx: liftedFuncIdx });
  for (const cap of captures) {
    if (cap.mutable) {
      if (fctx.boxedCaptures?.has(cap.name)) {
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref_null",
          typeIdx: refCellTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // Store closure struct in local for __self arg
  const closureLocal = allocLocal(fctx, `__ctor_closure_${closureId}`, {
    kind: "ref",
    typeIdx: structTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: closureLocal });

  // Push __self argument
  fctx.body.push({ op: "local.get", index: closureLocal });

  // Push call-site arguments (flattened, spread already resolved)
  for (let i = 0; i < flatArgs.length; i++) {
    compileExpression(ctx, fctx, flatArgs[i]!, formalParams[i]);
  }

  // Call the lifted function
  fctx.body.push({ op: "call", funcIdx: liftedFuncIdx });

  // new expression returns the constructed object — produce externref null
  // since we don't construct actual objects, and callers typically discard the result
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * Compile a ClassExpression used as a value (e.g. `x = class { ... }`).
 * The class should already be collected during the collection phase.
 * We produce the constructor function reference so the class can be instantiated.
 */
function compileClassExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ClassExpression,
): ValType | null {
  // Look up the synthetic name assigned during the collection phase
  const syntheticName = ctx.anonClassExprNames.get(expr);
  if (syntheticName) {
    const ctorName = `${syntheticName}_new`;
    const funcIdx = ctx.funcMap.get(ctorName);
    if (funcIdx !== undefined) {
      // Produce a ref.func to the constructor as the class value
      fctx.body.push({ op: "ref.func", funcIdx });
      return { kind: "funcref" };
    }
  }

  // If the class has a name, check if it was collected under that name
  if (expr.name) {
    const className = expr.name.text;
    if (ctx.classSet.has(className)) {
      const ctorName = `${className}_new`;
      const funcIdx = ctx.funcMap.get(ctorName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "ref.func", funcIdx });
        return { kind: "funcref" };
      }
    }
  }

  // Fallback: produce externref null (class was not collected)
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

function compileNewExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | null {
  // Handle `new function() { ... }(args)` — constructor with function expression
  if (ts.isFunctionExpression(expr.expression)) {
    return compileNewFunctionExpression(ctx, fctx, expr, expr.expression);
  }

  // Arrow functions are NOT constructors — `new (() => {})` throws TypeError (#730)
  {
    let unwrappedNew: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(unwrappedNew)) {
      unwrappedNew = unwrappedNew.expression;
    }
    if (ts.isArrowFunction(unwrappedNew)) {
      emitThrowString(ctx, fctx, "TypeError: is not a constructor");
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle `new (class { ... })()` — anonymous class expression in new
  // Unwrap parenthesized expressions to find the class expression
  {
    let unwrappedExpr: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(unwrappedExpr)) {
      unwrappedExpr = unwrappedExpr.expression;
    }
    if (ts.isClassExpression(unwrappedExpr)) {
      // Look up the synthetic name assigned during the collection phase
      const syntheticName = ctx.anonClassExprNames.get(unwrappedExpr);
      if (syntheticName) {
        const ctorName = `${syntheticName}_new`;
        const funcIdx = ctx.funcMap.get(ctorName);
        if (funcIdx === undefined) {
          ctx.errors.push({
            message: `Missing constructor for anonymous class`,
            line: getLine(expr),
            column: getCol(expr),
          });
          return null;
        }

        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!);
          }
        }

        fctx.body.push({ op: "call", funcIdx });
        const structTypeIdx = ctx.structMap.get(syntheticName)!;
        return { kind: "ref", typeIdx: structTypeIdx };
      }
    }
  }

  // Handle `new Promise(executor)` — delegate to host import
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
    const funcIdx = ctx.funcMap.get("Promise_new");
    if (funcIdx !== undefined) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx });
    } else {
      // No import registered — fallback to null
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle `new Number(x)`, `new String(x)`, `new Boolean(x)` — wrapper constructors
  // Return externref so typeof returns "object" (wrapper semantics).
  // Number/Boolean: box to externref via __box_number. String: already externref.
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (
      ctorName === "Number" ||
      ctorName === "String" ||
      ctorName === "Boolean"
    ) {
      const args = expr.arguments ?? [];

      if (ctorName === "Number") {
        // new Number(x) → compile x as f64, box to externref
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        addUnionImports(ctx);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boxIdx });
        }
        return { kind: "externref" };
      }

      if (ctorName === "String") {
        // new String(x) → compile x as externref string, return as externref
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        } else {
          const emptyStrResult = compileStringLiteral(ctx, fctx, "");
          if (!emptyStrResult) {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        return { kind: "externref" };
      }

      if (ctorName === "Boolean") {
        // new Boolean(x) → compile x as f64, box to externref
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        addUnionImports(ctx);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boxIdx });
        }
        return { kind: "externref" };
      }
    }
  }

  // Handle `new Error(msg)`, `new TypeError(msg)`, `new RangeError(msg)` — inline as externref
  // Instead of importing a host constructor, we represent the error as its message string
  // boxed to externref. This keeps the compilation pure-Wasm.
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (
      ctorName === "Error" ||
      ctorName === "TypeError" ||
      ctorName === "RangeError" ||
      ctorName === "SyntaxError" ||
      ctorName === "URIError" ||
      ctorName === "EvalError" ||
      ctorName === "ReferenceError" ||
      ctorName === "Test262Error"
    ) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        // Compile the message argument to externref
        const resultType = compileExpression(ctx, fctx, args[0]!, {
          kind: "externref",
        });
        if (resultType && resultType.kind !== "externref") {
          coerceType(ctx, fctx, resultType, { kind: "externref" });
        }
      } else {
        // No message — push null externref
        fctx.body.push({ op: "ref.null.extern" });
      }
      return { kind: "externref" };
    }
  }

  // Handle `new Object()` — create an empty struct (equivalent to {})
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Object") {
    // Look for an empty struct type, or create an externref null as empty object
    // In non-fast mode, an empty object is just an externref null
    // In fast mode or when we have struct types, emit a minimal struct
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Proxy(target, handler)` — compile as pass-through to target
  // Tier 0: the proxy variable behaves exactly like the target object.
  // This converts compile errors into working code for the 465+ test262 tests
  // that use Proxy. Future tiers will inline get/set traps.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Proxy") {
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      // Compile the target argument — the proxy IS the target for now
      const targetResult = compileExpression(ctx, fctx, args[0]!);
      // Drop the handler argument (don't even compile it to avoid side effects
      // from unsupported handler patterns — but we do need to compile it if it
      // has side effects... for now, just skip it)
      return targetResult;
    }
    // No arguments — null proxy
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Function(...)` — dynamic code generation is not possible in Wasm.
  // Emit a no-op function that returns undefined (ref.null extern) to prevent
  // compile errors. Tests that rely on dynamic behavior will fail at runtime
  // instead of at compile time, which is more informative.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Function") {
    // Compile and discard all arguments (they may have side effects)
    const args = expr.arguments ?? [];
    for (const arg of args) {
      const argResult = compileExpression(ctx, fctx, arg);
      if (argResult) {
        fctx.body.push({ op: "drop" });
      }
    }
    // Return ref.null extern — represents a function that returns undefined
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Date()`, `new Date(ms)`, `new Date(y, m, d, ...)` — native Date struct
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Date") {
    const dateTypeIdx = ensureDateStruct(ctx);
    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // new Date() — no clock in pure Wasm, use epoch 0
      fctx.body.push({ op: "i64.const", value: 0n } as unknown as Instr);
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    if (args.length === 1) {
      // new Date(ms) — millisecond timestamp
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    // new Date(year, month, day?, hours?, minutes?, seconds?, ms?)
    // JS months are 0-indexed. Day defaults to 1, rest default to 0.
    {
      const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);

      // Compile year
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      const yearLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: yearLocal } as Instr);

      // Compile month (0-indexed) + 1 for civil algorithm
      compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      fctx.body.push({ op: "i64.const", value: 1n } as Instr);
      fctx.body.push({ op: "i64.add" } as Instr);
      const monthLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: monthLocal } as Instr);

      // Compile day (default 1)
      if (args.length >= 3) {
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 1n } as Instr);
      }
      const dayLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: dayLocal } as Instr);

      // Compile hours (default 0)
      if (args.length >= 4) {
        compileExpression(ctx, fctx, args[3]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n } as Instr);
      }
      const hoursLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: hoursLocal } as Instr);

      // Compile minutes (default 0)
      if (args.length >= 5) {
        compileExpression(ctx, fctx, args[4]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n } as Instr);
      }
      const minutesLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: minutesLocal } as Instr);

      // Compile seconds (default 0)
      if (args.length >= 6) {
        compileExpression(ctx, fctx, args[5]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n } as Instr);
      }
      const secondsLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: secondsLocal } as Instr);

      // Compile ms (default 0)
      if (args.length >= 7) {
        compileExpression(ctx, fctx, args[6]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n } as Instr);
      }
      const msLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: msLocal } as Instr);

      // Handle year 0-99 mapping to 1900-1999 (JS Date quirk)
      // if (0 <= year <= 99) year += 1900
      fctx.body.push(
        { op: "local.get", index: yearLocal } as Instr,
        { op: "i64.const", value: 0n } as Instr,
        { op: "i64.ge_s" } as Instr,
        { op: "local.get", index: yearLocal } as Instr,
        { op: "i64.const", value: 99n } as Instr,
        { op: "i64.le_s" } as Instr,
        { op: "i32.and" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: yearLocal } as Instr,
            { op: "i64.const", value: 1900n } as Instr,
            { op: "i64.add" } as Instr,
            { op: "local.set", index: yearLocal } as Instr,
          ],
        } as unknown as Instr,
      );

      // Call days_from_civil(year, month, day) → i64 days
      fctx.body.push(
        { op: "local.get", index: yearLocal } as Instr,
        { op: "local.get", index: monthLocal } as Instr,
        { op: "local.get", index: dayLocal } as Instr,
        { op: "call", funcIdx: daysFromCivilIdx } as Instr,
      );

      // timestamp = days * 86400000 + hours * 3600000 + minutes * 60000 + seconds * 1000 + ms
      fctx.body.push(
        { op: "i64.const", value: 86400000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "local.get", index: hoursLocal } as Instr,
        { op: "i64.const", value: 3600000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: minutesLocal } as Instr,
        { op: "i64.const", value: 60000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: secondsLocal } as Instr,
        { op: "i64.const", value: 1000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: msLocal } as Instr,
        { op: "i64.add" } as Instr,
      );

      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);

      releaseTempLocal(fctx, msLocal);
      releaseTempLocal(fctx, secondsLocal);
      releaseTempLocal(fctx, minutesLocal);
      releaseTempLocal(fctx, hoursLocal);
      releaseTempLocal(fctx, dayLocal);
      releaseTempLocal(fctx, monthLocal);
      releaseTempLocal(fctx, yearLocal);

      return { kind: "ref", typeIdx: dateTypeIdx };
    }
  }

  // Handle `new TypedArray(n)` — TypedArray constructors (Uint8Array, Int32Array, Float64Array, etc.)
  // TypedArrays are fixed-length numeric arrays. We represent them as vec structs with f64 elements,
  // where length equals capacity (no dynamic growth like regular arrays).
  if (ts.isIdentifier(expr.expression)) {
    const TYPED_ARRAY_NAMES = new Set([
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
    ]);
    if (TYPED_ARRAY_NAMES.has(expr.expression.text)) {
      const elemWasm: ValType = { kind: "f64" };
      const vecTypeIdx = getOrRegisterVecType(ctx, "f64", elemWasm);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];

      if (args.length === 0) {
        // new TypedArray() → empty array, length 0
        fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      if (args.length === 1) {
        // Check if argument is a numeric literal or expression (size constructor)
        // vs an array/iterable (copy constructor)
        const argType = ctx.checker.getTypeAtLocation(args[0]!);
        const argSym = argType.getSymbol?.();
        const isArrayLike =
          argSym?.name === "Array" ||
          ((argType.flags & ts.TypeFlags.Object) !== 0 &&
            argSym?.name !== undefined &&
            TYPED_ARRAY_NAMES.has(argSym.name));

        if (!isArrayLike || ts.isNumericLiteral(args[0]!)) {
          // new TypedArray(n) → fixed-size array of length n, all zeros
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          const sizeLocal = allocLocal(
            fctx,
            `__ta_size_${fctx.locals.length}`,
            { kind: "i32" },
          );
          fctx.body.push({ op: "local.tee", index: sizeLocal }); // length = n
          fctx.body.push({ op: "local.get", index: sizeLocal });
          fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }

        // new TypedArray(arrayLike) — copy from source array
        // Compile source, then copy elements
        const srcResult = compileExpression(ctx, fctx, args[0]!);
        if (
          srcResult &&
          (srcResult.kind === "ref" || srcResult.kind === "ref_null")
        ) {
          const srcTypeIdx = (srcResult as { typeIdx: number }).typeIdx;
          const srcTypeDef = ctx.mod.types[srcTypeIdx];
          // Check if source is a vec struct
          if (
            srcTypeDef?.kind === "struct" &&
            srcTypeDef.fields[0]?.name === "length" &&
            srcTypeDef.fields[1]?.name === "data"
          ) {
            const srcVecLocal = allocLocal(
              fctx,
              `__ta_src_${fctx.locals.length}`,
              srcResult,
            );
            fctx.body.push({ op: "local.set", index: srcVecLocal });
            // Get source length
            fctx.body.push({ op: "local.get", index: srcVecLocal });
            fctx.body.push({
              op: "struct.get",
              typeIdx: srcTypeIdx,
              fieldIdx: 0,
            });
            const lenLocal = allocLocal(
              fctx,
              `__ta_len_${fctx.locals.length}`,
              { kind: "i32" },
            );
            fctx.body.push({ op: "local.tee", index: lenLocal });
            // Create new array of that length
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
            const dstDataLocal = allocLocal(
              fctx,
              `__ta_dst_${fctx.locals.length}`,
              { kind: "ref", typeIdx: arrTypeIdx },
            );
            fctx.body.push({ op: "local.set", index: dstDataLocal });

            // If source and dest have the same array type, use array.copy
            const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, srcTypeIdx);
            if (srcArrTypeIdx === arrTypeIdx) {
              fctx.body.push({ op: "local.get", index: dstDataLocal });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: srcVecLocal });
              fctx.body.push({
                op: "struct.get",
                typeIdx: srcTypeIdx,
                fieldIdx: 1,
              });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: lenLocal });
              fctx.body.push({
                op: "array.copy",
                dstTypeIdx: arrTypeIdx,
                srcTypeIdx: arrTypeIdx,
              } as Instr);
            }
            // Build result vec struct
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "local.get", index: dstDataLocal });
            fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
            return { kind: "ref_null", typeIdx: vecTypeIdx };
          }
        }
        // Fallback: treat argument as length
        // (source was already compiled and is on stack — drop it and recompile as f64)
        if (srcResult) fctx.body.push({ op: "drop" });
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        const fallbackSize = allocLocal(
          fctx,
          `__ta_fsz_${fctx.locals.length}`,
          { kind: "i32" },
        );
        fctx.body.push({ op: "local.tee", index: fallbackSize });
        fctx.body.push({ op: "local.get", index: fallbackSize });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      // new TypedArray() with multiple args — shouldn't happen per spec, but handle gracefully
      // Treat like new TypedArray(0)
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

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
  if (
    (!className || !ctx.classSet.has(className)) &&
    ts.isIdentifier(expr.expression)
  ) {
    const idName = expr.expression.text;
    if (ctx.classSet.has(idName)) {
      className = idName;
    } else {
      // Check classExprNameMap — for `let C: any; C = class { ... }; new C()`,
      // the identifier C maps to the synthetic class name via classExprNameMap.
      const mapped = ctx.classExprNameMap.get(idName);
      if (mapped && ctx.classSet.has(mapped)) {
        className = mapped;
      }
    }
  }

  if (!className) {
    // Unknown constructor (e.g. Test262Error) — call an imported constructor
    // registered upfront by collectUnknownConstructorImports.
    const ctorName = ts.isIdentifier(expr.expression)
      ? expr.expression.text
      : "__unknown";

    // RangeError validation for built-in constructors (type resolves to any
    // when lib declarations are not loaded, so className is undefined here)
    const args = expr.arguments ?? [];

    // new ArrayBuffer(byteLength) — validate non-negative integer length
    if (ctorName === "ArrayBuffer" && args.length >= 1) {
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: lenF64 });
      // Check: len != floor(len) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.floor" } as unknown as Instr);
      fctx.body.push({ op: "f64.ne" });
      // Check: len < 0
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "global.get", index: strIdx } as Instr,
            { op: "throw", tagIdx } as Instr,
          ],
          else: [],
        });
      }
    }

    // new DataView(buffer, byteOffset, byteLength) — validate offset and length
    if (ctorName === "DataView") {
      // Validate byteOffset (2nd arg) if provided
      if (args.length >= 2) {
        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        const offsetF64 = allocLocal(fctx, `__dv_offset_f64_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: offsetF64 });
        // Check: offset < 0
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check: offset != floor(offset) (NaN/non-integer)
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.floor" } as unknown as Instr);
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: Start offset is outside the bounds of the buffer";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: strIdx } as Instr,
              { op: "throw", tagIdx } as Instr,
            ],
            else: [],
          });
        }
      }
      // Validate byteLength (3rd arg) if provided
      if (args.length >= 3) {
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        const lenF64 = allocLocal(fctx, `__dv_len_f64_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // Check: len < 0
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check: len != floor(len) (NaN/non-integer)
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.floor" } as unknown as Instr);
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: Invalid DataView length";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: strIdx } as Instr,
              { op: "throw", tagIdx } as Instr,
            ],
            else: [],
          });
        }
      }
    }

    // new Array(n) — validate non-negative integer length < 2^32
    if (ctorName === "Array" && args.length === 1) {
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const nF64 = allocLocal(fctx, `__arr_n_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: nF64 });
      // Check: n != floor(n) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.floor" } as unknown as Instr);
      fctx.body.push({ op: "f64.ne" });
      // Check: n < 0
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      // Check: n >= 2^32
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.const", value: 4294967296 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "global.get", index: strIdx } as Instr,
            { op: "throw", tagIdx } as Instr,
          ],
          else: [],
        });
      }
    }

    const importName = `__new_${ctorName}`;
    const funcIdx = ctx.funcMap.get(importName);

    if (funcIdx !== undefined) {
      // Compile arguments as externref
      for (const arg of args) {
        const resultType = compileExpression(ctx, fctx, arg, {
          kind: "externref",
        });
        if (resultType && resultType.kind !== "externref") {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
      // Pad missing arguments with ref.null extern (the import may have
      // more params than this particular call site provides, since the
      // import is registered with the *max* arg count across all sites).
      const importParamTypes = getFuncParamTypes(ctx, funcIdx);
      if (importParamTypes) {
        for (let i = args.length; i < importParamTypes.length; i++) {
          pushDefaultValue(fctx, importParamTypes[i]!);
        }
      }
      // Re-lookup funcIdx: argument compilation may trigger addUnionImports
      const finalNewIdx = ctx.funcMap.get(importName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalNewIdx });
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
    const ctorRestInfo = ctx.funcRestParams.get(ctorName);

    // Check for spread arguments
    const hasSpreadCtorArg = args.some((a) => ts.isSpreadElement(a));
    if (hasSpreadCtorArg && paramTypes) {
      // Flatten spread arguments for constructor call
      const flatCtorArgs = flattenCallArgs(args);
      if (flatCtorArgs) {
        for (let i = 0; i < flatCtorArgs.length && i < paramTypes.length; i++) {
          compileExpression(ctx, fctx, flatCtorArgs[i]!, paramTypes[i]);
        }
        // Pad missing args
        for (let i = flatCtorArgs.length; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!);
        }
      } else {
        // Non-literal spread — compile via compileSpreadCallArgs
        compileSpreadCallArgs(
          ctx,
          fctx,
          expr as unknown as ts.CallExpression,
          funcIdx,
          ctorRestInfo,
        );
      }
    } else if (ctorRestInfo && !hasSpreadCtorArg) {
      // Calling a rest-param constructor: pack trailing args into a GC array
      for (let i = 0; i < ctorRestInfo.restIndex; i++) {
        if (i < args.length) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        } else {
          pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
        }
      }
      // Pack remaining arguments into a vec struct (array + length)
      const restArgCount = Math.max(0, args.length - ctorRestInfo.restIndex);
      fctx.body.push({ op: "i32.const", value: restArgCount });
      for (let i = ctorRestInfo.restIndex; i < args.length; i++) {
        compileExpression(ctx, fctx, args[i]!, ctorRestInfo.elemType);
      }
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: ctorRestInfo.arrayTypeIdx,
        length: restArgCount,
      });
      fctx.body.push({ op: "struct.new", typeIdx: ctorRestInfo.vecTypeIdx });
    } else {
      for (let i = 0; i < args.length; i++) {
        compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
      }
      // Pad missing constructor arguments with defaults (arity mismatch)
      if (paramTypes) {
        for (let i = args.length; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!);
        }
      }
    }

    // Re-lookup funcIdx: argument compilation may trigger addUnionImports
    // which shifts defined-function indices, making the earlier lookup stale.
    const finalCtorIdx = ctx.funcMap.get(ctorName) ?? funcIdx;
    fctx.body.push({ op: "call", funcIdx: finalCtorIdx });
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

  // new Uint8Array(n), new Int32Array(n), new Float64Array(n), etc. → vec struct with f64 elements
  {
    const TYPED_ARRAY_CTORS = new Set([
      "Int8Array",
      "Uint8Array",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
    ]);
    if (className && TYPED_ARRAY_CTORS.has(className)) {
      const elemType: ValType = { kind: "f64" };
      const vecTypeIdx = getOrRegisterVecType(ctx, "f64", elemType);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];

      if (args.length === 0) {
        // new Uint8Array() → empty array
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      } else {
        // new Uint8Array(n) → array of size n, all zeros
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        const sizeLocal = allocLocal(fctx, `__ta_size_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.tee", index: sizeLocal });
        fctx.body.push({ op: "local.get", index: sizeLocal });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      }
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // new ArrayBuffer(byteLength) → vec struct with i32 elements (1 byte per element)
  if (className === "ArrayBuffer") {
    const elemType: ValType = { kind: "i32" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const args = expr.arguments ?? [];

    if (args.length >= 1) {
      // new ArrayBuffer(byteLength) → create vec with byteLength elements, all 0
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });

      // RangeError validation: byteLength must be a non-negative integer < 2^31
      // (We use i32 internally so cap at i32 max)
      const lenF64Local = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: lenF64Local });
      // Check len != floor(len) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "f64.floor" } as unknown as Instr);
      fctx.body.push({ op: "f64.ne" });
      // Check len < 0
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "global.get", index: strIdx } as Instr,
            { op: "throw", tagIdx } as Instr,
          ],
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }

    const sizeLocal = allocLocal(fctx, `__ab_size_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.tee", index: sizeLocal });
    fctx.body.push({ op: "local.get", index: sizeLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // new DataView(buffer) / new DataView(buffer, byteOffset) / new DataView(buffer, byteOffset, byteLength)
  if (className === "DataView") {
    const elemType: ValType = { kind: "i32" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const args = expr.arguments ?? [];

    if (args.length >= 1) {
      // Compile buffer arg first
      const resultType = compileExpression(ctx, fctx, args[0]!);

      // Validate byteOffset (2nd arg) if provided
      if (args.length >= 2) {
        // Store buffer in local so we can access its length for validation
        const bufLocal = allocLocal(fctx, `__dv_buf_${fctx.locals.length}`,
          resultType && (resultType.kind === "ref" || resultType.kind === "ref_null")
            ? resultType : { kind: "externref" });
        fctx.body.push({ op: "local.set", index: bufLocal });

        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        const offsetF64 = allocLocal(fctx, `__dv_offset_f64_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: offsetF64 });
        // Check: offset < 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check: offset != floor(offset) (NaN/non-integer)
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.floor" } as unknown as Instr);
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });

        // If buffer is a vec struct, also check offset > bufferByteLength
        if (resultType && (resultType.kind === "ref" || resultType.kind === "ref_null")) {
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: bufLocal });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // buffer length
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
        }

        {
          const rangeErrMsg = "RangeError: Start offset is outside the bounds of the buffer";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: strIdx } as Instr,
              { op: "throw", tagIdx } as Instr,
            ],
            else: [],
          });
        }

        // Validate byteLength (3rd arg) if provided
        if (args.length >= 3) {
          compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
          const lenF64 = allocLocal(fctx, `__dv_len_f64_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: lenF64 });
          // Check: len < 0
          fctx.body.push({ op: "f64.const", value: 0 });
          fctx.body.push({ op: "f64.lt" });
          // Check: len != floor(len) (NaN/non-integer)
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "f64.floor" } as unknown as Instr);
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({ op: "i32.or" });

          // Check: offset + length > bufferByteLength
          if (resultType && (resultType.kind === "ref" || resultType.kind === "ref_null")) {
            fctx.body.push({ op: "local.get", index: offsetF64 });
            fctx.body.push({ op: "local.get", index: lenF64 });
            fctx.body.push({ op: "f64.add" });
            fctx.body.push({ op: "local.get", index: bufLocal });
            fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "f64.convert_i32_s" });
            fctx.body.push({ op: "f64.gt" });
            fctx.body.push({ op: "i32.or" });
          }

          {
            const rangeErrMsg = "RangeError: Invalid DataView length";
            addStringConstantGlobal(ctx, rangeErrMsg);
            const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
            const tagIdx = ensureExnTag(ctx);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "global.get", index: strIdx } as Instr,
                { op: "throw", tagIdx } as Instr,
              ],
              else: [],
            });
          }
        }

        // Restore buffer on stack
        fctx.body.push({ op: "local.get", index: bufLocal });
        if (resultType && (resultType.kind === "ref" || resultType.kind === "ref_null")) {
          return resultType;
        }
        if (resultType) return resultType;
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      // No offset/length args — just return buffer as-is
      if (
        resultType &&
        (resultType.kind === "ref" || resultType.kind === "ref_null")
      ) {
        return resultType;
      }
      if (resultType) return resultType;
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    } else {
      // No buffer — create empty ArrayBuffer-like vec
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
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
    const rawTypeArgs = ctx.checker.getTypeArguments(
      exprType as ts.TypeReference,
    );
    if (rawTypeArgs?.[0] && rawTypeArgs[0].flags & ts.TypeFlags.Any) {
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
      const typeArgs = ctx.checker.getTypeArguments(
        exprType as ts.TypeReference,
      );
      const elemTsType = typeArgs?.[0];
      elemWasm = elemTsType
        ? resolveWasmType(ctx, elemTsType)
        : { kind: "f64" };
    }

    if (arrTypeIdx < 0) {
      ctx.errors.push({
        message: "new Array(): invalid vec type",
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // new Array() → empty array with default backing capacity
      // JS arrays are dynamically resizable; wasm arrays are fixed-size.
      // Allocate a default backing buffer so index assignments work.
      const DEFAULT_CAPACITY = 64;
      fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
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

      // RangeError validation: n must be a non-negative integer < 2^32
      // Check: n != floor(n) || n < 0 || n >= 2^32 → throw RangeError
      const nF64Local = allocLocal(fctx, `__arr_n_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: nF64Local });
      // Check n != floor(n) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.floor" } as unknown as Instr);
      fctx.body.push({ op: "f64.ne" });
      // Check n < 0
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      // Check n >= 2^32
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 4294967296 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "i32.or" });
      // If any check true, throw RangeError
      {
        const rangeErrMsg = "RangeError: Invalid array length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "global.get", index: strIdx } as Instr,
            { op: "throw", tagIdx } as Instr,
          ],
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, {
        kind: "i32",
      });
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
    fctx.body.push({
      op: "array.new_fixed",
      typeIdx: arrTypeIdx,
      length: args.length,
    });
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: arrTypeIdx,
    });
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
export function findExternInfoForMember(
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
  const resolvedInfo = findExternInfoForMember(
    ctx,
    className,
    methodName,
    "method",
  );
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
  const extMethodParamCount = methodInfo ? methodInfo.params.length - 1 : callExpr.arguments.length;
  for (let i = 0; i < callExpr.arguments.length; i++) {
    if (i < extMethodParamCount) {
      const hint = methodInfo?.params[i + 1]; // +1 to skip 'this'
      compileExpression(ctx, fctx, callExpr.arguments[i]!, hint);
    } else {
      const extraType = compileExpression(ctx, fctx, callExpr.arguments[i]!);
      if (extraType !== null && extraType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }
  }

  // Pad missing optional args with default values
  if (methodInfo) {
    const actualArgs = Math.min(callExpr.arguments.length, extMethodParamCount) + 1; // +1 for 'this'
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

/**
 * Emit a lazy-initialized prototype global access.
 * On first access, creates a struct instance with default values and stores it
 * as externref in the global. Subsequent accesses return the same instance.
 * This gives reference identity for ClassName.prototype === Object.getPrototypeOf(instance).
 */
export function emitLazyProtoGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
): boolean {
  const protoGlobalIdx = ctx.protoGlobals?.get(className);
  if (protoGlobalIdx === undefined) return false;

  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return false;

  // Build the init body: push default values for all fields, struct.new, extern.convert_any, global.set
  const initBody: Instr[] = [];
  for (const field of fields) {
    if (field.name === "__tag") {
      const tag = ctx.classTagMap.get(className) ?? 0;
      initBody.push({ op: "i32.const", value: tag });
    } else {
      // Push default value for each field type
      switch (field.type.kind) {
        case "f64":
          initBody.push({ op: "f64.const", value: 0 });
          break;
        case "i32":
          initBody.push({ op: "i32.const", value: 0 });
          break;
        case "i64":
          initBody.push({ op: "i64.const", value: 0n });
          break;
        case "externref":
          initBody.push({ op: "ref.null.extern" });
          break;
        case "ref_null":
          initBody.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        case "ref":
          initBody.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        default:
          initBody.push({ op: "i32.const", value: 0 });
          break;
      }
    }
  }
  initBody.push({ op: "struct.new", typeIdx: structTypeIdx });
  initBody.push({ op: "extern.convert_any" });
  initBody.push({ op: "global.set", index: protoGlobalIdx });

  // Emit: if global is null, init it; then get it
  fctx.body.push({ op: "global.get", index: protoGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: initBody,
    else: [],
  });
  fctx.body.push({ op: "global.get", index: protoGlobalIdx });
  return true;
}

/**
 * After dynamically adding a field to a struct type, patch all existing
 * struct.new instructions in compiled function bodies so they push a default
 * value for the new field. Without this, struct.new expects N values on the
 * stack but the constructor only pushed N-1.
 */
function patchStructNewForDynamicField(
  ctx: CodegenContext,
  structTypeIdx: number,
  newFieldType: ValType,
): void {
  // Walk all compiled function bodies and patch struct.new instructions
  for (const func of ctx.mod.functions) {
    if (!func.body || func.body.length === 0) continue;
    patchStructNewInBody(func.body, structTypeIdx, newFieldType);
  }
  // Also patch the current function being compiled (if any)
  if (ctx.currentFunc) {
    patchStructNewInBody(ctx.currentFunc.body, structTypeIdx, newFieldType);
    // Also patch saved bodies (from pushBody/popBody pattern)
    if (ctx.currentFunc.savedBodies) {
      for (const savedBody of ctx.currentFunc.savedBodies) {
        patchStructNewInBody(savedBody, structTypeIdx, newFieldType);
      }
    }
  }
}

/** Recursively patch struct.new instructions in a body (handles nested if/block/loop). */
function patchStructNewInBody(
  body: Instr[],
  structTypeIdx: number,
  newFieldType: ValType,
): void {
  for (let i = 0; i < body.length; i++) {
    const instr = body[i]!;
    if (instr.op === "struct.new" && (instr as any).typeIdx === structTypeIdx) {
      // Insert default value instruction before this struct.new
      const defaultInstr = defaultValueInstrForType(newFieldType);
      body.splice(i, 0, ...defaultInstr);
      i += defaultInstr.length; // skip past inserted instructions
    }
    // Recurse into nested blocks
    if ((instr as any).then)
      patchStructNewInBody((instr as any).then, structTypeIdx, newFieldType);
    if ((instr as any).else)
      patchStructNewInBody((instr as any).else, structTypeIdx, newFieldType);
    if ((instr as any).body) {
      // block, loop, try instructions
      const nestedBody = (instr as any).body;
      if (Array.isArray(nestedBody))
        patchStructNewInBody(nestedBody, structTypeIdx, newFieldType);
    }
    if ((instr as any).instrs) {
      const nestedInstrs = (instr as any).instrs;
      if (Array.isArray(nestedInstrs))
        patchStructNewInBody(nestedInstrs, structTypeIdx, newFieldType);
    }
    // try/catch blocks
    if ((instr as any).catches) {
      for (const c of (instr as any).catches) {
        if (Array.isArray(c.body))
          patchStructNewInBody(c.body, structTypeIdx, newFieldType);
      }
    }
    if ((instr as any).catchAll) {
      if (Array.isArray((instr as any).catchAll))
        patchStructNewInBody(
          (instr as any).catchAll,
          structTypeIdx,
          newFieldType,
        );
    }
  }
}

/** Return instructions that produce a default value for a given type. */
function defaultValueInstrForType(type: ValType): Instr[] {
  switch (type.kind) {
    case "f64":
      return [{ op: "f64.const", value: 0 } as Instr];
    case "i32":
      return [{ op: "i32.const", value: 0 } as Instr];
    case "externref":
      return [{ op: "ref.null.extern" } as Instr];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: type.typeIdx } as Instr];
    case "ref":
      return [
        { op: "ref.null", typeIdx: type.typeIdx } as Instr,
        { op: "ref.as_non_null" } as Instr,
      ];
    case "eqref":
      return [{ op: "ref.null.eq" }];
    default:
      return [{ op: "i32.const", value: 0 } as Instr];
  }
}

/**
 * Emit a null-guarded struct.get: if the object ref on the stack is null (e.g.
 * from a failed ref.cast that returned ref.null), produce a default value
 * instead of trapping. This handles wrong-type-but-not-truly-null cases. If the
 * source value is truly null/undefined, the TypeError is thrown on the
 * externref __extern_get path instead.
 * push a default value instead of trapping.
 *
 * Expects the object ref to be on the Wasm stack. Emits:
 *   local.tee $tmp
 *   ref.is_null
 *   if (result fieldType)
 *     <default_value>
 *   else
 *     local.get $tmp
 *     struct.get typeIdx fieldIdx
 *   end
 *
 * Returns the field's ValType.
 */

/**
 * Emit instructions that throw a TypeError via the Wasm exception tag.
 * Pushes a null externref as the exception payload and then emits `throw`.
 * This is used for null/undefined property access, calling non-functions, etc.
 *
 * Returns an array of instructions (for use inside if-then blocks).
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
        fctx.body.push({
          op: "array.new_fixed",
          typeIdx: restInfo.arrayTypeIdx,
          length: 1,
        });
        fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
      }
    } else {
      // No rest args provided — pass empty vec struct { 0, [] }
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: restInfo.arrayTypeIdx,
        length: 0,
      });
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
      if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null"))
        continue;

      const vecTypeDef = ctx.mod.types[vecType.typeIdx];
      if (!vecTypeDef || vecTypeDef.kind !== "struct") continue;

      // Extract data array from vec struct
      const vecLocal = allocLocal(
        fctx,
        `__spread_vec_${fctx.locals.length}`,
        vecType,
      );
      fctx.body.push({ op: "local.set", index: vecLocal });

      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecType.typeIdx);
      if (arrTypeIdx < 0) continue;
      const dataLocal = allocLocal(
        fctx,
        `__spread_data_${fctx.locals.length}`,
        { kind: "ref_null", typeIdx: arrTypeIdx },
      );
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({
        op: "struct.get",
        typeIdx: vecType.typeIdx,
        fieldIdx: 1,
      });
      fctx.body.push({ op: "local.set", index: dataLocal });

      // Extract elements up to the remaining parameter count
      const arrDefSpread = ctx.mod.types[arrTypeIdx];
      const spreadElemType =
        arrDefSpread && arrDefSpread.kind === "array"
          ? arrDefSpread.element
          : { kind: "f64" as const };
      const remainingParams = paramTypes.length - paramIdx;
      for (let i = 0; i < remainingParams; i++) {
        fctx.body.push({ op: "local.get", index: dataLocal });
        fctx.body.push({ op: "i32.const", value: i });
        emitBoundsCheckedArrayGet(fctx, arrTypeIdx, spreadElemType);
        // Coerce spread element to expected param type if they differ
        const expectedParamType = paramTypes[paramIdx];
        if (expectedParamType && !valTypesMatch(spreadElemType, expectedParamType)) {
          coerceType(ctx, fctx, spreadElemType, expectedParamType);
        }
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
  // WASI mode: emit fd_write to stdout instead of JS host imports
  if (ctx.wasi) {
    return compileConsoleCallWasi(ctx, fctx, expr, method);
  }

  for (const arg of expr.arguments) {
    const argType = ctx.checker.getTypeAtLocation(arg);
    compileExpression(ctx, fctx, arg);

    if (isStringType(argType)) {
      // Fast mode: flatten + marshal native string to externref before passing to host
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
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

// ─── Date support ───────────────────────────────────────────────────────────
// Date is represented as a WasmGC struct with a single mutable i64 field
// (milliseconds since Unix epoch, UTC).  All getters decompose the timestamp
// using Howard Hinnant's civil_from_days algorithm, implemented purely in
// i64 arithmetic — no host imports needed.

/** Ensure the $__Date struct type exists, return its type index. */
function ensureDateStruct(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("__Date");
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__Date",
    fields: [{ name: "timestamp", type: { kind: "i64" }, mutable: true }],
  });
  ctx.structMap.set("__Date", typeIdx);
  ctx.structFields.set("__Date", [
    { name: "timestamp", type: { kind: "i64" }, mutable: true },
  ]);
  return typeIdx;
}

/**
 * Ensure the __date_civil_from_days helper function exists.
 * Signature: (i64 days_since_epoch) -> (i64 packed)
 *   packed = year * 10000 + month * 100 + day
 *   (month 1-12, day 1-31)
 *
 * Uses Hinnant's algorithm: http://howardhinnant.github.io/date_algorithms.html#civil_from_days
 */
function ensureDateCivilHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_civil_from_days");
  if (existing !== undefined) return existing;

  // func (param $z i64) (result i64)
  // locals: $z(0), $era(1), $doe(2), $yoe(3), $doy(4), $mp(5), $y(6), $m(7), $d(8)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "i64" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_civil_from_days", funcIdx);

  const body: Instr[] = [];

  // z += 719468  (shift epoch from 1970-01-01 to 0000-03-01)
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 719468n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 0 } as Instr,
  );

  // era = (z >= 0 ? z : z - 146096) / 146097
  // We use i64.div_s which floors toward zero, so we need the adjustment
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 0n } as Instr,
    { op: "i64.ge_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 } as Instr],
      else: [
        { op: "local.get", index: 0 } as Instr,
        { op: "i64.const", value: 146096n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    } as unknown as Instr,
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 1 } as Instr, // era
  );

  // doe = z - era * 146097  (day of era, [0, 146096])
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 2 } as Instr, // doe
  );

  // yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365
  body.push(
    { op: "local.get", index: 2 } as Instr, // doe
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 1460n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 36524n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 146096n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.const", value: 365n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 3 } as Instr, // yoe
  );

  // y = yoe + era * 400
  body.push(
    { op: "local.get", index: 3 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr, // y (still March-based)
  );

  // doy = doe - (365*yoe + yoe/4 - yoe/100)
  body.push(
    { op: "local.get", index: 2 } as Instr, // doe
    { op: "i64.const", value: 365n } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 4n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 4 } as Instr, // doy
  );

  // mp = (5*doy + 2) / 153
  body.push(
    { op: "i64.const", value: 5n } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 153n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 5 } as Instr, // mp
  );

  // d = doy - (153*mp + 2)/5 + 1
  body.push(
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 153n } as Instr,
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 5n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.const", value: 1n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 8 } as Instr, // d
  );

  // m = mp < 10 ? mp + 3 : mp - 9
  body.push(
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.const", value: 10n } as Instr,
    { op: "i64.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 5 } as Instr,
        { op: "i64.const", value: 3n } as Instr,
        { op: "i64.add" } as Instr,
      ],
      else: [
        { op: "local.get", index: 5 } as Instr,
        { op: "i64.const", value: 9n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    } as unknown as Instr,
    { op: "local.set", index: 7 } as Instr, // m (1-12)
  );

  // y += (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 6 } as Instr,
    { op: "local.get", index: 7 } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.le_s" } as Instr,
    { op: "i64.extend_i32_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr, // y (adjusted)
  );

  // return y * 10000 + m * 100 + d
  body.push(
    { op: "local.get", index: 6 } as Instr,
    { op: "i64.const", value: 10000n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 7 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 8 } as Instr,
    { op: "i64.add" } as Instr,
  );

  ctx.mod.functions.push({
    name: "__date_civil_from_days",
    typeIdx: funcTypeIdx,
    locals: [
      // 0: z (param), 1: era, 2: doe, 3: yoe, 4: doy, 5: mp, 6: y, 7: m, 8: d
      { name: "$era", type: { kind: "i64" } },
      { name: "$doe", type: { kind: "i64" } },
      { name: "$yoe", type: { kind: "i64" } },
      { name: "$doy", type: { kind: "i64" } },
      { name: "$mp", type: { kind: "i64" } },
      { name: "$y", type: { kind: "i64" } },
      { name: "$m", type: { kind: "i64" } },
      { name: "$d", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Ensure the __date_days_from_civil helper function exists.
 * Signature: (i64 year, i64 month, i64 day) -> i64 days_since_epoch
 *
 * Implements Hinnant's days_from_civil algorithm (inverse of civil_from_days).
 */
function ensureDateDaysFromCivilHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_days_from_civil");
  if (existing !== undefined) return existing;

  // func (param $y i64) (param $m i64) (param $d i64) (result i64)
  // locals: $y(0), $m(1), $d(2), $era(3), $yoe(4), $doy(5), $doe(6)
  const funcTypeIdx = addFuncType(
    ctx,
    [{ kind: "i64" }, { kind: "i64" }, { kind: "i64" }],
    [{ kind: "i64" }],
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_days_from_civil", funcIdx);

  const body: Instr[] = [];

  // y -= (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 0 } as Instr, // y
    { op: "local.get", index: 1 } as Instr, // m
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.le_s" } as Instr,
    { op: "i64.extend_i32_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 0 } as Instr, // y adjusted
  );

  // era = (y >= 0 ? y : y - 399) / 400
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 0n } as Instr,
    { op: "i64.ge_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 } as Instr],
      else: [
        { op: "local.get", index: 0 } as Instr,
        { op: "i64.const", value: 399n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    } as unknown as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 3 } as Instr, // era
  );

  // yoe = y - era * 400
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 4 } as Instr, // yoe
  );

  // doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1
  body.push(
    { op: "i64.const", value: 153n } as Instr,
    { op: "local.get", index: 1 } as Instr, // m
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.gt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 1 } as Instr,
        { op: "i64.const", value: 3n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
      else: [
        { op: "local.get", index: 1 } as Instr,
        { op: "i64.const", value: 9n } as Instr,
        { op: "i64.add" } as Instr,
      ],
    } as unknown as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 5n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.get", index: 2 } as Instr, // d
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 1n } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 5 } as Instr, // doy
  );

  // doe = yoe * 365 + yoe/4 - yoe/100 + doy
  body.push(
    { op: "local.get", index: 4 } as Instr, // yoe
    { op: "i64.const", value: 365n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 4n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr, // doe
  );

  // return era * 146097 + doe - 719468
  body.push(
    { op: "local.get", index: 3 } as Instr, // era
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 6 } as Instr, // doe
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 719468n } as Instr,
    { op: "i64.sub" } as Instr,
  );

  ctx.mod.functions.push({
    name: "__date_days_from_civil",
    typeIdx: funcTypeIdx,
    locals: [
      // 3: era, 4: yoe, 5: doy, 6: doe
      { name: "$era", type: { kind: "i64" } },
      { name: "$yoe", type: { kind: "i64" } },
      { name: "$doy", type: { kind: "i64" } },
      { name: "$doe", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Compile a Date method call on a Date struct receiver.
 * Returns undefined if this is not a Date method (caller should continue).
 */
function compileDateMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
): InnerResult | undefined {
  const methodName = propAccess.name.text;
  const symName = receiverType.getSymbol()?.name;
  if (symName !== "Date") return undefined;

  const DATE_METHODS = new Set([
    "getTime",
    "valueOf",
    "getFullYear",
    "getMonth",
    "getDate",
    "getHours",
    "getMinutes",
    "getSeconds",
    "getMilliseconds",
    "getDay",
    "setTime",
    "getTimezoneOffset",
    "getUTCFullYear",
    "getUTCMonth",
    "getUTCDate",
    "getUTCHours",
    "getUTCMinutes",
    "getUTCSeconds",
    "getUTCMilliseconds",
    "getUTCDay",
    "toISOString",
    "toJSON",
    "toString",
    "toDateString",
    "toTimeString",
    "toLocaleDateString",
    "toLocaleTimeString",
    "toLocaleString",
    "toUTCString",
    "toGMTString",
  ]);
  if (!DATE_METHODS.has(methodName)) return undefined;

  const dateTypeIdx = ensureDateStruct(ctx);
  const dateRefType: ValType = { kind: "ref", typeIdx: dateTypeIdx };

  // Compile receiver — the Date struct
  const recvResult = compileExpression(
    ctx,
    fctx,
    propAccess.expression,
    dateRefType,
  );
  if (!recvResult) return null;

  // getTime / valueOf: read i64 timestamp, convert to f64
  if (methodName === "getTime" || methodName === "valueOf") {
    fctx.body.push({
      op: "struct.get",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    } as unknown as Instr);
    fctx.body.push({ op: "f64.convert_i64_s" } as Instr);
    return { kind: "f64" };
  }

  // getTimezoneOffset: always 0 (we operate in UTC)
  if (methodName === "getTimezoneOffset") {
    fctx.body.push({ op: "drop" } as Instr);
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    return { kind: "f64" };
  }

  // setTime(ms): update the timestamp field
  if (methodName === "setTime") {
    // We need the ref on stack, but also need the new value
    // Stack: [dateRef]
    // Compile the argument
    const tempLocal = allocTempLocal(fctx, dateRefType);
    fctx.body.push({ op: "local.set", index: tempLocal } as Instr);
    // Get the new timestamp
    if (callExpr.arguments.length >= 1) {
      fctx.body.push({ op: "local.get", index: tempLocal } as Instr);
      compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      fctx.body.push({
        op: "struct.set",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      } as unknown as Instr);
      // Return the new timestamp as f64
      fctx.body.push({ op: "local.get", index: tempLocal } as Instr);
      fctx.body.push({
        op: "struct.get",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      } as unknown as Instr);
      fctx.body.push({ op: "f64.convert_i64_s" } as Instr);
    } else {
      fctx.body.push({ op: "f64.const", value: NaN } as Instr);
    }
    releaseTempLocal(fctx, tempLocal);
    return { kind: "f64" };
  }

  // For all time-component getters, we need the i64 timestamp
  // Stack: [dateRef]
  fctx.body.push({
    op: "struct.get",
    typeIdx: dateTypeIdx,
    fieldIdx: 0,
  } as unknown as Instr);
  // Stack: [i64 timestamp]

  // Time-of-day getters (no civil calendar needed)
  const MS_PER_DAY = 86400000n;
  const MS_PER_HOUR = 3600000n;
  const MS_PER_MINUTE = 60000n;
  const MS_PER_SECOND = 1000n;

  if (methodName === "getHours" || methodName === "getUTCHours") {
    // hours = ((timestamp % 86400000) + 86400000) % 86400000 / 3600000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getMinutes" || methodName === "getUTCMinutes") {
    // minutes = ((timestamp % 3600000) + 3600000) % 3600000 / 60000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getSeconds" || methodName === "getUTCSeconds") {
    // seconds = ((timestamp % 60000) + 60000) % 60000 / 1000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getMilliseconds" || methodName === "getUTCMilliseconds") {
    // ms = ((timestamp % 1000) + 1000) % 1000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  // getDay / getUTCDay: day of week (0=Sunday)
  // (floor(timestamp / 86400000) + 4) % 7  (1970-01-01 was Thursday = 4)
  if (methodName === "getDay" || methodName === "getUTCDay") {
    // We need to handle negative timestamps correctly:
    // days = floor(ts / 86400000) — for negative, use (ts - 86399999) / 86400000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.div_s" } as Instr,
      // For negative timestamps, i64.div_s truncates toward zero, but we want floor division
      // This is fine because we handle the modular arithmetic with the +7 % 7 below
      { op: "i64.const", value: 4n } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: 7n } as Instr,
      { op: "i64.rem_s" } as Instr,
      // Handle negative remainder: ((result % 7) + 7) % 7
      { op: "i64.const", value: 7n } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: 7n } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  // Calendar getters need civil_from_days
  // Stack: [i64 timestamp]
  // First compute days: floor(timestamp / 86400000)
  // For negative timestamps we need floor division, not truncation.
  // floor_div(a, b) for positive b: (a >= 0) ? a/b : (a - b + 1) / b
  const civilIdx = ensureDateCivilHelper(ctx);

  // Compute floor division of timestamp by MS_PER_DAY
  // Since i64.div_s truncates toward zero, we need to adjust for negative values
  {
    const tempTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: tempTs } as Instr);

    // if (ts >= 0) ts / 86400000 else (ts - 86399999) / 86400000
    fctx.body.push(
      { op: "local.get", index: tempTs } as Instr,
      { op: "i64.const", value: 0n } as Instr,
      { op: "i64.ge_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [
          { op: "local.get", index: tempTs } as Instr,
          { op: "i64.const", value: MS_PER_DAY } as Instr,
          { op: "i64.div_s" } as Instr,
        ],
        else: [
          { op: "local.get", index: tempTs } as Instr,
          { op: "i64.const", value: MS_PER_DAY - 1n } as Instr,
          { op: "i64.sub" } as Instr,
          { op: "i64.const", value: MS_PER_DAY } as Instr,
          { op: "i64.div_s" } as Instr,
        ],
      } as unknown as Instr,
    );
    releaseTempLocal(fctx, tempTs);
  }

  // Stack: [i64 days_since_epoch]
  fctx.body.push({ op: "call", funcIdx: civilIdx } as Instr);
  // Stack: [i64 packed = year*10000 + month*100 + day]

  if (methodName === "getFullYear" || methodName === "getUTCFullYear") {
    // year = packed / 10000
    fctx.body.push(
      { op: "i64.const", value: 10000n } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getMonth" || methodName === "getUTCMonth") {
    // month = (packed / 100) % 100 - 1  (JS months are 0-indexed)
    fctx.body.push(
      { op: "i64.const", value: 100n } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "i64.const", value: 100n } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: 1n } as Instr,
      { op: "i64.sub" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getDate" || methodName === "getUTCDate") {
    // day = packed % 100
    fctx.body.push(
      { op: "i64.const", value: 100n } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  // toISOString / toJSON: emit a formatted string
  if (methodName === "toISOString" || methodName === "toJSON") {
    // For now, drop the packed civil date and return a placeholder
    // A full implementation would format as "YYYY-MM-DDTHH:MM:SS.sssZ"
    // but that requires string building which is complex. Return the timestamp as a string.
    fctx.body.push({ op: "drop" } as Instr);
    return compileStringLiteral(ctx, fctx, "1970-01-01T00:00:00.000Z");
  }

  // toString / toDateString / toTimeString / toLocale* / toUTCString / toGMTString:
  // Stub implementations — return a placeholder string representation.
  // Full formatting would require complex string building; for now return a fixed string.
  const STRING_DATE_METHODS = new Set([
    "toString",
    "toDateString",
    "toTimeString",
    "toLocaleDateString",
    "toLocaleTimeString",
    "toLocaleString",
    "toUTCString",
    "toGMTString",
  ]);
  if (STRING_DATE_METHODS.has(methodName)) {
    fctx.body.push({ op: "drop" } as Instr);
    return compileStringLiteral(ctx, fctx, "Thu Jan 01 1970 00:00:00 GMT+0000");
  }

  // Shouldn't reach here
  fctx.body.push({ op: "drop" } as Instr);
  fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  return { kind: "f64" };
}

/** WASI mode: compile console.log/warn/error by writing UTF-8 to stdout via fd_write */
function compileConsoleCallWasi(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  _method: string,
): InnerResult {
  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined) return VOID_RESULT;

  let first = true;
  for (const arg of expr.arguments) {
    // Add space separator between arguments (like console.log does)
    if (!first) {
      const spaceData = wasiAllocStringData(ctx, " ");
      fctx.body.push({ op: "i32.const", value: spaceData.offset } as Instr);
      fctx.body.push({ op: "i32.const", value: spaceData.length } as Instr);
      fctx.body.push({ op: "call", funcIdx: writeStringIdx });
    }
    first = false;

    // Check if this is a string literal we can embed directly
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      const strValue = arg.text;
      const data = wasiAllocStringData(ctx, strValue);
      fctx.body.push({ op: "i32.const", value: data.offset } as Instr);
      fctx.body.push({ op: "i32.const", value: data.length } as Instr);
      fctx.body.push({ op: "call", funcIdx: writeStringIdx });
    } else if (ts.isTemplateExpression(arg)) {
      // Template literal: handle head + spans
      if (arg.head.text) {
        const headData = wasiAllocStringData(ctx, arg.head.text);
        fctx.body.push({ op: "i32.const", value: headData.offset } as Instr);
        fctx.body.push({ op: "i32.const", value: headData.length } as Instr);
        fctx.body.push({ op: "call", funcIdx: writeStringIdx });
      }
      for (const span of arg.templateSpans) {
        // Compile the expression and convert to string output
        const exprType = compileExpression(ctx, fctx, span.expression);
        emitWasiValueToStdout(ctx, fctx, exprType, span.expression);
        if (span.literal.text) {
          const litData = wasiAllocStringData(ctx, span.literal.text);
          fctx.body.push({ op: "i32.const", value: litData.offset } as Instr);
          fctx.body.push({ op: "i32.const", value: litData.length } as Instr);
          fctx.body.push({ op: "call", funcIdx: writeStringIdx });
        }
      }
    } else {
      // For non-literal arguments, compile the expression and handle by type
      const argType = ctx.checker.getTypeAtLocation(arg);
      const exprType = compileExpression(ctx, fctx, arg);
      emitWasiValueToStdout(ctx, fctx, exprType, arg);
    }
  }

  // Emit newline at the end
  const newlineData = wasiAllocStringData(ctx, "\n");
  fctx.body.push({ op: "i32.const", value: newlineData.offset } as Instr);
  fctx.body.push({ op: "i32.const", value: newlineData.length } as Instr);
  fctx.body.push({ op: "call", funcIdx: writeStringIdx });

  return VOID_RESULT;
}

/** Allocate a UTF-8 string in a data segment and return its offset/length */
function wasiAllocStringData(
  ctx: CodegenContext,
  str: string,
): { offset: number; length: number } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);

  // Find the next available offset in data segments
  // Data segments start after the scratch area (offset 1024)
  let offset = 1024;
  for (const seg of ctx.mod.dataSegments) {
    const segEnd = seg.offset + seg.bytes.length;
    if (segEnd > offset) offset = segEnd;
  }

  ctx.mod.dataSegments.push({ offset, bytes });
  return { offset, length: bytes.length };
}

/** Emit code to write a compiled value to stdout in WASI mode */
function emitWasiValueToStdout(
  ctx: CodegenContext,
  fctx: FunctionContext,
  exprType: InnerResult,
  _node: ts.Node,
): void {
  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined) return;

  if (exprType === VOID_RESULT || exprType === null) {
    // void expression, nothing to write — drop already handled
    return;
  }

  if (exprType.kind === "f64") {
    // Number: use __wasi_write_f64 helper (emit inline if not yet registered)
    const writeF64Idx = ensureWasiWriteF64Helper(ctx);
    if (writeF64Idx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeF64Idx });
    } else {
      fctx.body.push({ op: "drop" } as Instr);
    }
  } else if (exprType.kind === "i32") {
    // Boolean or i32: write "true"/"false" or the integer
    const writeI32Idx = ensureWasiWriteI32Helper(ctx);
    if (writeI32Idx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeI32Idx });
    } else {
      fctx.body.push({ op: "drop" } as Instr);
    }
  } else {
    // For other types (externref, ref, etc.), just drop and write a placeholder
    fctx.body.push({ op: "drop" } as Instr);
    const placeholder = wasiAllocStringData(ctx, "[object]");
    fctx.body.push({ op: "i32.const", value: placeholder.offset } as Instr);
    fctx.body.push({ op: "i32.const", value: placeholder.length } as Instr);
    fctx.body.push({ op: "call", funcIdx: writeStringIdx });
  }
}

/** Ensure the __wasi_write_i32 helper exists and return its function index */
function ensureWasiWriteI32Helper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__wasi_write_i32");
  if (existing !== undefined) return existing;

  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined) return -1;

  // Simple i32 to decimal string conversion
  // Uses bump allocator to write digits to linear memory
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_i32", funcIdx);

  // Algorithm: handle negative, then extract digits in reverse, then write forward
  // Locals: 0=value, 1=buf_start, 2=buf_pos, 3=is_neg, 4=digit
  const body: Instr[] = [];

  // For simplicity, handle 0 specially, negatives, and positive integers
  // We allocate a 12-byte buffer on the bump allocator for the digit string
  const bufStartLocal = 1; // local index
  const bufPosLocal = 2;
  const isNegLocal = 3;
  const absValLocal = 4;
  const tmpLocal = 5;

  body.push(
    // buf_start = bump_ptr
    { op: "global.get", index: ctx.wasiBumpPtrGlobalIdx } as Instr,
    { op: "local.set", index: bufStartLocal } as Instr,
    // buf_pos = buf_start + 11 (write digits right-to-left, max 11 digits + sign)
    { op: "local.get", index: bufStartLocal } as Instr,
    { op: "i32.const", value: 11 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: bufPosLocal } as Instr,

    // Check if value == 0
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.eqz" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Write "0" directly
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 48 } as Instr, // '0'
        { op: "i32.store8", align: 0, offset: 0 } as Instr,
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check if negative
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.lt_s" } as Instr,
    { op: "local.set", index: isNegLocal } as Instr,

    // absVal = is_neg ? -value : value
    { op: "local.get", index: isNegLocal } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: 0 } as Instr,
        { op: "i32.sub" } as Instr,
      ],
      else: [{ op: "local.get", index: 0 } as Instr],
    },
    { op: "local.set", index: absValLocal } as Instr,

    // Loop: extract digits right to left
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if absVal == 0, break
            { op: "local.get", index: absValLocal } as Instr,
            { op: "i32.eqz" } as Instr,
            { op: "br_if", depth: 1 } as Instr,

            // digit = absVal % 10
            { op: "local.get", index: absValLocal } as Instr,
            { op: "i32.const", value: 10 } as Instr,
            { op: "i32.rem_u" } as Instr,
            { op: "local.set", index: tmpLocal } as Instr,

            // absVal = absVal / 10
            { op: "local.get", index: absValLocal } as Instr,
            { op: "i32.const", value: 10 } as Instr,
            { op: "i32.div_u" } as Instr,
            { op: "local.set", index: absValLocal } as Instr,

            // buf_pos--
            { op: "local.get", index: bufPosLocal } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.sub" } as Instr,
            { op: "local.set", index: bufPosLocal } as Instr,

            // memory[buf_pos] = digit + '0'
            { op: "local.get", index: bufPosLocal } as Instr,
            { op: "local.get", index: tmpLocal } as Instr,
            { op: "i32.const", value: 48 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "i32.store8", align: 0, offset: 0 } as Instr,

            // continue loop
            { op: "br", depth: 0 } as Instr,
          ],
        },
      ],
    },

    // If negative, prepend '-'
    { op: "local.get", index: isNegLocal } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "local.set", index: bufPosLocal } as Instr,
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 45 } as Instr, // '-'
        { op: "i32.store8", align: 0, offset: 0 } as Instr,
      ],
    },

    // Call __wasi_write_string(buf_pos, buf_start + 12 - buf_pos)
    { op: "local.get", index: bufPosLocal } as Instr,
    { op: "local.get", index: bufStartLocal } as Instr,
    { op: "i32.const", value: 12 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.get", index: bufPosLocal } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "call", funcIdx: writeStringIdx } as Instr,
  );

  ctx.mod.functions.push({
    name: "__wasi_write_i32",
    typeIdx: funcTypeIdx,
    locals: [
      { name: "buf_start", type: { kind: "i32" } },
      { name: "buf_pos", type: { kind: "i32" } },
      { name: "is_neg", type: { kind: "i32" } },
      { name: "abs_val", type: { kind: "i32" } },
      { name: "tmp", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/** Ensure the __wasi_write_f64 helper exists and return its function index */
function ensureWasiWriteF64Helper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__wasi_write_f64");
  if (existing !== undefined) return existing;

  const writeI32Idx = ensureWasiWriteI32Helper(ctx);
  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined || writeI32Idx < 0) return -1;

  // Simple f64 output: truncate to i32 and print as integer
  // For NaN, Infinity, -Infinity, handle specially
  const funcTypeIdx = addFuncType(ctx, [{ kind: "f64" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_f64", funcIdx);

  // Allocate data segments for special values
  const nanData = wasiAllocStringData(ctx, "NaN");
  const infData = wasiAllocStringData(ctx, "Infinity");
  const negInfData = wasiAllocStringData(ctx, "-Infinity");

  const body: Instr[] = [
    // Check NaN: value != value
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.ne" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: nanData.offset } as Instr,
        { op: "i32.const", value: nanData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check positive infinity
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.const", value: Infinity } as Instr,
    { op: "f64.eq" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: infData.offset } as Instr,
        { op: "i32.const", value: infData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check negative infinity
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.const", value: -Infinity } as Instr,
    { op: "f64.eq" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: negInfData.offset } as Instr,
        { op: "i32.const", value: negInfData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Normal number: truncate to i32 and print
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.trunc_sat_f64_s" } as Instr,
    { op: "call", funcIdx: writeI32Idx } as Instr,
  ];

  ctx.mod.functions.push({
    name: "__wasi_write_f64",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });

  return funcIdx;
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
    // JS Math.round: compare frac = x - floor(x) to 0.5.
    // If frac >= 0.5 use ceil(x), else floor(x). Preserves -0 via copysign.
    // This avoids precision loss from floor(x + 0.5) with large odd integers near 2^52.
    const xLocal = allocLocal(fctx, `__round_x_${fctx.locals.length}`, {
      kind: "f64",
    });
    const floorLocal = allocLocal(fctx, `__round_fl_${fctx.locals.length}`, {
      kind: "f64",
    });
    const rLocal = allocLocal(fctx, `__round_r_${fctx.locals.length}`, {
      kind: "f64",
    });
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "local.tee", index: xLocal } as Instr);
    fctx.body.push({ op: "f64.floor" } as Instr);
    fctx.body.push({ op: "local.set", index: floorLocal } as Instr);
    // frac = x - floor(x)
    fctx.body.push({ op: "local.get", index: xLocal } as Instr);
    fctx.body.push({ op: "local.get", index: floorLocal } as Instr);
    fctx.body.push({ op: "f64.sub" } as Instr);
    // frac >= 0.5 ? ceil(x) : floor(x)
    fctx.body.push({ op: "f64.const", value: 0.5 } as Instr);
    fctx.body.push({ op: "f64.ge" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: xLocal } as Instr,
        { op: "f64.ceil" } as Instr,
      ],
      else: [{ op: "local.get", index: floorLocal } as Instr],
    } as Instr);
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
        { op: "f64.copysign" },
      ],
      else: [{ op: "local.get", index: rLocal } as Instr],
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
    const tmp = allocLocal(fctx, `__sign_${fctx.locals.length}`, {
      kind: "f64",
    });
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
            { op: "f64.copysign" },
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
      const loc = allocLocal(fctx, `__hypot_${fctx.locals.length}`, {
        kind: "f64",
      });
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
    "exp",
    "log",
    "log2",
    "log10",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "acosh",
    "asinh",
    "atanh",
    "cbrt",
    "expm1",
    "log1p",
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
      fctx.body.push({
        op: "f64.const",
        value: method === "min" ? Infinity : -Infinity,
      } as Instr);
      return { kind: "f64" };
    }

    // Check if any argument is statically NaN → evaluate all args for side effects, then return NaN
    if (expr.arguments.some((a) => isStaticNaN(ctx, a))) {
      // Must still evaluate all arguments (ToNumber coercion / side effects)
      for (const arg of expr.arguments) {
        if (!isStaticNaN(ctx, arg)) {
          compileExpression(ctx, fctx, arg, f64Hint);
          fctx.body.push({ op: "drop" } as Instr);
        }
      }
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    // Try static valueOf resolution for each argument.
    // For object-typed arguments, tryStaticToNumber resolves {} → NaN,
    // { valueOf: () => 42 } → 42, { valueOf: () => void } → NaN, etc.
    const staticValues: (number | undefined)[] = expr.arguments.map((a) => {
      const tsType = ctx.checker.getTypeAtLocation(a);
      // Only apply static valueOf to non-number types (objects)
      if (tsType.flags & ts.TypeFlags.Object) {
        return tryStaticToNumber(ctx, a);
      }
      return undefined;
    });

    // If ALL arguments resolved statically, compute the result at compile time
    if (staticValues.every((v) => v !== undefined)) {
      const nums = staticValues as number[];
      const result =
        method === "min"
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
      const local = allocLocal(fctx, `__minmax_${fctx.locals.length}`, {
        kind: "f64",
      });
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
      innerBody.push({ op: wasmOp });
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
  if (!condType) {
    // void condition — JS treats undefined as falsy, so push i32.const 0
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    ensureI32Condition(fctx, condType, ctx);
  }

  const savedBody = pushBody(fctx);
  const thenResultType = compileExpression(ctx, fctx, expr.whenTrue);
  // If the then-branch is void (no value on stack), push a default value
  // so the ternary has a consistent result. JS treats void as undefined → NaN for numbers.
  if (!thenResultType) {
    fctx.body.push({ op: "f64.const", value: NaN });
  }
  let thenInstrs = fctx.body;

  fctx.body = [];
  const elseResultType = compileExpression(ctx, fctx, expr.whenFalse);
  if (!elseResultType) {
    fctx.body.push({ op: "f64.const", value: NaN });
  }
  let elseInstrs = fctx.body;

  fctx.body = savedBody;

  const thenType: ValType = thenResultType ?? { kind: "f64" };
  const elseType: ValType = elseResultType ?? { kind: "f64" };

  // Determine the common result type for both branches
  let resultValType: ValType = thenType;

  const sameKind = thenType.kind === elseType.kind;
  const sameRefIdx =
    sameKind &&
    (thenType.kind === "ref" || thenType.kind === "ref_null") &&
    (thenType as { typeIdx: number }).typeIdx ===
      (elseType as { typeIdx: number }).typeIdx;

  if (
    !sameKind ||
    ((thenType.kind === "ref" || thenType.kind === "ref_null") && !sameRefIdx)
  ) {
    // Types differ — find a common type and coerce both branches
    if (
      (thenType.kind === "i32" || thenType.kind === "f64") &&
      (elseType.kind === "i32" || elseType.kind === "f64")
    ) {
      // Both numeric — coerce to f64
      resultValType = { kind: "f64" };
    } else if (
      (thenType.kind === "ref" || thenType.kind === "ref_null") &&
      (elseType.kind === "ref" || elseType.kind === "ref_null") &&
      isAnyValue(thenType, ctx) === isAnyValue(elseType, ctx)
    ) {
      // Both refs but different typeIdx — use ref_null of the then type
      resultValType =
        thenType.kind === "ref"
          ? {
              kind: "ref_null",
              typeIdx: (thenType as { typeIdx: number }).typeIdx,
            }
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
    resultValType = {
      kind: "ref_null",
      typeIdx: (resultValType as { typeIdx: number }).typeIdx,
    };
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
// ── Property access (extracted to ./property-access.ts) ──────────────
import {
  compileElementAccess,
  compilePropertyAccess,
  emitBoundsGuardedArraySet,
  emitNullCheckThrow,
  emitNullGuardedStructGet,
  typeErrorThrowInstrs,
} from "./property-access.js";
export function resolveStructName(
  ctx: CodegenContext,
  tsType: ts.Type,
): string | undefined {
  const name = tsType.symbol?.name;
  if (
    name &&
    name !== "__type" &&
    name !== "__object" &&
    ctx.structMap.has(name)
  ) {
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

// Object/array/tuple/symbol literal compilation has been extracted to ./literals.ts (#688 step 7).

// Object.defineProperty flag helpers, compileObjectDefineProperty,
// compileObjectKeysOrValues, and compilePropertyIntrospection have been
// extracted to ./object-ops.ts (#688 step 6).

// ── Generator helper functions ────────────────────────────────────────

/**
 * Check if a type looks like an IteratorResult (has .value and .done properties)
 * even if the type checker doesn't resolve it as IteratorResult directly.
 * This handles cases where the type is a union (IteratorYieldResult | IteratorReturnResult).
 */
export function isGeneratorIteratorResultLike(
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
export function getIteratorResultValueType(
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
  if (!fctx.isGenerator) {
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
    // In the eager generator model, yield always "receives" undefined from .next().
    // Push ref.null extern so callers that use yield as an expression get a value.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" } as ValType;
  }

  // Compile the yielded expression
  const yieldedType = compileExpressionInner(ctx, fctx, expr.expression);
  if (yieldedType === null || yieldedType === VOID_RESULT) {
    // Even if the yielded expression produced nothing, yield itself is an
    // expression that returns the value from .next() — push undefined.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" } as ValType;
  }

  // Store the yielded value in a temp local, then push to buffer
  const tmpLocal = allocLocal(
    fctx,
    `__yield_tmp_${fctx.locals.length}`,
    yieldedType,
  );
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

  // In the eager generator model, yield always "receives" undefined from .next().
  // Push ref.null extern so callers that use yield as an expression get a value.
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" } as ValType;
}

/** Check if an expression is statically known to be NaN at compile time */
/**
 * Try to statically determine the numeric value of an expression.
 * Handles: numeric literals, NaN, Infinity, -Infinity, object-with-valueOf, {}.
 * Returns undefined if the value cannot be determined at compile time.
 */
export function tryStaticToNumber(
  ctx: CodegenContext,
  expr: ts.Expression,
): number | undefined {
  // Numeric literal
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  // String literal → ToNumber: "" → 0, "123" → 123, "abc" → NaN
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return Number(expr.text);
  // null → 0
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 0;
  // undefined → NaN
  if (ts.isIdentifier(expr) && expr.text === "undefined") return NaN;
  // true → 1, false → 0
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 0;
  // NaN identifier
  if (ts.isIdentifier(expr) && expr.text === "NaN") return NaN;
  // Infinity identifier
  if (ts.isIdentifier(expr) && expr.text === "Infinity") return Infinity;
  // -Infinity: prefix minus on Infinity
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken
  ) {
    const inner = tryStaticToNumber(ctx, expr.operand);
    if (inner !== undefined) return -inner;
  }
  // Binary expressions: fold constant operands at compile time
  if (ts.isBinaryExpression(expr)) {
    // Don't fold string + anything as numeric — JS semantics requires string concat
    if (
      expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (ts.isStringLiteral(expr.left) ||
        ts.isNoSubstitutionTemplateLiteral(expr.left) ||
        ts.isStringLiteral(expr.right) ||
        ts.isNoSubstitutionTemplateLiteral(expr.right))
    ) {
      return undefined;
    }
    const left = tryStaticToNumber(ctx, expr.left);
    const right = tryStaticToNumber(ctx, expr.right);
    if (left !== undefined && right !== undefined) {
      switch (expr.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: {
          // For +, check if either operand is a string type in TS.
          // If so, + is string concatenation, not numeric addition,
          // and we cannot fold to a number.
          const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
          const rightTsType = ctx.checker.getTypeAtLocation(expr.right);
          if (isStringType(leftTsType) || isStringType(rightTsType))
            return undefined;
          return left + right;
        }
        case ts.SyntaxKind.MinusToken:
          return left - right;
        case ts.SyntaxKind.AsteriskToken:
          return left * right;
        case ts.SyntaxKind.SlashToken:
          return right !== 0 ? left / right : undefined;
        case ts.SyntaxKind.PercentToken:
          return right !== 0 ? left % right : undefined;
        case ts.SyntaxKind.AsteriskAsteriskToken:
          return left ** right;
        case ts.SyntaxKind.AmpersandToken:
          return left & right;
        case ts.SyntaxKind.BarToken:
          return left | right;
        case ts.SyntaxKind.CaretToken:
          return left ^ right;
        case ts.SyntaxKind.LessThanLessThanToken:
          return left << right;
        case ts.SyntaxKind.GreaterThanGreaterThanToken:
          return left >> right;
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
          return left >>> right;
        default:
          break; // non-numeric binary op, fall through
      }
    }
  }
  // Property access on string literals: "hello".length → 5
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "length") {
    const obj = expr.expression;
    if (ts.isStringLiteral(obj) || ts.isNoSubstitutionTemplateLiteral(obj)) {
      return obj.text.length;
    }
    // Also resolve through const variables: const s = "hello"; s.length → 5
    if (ts.isIdentifier(obj)) {
      const sym = ctx.checker.getSymbolAtLocation(obj);
      const decl = sym?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = decl.initializer;
        if (
          ts.isStringLiteral(init) ||
          ts.isNoSubstitutionTemplateLiteral(init)
        ) {
          return init.text.length;
        }
      }
    }
  }
  // Object literal: check valueOf or return NaN for {}
  if (ts.isObjectLiteralExpression(expr)) {
    const valueOfProp = expr.properties.find(
      (p) =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === "valueOf",
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
  // Parenthesized expression: unwrap parentheses
  if (ts.isParenthesizedExpression(expr)) {
    return tryStaticToNumber(ctx, expr.expression);
  }
  // Unary + (ToNumber coercion): +expr
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.PlusToken
  ) {
    return tryStaticToNumber(ctx, expr.operand);
  }
  // Variable: trace to initializer (only for const declarations to avoid
  // incorrectly folding mutable variables like `let heapSize = 0`)
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const declList = decl.parent;
      if (
        ts.isVariableDeclarationList(declList) &&
        (declList.flags & ts.NodeFlags.Const) !== 0
      ) {
        return tryStaticToNumber(ctx, decl.initializer);
      }
    }
  }
  return undefined;
}

/** Get the static numeric return value of a simple function (single return statement) */
function getStaticReturnValue(
  ctx: CodegenContext,
  fn: ts.FunctionExpression | ts.ArrowFunction,
): number | undefined {
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
    ts.isNumericLiteral(expr.left) &&
    Number(expr.left.text) === 0 &&
    ts.isNumericLiteral(expr.right) &&
    Number(expr.right.text) === 0
  )
    return true;
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

// getLine and getCol are now imported from ./shared.js

// Register delegates for shared.ts so that array-methods.ts (and other extracted
registerCompileExpression(compileExpression);
registerEnsureLateImport(ensureLateImport);
registerFlushLateImportShifts(flushLateImportShifts);
