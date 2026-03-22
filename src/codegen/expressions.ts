import ts from "typescript";
import type { CodegenContext, FunctionContext, ClosureInfo, RestParamInfo } from "./index.js";
import { allocLocal, allocTempLocal, releaseTempLocal, getLocalType, resolveWasmType, resolveNativeTypeAnnotation, getOrRegisterArrayType, getOrRegisterVecType, getArrTypeIdxFromVec, addFuncType, addImport, addUnionImports, parseRegExpLiteral, ensureStructForType, isTupleType, getTupleElementTypes, getOrRegisterTupleType, localGlobalIdx, nativeStringType, flatStringType, ensureNativeStringHelpers, getOrRegisterRefCellType, isAnyValue, ensureAnyHelpers, addStringImports, cacheStringLiterals, addStringConstantGlobal, nextModuleGlobalIdx, getOrRegisterTemplateVecType, pushBody, popBody, destructureParamArray, destructureParamObject, ensureExnTag } from "./index.js";
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
  isSymbolType,
  unwrapPromiseType,
} from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction, FieldDef, StructTypeDef } from "../ir/types.js";
import { ensureI32Condition, ensureExnTag } from "./index.js";
import { compileStatement, emitTdzCheck } from "./statements.js";
import { walkInstructions } from "./walk-instructions.js";
import { ensureTimsortHelper } from "./timsort.js";
import { coerceType as coerceTypeImpl, pushDefaultValue, defaultValueInstrs, coercionInstrs, emitGuardedRefCast, emitSafeExternrefToF64 } from "./type-coercion.js";
export { pushDefaultValue, defaultValueInstrs, coercionInstrs } from "./type-coercion.js";
import { resolveArrayInfo, compileArrayPrototypeCall, compileArrayMethodCall } from "./array-methods.js";
import { compileCallExpression, compileNewExpression, compileClassExpression, compileSuperPropertyAccess, compileSuperElementAccess, resolveEnclosingClassName, findExternInfoForMember, emitLazyProtoGet, patchStructNewForDynamicField, getFuncParamTypes } from "./calls.js";
export { compileCallExpression, compileNewExpression, compileClassExpression, compileSuperPropertyAccess, compileSuperElementAccess, resolveEnclosingClassName, findExternInfoForMember, emitLazyProtoGet, patchStructNewForDynamicField, getFuncParamTypes } from "./calls.js";

/** Sentinel: expression compiled successfully but produces no value (void) */
export const VOID_RESULT = Symbol("void");
export type InnerResult = ValType | null | typeof VOID_RESULT;

/**
 * Emit a Wasm throw instruction with a string error message.
 * This replaces `unreachable` traps so that JS try/catch (and assert.throws)
 * can catch the error instead of getting an uncatchable RuntimeError.
 */
function emitThrowString(
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
export function isEffectivelyVoidReturn(
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
export function wasmFuncReturnsVoid(ctx: CodegenContext, funcIdx: number): boolean {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          return !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0;
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
    ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map(
      idx => idx >= importsBefore ? idx + added : idx,
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
 * After dynamically adding a field to a struct type, patch all existing
 * struct.new instructions for that type by inserting a default value
 * instruction immediately before each struct.new.  This ensures the
 * operand count matches the (now larger) field list.
 */
function patchStructNewForAddedField(
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
    while (ts.isAsExpression(inner) || ts.isNonNullExpression(inner) || ts.isParenthesizedExpression(inner) || ts.isTypeAssertionExpression(inner)) {
      inner = ts.isParenthesizedExpression(inner) ? inner.expression :
              ts.isAsExpression(inner) ? inner.expression :
              ts.isNonNullExpression(inner) ? inner.expression :
              (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined = inner.kind === ts.SyntaxKind.UndefinedKeyword ||
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
      const operandType = compileExpressionInner(ctx, fctx, inner.expression);
      if (operandType !== null && operandType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
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
  if (expectedType && (expectedType.kind === "ref_null" || expectedType.kind === "ref")) {
    let inner: ts.Expression = expr;
    while (ts.isAsExpression(inner) || ts.isNonNullExpression(inner) || ts.isParenthesizedExpression(inner) || ts.isTypeAssertionExpression(inner)) {
      inner = ts.isParenthesizedExpression(inner) ? inner.expression :
              ts.isAsExpression(inner) ? inner.expression :
              ts.isNonNullExpression(inner) ? inner.expression :
              (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined = inner.kind === ts.SyntaxKind.UndefinedKeyword ||
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
    while (ts.isAsExpression(inner) || ts.isNonNullExpression(inner) || ts.isParenthesizedExpression(inner) || ts.isTypeAssertionExpression(inner)) {
      inner = ts.isParenthesizedExpression(inner) ? inner.expression :
              ts.isAsExpression(inner) ? inner.expression :
              ts.isNonNullExpression(inner) ? inner.expression :
              (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined = inner.kind === ts.SyntaxKind.UndefinedKeyword ||
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
      const operandType = compileExpressionInner(ctx, fctx, inner.expression);
      if (operandType !== null && operandType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_undefined");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
    }
    // Boolean literals: box with __any_box_bool to preserve tag=4 for typeof checks
    if (inner.kind === ts.SyntaxKind.TrueKeyword || inner.kind === ts.SyntaxKind.FalseKeyword) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_bool");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "i32.const", value: inner.kind === ts.SyntaxKind.TrueKeyword ? 1 : 0 });
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
    if (lastInstr && (lastInstr as any).op === "call" && (lastInstr as any).funcIdx !== undefined) {
      if (wasmFuncReturnsVoid(ctx, (lastInstr as any).funcIdx)) {
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
  if (result !== null && result !== VOID_RESULT &&
      (typeof result !== "object" || result === null || !("kind" in result))) {
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
    if (expectedType && (result.kind === "ref" || result.kind === "ref_null") &&
        (expectedType.kind === "ref" || expectedType.kind === "ref_null")) {
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
      wasmType = mapTsTypeToWasm(ctx.checker.getTypeAtLocation(expr), ctx.checker);
    } catch {
      wasmType = { kind: "f64" };
    }
  }
  pushDefaultValue(fctx, wasmType);
  return wasmType;
}

/** Check if two ValTypes are structurally equal */
export function valTypesMatch(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") &&
      (b.kind === "ref" || b.kind === "ref_null")) {
    return (a as { typeIdx: number }).typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}

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
      (stackType as { typeIdx: number }).typeIdx === (localType as { typeIdx: number }).typeIdx;
    if (sameRefTypeIdx && stackType.kind === "ref_null" && localType.kind === "ref") {
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
function updateLocalType(fctx: FunctionContext, localIdx: number, newType: ValType): void {
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
      param.type = { kind: "ref_null", typeIdx: (param.type as { typeIdx: number }).typeIdx };
    }
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local && local.type.kind === "ref") {
      local.type = { kind: "ref_null", typeIdx: (local.type as { typeIdx: number }).typeIdx };
    }
  }
}

/** Coerce a value on the stack from one type to another */
export function coerceType(ctx: CodegenContext, fctx: FunctionContext, from: ValType, to: ValType): void {
  return coerceTypeImpl(ctx, fctx, from, to, compileStringLiteral);
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

  // OmittedExpression — array hole/elision, equivalent to undefined
  if (ts.isOmittedExpression(expr)) {
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
    // In module/global scope (strict mode), `this` is undefined.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
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

  // delete expr — compile operand for side effects, return boolean
  if (ts.isDeleteExpression(expr)) {
    return compileDeleteExpression(ctx, fctx, expr);
  }

  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return compileArrowFunction(ctx, fctx, expr);
  }

  // MetaProperty: new.target
  if (ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.NewKeyword && expr.name.text === "target") {
    if (fctx.isConstructor) {
      // Inside a constructor, new.target is always the constructor (truthy).
      // Return i32 1 as a truthy sentinel since we don't have first-class
      // constructor references as values.
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    } else {
      // Outside a constructor, new.target is undefined.
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // MetaProperty: import.meta — compile as an object with a `url` property.
  // Bare `import.meta` is rare; typically accessed as `import.meta.url`.
  // We return a string placeholder since the object shape is simple.
  if (ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.ImportKeyword && expr.name.text === "meta") {
    // Return a non-null externref as a truthy object sentinel.
    // In most real usage, import.meta.url is accessed via PropertyAccess
    // which is handled separately in compilePropertyAccess.
    return compileStringLiteral(ctx, fctx, "[object Object]");
  }

  // MetaProperty catch-all: import.source, import.defer, and any future
  // import.* meta-properties that the TS parser recognizes but we don't
  // implement.  Emit null externref so compilation doesn't crash.
  if (ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.ImportKeyword) {
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
    return compileExpressionInner(ctx, fctx, (expr as any as ts.SpreadElement).expression);
  }

  ctx.errors.push({
    message: `Unsupported expression: ${ts.SyntaxKind[expr.kind]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Delete expression ─────────────────────────────────────────────────

/**
 * Emit the sentinel (undefined) value for a given Wasm field type.
 * - ref/ref_null: ref.null of the struct's type index
 * - externref: ref.null.extern
 * - f64: NaN (chosen as sentinel since deleted numeric props return undefined → NaN in numeric context)
 * - i32: 0
 */
function emitDeleteSentinel(fctx: FunctionContext, fieldType: ValType): void {
  switch (fieldType.kind) {
    case "ref":
    case "ref_null":
      fctx.body.push({ op: "ref.null", typeIdx: (fieldType as { typeIdx: number }).typeIdx });
      break;
    case "externref":
      fctx.body.push({ op: "ref.null.extern" });
      break;
    case "f64":
      fctx.body.push({ op: "f64.const", value: NaN });
      break;
    case "i32":
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
    default:
      fctx.body.push({ op: "ref.null.extern" });
      break;
  }
}

/**
 * Compile `delete expr`.
 * - `delete obj.prop` / `delete obj[key]`: set the field to a sentinel (undefined) value, return true
 * - `delete identifier`: return false (i32 0) — variables are not deletable
 * - `delete otherExpr`: compile for side effects, drop, return true (i32 1)
 *
 * WasmGC struct fields cannot be removed at runtime, so we simulate deletion
 * by setting the field to a sentinel value (ref.null for ref types, NaN for f64).
 * Property reads of ref.null / NaN naturally produce undefined-like behavior.
 */
function compileDeleteExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.DeleteExpression,
): InnerResult {
  const operand = expr.expression;

  // Unwrap parenthesized/type-assertion wrappers to find the underlying expression
  let inner: ts.Expression = operand;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) ||
         ts.isNonNullExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = ts.isParenthesizedExpression(inner) ? inner.expression :
            ts.isAsExpression(inner) ? inner.expression :
            ts.isNonNullExpression(inner) ? inner.expression :
            (inner as ts.TypeAssertion).expression;
  }

  if (ts.isIdentifier(inner)) {
    // Variables are not deletable — return false
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Try to resolve struct type and field for property access: delete obj.prop
  if (ts.isPropertyAccessExpression(inner)) {
    const objType = ctx.checker.getTypeAtLocation(inner.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(inner.expression)) {
      typeName = ctx.widenedVarStructMap.get(inner.expression.text);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = ts.isPrivateIdentifier(inner.name) ? inner.name.text.slice(1) : inner.name.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          // Compile the object expression, then set field to sentinel
          compileExpression(ctx, fctx, inner.expression);
          emitDeleteSentinel(fctx, fieldType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fctx.body.push({ op: "i32.const", value: 1 });
          return { kind: "i32" };
        }
      }
    }
  }

  // Try to resolve struct type and field for element access: delete obj["prop"]
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteral(inner.argumentExpression)) {
    const objType = ctx.checker.getTypeAtLocation(inner.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(inner.expression)) {
      typeName = ctx.widenedVarStructMap.get(inner.expression.text);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = inner.argumentExpression.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          compileExpression(ctx, fctx, inner.expression);
          emitDeleteSentinel(fctx, fieldType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fctx.body.push({ op: "i32.const", value: 1 });
          return { kind: "i32" };
        }
      }
    }
  }

  // For property access / element access / other expressions:
  // compile the operand for side effects, drop, return true
  const operandType = compileExpressionInner(ctx, fctx, operand);
  if (operandType !== null && operandType !== VOID_RESULT) {
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "i32.const", value: 1 });
  return { kind: "i32" };
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
  // Track `this` keyword references so arrow functions can capture the
  // enclosing scope's `this` through the normal closure mechanism.
  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
    names.add("this");
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

/**
 * Promote captured locals to globals for getter/setter accessor functions.
 *
 * When an object literal getter/setter references variables from the enclosing
 * function scope, those variables need to be accessible as Wasm globals (since
 * the getter/setter is compiled as a separate Wasm function).
 *
 * This function:
 * 1. Scans the accessor body for referenced identifiers
 * 2. For each that maps to a local in the enclosing fctx, creates a Wasm global
 * 3. Copies the local's current value into the global
 * 4. Removes the name from localMap so subsequent code uses the global
 * 5. Registers in ctx.capturedGlobals for resolution in the accessor body
 */
function promoteAccessorCapturesToGlobals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  accessorBody: ts.Block | undefined,
): void {
  if (!accessorBody) return;

  const referencedNames = new Set<string>();
  for (const stmt of accessorBody.statements) {
    collectReferencedIdentifiers(stmt, referencedNames);
  }

  for (const name of referencedNames) {
    // Skip if already a captured global or module global
    if (ctx.capturedGlobals.has(name)) continue;
    if (ctx.moduleGlobals.has(name)) continue;

    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;

    // Skip 'this' — it's passed as param 0 to the accessor
    if (name === "this") continue;

    // Skip if it's a known function name (not a variable capture)
    if (ctx.funcMap.has(name)) continue;

    // Get the local's type
    const localType = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" as const };

    // Widen non-nullable ref to ref_null for global init
    const globalType: ValType = localType.kind === "ref"
      ? { kind: "ref_null", typeIdx: (localType as { typeIdx: number }).typeIdx }
      : localType;

    // Create default init for the global
    const init: Instr[] =
      globalType.kind === "f64"
        ? [{ op: "f64.const", value: 0 }]
        : globalType.kind === "i32"
          ? [{ op: "i32.const", value: 0 }]
          : globalType.kind === "externref"
            ? [{ op: "ref.null.extern" }]
            : globalType.kind === "ref_null"
              ? [{ op: "ref.null", typeIdx: (globalType as { typeIdx: number }).typeIdx }]
              : [{ op: "i32.const", value: 0 }];

    const globalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__captured_${name}`,
      type: globalType,
      mutable: true,
      init,
    });

    // Copy current local value into the new global
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "global.set", index: globalIdx });

    // Register as captured global so accessor body resolves via global.get
    ctx.capturedGlobals.set(name, globalIdx);
    if (localType.kind === "ref") {
      ctx.capturedGlobalsWidened.add(name);
    }

    // If this variable has a local TDZ flag, also promote it to a global TDZ flag
    const tdzFlagLocalIdx = fctx.tdzFlagLocals?.get(name);
    if (tdzFlagLocalIdx !== undefined) {
      const tdzGlobalIdx = nextModuleGlobalIdx(ctx);
      ctx.mod.globals.push({
        name: `__tdz_${name}`,
        type: { kind: "i32" },
        mutable: true,
        init: [{ op: "i32.const", value: 0 }],
      });
      // Copy current TDZ flag value to the global
      fctx.body.push({ op: "local.get", index: tdzFlagLocalIdx });
      fctx.body.push({ op: "global.set", index: tdzGlobalIdx });
      ctx.tdzGlobals.set(name, tdzGlobalIdx);
    }

    // Remove from localMap so subsequent code in the enclosing function
    // also uses the global (maintaining shared state with the accessor)
    fctx.localMap.delete(name);
  }
}

/** Collect all identifier names from a binding pattern (destructuring parameter) */
function collectBindingPatternNames(pattern: ts.BindingPattern, names: Set<string>): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      names.add(element.name.text);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      collectBindingPatternNames(element.name, names);
    }
  }
}

/** Check if a name is defined in any of the arrow's own parameters (including destructuring) */
function isOwnParamName(arrow: ts.ArrowFunction | ts.FunctionExpression, name: string): boolean {
  for (const p of arrow.parameters) {
    if (ts.isIdentifier(p.name) && p.name.text === name) return true;
    if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
      const names = new Set<string>();
      collectBindingPatternNames(p.name, names);
      if (names.has(name)) return true;
    }
  }
  return false;
}

/**
 * Emit destructuring code for an arrow function parameter that uses a binding pattern.
 * The parameter value is already in a local at `paramIdx`; this emits instructions to
 * extract fields/elements into new locals in the lifted function context.
 */
function emitArrowParamDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  param: ts.ParameterDeclaration,
  paramIdx: number,
  paramType: ValType,
): void {
  if (ts.isObjectBindingPattern(param.name)) {
    // Object destructuring: const { a, b } = param
    const pattern = param.name;

    // Resolve struct type from the parameter's TS type
    const tsParamType = ctx.checker.getTypeAtLocation(param);
    ensureStructForType(ctx, tsParamType);

    const symName = tsParamType.symbol?.name;
    let typeName =
      symName &&
      symName !== "__type" &&
      symName !== "__object" &&
      ctx.structMap.has(symName)
        ? symName
        : (ctx.anonTypeMap.get(tsParamType) ?? symName);

    if (
      typeName &&
      (typeName === "__type" || typeName === "__object") &&
      !ctx.anonTypeMap.has(tsParamType) &&
      tsParamType.getProperties().length > 0
    ) {
      ensureStructForType(ctx, tsParamType);
      typeName = ctx.anonTypeMap.get(tsParamType) ?? typeName;
    }

    if (!typeName) return;
    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) return;

    // Null guard for ref_null param types
    const savedBodyAPD = fctx.body;
    const apdInstrs: Instr[] = [];
    fctx.body = apdInstrs;

    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      if (ts.isOmittedExpression(element as any)) continue;
      const propNameNode = element.propertyName ?? element.name;
      if (!ts.isIdentifier(element.name)) {
        continue;
      }
      // propName must be an identifier or string literal to extract field name
      if (!ts.isIdentifier(propNameNode) && !ts.isStringLiteral(propNameNode)) {
        continue;
      }
      const propName = propNameNode as ts.Identifier;
      const localName = element.name.text;

      const fieldIdx = fields.findIndex((f) => f.name === propName.text);
      if (fieldIdx === -1) continue;

      const fieldType = fields[fieldIdx]!.type;
      const localIdx = allocLocal(fctx, localName, fieldType);

      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      if (element.initializer) {
        if (fieldType.kind === "externref") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "ref.is_null" } as Instr);
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpField } as Instr,
              { op: "local.set", index: localIdx } as Instr,
            ],
          });
        } else if (fieldType.kind === "f64") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "local.get", index: tmpField });
          fctx.body.push({ op: "f64.ne" });
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpField } as Instr,
              { op: "local.set", index: localIdx } as Instr,
            ],
          });
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else {
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }

    // Close null guard
    fctx.body = savedBodyAPD;
    if (paramType.kind === "ref_null" && apdInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: apdInstrs });
    } else {
      fctx.body.push(...apdInstrs);
    }
  } else if (ts.isArrayBindingPattern(param.name)) {
    // Array destructuring: const [a, b] = param
    const pattern = param.name;

    if (paramType.kind !== "ref" && paramType.kind !== "ref_null") return;

    const vecTypeIdx = (paramType as { typeIdx: number }).typeIdx;
    const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const arrDef = ctx.mod.types[innerArrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") return;

    const innerElemType = arrDef.element;

    // Null guard for ref_null param types
    const savedBodyAPDA = fctx.body;
    const apdaInstrs: Instr[] = [];
    fctx.body = apdaInstrs;

    for (let i = 0; i < pattern.elements.length; i++) {
      const element = pattern.elements[i]!;
      if (ts.isOmittedExpression(element)) continue;
      if (!ts.isIdentifier((element as ts.BindingElement).name)) continue;

      const localName = ((element as ts.BindingElement).name as ts.Identifier).text;
      const bindingTsType = ctx.checker.getTypeAtLocation(element);
      const bindingWasmType = resolveWasmType(ctx, bindingTsType);
      const localIdx = allocLocal(fctx, localName, bindingWasmType);

      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);

      if (!valTypesMatch(innerElemType, bindingWasmType)) {
        coerceType(ctx, fctx, innerElemType, bindingWasmType);
      }

      fctx.body.push({ op: "local.set", index: localIdx });
    }

    // Close null guard
    fctx.body = savedBodyAPDA;
    if (paramType.kind === "ref_null" && apdaInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: apdaInstrs });
    } else {
      fctx.body.push(...apdaInstrs);
    }
  }
}

/**
 * Emit default-value initialization for arrow/closure function parameters.
 * Similar to the logic in compileFunctionBody but operates on the lifted fctx.
 */
function emitArrowParamDefaults(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  paramOffset: number, // offset in liftedFctx.params (usually 1 for __self)
): void {
  for (let i = 0; i < arrow.parameters.length; i++) {
    const param = arrow.parameters[i]!;
    if (!param.initializer) continue;
    // Only for simple identifier params (destructuring defaults handled separately)
    if (!ts.isIdentifier(param.name)) continue;

    const paramIdx = paramOffset + i;
    const paramType = fctx.params[paramIdx]?.type;
    if (!paramType) continue;

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    compileExpression(ctx, fctx, param.initializer, paramType);
    fctx.body.push({ op: "local.set", index: paramIdx });
    const thenInstrs = fctx.body;
    fctx.body = savedBody;

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "i32") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "f64") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    }
  }
}

/**
 * Emit default-value initialization for method/setter parameters with initializers.
 * For each param with a default value, check if the caller omitted it
 * (externref -> ref.is_null, i32 -> i32.eqz, f64 -> f64.eq 0.0) and if so
 * compile the initializer expression and assign it to the param local.
 */
function emitMethodParamDefaults(
  ctx: CodegenContext,
  fctx: FunctionContext,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  paramOffset: number, // offset in fctx.params (usually 1 for 'this')
): void {
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    if (!param.initializer) continue;
    if (!ts.isIdentifier(param.name)) continue;

    const paramIdx = paramOffset + i;
    const paramType = fctx.params[paramIdx]?.type;
    if (!paramType) continue;

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    compileExpression(ctx, fctx, param.initializer, paramType);
    fctx.body.push({ op: "local.set", index: paramIdx });
    const thenInstrs = fctx.body;
    fctx.body = savedBody;

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "i32") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "f64") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    }
  }
}

/** Check if an arrow/function expression is used as a callback argument to a call
 *  that targets a HOST import (not a user-defined function). User-defined functions
 *  should receive closures via the GC struct path, not the __make_callback host path. */
function isHostCallbackArgument(node: ts.Node, ctx: CodegenContext): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent)) {
    if (!parent.arguments.some((arg) => arg === node)) return false;
    // Check if the callee is a user-defined function — if so, NOT a host callback
    if (ts.isIdentifier(parent.expression)) {
      const calleeName = parent.expression.text;
      const funcIdx = ctx.funcMap.get(calleeName);
      if (funcIdx !== undefined && funcIdx >= ctx.numImportFuncs) {
        // User-defined function — use closure path, not host callback
        return false;
      }
    }
    // For method calls (property access), check if the method is known array HOF
    // (filter, map, etc.) — those have dedicated inline compilation and ARE handled
    // as closure calls. For other property accesses, treat as host callback.
    return true;
  }
  return false;
}

function compileArrowFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  // If used as callback argument to a host call, use the __make_callback path
  if (isHostCallbackArgument(arrow, ctx)) {
    return compileArrowAsCallback(ctx, fctx, arrow);
  }
  // Otherwise, compile as a first-class closure value
  return compileArrowAsClosure(ctx, fctx, arrow);
}

/** Compile an arrow function as a first-class closure value (Wasm GC struct + funcref) */
export function compileArrowAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  const closureId = ctx.closureCounter++;
  const closureName = `__closure_${closureId}`;
  const body = arrow.body;

  // Check if this is a generator function expression (function*() { ... })
  const isGenerator = ts.isFunctionExpression(arrow) && arrow.asteriskToken !== undefined;
  if (isGenerator) {
    ctx.generatorFunctions.add(closureName);
  }

  // 1. Determine arrow parameter types and return type
  const arrowParams: ValType[] = [];
  for (const p of arrow.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    let wasmType = resolveWasmType(ctx, paramType);
    // If the parameter has a default value and is a non-null ref type,
    // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
    if (p.initializer && wasmType.kind === "ref") {
      wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
    }
    arrowParams.push(wasmType);
  }

  const sig = ctx.checker.getSignatureFromDeclaration(arrow);
  let closureReturnType: ValType | null = null;
  if (isGenerator) {
    // Generator function expressions always return externref (JS Generator object)
    closureReturnType = { kind: "externref" };
  } else if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    // Treat `never` the same as `void` — a function returning `never` (e.g.
    // always throws) never produces a value, so it should have no Wasm result.
    // Without this, `never` resolves to externref and creates a mismatched
    // closure wrapper type vs. the `() => void` signature expected by callers.
    if (!isVoidType(retType) && !(retType.flags & ts.TypeFlags.Never)) {
      closureReturnType = resolveWasmType(ctx, retType);
    }
  }

  // (#585) Check the contextual type (e.g., a parameter type like `() => void`).
  // If the contextual type expects a void-returning callable but the closure's
  // actual return type is non-void, override to void so the closure uses the
  // same wrapper struct type that callers will ref.cast against.
  if (closureReturnType !== null) {
    const ctxType = ctx.checker.getContextualType(arrow);
    if (ctxType) {
      const ctxCallSigs = ctxType.getCallSignatures?.();
      if (ctxCallSigs && ctxCallSigs.length > 0) {
        const ctxRetType = ctx.checker.getReturnTypeOfSignature(ctxCallSigs[0]!);
        if (isVoidType(ctxRetType)) {
          closureReturnType = null;
        }
      }
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

  const captures: { name: string; type: ValType; localIdx: number; mutable: boolean; alreadyBoxed: boolean }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    // Skip if the name is the arrow's own parameter (including destructuring bindings)
    if (isOwnParamName(arrow, name)) continue;
    // Skip if the name is a named function expression's own name (self-reference)
    if (ts.isFunctionExpression(arrow) && arrow.name && arrow.name.text === name) continue;
    const type = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" };
    // A capture is mutable if the closure writes to it
    const isMutable = writtenInClosure.has(name);
    // Check if the variable is already boxed from a previous closure capture.
    // If so, the local already holds a ref cell — don't wrap it again.
    const alreadyBoxed = !!fctx.boxedCaptures?.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable, alreadyBoxed });
  }

  // 3. Create struct type: field 0 = funcref, fields 1..N = captured vars
  //    For mutable captures, the field type is a ref cell (struct { value: T })
  const closureResults: ValType[] = closureReturnType ? [closureReturnType] : [];

  // For closures with no captures, reuse the shared wrapper struct type from
  // getOrCreateFuncRefWrapperTypes. This ensures all no-capture closures with
  // the same signature share the same struct type, enabling consistent call_ref
  // dispatch when closures are passed as callable parameters (externref).
  let structTypeIdx: number;
  let liftedFuncTypeIdx: number;
  let liftedParams: ValType[];
  const isNamedFuncExpr = ts.isFunctionExpression(arrow) && arrow.name;

  if (captures.length === 0 && !isNamedFuncExpr) {
    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults);
    if (wrapperTypes) {
      structTypeIdx = wrapperTypes.structTypeIdx;
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedParams = [
        { kind: "ref", typeIdx: structTypeIdx },
        ...arrowParams,
      ];
    } else {
      // Fallback: create a unique struct type
      const structFields = [
        { name: "func", type: { kind: "funcref" as const }, mutable: false },
      ];
      structTypeIdx = ctx.mod.types.length;
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      liftedParams = [
        { kind: "ref", typeIdx: structTypeIdx },
        ...arrowParams,
      ];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  } else {
    const structFields = [
      { name: "func", type: { kind: "funcref" as const }, mutable: false },
      ...captures.map((c) => {
        if (c.mutable && !c.alreadyBoxed) {
          // First time boxing: create ref cell type for the capture value type
          const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
          return {
            name: c.name,
            type: { kind: "ref_null" as const, typeIdx: refCellTypeIdx },
            mutable: false,
          };
        }
        if (c.mutable && c.alreadyBoxed) {
          // Already boxed: the capture's type IS the ref cell type already
          return {
            name: c.name,
            type: c.type,
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

    // For closures with captures (but not named func exprs), make the struct
    // a subtype of the shared wrapper struct so ref.cast at call sites succeeds.
    // Named func exprs need ref_null __self (for var hoisting), so they can't
    // share the wrapper's lifted func type which uses non-null ref.
    const wrapperTypes = !isNamedFuncExpr
      ? getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults)
      : null;

    structTypeIdx = ctx.mod.types.length;
    if (wrapperTypes) {
      // Subtype of the wrapper struct — inherits field 0 (funcref), adds captures
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
        superTypeIdx: wrapperTypes.structTypeIdx,
      });
      // Share the wrapper's lifted func type so call_ref dispatches correctly.
      // The __self param is (ref $wrapperStruct), and the lifted body will
      // ref.cast to the specific subtype to access captures.
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedParams = [
        { kind: "ref_null", typeIdx: structTypeIdx },
        ...arrowParams,
      ];
    } else {
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      // 4. Create the lifted function type: (ref_null $closure_struct, ...arrowParams) → results
      // Use ref_null for __self so that var-hoisted variables shadowing the function name
      // (e.g. `var g` inside `function g()`) can be default-initialized to null.
      liftedParams = [
        { kind: "ref_null", typeIdx: structTypeIdx },
        ...arrowParams,
      ];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  }

  // 5. Build the lifted function body
  // For no-capture closures using wrapper types, self param is non-null ref.
  // For captured closures sharing wrapper types, self param uses the WRAPPER struct
  // type (non-null ref) — captures are accessed via ref.cast to the subtype.
  // For named func exprs, self param is ref_null (var hoisting support).
  const usesWrapperFuncType = captures.length > 0 && !isNamedFuncExpr && !!getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults);
  const selfParamKind = isNamedFuncExpr ? "ref_null" as const : "ref" as const;
  const selfTypeIdx = usesWrapperFuncType
    ? getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults)!.structTypeIdx
    : structTypeIdx;
  const liftedFctx: FunctionContext = {
    name: closureName,
    params: [
      { name: "__self", type: { kind: selfParamKind, typeIdx: selfTypeIdx } },
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
    savedBodies: [],
    enclosingClassName: fctx.enclosingClassName ?? resolveEnclosingClassName(fctx),
    isGenerator,
  };

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // Initialize locals for captured variables from struct fields.
  // When using wrapper func types, __self is typed as the wrapper base struct —
  // cast it to the specific subtype to access capture fields.
  let selfLocalForCaptures = 0; // default: param 0 (__self)
  if (usesWrapperFuncType && captures.length > 0) {
    const castLocal = allocLocal(liftedFctx, "__self_cast", { kind: "ref", typeIdx: structTypeIdx });
    liftedFctx.body.push({ op: "local.get", index: 0 }); // __self (wrapper base type)
    liftedFctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as Instr);
    liftedFctx.body.push({ op: "local.set", index: castLocal });
    selfLocalForCaptures = castLocal;
  }
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      // Mutable capture: store the ref cell reference itself.
      // If already boxed, cap.type IS the ref cell type — extract the existing
      // ref cell type index instead of creating a new wrapper.
      let refCellTypeIdx: number;
      let valType: ValType;
      if (cap.alreadyBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        // Already boxed: the field stores the ref cell directly
        refCellTypeIdx = (cap.type as { typeIdx: number }).typeIdx;
        // Look up the original value type from the outer scope's boxed capture info
        const outerBoxed = fctx.boxedCaptures?.get(cap.name);
        valType = outerBoxed?.valType ?? { kind: "f64" };
      } else {
        refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        valType = cap.type;
      }
      const refCellType: ValType = { kind: "ref_null", typeIdx: refCellTypeIdx };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      // Register as boxed so identifier read/write uses struct.get/set
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType });
    } else {
      const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
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
    // The function name binding is read-only (assignments are silently ignored)
    if (!liftedFctx.readOnlyBindings) liftedFctx.readOnlyBindings = new Set();
    liftedFctx.readOnlyBindings.add(funcExprName);
  }

  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
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

  // Emit default-value initialization for simple params with defaults
  emitArrowParamDefaults(ctx, liftedFctx, arrow, 1 /* skip __self */);

  // Destructuring parameter initialization: for parameters with binding patterns
  // (e.g. function([x, y]) or function({a, b})), extract values from the parameter
  // and assign them to local variables.
  for (let pi = 0; pi < arrow.parameters.length; pi++) {
    const param = arrow.parameters[pi]!;
    if (ts.isIdentifier(param.name)) continue; // simple param, already handled

    const paramIdx = pi + 1; // +1 for __self
    const paramType = arrowParams[pi]!;

    // Helper: allocate locals for all identifiers in a binding pattern
    // using TS type inference for each element. This is a fallback for when
    // the Wasm type doesn't provide enough info to extract values.
    const allocBindingLocals = (pattern: ts.BindingPattern) => {
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (ts.isIdentifier(element.name)) {
          const localName = element.name.text;
          if (!liftedFctx.localMap.has(localName)) {
            const elemTsType = ctx.checker.getTypeAtLocation(element);
            const elemWasmType = resolveWasmType(ctx, elemTsType);
            allocLocal(liftedFctx, localName, elemWasmType);
          }
        } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
          allocBindingLocals(element.name);
        }
      }
    };

    if (ts.isArrayBindingPattern(param.name)) {
      // Array destructuring: function([a, b, c]) { ... }
      let handled = false;

      // Resolve the vec type — for externref params, try to infer the
      // concrete array type from TS so we can any.convert_extern + ref.cast.
      // First try the TS checker, then fall back to the default f64 vec type.
      let resolvedParamType = paramType;
      let srcParamIdx = paramIdx;
      if (paramType.kind === "externref") {
        // Infer the actual array type from TS checker
        const tsParamType = ctx.checker.getTypeAtLocation(param);
        let inferred = resolveWasmType(ctx, tsParamType);
        // If TS returns externref (e.g. any), fall back to the default f64 vec type
        if (inferred.kind === "externref") {
          const elemKey = ctx.fast ? "i32" : "f64";
          const elemType2: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
          const vecIdx = getOrRegisterVecType(ctx, elemKey, elemType2);
          inferred = { kind: "ref_null", typeIdx: vecIdx };
        }
        if (inferred.kind === "ref" || inferred.kind === "ref_null") {
          // Convert externref to the concrete vec type via any.convert_extern + ref.cast
          const castLocal = allocLocal(liftedFctx, `__cast_arr_${liftedFctx.locals.length}`, { kind: "ref_null", typeIdx: inferred.typeIdx });
          liftedFctx.body.push({ op: "local.get", index: paramIdx });
          liftedFctx.body.push({ op: "ref.is_null" } as Instr);
          liftedFctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [],
            else: [
              { op: "local.get", index: paramIdx } as Instr,
              { op: "any.convert_extern" },
              { op: "ref.cast_null", typeIdx: inferred.typeIdx },
              { op: "local.set", index: castLocal } as Instr,
            ],
          });
          resolvedParamType = { kind: "ref_null", typeIdx: inferred.typeIdx };
          srcParamIdx = castLocal;
        }
      }

      if (resolvedParamType.kind === "ref" || resolvedParamType.kind === "ref_null") {
        const typeIdx = resolvedParamType.typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        if (typeDef && typeDef.kind === "struct") {
          const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
          const arrDef = ctx.mod.types[arrTypeIdx];
          if (arrDef && arrDef.kind === "array") {
            const elemType = arrDef.element;
            const savedBodyFPAD = liftedFctx.body;
            const fpadInstrs: Instr[] = [];
            liftedFctx.body = fpadInstrs;
            for (let ei = 0; ei < param.name.elements.length; ei++) {
              const element = param.name.elements[ei]!;
              if (ts.isOmittedExpression(element)) continue;
              if (!ts.isBindingElement(element)) continue;

              // Handle rest element: function([a, ...rest])
              if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
                const restName = element.name.text;
                const restLenLocal = allocLocal(liftedFctx, `__rest_len_${liftedFctx.locals.length}`, { kind: "i32" });
                // Compute rest length: max(0, param.length - ei)
                liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
                liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
                liftedFctx.body.push({ op: "i32.const", value: ei });
                liftedFctx.body.push({ op: "i32.sub" } as Instr);
                liftedFctx.body.push({ op: "local.set", index: restLenLocal });
                // Clamp to 0 if negative
                liftedFctx.body.push({ op: "i32.const", value: 0 } as Instr);
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "i32.const", value: 0 } as Instr);
                liftedFctx.body.push({ op: "i32.lt_s" } as Instr);
                liftedFctx.body.push({ op: "select" } as Instr);
                liftedFctx.body.push({ op: "local.set", index: restLenLocal });

                // Create new data array
                const restArrLocal = allocLocal(liftedFctx, `__rest_arr_${liftedFctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
                liftedFctx.body.push({ op: "local.set", index: restArrLocal });

                // array.copy(restArr, 0, srcData, ei, restLen)
                liftedFctx.body.push({ op: "local.get", index: restArrLocal });
                liftedFctx.body.push({ op: "i32.const", value: 0 });
                liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
                liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // src data
                liftedFctx.body.push({ op: "i32.const", value: ei });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);

                // Create new vec struct: struct.new(restLen, restArr)
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "local.get", index: restArrLocal });
                liftedFctx.body.push({ op: "struct.new", typeIdx } as Instr);

                const vecType: ValType = { kind: "ref_null", typeIdx };
                const restLocal = allocLocal(liftedFctx, restName, vecType);
                liftedFctx.body.push({ op: "local.set", index: restLocal });
                continue;
              }

              if (!ts.isIdentifier(element.name)) continue;
              const localName = element.name.text;
              const localIdx = allocLocal(liftedFctx, localName, elemType);
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
              liftedFctx.body.push({ op: "i32.const", value: ei });
              emitBoundsCheckedArrayGet(liftedFctx, arrTypeIdx, elemType);
              liftedFctx.body.push({ op: "local.set", index: localIdx });
            }
            liftedFctx.body = savedBodyFPAD;
            if ((resolvedParamType.kind === "ref_null") && fpadInstrs.length > 0) {
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "ref.is_null" } as Instr);
              liftedFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fpadInstrs });
            } else {
              liftedFctx.body.push(...fpadInstrs);
            }
            handled = true;
          } else if (typeDef.fields.length > 0 && typeDef.fields[0]!.name === "_0") {
            // Tuple struct destructuring: extract positional fields via struct.get
            const savedBodyFPAD = liftedFctx.body;
            const fpadInstrs: Instr[] = [];
            liftedFctx.body = fpadInstrs;
            for (let ei = 0; ei < param.name.elements.length; ei++) {
              const element = param.name.elements[ei]!;
              if (ts.isOmittedExpression(element)) continue;
              if (!ts.isBindingElement(element)) continue;
              if (ei >= typeDef.fields.length) break;

              const fieldType = typeDef.fields[ei]!.type;
              if (!ts.isIdentifier(element.name)) continue;
              const localName = element.name.text;
              const localIdx = allocLocal(liftedFctx, localName, fieldType);
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: ei });
              liftedFctx.body.push({ op: "local.set", index: localIdx });
            }
            liftedFctx.body = savedBodyFPAD;
            if ((resolvedParamType.kind === "ref_null") && fpadInstrs.length > 0) {
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "ref.is_null" } as Instr);
              liftedFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fpadInstrs });
            } else {
              liftedFctx.body.push(...fpadInstrs);
            }
            handled = true;
          }
        }
      }
      if (!handled) {
        allocBindingLocals(param.name);
      }
    } else if (ts.isObjectBindingPattern(param.name)) {
      // Object destructuring: function({a, b}) { ... }
      let handled = false;
      if (paramType.kind === "ref" || paramType.kind === "ref_null") {
        const typeIdx = paramType.typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        if (typeDef && typeDef.kind === "struct") {
          let allFound = true;
          const savedBodyFPOD = liftedFctx.body;
          const fpodInstrs: Instr[] = [];
          liftedFctx.body = fpodInstrs;
          for (const element of param.name.elements) {
            if (ts.isOmittedExpression(element)) continue;
            if (!ts.isIdentifier(element.name)) continue;
            const localName = element.name.text;
            const propName = element.propertyName
              ? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : localName)
              : localName;
            const fieldIdx = typeDef.fields.findIndex((f: any) => f.name === propName);
            if (fieldIdx < 0) { allFound = false; continue; }
            const fieldType = typeDef.fields[fieldIdx]!.type;
            const localIdx = allocLocal(liftedFctx, localName, fieldType);
            liftedFctx.body.push({ op: "local.get", index: paramIdx });
            liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
            liftedFctx.body.push({ op: "local.set", index: localIdx });
          }
          liftedFctx.body = savedBodyFPOD;
          if (paramType.kind === "ref_null" && fpodInstrs.length > 0) {
            liftedFctx.body.push({ op: "local.get", index: paramIdx });
            liftedFctx.body.push({ op: "ref.is_null" } as Instr);
            liftedFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fpodInstrs });
          } else {
            liftedFctx.body.push(...fpodInstrs);
          }
          handled = allFound;
        }
      }
      if (!handled) {
        allocBindingLocals(param.name);
      }
    }
  }

  let conciseBodyHasValue = false;

  if (isGenerator && ts.isBlock(body)) {
    // Generator function expression: eagerly evaluate body, collect yields
    // into a buffer, then wrap with __create_generator.
    const bufferLocal = allocLocal(liftedFctx, "__gen_buffer", { kind: "externref" });
    const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
    liftedFctx.body.push({ op: "call", funcIdx: createBufIdx });
    liftedFctx.body.push({ op: "local.set", index: bufferLocal });

    // Wrap body in a block so return can br out
    const bodyInstrs: Instr[] = [];
    const outerBody = liftedFctx.body;
    liftedFctx.body = bodyInstrs;

    liftedFctx.generatorReturnDepth = 0;
    liftedFctx.blockDepth++;
    for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!++;
    for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!++;

    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }

    liftedFctx.blockDepth--;
    for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!--;
    for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!--;
    liftedFctx.generatorReturnDepth = undefined;

    liftedFctx.body = outerBody;
    liftedFctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    });

    // Return __create_generator(__gen_buffer)
    const createGenIdx = ctx.funcMap.get("__create_generator")!;
    liftedFctx.body.push({ op: "local.get", index: bufferLocal });
    liftedFctx.body.push({ op: "call", funcIdx: createGenIdx });
    conciseBodyHasValue = true; // generator return value is already on stack
  } else if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    const exprType = compileExpression(ctx, liftedFctx, body);
    if (exprType !== null && closureReturnType) {
      // Expression result is the return value - already on stack
      conciseBodyHasValue = true;

      // The actual expression type may differ from the declared return type
      // (e.g. TS infers `any`->externref but codegen produces f64 for arithmetic).
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

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
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
  } else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    // Assignment expression: f = function() { ... }
    // Only register if the target variable is a local in the current function context
    // and not a boxed (mutable) capture, which stores values as externref.
    const assignName = parent.left.text;
    const currentFctx = ctx.currentFunc;
    const localIdx = currentFctx.localMap.get(assignName);
    if (localIdx !== undefined && !currentFctx.boxedCaptures?.has(assignName)) {
      // It's a local variable (not a boxed capture) — safe to register as closure
      ctx.closureMap.set(assignName, closureInfo);
    }
  } else if (
    ts.isPropertyAssignment(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    // Object literal: { fn: function() { ... } }
    // Don't register in closureMap (property, not variable)
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
    // Skip if the name is the arrow's own parameter (including destructuring bindings)
    if (isOwnParamName(arrow, name)) continue;
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
    savedBodies: [],
    enclosingClassName: fctx.enclosingClassName ?? resolveEnclosingClassName(fctx),
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
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = cbFctx;

  // Emit default-value initialization for simple params with defaults
  emitArrowParamDefaults(ctx, cbFctx, arrow, 1 /* skip __captures */);

  // Emit destructuring code for binding pattern parameters
  for (let i = 0; i < arrow.parameters.length; i++) {
    const param = arrow.parameters[i]!;
    if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) {
      emitArrowParamDestructuring(ctx, cbFctx, param, 1 + i, cbParams[i + 1] ?? { kind: "f64" });
    }
  }

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

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
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

/**
 * Look up a function's parameter and result types from its index.
 */
function getFuncSignature(ctx: CodegenContext, funcIdx: number): { params: ValType[]; results: ValType[] } | null {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          if (typeDef?.kind === "func") return { params: typeDef.params, results: typeDef.results };
          return null;
        }
        importFuncCount++;
      }
    }
  } else {
    const localIdx = funcIdx - ctx.numImportFuncs;
    const func = ctx.mod.functions[localIdx];
    if (func) {
      const typeDef = ctx.mod.types[func.typeIdx];
      if (typeDef?.kind === "func") return { params: typeDef.params, results: typeDef.results };
    }
  }
  return null;
}

/**
 * Get or create the closure struct type and lifted func type for wrapping
 * plain functions with a given signature. Struct type and func type are shared
 * across all functions with the same signature, but each function gets its own
 * trampoline.
 */
export function getOrCreateFuncRefWrapperTypes(
  ctx: CodegenContext,
  userParams: ValType[],
  resultTypes: ValType[],
): { structTypeIdx: number; liftedFuncTypeIdx: number; closureInfo: ClosureInfo } | null {
  // Build cache key from param types and result types
  const sigKey = `${userParams.map(p => p.kind + ((p as any).typeIdx ?? "")).join(",")}->${resultTypes.map(r => r.kind + ((r as any).typeIdx ?? "")).join(",")}`;

  const cached = ctx.funcRefWrapperCache.get(sigKey);
  if (cached) {
    return { structTypeIdx: cached.structTypeIdx, liftedFuncTypeIdx: cached.funcTypeIdx, closureInfo: cached };
  }

  // Create the closure struct type: just (field $func funcref), no captures.
  // Mark as non-final (superTypeIdx = -1) so closures with captures can be
  // subtypes of this wrapper struct, enabling ref.cast to succeed at call sites.
  const closureName = `__fn_wrap_${ctx.closureCounter++}`;
  const structFields = [
    { name: "func", type: { kind: "funcref" as const }, mutable: false },
  ];
  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
    superTypeIdx: -1, // non-final, no parent — allows subtypes
  });

  // Create the lifted function type: (ref $struct, ...userParams) -> results
  const liftedParams: ValType[] = [
    { kind: "ref", typeIdx: structTypeIdx },
    ...userParams,
  ];
  const liftedFuncTypeIdx = addFuncType(ctx, liftedParams, resultTypes, `${closureName}_type`);

  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: resultTypes.length > 0 ? resultTypes[0]! : null,
    paramTypes: userParams,
  };
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);
  ctx.funcRefWrapperCache.set(sigKey, closureInfo);

  return { structTypeIdx, liftedFuncTypeIdx, closureInfo };
}

/**
 * Emit a closure struct wrapping a plain function. Creates a per-function
 * trampoline that delegates to the original function.  Struct types are shared
 * across functions with the same signature so they can be reassigned.
 * Pushes the closure struct ref onto the stack and returns its type.
 */
function emitFuncRefAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  funcIdx: number,
): ValType | null {
  const sig = getFuncSignature(ctx, funcIdx);
  if (!sig) return null;

  // Skip functions with nested-func captures (their first N params are capture values
  // from the enclosing scope, which can't be threaded through a generic trampoline)
  const nestedCaptures = ctx.nestedFuncCaptures.get(funcName);
  if (nestedCaptures && nestedCaptures.length > 0) return null;

  const userParams = sig.params;

  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, sig.results);
  if (!wrapperTypes) return null;

  const { structTypeIdx, liftedFuncTypeIdx, closureInfo } = wrapperTypes;

  // Create a trampoline function for THIS specific function.
  // The trampoline takes (self, ...userParams) and calls the original function.
  const trampolineName = `__fn_tramp_${funcName}_${ctx.closureCounter++}`;
  const trampolineBody: Instr[] = [];

  // Push the user-visible params (skip self at param 0)
  for (let i = 0; i < userParams.length; i++) {
    trampolineBody.push({ op: "local.get", index: i + 1 } as Instr);
  }
  trampolineBody.push({ op: "call", funcIdx } as Instr);

  const trampolineFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: trampolineName,
    typeIdx: liftedFuncTypeIdx,
    locals: [],
    body: trampolineBody,
    exported: false,
  });
  ctx.funcMap.set(trampolineName, trampolineFuncIdx);

  // Emit: ref.func $trampoline, struct.new $closure_struct
  fctx.body.push({ op: "ref.func", funcIdx: trampolineFuncIdx });
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * Emit a TDZ check for a function-local let/const variable.
 * If the TDZ flag local is 0 (uninitialized), throw a ReferenceError.
 */
export function emitLocalTdzCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  flagIdx: number,
): void {
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "local.get", index: flagIdx });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "ref.null.extern" } as Instr,
      { op: "throw", tagIdx },
    ],
    else: [],
  } as unknown as Instr);
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
      emitLocalTdzCheck(ctx, fctx, name, tdzFlagIdx);
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
        undefined, /* propName */
        false, /* throwOnNull — ref cells use default for uninitialized captures */
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
    emitTdzCheck(ctx, fctx, name);
    fctx.body.push({ op: "global.get", index: capturedIdx });
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
    const gType = globalDef?.type ?? { kind: "f64" };
    // Globals widened from ref to ref_null for null init — narrow back
    if (gType.kind === "ref_null" && (ctx.capturedGlobalsWidened.has(name) || fctx.narrowedNonNull?.has(name))) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: gType.typeIdx };
    }
    return gType;
  }

  // Check module-level globals (top-level let/const declarations)
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined) {
    // TDZ check: throw ReferenceError if let/const variable accessed before initialization
    emitTdzCheck(ctx, fctx, name);
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
  if (funcRefIdx !== undefined &&
      !name.startsWith("__") &&
      !ctx.classSet.has(name)) {
    // Check if there's already a closure registered (e.g. from closureMap)
    const existingClosure = ctx.closureMap.get(name);
    if (existingClosure) {
      // Already a closure — check if there's a module-level global for it
      const closureModGlobal = ctx.moduleGlobals.get(name);
      if (closureModGlobal !== undefined) {
        fctx.body.push({ op: "global.get", index: closureModGlobal });
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, closureModGlobal)];
        return globalDef?.type ?? { kind: "ref", typeIdx: existingClosure.structTypeIdx };
      }
    }
    // Wrap the plain function in a closure struct
    const refType = emitFuncRefAsClosure(ctx, fctx, name, funcRefIdx);
    if (refType) return refType;
  }

  // Graceful fallback for unknown identifiers — emit a type-appropriate default
  // instead of a hard compile error. This allows the compiler to continue past
  // references to unimplemented globals (Symbol, Object, Reflect, etc.) and
  // test harness variables.
  // Use the TypeScript type to determine the correct Wasm default value:
  //   number → f64.const 0 (matches JS `undefined` coerced to number = NaN,
  //            but 0 is a safe default for hoisted vars)
  //   boolean → i32.const 0
  //   otherwise → ref.null extern
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

/**
 * Collect all class tags that are "instanceof-compatible" with the given class:
 * the class itself plus all its descendants (transitive children).
 */
function collectInstanceOfTags(ctx: CodegenContext, className: string): number[] {
  const ownTag = ctx.classTagMap.get(className);
  if (ownTag === undefined) return [];
  const tags = [ownTag];
  // Walk classParentMap to find all children (classes whose parent is className)
  for (const [child, parent] of ctx.classParentMap) {
    if (parent === className) {
      tags.push(...collectInstanceOfTags(ctx, child));
    }
  }
  return tags;
}

/**
 * Resolve the class name from the right operand of an instanceof expression.
 * Handles identifiers, class expressions, and arbitrary expressions via the type checker.
 */
function resolveInstanceOfClassName(
  ctx: CodegenContext,
  rightExpr: ts.Expression,
): string | undefined {
  // Direct identifier: `x instanceof Foo`
  if (ts.isIdentifier(rightExpr)) {
    const name = rightExpr.text;
    // Check direct name first, then classExprNameMap
    if (ctx.classTagMap.has(name)) return name;
    const mapped = ctx.classExprNameMap.get(name);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    // Fall through to type checker
  }

  // Use the TypeScript type checker to resolve the type of the right operand
  const tsType = ctx.checker.getTypeAtLocation(rightExpr);
  // For class constructors, get the construct signatures' return type
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

  // Try the symbol name directly (for class expressions assigned to variables)
  const symbolName = tsType.getSymbol()?.name;
  if (symbolName) {
    if (ctx.classTagMap.has(symbolName)) return symbolName;
    const mapped = ctx.classExprNameMap.get(symbolName);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }

  return undefined;
}

/**
 * Compile `expr instanceof ClassName`.
 * Reads the hidden __tag field (index 0) from the struct and compares
 * it against the class's compile-time tag value (and all descendant tags
 * for class hierarchy support).
 */
function compileInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  // Resolve the right operand class name (supports identifiers, expressions, class expressions)
  const className = resolveInstanceOfClassName(ctx, expr.right);
  if (className === undefined) {
    // Cannot resolve the class — emit false (i32.const 0) as a graceful fallback
    // We still need to compile the left operand for side effects, then drop it
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Collect all compatible tags (this class + all descendants)
  const compatibleTags = collectInstanceOfTags(ctx, className);
  if (compatibleTags.length === 0) {
    // No tags found — emit false
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Compile left operand (the value to test) — must be a ref to a class struct
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) return null;

  // Resolve the struct type index for the right-side class (the target we test against)
  const rightStructTypeIdx = ctx.structMap.get(className);

  // Find the root ancestor of the right class (for casting externref values)
  let rootClass = className;
  while (ctx.classParentMap.has(rootClass)) {
    rootClass = ctx.classParentMap.get(rootClass)!;
  }
  const rootStructTypeIdx = ctx.structMap.get(rootClass) ?? rightStructTypeIdx;

  // --- Handle externref left operand (any type) ---
  // When the left operand is externref, we cannot do struct.get directly.
  // Convert externref -> anyref, try to cast to the root struct type,
  // then read the __tag field and compare against compatible tags.
  // We use ref.test first to avoid trapping on non-struct values (null, primitives).
  if (leftType.kind === "externref") {
    if (rootStructTypeIdx === undefined) {
      // Cannot resolve any struct type — drop and emit false
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // Convert externref -> anyref, store in local
    fctx.body.push({ op: "any.convert_extern" });
    const anyLocalIdx = allocTempLocal(fctx, { kind: "anyref" });
    fctx.body.push({ op: "local.set", index: anyLocalIdx });

    // Build the "then" branch: value is NOT a struct of the right root type → false
    const thenBody: Instr[] = [
      { op: "i32.const", value: 0 },
    ];

    // Build the "else" branch: value IS a struct → read __tag and compare
    const elseBody: Instr[] = [
      { op: "local.get", index: anyLocalIdx },
      { op: "ref.cast", typeIdx: rootStructTypeIdx },
      { op: "struct.get", typeIdx: rootStructTypeIdx, fieldIdx: 0 },
    ];

    if (compatibleTags.length === 1) {
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
    } else {
      const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
      elseBody.push({ op: "local.set", index: tagLocalIdx });
      elseBody.push({ op: "local.get", index: tagLocalIdx });
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
      for (let i = 1; i < compatibleTags.length; i++) {
        elseBody.push({ op: "local.get", index: tagLocalIdx });
        elseBody.push({ op: "i32.const", value: compatibleTags[i]! });
        elseBody.push({ op: "i32.eq" });
        elseBody.push({ op: "i32.or" });
      }
    }

    // Emit: (local.get $any) (ref.test (ref $rootStruct))
    //        (if (result i32) (then i32.const 0) (else ...read tag...))
    // Note: ref.test returns 0 for non-struct values and null, 1 for matching struct.
    // We invert the condition: if ref.test FAILS → 0, if PASSES → check tag.
    fctx.body.push({ op: "local.get", index: anyLocalIdx });
    fctx.body.push({ op: "ref.test", typeIdx: rootStructTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: elseBody,   // ref.test passed → check tag
      else: thenBody,    // ref.test failed → false
    });
    releaseTempLocal(fctx, anyLocalIdx);

    return { kind: "i32" };
  }

  // --- Handle i32 or f64 left operand (primitive types) ---
  // Primitives are never instances of a class — drop and emit false
  if (leftType.kind === "i32" || leftType.kind === "f64") {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // --- Resolve the struct type index from the left operand's type ---
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  let leftClassName = leftTsType.getSymbol()?.name;
  if (leftClassName && !ctx.structMap.has(leftClassName)) {
    leftClassName = ctx.classExprNameMap.get(leftClassName) ?? leftClassName;
  }
  let leftStructTypeIdx = leftClassName ? ctx.structMap.get(leftClassName) : undefined;

  // If the left operand type is not directly resolvable, try to find any struct
  // that could be the base type. For union types or 'any', we try the right class's struct.
  if (leftStructTypeIdx === undefined) {
    leftStructTypeIdx = rootStructTypeIdx;
  }

  if (leftStructTypeIdx === undefined) {
    // Still cannot resolve — drop left value and emit false
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // --- Handle nullable ref (ref_null) — null instanceof X must be false ---
  // For nullable refs, emit: if (ref.is_null) then 0 else (tag check)
  const isNullable = leftType.kind === "ref_null";
  if (isNullable) {
    // Store the ref in a local so we can test it for null and re-use it
    const refLocalIdx = allocLocal(fctx, `__instanceof_ref_${fctx.locals.length}`, leftType);
    fctx.body.push({ op: "local.set", index: refLocalIdx });

    // Build the "then" branch (null case → false)
    const thenBody: Instr[] = [
      { op: "i32.const", value: 0 },
    ];

    // Build the "else" branch (non-null case → read tag and compare)
    const elseBody: Instr[] = [
      { op: "local.get", index: refLocalIdx },
      { op: "ref.cast", typeIdx: leftStructTypeIdx },
      { op: "struct.get", typeIdx: leftStructTypeIdx, fieldIdx: 0 },
    ];

    if (compatibleTags.length === 1) {
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
    } else {
      const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
      elseBody.push({ op: "local.set", index: tagLocalIdx });
      elseBody.push({ op: "local.get", index: tagLocalIdx });
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
      for (let i = 1; i < compatibleTags.length; i++) {
        elseBody.push({ op: "local.get", index: tagLocalIdx });
        elseBody.push({ op: "i32.const", value: compatibleTags[i]! });
        elseBody.push({ op: "i32.eq" });
        elseBody.push({ op: "i32.or" });
      }
    }

    // Emit: (local.get $ref) (ref.is_null) (if (result i32) (then ...) (else ...))
    fctx.body.push({ op: "local.get", index: refLocalIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: thenBody,
      else: elseBody,
    });

    return { kind: "i32" };
  }

  // --- Non-nullable ref path: read __tag field directly ---
  // Read the __tag field (field index 0) from the struct
  fctx.body.push({ op: "struct.get", typeIdx: leftStructTypeIdx, fieldIdx: 0 });

  if (compatibleTags.length === 1) {
    // Simple case: exact match only (no subclasses)
    fctx.body.push({ op: "i32.const", value: compatibleTags[0]! });
    fctx.body.push({ op: "i32.eq" });
  } else {
    // Multiple tags: emit (tag == t1) || (tag == t2) || ...
    // We need to store the tag value in a local to avoid re-reading it
    const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: tagLocalIdx });

    // First comparison
    fctx.body.push({ op: "local.get", index: tagLocalIdx });
    fctx.body.push({ op: "i32.const", value: compatibleTags[0]! });
    fctx.body.push({ op: "i32.eq" });

    // Remaining comparisons, OR'd together
    for (let i = 1; i < compatibleTags.length; i++) {
      fctx.body.push({ op: "local.get", index: tagLocalIdx });
      fctx.body.push({ op: "i32.const", value: compatibleTags[i]! });
      fctx.body.push({ op: "i32.eq" });
      fctx.body.push({ op: "i32.or" });
    }
  }

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

  // typeof Math.<constant> → "number", typeof Math.<method> → "function"
  if (ts.isPropertyAccessExpression(operand) &&
      ts.isIdentifier(operand.expression) &&
      operand.expression.text === "Math") {
    const mathConstants = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
    if (mathConstants.has(operand.name.text)) {
      return compileStringLiteral(ctx, fctx, "number");
    }
    return compileStringLiteral(ctx, fctx, "function");
  }

  // typeof import.meta → "object"
  if (ts.isMetaProperty(operand) &&
      operand.keywordToken === ts.SyntaxKind.ImportKeyword &&
      operand.name.text === "meta") {
    return compileStringLiteral(ctx, fctx, "object");
  }

  // typeof new.target → "function" inside constructors, "undefined" outside
  if (ts.isMetaProperty(operand) &&
      operand.keywordToken === ts.SyntaxKind.NewKeyword &&
      operand.name.text === "target") {
    if (fctx.isConstructor) {
      return compileStringLiteral(ctx, fctx, "function");
    } else {
      return compileStringLiteral(ctx, fctx, "undefined");
    }
  }

  const tsType = ctx.checker.getTypeAtLocation(operand);

  // Handle null and undefined before wasm type mapping, since they map
  // to externref/i32 which would give wrong typeof results.
  if (tsType.flags & ts.TypeFlags.Null) {
    return compileStringLiteral(ctx, fctx, "object");
  }
  if (tsType.flags & ts.TypeFlags.Undefined || tsType.flags & ts.TypeFlags.Void) {
    return compileStringLiteral(ctx, fctx, "undefined");
  }

  const wasmType = resolveWasmType(ctx, tsType);

  // For statically known types, emit the constant string directly.
  // The type-name strings are pre-registered by collectStringLiterals.
  if (wasmType.kind === "f64") {
    return compileStringLiteral(ctx, fctx, "number");
  }
  if (wasmType.kind === "i32") {
    // Determine if this is boolean, symbol, or number (i32 is used for all three)
    if (isSymbolType(tsType)) {
      return compileStringLiteral(ctx, fctx, "symbol");
    }
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
    // Also check construct signatures — classes have typeof "function"
    const ctorSigs = tsType.getConstructSignatures?.();
    if (ctorSigs && ctorSigs.length > 0) {
      return compileStringLiteral(ctx, fctx, "function");
    }
    return compileStringLiteral(ctx, fctx, "object");
  }

  // For externref: check if the TS type is statically known as string
  if (isStringType(tsType)) {
    return compileStringLiteral(ctx, fctx, "string");
  }

  // For externref types: check call/construct signatures for function types
  if (wasmType.kind === "externref") {
    const callSigs = tsType.getCallSignatures?.();
    if (callSigs && callSigs.length > 0) {
      return compileStringLiteral(ctx, fctx, "function");
    }
    const ctorSigs = tsType.getConstructSignatures?.();
    if (ctorSigs && ctorSigs.length > 0) {
      return compileStringLiteral(ctx, fctx, "function");
    }
    // If the TS type is a known object type (not any/unknown), resolve statically
    if (tsType.flags & ts.TypeFlags.Object) {
      return compileStringLiteral(ctx, fctx, "object");
    }
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
  // Math.<constant> → "number", Math.<method> → "function"
  if (ts.isPropertyAccessExpression(operand) &&
      ts.isIdentifier(operand.expression) &&
      operand.expression.text === "Math") {
    const mathConstants = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
    staticTypeof = mathConstants.has(operand.name.text) ? "number" : "function";
  } else if (tsType.flags & ts.TypeFlags.Null) {
    staticTypeof = "object";
  } else if (tsType.flags & ts.TypeFlags.Undefined || tsType.flags & ts.TypeFlags.Void) {
    staticTypeof = "undefined";
  } else {
    const wasmType = resolveWasmType(ctx, tsType);
    if (wasmType.kind === "f64") staticTypeof = "number";
    else if (wasmType.kind === "i32") staticTypeof = isSymbolType(tsType) ? "symbol" : isBooleanType(tsType) ? "boolean" : "number";
    else if ((wasmType.kind === "ref" || wasmType.kind === "ref_null") && !isAnyValue(wasmType, ctx)) {
      const callSigs = tsType.getCallSignatures?.();
      const ctorSigs2 = tsType.getConstructSignatures?.();
      staticTypeof = (callSigs && callSigs.length > 0) || (ctorSigs2 && ctorSigs2.length > 0) ? "function" : "object";
    }
    else if (isStringType(tsType)) staticTypeof = "string";
    else if (wasmType.kind === "externref") {
      const callSigs = tsType.getCallSignatures?.();
      const ctorSigs2 = tsType.getConstructSignatures?.();
      if ((callSigs && callSigs.length > 0) || (ctorSigs2 && ctorSigs2.length > 0)) {
        staticTypeof = "function";
      } else if (tsType.flags & ts.TypeFlags.Object) {
        staticTypeof = "object";
      }
    }
  }
  if (staticTypeof !== null) {
    const matches = staticTypeof === stringLiteral;
    const result = isEq ? (matches ? 1 : 0) : (matches ? 0 : 1);
    fctx.body.push({ op: "i32.const", value: result });
    return { kind: "i32" };
  }

  // Any-typed typeof comparison via tag check
  // Instead of calling __any_typeof + string comparison, we can directly check the tag
  // on the $AnyValue struct. This avoids pulling in the full native string helpers.
  if (isAnyValue(resolveWasmType(ctx, tsType), ctx)) {
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
        const tagLocal = allocTempLocal(fctx, { kind: "i32" });
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
        releaseTempLocal(fctx, tagLocal);
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

/**
 * Operators eligible for chain flattening — arithmetic and bitwise ops that
 * take two numeric operands and produce a numeric result of the same type.
 * We exclude ** (exponentiation) because it calls Math_pow and comparison
 * operators because they produce i32 (boolean), not f64.
 */
const FLATTENABLE_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

/**
 * Try to flatten a left-recursive chain of the same binary operator into an
 * iterative compilation. For expressions like `a + b + c + d` (AST:
 * `((a + b) + c) + d`), this avoids O(n) JS call-stack depth and improves
 * compilation speed for long chains.
 *
 * Returns null if flattening is not applicable (not the same operator
 * throughout, non-numeric operands, chain too short, etc.).
 */
function tryFlattenBinaryChain(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): InnerResult | null {
  // Only flatten operators that produce the same type as their inputs
  if (!FLATTENABLE_OPS.has(op)) return null;

  // Must have at least 3 operands (i.e., left is also a binary expr with same op)
  if (!ts.isBinaryExpression(expr.left) || expr.left.operatorToken.kind !== op) {
    return null;
  }

  // Collect all leaf operands by walking the left-recursive spine
  const operands: ts.Expression[] = [];
  let node: ts.Expression = expr;
  while (ts.isBinaryExpression(node) && node.operatorToken.kind === op) {
    operands.push(node.right);
    node = node.left;
  }
  operands.push(node); // leftmost operand
  operands.reverse(); // now in left-to-right order

  // Verify all operands are numeric (not string, not any, not bigint)
  // If plus and any operand is a string type, bail out — it's string concat
  for (const operand of operands) {
    const tsType = ctx.checker.getTypeAtLocation(operand);
    if (isStringType(tsType)) return null;
    if (isBigIntType(tsType)) return null;
    if ((tsType.flags & ts.TypeFlags.Any) !== 0) return null;
  }

  // Determine numeric hint — also check if all operands use native i32 type annotations
  const isDivOrPow = op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.AsteriskAsteriskToken;
  let allNativeI32 = !isDivOrPow;
  if (allNativeI32 && !ctx.fast) {
    for (const operand of operands) {
      const tsType = ctx.checker.getTypeAtLocation(operand);
      const native = resolveNativeTypeAnnotation(tsType);
      if (native?.kind !== "i32") { allNativeI32 = false; break; }
    }
  }
  const numericHint: ValType = { kind: ((ctx.fast || allNativeI32) && !isDivOrPow) ? "i32" : "f64" };

  // Compile first operand
  let resultType = compileExpression(ctx, fctx, operands[0], numericHint);
  if (!resultType) return null;

  // Compile subsequent operands, emitting the operator after each pair
  for (let i = 1; i < operands.length; i++) {
    let rightType = compileExpression(ctx, fctx, operands[i], numericHint);
    if (!rightType) return null;

    // Promote i32/f64 mismatch
    if (resultType.kind === "i32" && rightType.kind === "f64") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
      resultType = { kind: "f64" };
      rightType = { kind: "f64" };
    } else if (resultType.kind === "f64" && rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      rightType = { kind: "f64" };
    }

    // i32 path: fast mode or native type annotations
    if ((ctx.fast || allNativeI32) && resultType.kind === "i32" && rightType.kind === "i32") {
      resultType = compileI32BinaryOp(ctx, fctx, op, expr);
    } else {
      resultType = compileNumericBinaryOp(ctx, fctx, op, expr);
    }
  }

  return resultType;
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
  const isStrictEqOp = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isStrictNeqOp = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isLooseEqOp = op === ts.SyntaxKind.EqualsEqualsToken;
  const isLooseNeqOp = op === ts.SyntaxKind.ExclamationEqualsToken;
  if (isEqOp || isNeqOp) {
    const rightIsNullKeyword = expr.right.kind === ts.SyntaxKind.NullKeyword;
    const rightIsUndefinedId = ts.isIdentifier(expr.right) && expr.right.text === "undefined";
    const rightIsNullish = rightIsNullKeyword || rightIsUndefinedId;
    const leftIsNullKeyword = expr.left.kind === ts.SyntaxKind.NullKeyword;
    const leftIsUndefinedId = ts.isIdentifier(expr.left) && expr.left.text === "undefined";
    const leftIsNullish = leftIsNullKeyword || leftIsUndefinedId;
    if (rightIsNullish || leftIsNullish) {
      // Determine which side is the literal null/undefined and which is the expression
      const nonNullExpr = rightIsNullish ? expr.left : expr.right;

      // Check if the non-null side is also a null/undefined literal
      const nonNullIsNullKeyword = rightIsNullish ? leftIsNullKeyword : rightIsNullKeyword;
      const nonNullIsUndefinedId = rightIsNullish ? leftIsUndefinedId : rightIsUndefinedId;
      const nullSideIsNullKeyword = rightIsNullish ? rightIsNullKeyword : leftIsNullKeyword;
      const nullSideIsUndefinedId = rightIsNullish ? rightIsUndefinedId : leftIsUndefinedId;

      // Both sides are null/undefined literals
      if (nonNullIsNullKeyword || nonNullIsUndefinedId) {
        // For strict equality: null === null or undefined === undefined → true;
        //                      null === undefined → false
        if (isStrictEqOp || isStrictNeqOp) {
          const sameKind = (nonNullIsNullKeyword && nullSideIsNullKeyword) ||
                           (nonNullIsUndefinedId && nullSideIsUndefinedId);
          fctx.body.push({ op: "i32.const", value: isStrictEqOp ? (sameKind ? 1 : 0) : (sameKind ? 0 : 1) });
          return { kind: "i32" };
        }
        // For loose equality: null == undefined → true
        fctx.body.push({ op: "i32.const", value: isLooseEqOp ? 1 : 0 });
        return { kind: "i32" };
      }

      // Check the TS type of the non-null side to detect undefined/null-typed variables
      const nonNullTsType = ctx.checker.getTypeAtLocation(nonNullExpr);
      const nonNullIsUndefinedType = (nonNullTsType.flags & ts.TypeFlags.Undefined) !== 0 ||
                                      (nonNullTsType.flags & ts.TypeFlags.Void) !== 0;
      const nonNullIsNullType = (nonNullTsType.flags & ts.TypeFlags.Null) !== 0;

      // Compile the non-null side
      const valType = compileExpression(ctx, fctx, nonNullExpr);
      if (valType === null) {
        // Void expression (e.g. void function call) compared to null/undefined:
        // void returns undefined, so undefined == undefined/null is true (loose)
        // undefined === undefined is true, undefined === null is false (strict)
        if (isStrictEqOp || isStrictNeqOp) {
          const sameKind = nullSideIsUndefinedId; // void = undefined
          fctx.body.push({ op: "i32.const", value: isStrictEqOp ? (sameKind ? 1 : 0) : (sameKind ? 0 : 1) });
        } else {
          fctx.body.push({ op: "i32.const", value: isEqOp ? 1 : 0 });
        }
        return { kind: "i32" };
      }
      if (valType.kind === "externref") {
        // For strict equality: if non-null side is externref (could be null-typed variable)
        // and the literal side is undefined, null === undefined is false
        if ((isStrictEqOp || isStrictNeqOp) && nonNullIsNullType && (nullSideIsUndefinedId)) {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: isStrictNeqOp ? 1 : 0 });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "ref.is_null" });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
      // Non-externref type compared with null/undefined:
      // If the TS type is undefined or null, it's a nullish value stored as i32
      if (nonNullIsUndefinedType || nonNullIsNullType) {
        fctx.body.push({ op: "drop" });
        // Loose equality: undefined/null == null/undefined → true
        if (isLooseEqOp || isLooseNeqOp) {
          fctx.body.push({ op: "i32.const", value: isLooseEqOp ? 1 : 0 });
          return { kind: "i32" };
        }
        // Strict equality: only true if same kind
        const sameKind = (nonNullIsUndefinedType && nullSideIsUndefinedId) ||
                         (nonNullIsNullType && nullSideIsNullKeyword);
        fctx.body.push({ op: "i32.const", value: isStrictEqOp ? (sameKind ? 1 : 0) : (sameKind ? 0 : 1) });
        return { kind: "i32" };
      }
      // For ref/ref_null struct types, use ref.is_null to check nullability
      if (valType.kind === "ref" || valType.kind === "ref_null") {
        fctx.body.push({ op: "ref.is_null" });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
      // For other non-externref types (number, boolean), always not-equal to null/undefined
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isNeqOp ? 1 : 0 });
      return { kind: "i32" };
    }
  }

  // `key in obj` — compile-time property existence check
  if (op === ts.SyntaxKind.InKeyword) {
    const rightType = ctx.checker.getTypeAtLocation(expr.right);
    const rightWasm = resolveWasmType(ctx, rightType);

    // Get struct field names if available; detect vec (array) types
    let structFieldNames: string[] | null = null;
    let isVecType = false;
    let vecTypeIdx = -1;
    if (rightWasm.kind === "ref" || rightWasm.kind === "ref_null") {
      const typeIdx = (rightWasm as { typeIdx: number }).typeIdx;
      const structDef = ctx.mod.types[typeIdx];
      if (structDef?.kind === "struct") {
        if (structDef.name?.startsWith("__vec_")) {
          isVecType = true;
          vecTypeIdx = typeIdx;
        } else {
          structFieldNames = structDef.fields.map(f => f.name).filter((n): n is string => n !== undefined);
        }
      }
    }

    // Resolve the key to a compile-time string if possible.
    // For comma expressions like (x = y, "key"), extract the last element.
    // For PrivateIdentifier (#field in obj), extract the field name without '#'.
    let staticKey: string | null = null;
    let leftExpr: ts.Expression = expr.left;
    if (ts.isPrivateIdentifier(leftExpr)) {
      staticKey = leftExpr.text.startsWith("#") ? leftExpr.text.slice(1) : leftExpr.text;
    } else if (ts.isStringLiteral(leftExpr)) {
      staticKey = leftExpr.text;
    } else if (ts.isNumericLiteral(leftExpr)) {
      staticKey = leftExpr.text;
    } else if (ts.isBinaryExpression(leftExpr) && leftExpr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // Comma expression: extract the last element for the static key
      let last: ts.Expression = leftExpr.right;
      while (ts.isBinaryExpression(last) && last.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        last = last.right;
      }
      if (ts.isStringLiteral(last)) {
        staticKey = last.text;
      } else if (ts.isNumericLiteral(last)) {
        staticKey = last.text;
      }
    } else if (ts.isParenthesizedExpression(leftExpr)) {
      // Parenthesized expression: unwrap and check for comma or literal
      let inner = leftExpr.expression;
      if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        let last: ts.Expression = inner.right;
        while (ts.isBinaryExpression(last) && last.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          last = last.right;
        }
        if (ts.isStringLiteral(last)) {
          staticKey = last.text;
        } else if (ts.isNumericLiteral(last)) {
          staticKey = last.text;
        }
      } else if (ts.isStringLiteral(inner)) {
        staticKey = inner.text;
      } else if (ts.isNumericLiteral(inner)) {
        staticKey = inner.text;
      }
    }

    // Also check the TypeScript type system for property existence.
    // This handles built-in constructors (Number.MAX_VALUE), prototype methods
    // (valueOf, toString), and dynamically assigned properties.
    let tsTypeHasProperty = false;
    if (staticKey !== null) {
      // Check direct properties on the TypeScript type
      const prop = rightType.getProperty(staticKey);
      if (prop) {
        tsTypeHasProperty = true;
      }
      // Check the right side's type for comma expressions too
      if (!tsTypeHasProperty && ts.isBinaryExpression(expr.right) && expr.right.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        let lastRight: ts.Expression = expr.right.right;
        while (ts.isBinaryExpression(lastRight) && lastRight.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          lastRight = lastRight.right;
        }
        const lastRightType = ctx.checker.getTypeAtLocation(lastRight);
        const prop2 = lastRightType.getProperty(staticKey);
        if (prop2) tsTypeHasProperty = true;
      }
      // Also check apparent type (includes prototype methods like valueOf, toString)
      if (!tsTypeHasProperty) {
        const apparentType = ctx.checker.getApparentType(rightType);
        const apparentProp = apparentType.getProperty(staticKey);
        if (apparentProp) tsTypeHasProperty = true;
      }
    }

    // Array (vec) index bounds check: `index in arr` → 0 <= index < arr.length
    if (isVecType && staticKey !== null) {
      const numIdx = Number(staticKey);
      if (Number.isFinite(numIdx) && numIdx >= 0 && Number.isInteger(numIdx)) {
        // Evaluate left for side effects, drop result
        const leftResult = compileExpression(ctx, fctx, expr.left);
        if (leftResult && leftResult !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
        // Compile the array expression to get the vec struct
        const rightResult = compileExpression(ctx, fctx, expr.right);
        if (rightResult && rightResult !== VOID_RESULT) {
          // Read length field (field 0 of vec struct)
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          // Compare: numIdx < length
          fctx.body.push({ op: "i32.const", value: numIdx });
          fctx.body.push({ op: "i32.gt_s" }); // length > index  <==>  index < length
        } else {
          fctx.body.push({ op: "i32.const", value: 0 });
        }
        return { kind: "i32" };
      }
      // Non-numeric key like "length" on array — check TS type
      if (staticKey === "length") {
        const leftResult = compileExpression(ctx, fctx, expr.left);
        if (leftResult && leftResult !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
        const rightResult = compileExpression(ctx, fctx, expr.right);
        if (rightResult && rightResult !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
    }

    // Static resolution: key is known at compile time
    if (staticKey !== null) {
      const hasInStruct = structFieldNames !== null && structFieldNames.includes(staticKey);
      const has = hasInStruct || tsTypeHasProperty;
      // Evaluate both operands for side effects (needed for comma expressions like
      // (NUMBER = Number, "MAX_VALUE") in NUMBER). Drop the produced values.
      const leftResult = compileExpression(ctx, fctx, expr.left);
      if (leftResult && leftResult !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      const rightResult = compileExpression(ctx, fctx, expr.right);
      if (rightResult && rightResult !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
      return { kind: "i32" };
    }

    // Dynamic key with known struct fields: runtime string comparison
    if (structFieldNames !== null && structFieldNames.length > 0) {
      // Compile the key expression (should produce a string/externref)
      const keyType = compileExpression(ctx, fctx, expr.left);
      if (keyType) {
        // Compare key against each field name using wasm:js-string equals
        const equalsIdx = ctx.funcMap.get("__str_eq") ?? ctx.funcMap.get("string_equals");
        const jsStrEquals = ctx.mod.imports.findIndex(
          imp => imp.module === "wasm:js-string" && imp.name === "equals"
        );
        const eqFunc = jsStrEquals >= 0 ? jsStrEquals : equalsIdx;
        if (eqFunc !== undefined && eqFunc >= 0) {
          const keyLocal = allocLocal(fctx, `__in_key_${fctx.locals.length}`, keyType);
          fctx.body.push({ op: "local.set", index: keyLocal });
          // Start with false (0)
          fctx.body.push({ op: "i32.const", value: 0 });
          for (const fieldName of structFieldNames) {
            // Load the key and the field name string, compare
            fctx.body.push({ op: "local.get", index: keyLocal });
            const strGlobal = ctx.stringGlobalMap.get(fieldName);
            if (strGlobal !== undefined) {
              fctx.body.push({ op: "global.get", index: strGlobal });
              fctx.body.push({ op: "call", funcIdx: eqFunc });
              fctx.body.push({ op: "i32.or" }); // OR with accumulated result
            }
          }
          return { kind: "i32" };
        }
      }
    }

    // Dynamic key with no struct fields — try TS type system for known properties
    // Compile both sides for side effects, then use TS type system if the key
    // can be resolved from its type (e.g., a string variable with a known literal type).
    {
      const leftResult = compileExpression(ctx, fctx, expr.left);
      if (leftResult && leftResult !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      const rightResult = compileExpression(ctx, fctx, expr.right);
      if (rightResult && rightResult !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }

      // Try to resolve key from the TS type of the left expression
      const leftType = ctx.checker.getTypeAtLocation(expr.left);
      if (leftType.isStringLiteral()) {
        const key = leftType.value;
        const prop = rightType.getProperty(key);
        const apparentType = ctx.checker.getApparentType(rightType);
        const apparentProp = apparentType.getProperty(key);
        const has = !!(prop || apparentProp || (structFieldNames && structFieldNames.includes(key)));
        fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
        return { kind: "i32" };
      }

      // Fully dynamic — emit false as safe fallback
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
  }

  // ── Flatten long chains of same numeric operator ──
  // For expressions like a + b + c + d (left-recursive AST), flatten into an
  // iterative loop to avoid deep JS recursion and improve compilation speed.
  {
    const flatResult = tryFlattenBinaryChain(ctx, fctx, expr, op);
    if (flatResult !== null) return flatResult;
  }

  // ── Constant folding: emit a single constant when both operands are compile-time known ──
  {
    const folded = tryStaticToNumber(ctx, expr);
    if (folded !== undefined) {
      fctx.body.push({ op: "f64.const", value: folded });
      return { kind: "f64" };
    }
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

  // ── Any-typed operand dispatch ──
  // When both operands are `any`, use AnyValue dispatch ONLY for operators that
  // may have non-numeric semantics (+ can do string concat, equality needs type
  // awareness). For strictly numeric ops (-, *, /, %, **, comparisons, bitwise),
  // skip AnyValue and compile with a numeric hint so operands unbox to f64
  // directly, avoiding the overhead of AnyValue tag dispatch.
  if (ctx.anyValueTypeIdx >= 0) {
    const leftIsAny = (leftTsType.flags & ts.TypeFlags.Any) !== 0;
    const rightIsAny = (rightTsType.flags & ts.TypeFlags.Any) !== 0;
    if (leftIsAny && rightIsAny) {
      const isPlusOp = op === ts.SyntaxKind.PlusToken;
      const isEqualityOp = op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      // Only dispatch through AnyValue for + (string concat possible) and equality
      if (isPlusOp || isEqualityOp) {
        const anyDispatch = compileAnyBinaryDispatch(ctx, fctx, expr, op);
        if (anyDispatch !== null) return anyDispatch;
      }
      // For strictly numeric ops, fall through to compile with numeric hint
    }
  }

  // String operations — string triggers string concat for +, or string comparison when both strings
  const isRelational = op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken;
  if (isStringType(leftTsType) && (isStringType(rightTsType) || op === ts.SyntaxKind.PlusToken || (!isRelational && !isNumberType(rightTsType) && !isBooleanType(rightTsType) && !isBigIntType(rightTsType)))) {
    return compileStringBinaryOp(ctx, fctx, expr, op);
  }
  if (op === ts.SyntaxKind.PlusToken && isStringType(rightTsType) && !isBigIntType(leftTsType)) {
    return compileStringBinaryOp(ctx, fctx, expr, op);
  }

  // BigInt operations — handle both pure bigint and mixed bigint/number cases
  if (isBigIntType(leftTsType) || isBigIntType(rightTsType)) {
    const leftIsBigInt = isBigIntType(leftTsType);
    const rightIsBigInt = isBigIntType(rightTsType);

    // Mixed BigInt + Number/String: comparison and equality operators (#227, #228, #295)
    if (leftIsBigInt !== rightIsBigInt) {
      const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;

      // Strict equality: BigInt and Number/String are different types → always false/true
      if (isStrictEq || isStrictNeq) {
        // Compile both sides for side effects, then drop them
        const lt = compileExpression(ctx, fctx, expr.left);
        if (lt) fctx.body.push({ op: "drop" });
        const rt = compileExpression(ctx, fctx, expr.right);
        if (rt) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }

      // Loose equality and comparisons: convert both operands to f64, then compare
      // For BigInt vs Number: i64 → f64 via f64.convert_i64_s
      // For BigInt vs String: string → f64 via parseFloat, i64 → f64 (#295)
      //   Incomparable strings (parseFloat returns NaN) make all comparisons false,
      //   which matches the JS spec for BigInt vs non-numeric-string.
      const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
      const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
      const isComparison = op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken;

      if (isLooseEq || isLooseNeq || isComparison) {
        const leftIsStr = isStringType(leftTsType);
        const rightIsStr = isStringType(rightTsType);

        // Compile left operand
        const leftType = compileExpression(ctx, fctx, expr.left, leftIsBigInt ? { kind: "i64" } : undefined);
        if (!leftType) return null;
        // Convert left to f64
        if (leftType.kind === "i64") {
          fctx.body.push({ op: "f64.convert_i64_s" });
        } else if (leftType.kind === "externref") {
          // String/externref → f64 via parseFloat (NaN for incomparable strings)
          const pfIdx = ctx.funcMap.get("parseFloat");
          if (pfIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: pfIdx });
          } else {
            addUnionImports(ctx);
            const unboxIdx = ctx.funcMap.get("__unbox_number")!;
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
        } else if (leftType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }

        // Compile right operand
        const rightType = compileExpression(ctx, fctx, expr.right, rightIsBigInt ? { kind: "i64" } : undefined);
        if (!rightType) return null;
        // Convert right to f64
        if (rightType.kind === "i64") {
          fctx.body.push({ op: "f64.convert_i64_s" });
        } else if (rightType.kind === "externref") {
          // String/externref → f64 via parseFloat (NaN for incomparable strings)
          const pfIdx = ctx.funcMap.get("parseFloat");
          if (pfIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: pfIdx });
          } else {
            addUnionImports(ctx);
            const unboxIdx = ctx.funcMap.get("__unbox_number")!;
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
        } else if (rightType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }

        // Emit f64 comparison
        if (isLooseEq) {
          fctx.body.push({ op: "f64.eq" });
        } else if (isLooseNeq) {
          fctx.body.push({ op: "f64.ne" });
        } else {
          return compileNumericBinaryOp(ctx, fctx, op, expr);
        }
        return { kind: "i32" };
      }

      // Mixed BigInt + Number arithmetic (e.g. 1n + 1): always a TypeError in JS.
      // Compile both sides for side effects, drop their values, then throw.
      const lt = compileExpression(ctx, fctx, expr.left);
      if (lt) fctx.body.push({ op: "drop" });
      const rt = compileExpression(ctx, fctx, expr.right);
      if (rt) fctx.body.push({ op: "drop" });
      emitThrowString(ctx, fctx, "Cannot mix BigInt and other types, use explicit conversions");
      return { kind: "i32" };
    }

    // Both operands are BigInt — compile as i64
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
  // In fast mode, numeric hint is i32 (unless division/power which promotes to f64).
  // Also use i32 hint when operands have native i32 type annotations (type i32 = number).
  const isDivOrPow = op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.AsteriskAsteriskToken;
  const leftNativeType = resolveNativeTypeAnnotation(leftTsType);
  const rightNativeType = resolveNativeTypeAnnotation(rightTsType);
  const bothNativeI32 = leftNativeType?.kind === "i32" && rightNativeType?.kind === "i32";
  const numericHint: ValType | undefined = isNumericOp
    ? { kind: ((ctx.fast || bothNativeI32) && !isDivOrPow) ? "i32" : "f64" }
    : undefined;

  let leftType = compileExpression(ctx, fctx, expr.left, numericHint);
  let rightType = compileExpression(ctx, fctx, expr.right, numericHint);

  if (!leftType || !rightType) return null;

  // Promote i32↔f64 mismatch (e.g. string.length:i32 !== 8:f64)
  if (leftType.kind === "i32" && rightType.kind === "f64") {
    const tmpR = allocTempLocal(fctx, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: tmpR });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.get", index: tmpR });
    releaseTempLocal(fctx, tmpR);
    leftType = { kind: "f64" };
  } else if (leftType.kind === "f64" && rightType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    rightType = { kind: "f64" };
  }

  // ── Struct ref valueOf coercion (#138/#139) ──
  // When operands are struct refs (objects with valueOf), coerce them to f64
  // before performing numeric/comparison/equality operations.
  // For strict equality (===, !==): compare struct refs by reference identity.
  {
    const leftIsRef = leftType.kind === "ref" || leftType.kind === "ref_null";
    const rightIsRef = rightType.kind === "ref" || rightType.kind === "ref_null";
    if (leftIsRef || rightIsRef) {
      // Strict equality: reference identity comparison (no valueOf coercion)
      const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (isStrictEq || isStrictNeq) {
        if (leftIsRef && rightIsRef) {
          fctx.body.push({ op: "ref.eq" });
          if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        // Strict equality with one ref and one primitive → always false (===) or true (!==)
        // since objects and primitives are different types in JS strict equality
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }

      // For numeric, comparison, and loose equality ops: coerce struct refs → f64 via valueOf
      if (isNumericOp || isEqOp || isNeqOp) {
        // Coerce right operand (top of stack) first
        if (rightIsRef) {
          coerceType(ctx, fctx, rightType, { kind: "f64" });
          rightType = { kind: "f64" };
        }
        // Coerce left operand (below right on stack) — save right to local
        if (leftIsRef) {
          const tmpR = allocTempLocal(fctx, rightType);
          fctx.body.push({ op: "local.set", index: tmpR });
          coerceType(ctx, fctx, leftType, { kind: "f64" });
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "f64" };
        }
        // After valueOf coercion, one side may be f64 (from ref) and the other
        // may still be i32 (boolean/integer). Promote i32 → f64 to avoid type mismatch. (#433)
        if (leftType.kind === "i32" && rightType.kind === "f64") {
          const tmpR = allocTempLocal(fctx, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: tmpR });
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "f64" };
        } else if (leftType.kind === "f64" && rightType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          rightType = { kind: "f64" };
        }
        // Now both operands are f64 — fall through to numeric dispatch below
      }
    }
  }

  // i32 numeric operations: fast mode or native type annotations (type i32 = number)
  if (leftType.kind === "i32" && rightType.kind === "i32" &&
      (ctx.fast && isNumberType(leftTsType) || bothNativeI32)) {
    return compileI32BinaryOp(ctx, fctx, op, expr);
  }

  // i64 operations (bigint detected by compiled type, e.g. from variables)
  if (leftType.kind === "i64" && rightType.kind === "i64") {
    return compileI64BinaryOp(ctx, fctx, op, expr);
  }

  // Mixed i64/f64 (BigInt vs Number detected by compiled type) — convert i64 to f64 (#227, #228)
  if ((leftType.kind === "i64" && rightType.kind === "f64") ||
      (leftType.kind === "f64" && rightType.kind === "i64")) {
    const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (isStrictEq || isStrictNeq) {
      // Different types → always false (===) or true (!==)
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
      return { kind: "i32" };
    }
    // Convert i64 operand to f64 — right is on top of stack
    if (rightType.kind === "i64") {
      fctx.body.push({ op: "f64.convert_i64_s" });
    } else {
      // left is i64, need to swap: save right, convert left, restore right
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    // Now both are f64 — use numeric comparison
    const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
    const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
    if (isLooseEq) {
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    }
    if (isLooseNeq) {
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  if ((isNumberType(leftTsType) || leftType.kind === "f64") && leftType.kind !== "externref" && rightType.kind !== "externref") {
    // Ensure right operand is also f64 (may be i32 from boolean context)
    if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
  if ((isBooleanType(leftTsType) || leftType.kind === "i32") && leftType.kind !== "externref" && rightType.kind !== "externref") {
    // Ensure both operands are i32; if right is f64, promote left to f64 and use numeric path
    if (rightType.kind === "f64") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
      return compileNumericBinaryOp(ctx, fctx, op, expr);
    }
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
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  // Externref equality: when either operand is a known string type, use
  // string content comparison instead of numeric unboxing (#225).
  // For strict equality (===, !==), cross-type comparisons always return false/true (#296).
  if ((leftType.kind === "externref" || rightType.kind === "externref") && (isEqOp || isNeqOp)) {
    const isStrict = op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const leftIsString = isStringType(leftTsType);
    const rightIsString = isStringType(rightTsType);
    const leftIsNumber = isNumberType(leftTsType);
    const rightIsNumber = isNumberType(rightTsType);
    const leftIsBool = isBooleanType(leftTsType);
    const rightIsBool = isBooleanType(rightTsType);

    // Strict equality: different JS types → always false (===) or true (!==)
    if (isStrict) {
      const leftJsKind = leftIsString ? "string" : leftIsNumber ? "number" : leftIsBool ? "boolean" : "other";
      const rightJsKind = rightIsString ? "string" : rightIsNumber ? "number" : rightIsBool ? "boolean" : "other";
      if (leftJsKind !== "other" && rightJsKind !== "other" && leftJsKind !== rightJsKind) {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }
    }

    const eitherIsString = leftIsString || rightIsString;
    if (eitherIsString) {
      // Ensure both operands are externref before calling equals.
      // One side might be f64 (e.g. from a mistyped addition like new String("1") + new String("1"))
      // or i32 (from boolean). Coerce non-externref operands to externref first.
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      addStringImports(ctx);
      const equalsIdx = ctx.funcMap.get("equals");
      if (equalsIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: equalsIdx });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }

    // Reference identity fast-path for externref equality.
    // When both operands are externref (e.g. objects stored as any), check if they
    // are the same GC reference before falling back to numeric unboxing.
    // This fixes `var a = {}; var b = a; a === b` which was incorrectly returning false
    // because numeric unboxing of objects produces NaN, and NaN !== NaN.
    // Uses any.convert_extern to get anyref, then ref.test/ref.cast to eqref for ref.eq.
    // The eq abstract heap type is encoded as -19 in signed LEB128 (= 0x6d).
    const EQ_HEAP_TYPE = -19;
    if (leftType.kind === "externref" && rightType.kind === "externref" &&
        !leftIsString && !rightIsString && !leftIsNumber && !rightIsNumber &&
        !leftIsBool && !rightIsBool) {
      // Save both externrefs to temp locals for potential reuse in numeric fallback
      const tmpRight = allocTempLocal(fctx, { kind: "externref" });
      const tmpLeft = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: tmpRight });
      fctx.body.push({ op: "local.set", index: tmpLeft });

      // Convert left to anyref and test if it's an eqref (GC ref)
      fctx.body.push({ op: "local.get", index: tmpLeft });
      fctx.body.push({ op: "any.convert_extern" });
      const tmpAnyLeft = allocTempLocal(fctx, { kind: "anyref" });
      fctx.body.push({ op: "local.tee", index: tmpAnyLeft });
      fctx.body.push({ op: "ref.test", typeIdx: EQ_HEAP_TYPE });
      fctx.body.push({
        op: "if", blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // Left is eqref-compatible — check right too
          { op: "local.get", index: tmpRight },
          { op: "any.convert_extern" },
          ...(() => {
            const tmpAnyRight = allocTempLocal(fctx, { kind: "anyref" });
            const instrs: Instr[] = [
              { op: "local.tee", index: tmpAnyRight },
              { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
              {
                op: "if", blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  // Both are eqref — cast and compare with ref.eq
                  { op: "local.get", index: tmpAnyLeft },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "local.get", index: tmpAnyRight },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "ref.eq" },
                ],
                else: [
                  // Right is not eqref — cannot be equal to a GC ref
                  { op: "i32.const", value: 0 },
                ],
              },
            ];
            releaseTempLocal(fctx, tmpAnyRight);
            return instrs;
          })(),
        ],
        else: [
          // Left is not eqref — fall through to numeric comparison
          // by pushing -1 as sentinel to indicate "not handled"
          { op: "i32.const", value: -1 },
        ],
      });
      releaseTempLocal(fctx, tmpAnyLeft);

      // Check if the identity comparison produced a definitive result (0 or 1)
      // vs the sentinel -1 (meaning we need numeric fallback)
      const identityResult = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "local.tee", index: identityResult });
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.ne" });
      fctx.body.push({
        op: "if", blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // Identity check produced 0 or 1 — use it directly
          // For != / !==, negate
          { op: "local.get", index: identityResult },
          ...(isNeqOp ? [{ op: "i32.eqz" } as Instr] : []),
        ],
        else: (() => {
          // Numeric fallback: unbox both externrefs to f64 and compare
          addUnionImports(ctx);
          const unboxIdx = ctx.funcMap.get("__unbox_number")!;
          return [
            { op: "local.get", index: tmpLeft },
            { op: "call", funcIdx: unboxIdx },
            { op: "local.get", index: tmpRight },
            { op: "call", funcIdx: unboxIdx },
            { op: isEqOp ? "f64.eq" : "f64.ne" } as Instr,
          ] as Instr[];
        })(),
      });
      releaseTempLocal(fctx, identityResult);
      releaseTempLocal(fctx, tmpRight);
      releaseTempLocal(fctx, tmpLeft);
      return { kind: "i32" };
    }

    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number")!;
    // Coerce/unbox right side (top of stack) to f64
    if (rightType.kind === "externref") {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    // Coerce/unbox left side (below right on stack) to f64
    if (leftType.kind === "externref") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    } else if (leftType.kind === "i32") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    fctx.body.push({ op: isEqOp ? "f64.eq" : "f64.ne" });
    return { kind: "i32" };
  }

  // ── Fallback: coerce remaining type mismatches to f64 for numeric ops ──
  // When operand types don't match any specific path above (e.g. ref + externref,
  // i64 + externref, or other ambiguous combos), try to coerce both to f64.
  if (isNumericOp) {
    // Coerce right operand (top of stack) to f64
    if (rightType.kind === "externref") {
      addUnionImports(ctx);
      const unboxIdx = ctx.funcMap.get("__unbox_number")!;
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (rightType.kind === "i64") {
      fctx.body.push({ op: "f64.convert_i64_s" });
    } else if (rightType.kind === "ref" || rightType.kind === "ref_null") {
      coerceType(ctx, fctx, rightType, { kind: "f64" });
    }
    // Coerce left operand (below right on stack) — save right to local
    if (leftType.kind === "externref" || leftType.kind === "i32" || leftType.kind === "i64" ||
        leftType.kind === "ref" || leftType.kind === "ref_null") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      if (leftType.kind === "externref") {
        addUnionImports(ctx);
        const unboxIdx = ctx.funcMap.get("__unbox_number")!;
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
      } else if (leftType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      } else if (leftType.kind === "i64") {
        fctx.body.push({ op: "f64.convert_i64_s" });
      } else if (leftType.kind === "ref" || leftType.kind === "ref_null") {
        coerceType(ctx, fctx, leftType, { kind: "f64" });
      }
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
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
      helperName = "__any_eq"; resultIsI32 = true; break;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      helperName = "__any_strict_eq"; resultIsI32 = true; break;
    case ts.SyntaxKind.ExclamationEqualsToken:
      helperName = "__any_eq"; resultIsI32 = true; break;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      helperName = "__any_strict_eq"; resultIsI32 = true; break;
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

export function compileNumericBinaryOp(
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
      // BigInt exponentiation: base ** exp implemented as a loop
      // Stack: [base: i64, exp: i64] → [result: i64]
      const expLocal = allocTempLocal(fctx, { kind: "i64" });
      const baseLocal = allocTempLocal(fctx, { kind: "i64" });
      const resultLocal = allocTempLocal(fctx, { kind: "i64" });
      // Save exponent (top of stack), then base
      fctx.body.push({ op: "local.set", index: expLocal });
      fctx.body.push({ op: "local.set", index: baseLocal });
      // result = 1
      fctx.body.push({ op: "i64.const", value: 1n });
      fctx.body.push({ op: "local.set", index: resultLocal });
      // block $break { loop $continue {
      fctx.body.push({ op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          // if exp <= 0 then break
          { op: "local.get", index: expLocal },
          { op: "i64.const", value: 0n },
          { op: "i64.le_s" },
          { op: "br_if", depth: 1 }, // break out of block
          // result = result * base
          { op: "local.get", index: resultLocal },
          { op: "local.get", index: baseLocal },
          { op: "i64.mul" },
          { op: "local.set", index: resultLocal },
          // exp = exp - 1
          { op: "local.get", index: expLocal },
          { op: "i64.const", value: 1n },
          { op: "i64.sub" },
          { op: "local.set", index: expLocal },
          // continue loop
          { op: "br", depth: 0 },
        ] },
      ] });
      // Push result
      fctx.body.push({ op: "local.get", index: resultLocal });
      releaseTempLocal(fctx, expLocal);
      releaseTempLocal(fctx, baseLocal);
      releaseTempLocal(fctx, resultLocal);
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
  const tmp = allocTempLocal(fctx, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "f64.const", value: 4294967296 });
  fctx.body.push({ op: "f64.div" });
  fctx.body.push({ op: "f64.floor" });
  fctx.body.push({ op: "f64.const", value: 4294967296 });
  fctx.body.push({ op: "f64.mul" });
  fctx.body.push({ op: "f64.sub" });
  fctx.body.push({ op: "i32.trunc_sat_f64_u" });
  releaseTempLocal(fctx, tmp);
}

/** Truncate two f64 operands to i32 via ToInt32, apply an i32 bitwise op, convert back to f64 */
function compileBitwiseBinaryOp(
  fctx: FunctionContext,
  i32op: "i32.and" | "i32.or" | "i32.xor" | "i32.shl" | "i32.shr_s" | "i32.shr_u",
  unsigned: boolean,
): ValType {
  // Stack: [left_f64, right_f64]
  const tmpR = allocTempLocal(fctx, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: "local.get", index: tmpR });
  releaseTempLocal(fctx, tmpR);
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

/**
 * Emit JS remainder (a % b) with correct IEEE 754 edge cases.
 * Stack: [a_f64, b_f64] -> [result_f64]
 *
 * Edge cases handled:
 * - x % Infinity = x (when x is finite)
 * - -0 % x = -0 (sign of zero preserved via f64.copysign)
 * - Infinity % x = NaN, x % 0 = NaN, NaN % x = NaN (handled naturally by formula)
 */
function emitModulo(fctx: FunctionContext): void {
  const tmpB = allocTempLocal(fctx, { kind: "f64" });
  const tmpA = allocTempLocal(fctx, { kind: "f64" });

  fctx.body.push({ op: "local.set", index: tmpB });
  fctx.body.push({ op: "local.set", index: tmpA });

  // Build the "then" branch: b is infinite and a is finite → result is a
  const thenInstrs: Instr[] = [
    { op: "local.get", index: tmpA },
  ];

  // Build the "else" branch: standard formula a - trunc(a/b) * b with copysign
  const elseInstrs: Instr[] = [
    { op: "local.get", index: tmpA },
    { op: "local.get", index: tmpA },
    { op: "local.get", index: tmpB },
    { op: "f64.div" },
    { op: "f64.trunc" }, // JS % uses truncation toward zero, not floor
    { op: "local.get", index: tmpB },
    { op: "f64.mul" },
    { op: "f64.sub" },
    // Preserve sign of dividend for zero results (-0 % x should be -0)
    { op: "local.get", index: tmpA },
    { op: "f64.copysign" },
  ];

  // Check: if |b| == Infinity and a is finite, result is a; else standard formula
  fctx.body.push({ op: "local.get", index: tmpB });
  fctx.body.push({ op: "f64.abs" });
  fctx.body.push({ op: "f64.const", value: Infinity });
  fctx.body.push({ op: "f64.eq" });
  fctx.body.push({ op: "local.get", index: tmpA });
  fctx.body.push({ op: "f64.abs" });
  fctx.body.push({ op: "f64.const", value: Infinity });
  fctx.body.push({ op: "f64.ne" });
  fctx.body.push({ op: "i32.and" });
  // Use if/then/else to select between Infinity shortcut and standard formula
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmpA);
  releaseTempLocal(fctx, tmpB);
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
    if ((leftType.kind === "i32" || leftType.kind === "f64") &&
        (rType.kind === "i32" || rType.kind === "f64")) {
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

function compileLogicalOr(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // JS semantics: a || b → if a is truthy, return a; else return b
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) { ensureI32Condition(fctx, leftType, ctx); return { kind: "i32" }; }

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
    if ((leftType.kind === "i32" || leftType.kind === "f64") &&
        (rType.kind === "i32" || rType.kind === "f64")) {
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
function compileNullishCoalescing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // Compile LHS and store in temp
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) { ctx.errors.push({ message: "Failed to compile nullish coalescing LHS", line: getLine(expr), column: getCol(expr) }); return { kind: "externref" }; }
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
  if (rType.kind === "f64" && (resultKind.kind === "externref" || resultKind.kind === "ref" || resultKind.kind === "ref_null")) {
    unifiedType = { kind: "externref" };
  } else if (resultKind.kind === "f64" && (rType.kind === "externref" || rType.kind === "ref" || rType.kind === "ref_null")) {
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
        const resultType = compileExpression(ctx, fctx, expr.right, boxed.valType);
        if (!resultType) { ctx.errors.push({ message: "Failed to compile assignment value", line: getLine(expr), column: getCol(expr) }); return null; }
        const tmpVal = allocLocal(fctx, `__box_tmp_${fctx.locals.length}`, boxed.valType);
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
            { op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 } as Instr,
          ],
        });
        // Return the assigned value (expression result)
        fctx.body.push({ op: "local.get", index: tmpVal });
        return resultType;
      }
      const localType = localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : fctx.locals[localIdx - fctx.params.length]?.type;

      // When assigning a function expression/arrow or a function reference
      // to a variable, don't pass externref type hint — let it compile to
      // its native closure struct ref type. Then update the local's type so
      // closure calls work correctly.
      const isFuncExprRHS = ts.isFunctionExpression(expr.right) || ts.isArrowFunction(expr.right);
      const isFuncRefRHS = ts.isIdentifier(expr.right) && ctx.funcMap.has(expr.right.text);
      const isCallableRHS = isFuncExprRHS || isFuncRefRHS;
      // Also detect when the local already has a closure type (reassignment case)
      const localIsClosureRef = localType && (localType.kind === "ref" || localType.kind === "ref_null") &&
        ctx.closureInfoByTypeIdx.has((localType as { typeIdx: number }).typeIdx);
      const typeHint = ((isCallableRHS || localIsClosureRef) && localType?.kind === "externref") ? undefined
        : localIsClosureRef ? undefined  // Don't pass closure ref type as hint either — let RHS produce its own
        : localType;
      const resultType = compileExpression(ctx, fctx, expr.right, typeHint);
      if (!resultType) { ctx.errors.push({ message: "Failed to compile assignment value", line: getLine(expr), column: getCol(expr) }); return null; }

      // If a closure struct ref was assigned to an externref local, update the local's type
      if ((isCallableRHS || localIsClosureRef) && resultType.kind === "ref" && (localType?.kind === "externref" || localIsClosureRef)) {
        if (localIdx < fctx.params.length) {
          fctx.params[localIdx]!.type = resultType;
        } else {
          const localEntry = fctx.locals[localIdx - fctx.params.length];
          if (localEntry) localEntry.type = resultType;
        }
      }

      // Re-read local type after potential update (func expr may have changed it)
      const effectiveLocalType = localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : fctx.locals[localIdx - fctx.params.length]?.type;

      // Safety coercion: if the expression produced a type that doesn't match
      // the local's declared type (e.g. compileExpression didn't have expectedType
      // or coercion was incomplete), coerce before local.tee
      if (effectiveLocalType && !valTypesMatch(resultType, effectiveLocalType)) {
        const bodyLenBeforeCoerce = fctx.body.length;
        coerceType(ctx, fctx, resultType, effectiveLocalType);
        if (fctx.body.length === bodyLenBeforeCoerce &&
            (resultType.kind === "ref" || resultType.kind === "ref_null") &&
            (effectiveLocalType.kind === "ref" || effectiveLocalType.kind === "ref_null")) {
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
    return compileArrayDestructuringAssignment(ctx, fctx, expr.left, expr.right);
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
  if (!typeName || !ctx.structMap.has(typeName) || !ctx.structFields.get(typeName)) {
    // Ensure any target identifiers are allocated as locals
    for (const prop of target.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name.text;
        if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
          allocLocal(fctx, name, { kind: "externref" });
        }
      } else if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
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
  const tmpLocal = allocLocal(fctx, `__destruct_assign_${fctx.locals.length}`, resultType);
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
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "ref.is_null" } as Instr);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(() => {
                const saved = fctx.body;
                fctx.body = [];
                compileExpression(ctx, fctx, prop.objectAssignmentInitializer!, localType ?? fieldType);
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
      const propName = ts.isIdentifier(prop.name) ? prop.name.text
        : ts.isStringLiteral(prop.name) ? prop.name.text
        : ts.isNumericLiteral(prop.name) ? prop.name.text
        : undefined;
      if (!propName) continue; // computed or unsupported property name — skip
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) continue;
      const fieldType = fields[fieldIdx]!.type;

      // Determine the target and optional default value
      let targetExpr = prop.initializer;
      let defaultExpr: ts.Expression | undefined;

      // { y: x = defaultVal } — BinaryExpression with EqualsToken
      if (ts.isBinaryExpression(targetExpr) &&
          targetExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(targetExpr.left)) {
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
          if (fieldType.kind === "externref" || fieldType.kind === "ref" || fieldType.kind === "ref_null") {
            const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.tee", index: tmpField });
            fctx.body.push({ op: "ref.is_null" } as Instr);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...(() => {
                  const saved = fctx.body;
                  fctx.body = [];
                  compileExpression(ctx, fctx, defaultExpr!, localType ?? fieldType);
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
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitObjectDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isArrayLiteralExpression(targetExpr)) {
        // { prop: [a, b] } — nested array destructuring
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitArrayDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr)) {
        // { prop: obj.field } or { prop: arr[0] } — member expression target
        const tmpElem = allocLocal(fctx, `__nested_elem_${fctx.locals.length}`, fieldType);
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

  // Close null guard
  fctx.body = savedBodyDA;
  if (isNullableDA && destructInstrsDA.length > 0) {
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: destructInstrsDA });
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
      return compileExternrefArrayDestructuringAssignment(ctx, fctx, target, resultType);
    }
    // For f64/i32 — box to externref and retry
    if (resultType.kind === "f64" || resultType.kind === "i32") {
      if (resultType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        return compileExternrefArrayDestructuringAssignment(ctx, fctx, target, { kind: "externref" });
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
    return compileExternrefArrayDestructuringAssignment(ctx, fctx, target, { kind: "externref" });
  }

  // Detect whether RHS is a tuple struct (fields $_0, $_1, ...) or vec struct ({length, data})
  const isVecStruct = typeDef.fields.length === 2 &&
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
  const tmpLocal = allocLocal(fctx, `__arr_destruct_${fctx.locals.length}`, resultType);
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
          const tmpLen = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.sub" } as Instr);
          fctx.body.push({ op: "local.tee", index: tmpLen });

          fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
          const tmpRestArr = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "local.set", index: tmpRestArr });

          const tmpJ = allocLocal(fctx, `__rest_j_${fctx.locals.length}`, { kind: "i32" });
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
            body: [{
              op: "loop",
              blockType: { kind: "empty" },
              body: loopBody,
            } as Instr],
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
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isElementAccessExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isObjectLiteralExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitObjectDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isArrayLiteralExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitArrayDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isBinaryExpression(element) && element.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const assignTarget = element.left;
      const defaultExpr = element.right;
      if (ts.isIdentifier(assignTarget)) {
        const localName = assignTarget.text;
        let localIdx = fctx.localMap.get(localName);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, elemType);
        }
        emitElementGet(i);
        if (elemType.kind === "externref" || elemType.kind === "ref" || elemType.kind === "ref_null") {
          const tmpElem = allocLocal(fctx, `__dflt_${fctx.locals.length}`, elemType);
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

  // Close null guard
  fctx.body = savedBodyADA;
  if (isNullableADA && arrDestructInstrsADA.length > 0) {
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: arrDestructInstrsADA });
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
  const tmpLocal = allocLocal(fctx, `__ext_arr_destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Ensure __extern_get is available
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (getIdx === undefined) return null;

  // Ensure __box_number is available (needed to convert index to externref)
  let boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    boxIdx = ctx.funcMap.get("__box_number");
    // Also refresh getIdx since it may have shifted
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (boxIdx === undefined || getIdx === undefined) return null;

  for (let i = 0; i < target.elements.length; i++) {
    const element = target.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isSpreadElement(element)) continue; // rest on externref not supported yet

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
    } else if (ts.isPropertyAccessExpression(element) || ts.isElementAccessExpression(element)) {
      const tmpElem = allocLocal(fctx, `__ext_arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isBinaryExpression(element) && element.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // Default value: [a = default] = arr
      const assignTarget = element.left;
      const defaultExpr = element.right;
      if (ts.isIdentifier(assignTarget)) {
        const localName = assignTarget.text;
        let localIdx = fctx.localMap.get(localName);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, elemType);
        }
        const tmpElem = allocLocal(fctx, `__ext_dflt_${fctx.locals.length}`, elemType);
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
    if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) return;
    const tIdx = (arrType as { typeIdx: number }).typeIdx;
    const tDef = ctx.mod.types[tIdx];
    // Handle vec struct
    if (tDef?.kind === "struct" && tDef.fields.length === 2 && tDef.fields[0]?.name === "length" && tDef.fields[1]?.name === "data") {
      const aIdx = getArrTypeIdxFromVec(ctx, tIdx);
      // Save vec ref, compile index, then bounds-guard the write
      const vecTmp = allocLocal(fctx, `__dstr_vec_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: vecTmp });
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression);
      if (!idxResult) return;
      if (idxResult.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_f64_s" } as Instr);
      }
      const idxTmp = allocLocal(fctx, `__dstr_idx_${fctx.locals.length}`, { kind: "i32" });
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
    if (idx === srcTypeIdx) { structName = name; break; }
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
      const propName = ts.isIdentifier(prop.name) ? prop.name.text
        : ts.isStringLiteral(prop.name) ? prop.name.text
        : ts.isNumericLiteral(prop.name) ? prop.name.text
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
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitObjectDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isArrayLiteralExpression(targetExpr)) {
        // Nested array: { x: [a, b] } = obj
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitArrayDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr)) {
        // Member expression target: { x: obj.prop } = obj2
        const tmpElem = allocLocal(fctx, `__nested_elem_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpElem });
        emitAssignToTarget(ctx, fctx, targetExpr, tmpElem, fieldType);
      }
    }
  }

  // Close null guard
  fctx.body = savedBodyODFL;
  if (srcType.kind === "ref_null" && odflInstrs.length > 0) {
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: odflInstrs });
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

  // Close null guard
  fctx.body = savedBodyADFL;
  if (srcType.kind === "ref_null" && adflInstrs.length > 0) {
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: adflInstrs });
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

  // Handle static property assignment: ClassName.staticProp = value
  if (ts.isIdentifier(target.expression) && ctx.classSet.has(target.expression.text)) {
    const clsName = target.expression.text;
    const fullName = `${clsName}_${target.name.text}`;
    const globalIdx = ctx.staticProps.get(fullName);
    if (globalIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      const valType = compileExpression(ctx, fctx, value, globalDef?.type);
      if (!valType) return null;
      // Save value, set global, return value (assignment expression result)
      const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
      fctx.body.push({ op: "local.tee", index: tmpVal });
      fctx.body.push({ op: "global.set", index: globalIdx });
      fctx.body.push({ op: "local.get", index: tmpVal });
      return valType;
    }
  }

  // Handle externref property set
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    const externSetResult = compileExternPropertySet(ctx, fctx, target, value, objType);
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
        const fieldIdx = vecDef.fields.findIndex((f: { name: string }) => f.name === fieldName);
        if (fieldIdx >= 0) {
          const structObjResult = compileExpression(ctx, fctx, target.expression);
          if (!structObjResult) return null;
          const valType = compileExpression(ctx, fctx, value, vecDef.fields[fieldIdx]!.type);
          if (!valType) return null;
          const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
          fctx.body.push({ op: "local.tee", index: tmpVal });
          fctx.body.push({ op: "struct.set", typeIdx: shapeInfo.vecTypeIdx, fieldIdx });
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
      const vecTmp = allocLocal(fctx, `__arr_len_set_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
      fctx.body.push({ op: "local.set", index: vecTmp });
      // Compile value (the new length)
      const valType = compileExpression(ctx, fctx, value);
      if (!valType) return null;
      // Convert f64 to i32 if needed
      const newLenTmp = allocLocal(fctx, `__arr_len_set_nl_${fctx.locals.length}`, { kind: "i32" });
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
  const fieldName = ts.isPrivateIdentifier(target.name) ? target.name.text.slice(1) : target.name.text;
  const accessorKey = `${typeName}_${fieldName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const setterName = `${typeName}_set_${fieldName}`;
    const funcIdx = ctx.funcMap.get(setterName);
    if (funcIdx !== undefined) {
      const setterObjResult = compileExpression(ctx, fctx, target.expression);
      if (!setterObjResult) { ctx.errors.push({ message: "Failed to compile setter receiver", line: getLine(target), column: getCol(target) }); return null; }
      // Get setter's parameter types to provide type hint for value argument
      const setterParamTypes = getFuncParamTypes(ctx, funcIdx);
      const setterValExpectedType = setterParamTypes?.[1]; // param 0 = self, param 1 = value
      const setterValResult = compileExpression(ctx, fctx, value, setterValExpectedType);
      if (!setterValResult) { ctx.errors.push({ message: "Failed to compile setter value", line: getLine(target), column: getCol(target) }); return null; }
      // Save value for assignment expression result
      const setterTmpVal = allocLocal(fctx, `__setter_assign_${fctx.locals.length}`, setterValResult);
      fctx.body.push({ op: "local.tee", index: setterTmpVal });
      // Re-order stack: we need [obj, val] but tee left val on stack after obj
      // Actually obj is already on stack before val; tee saved val. Pop val, call, re-push val.
      // Stack is: [obj, val] after tee. But we need obj then val for call. That's correct.
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

  const structObjResult = compileExpression(ctx, fctx, target.expression);
  if (!structObjResult) { ctx.errors.push({ message: "Failed to compile struct field receiver", line: getLine(target), column: getCol(target) }); return null; }
  const valType = compileExpression(ctx, fctx, value, fields[fieldIdx]!.type);
  if (!valType) return null;
  // Save value so assignment expression returns the RHS
  const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
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
  const resolvedInfo = findExternInfoForMember(ctx, className, propName, "property");
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
  if (!externObjResult) { ctx.errors.push({ message: "Failed to compile extern property receiver", line: getLine(target), column: getCol(target) }); return null; }
  const propInfo = propOwner.properties.get(propName);
  const externValResult = compileExpression(ctx, fctx, value, propInfo?.type);
  if (!externValResult) { ctx.errors.push({ message: "Failed to compile extern property value", line: getLine(target), column: getCol(target) }); return null; }

  // Save value for assignment expression result
  const externTmpVal = allocLocal(fctx, `__extern_assign_${fctx.locals.length}`, externValResult);
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
    ctx.errors.push({ message: "Assignment to non-array", line: getLine(target), column: getCol(target) });
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
    const isVecStructAssign = typeDef.fields.length === 2 &&
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
      // Also handle computed key expressions (well-known symbols, enums, binary exprs)
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(ctx, target.argumentExpression);
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
              const setValResult = compileExpression(ctx, fctx, value, eaSetterValType);
              if (!setValResult) return null;
              const setValLocal = allocLocal(fctx, `__setter_assign_${fctx.locals.length}`, setValResult);
              fctx.body.push({ op: "local.tee", index: setValLocal });
              const finalEaSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;
              fctx.body.push({ op: "call", funcIdx: finalEaSetterIdx });
              fctx.body.push({ op: "local.get", index: setValLocal });
              return setValResult;
            }
          }
        }

        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx !== -1) {
          const valType = compileExpression(ctx, fctx, value, typeDef.fields[fieldIdx]!.type);
          if (!valType) return null;
          const tmpVal = allocLocal(fctx, `__elem_assign_${fctx.locals.length}`, valType);
          fctx.body.push({ op: "local.tee", index: tmpVal });
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
          fctx.body.push({ op: "local.get", index: tmpVal });
          return valType;
        }
      }
    }
  }

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
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
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
          if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
            if (ts.isStringLiteral(decl.initializer)) fieldName = decl.initializer.text;
            else if (ts.isNumericLiteral(decl.initializer)) fieldName = decl.initializer.text;
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
            const objLocal = allocLocal(fctx, `__struct_obj_${fctx.locals.length}`, arrType);
            fctx.body.push({ op: "local.set", index: objLocal });
            const valResult = compileExpression(ctx, fctx, value);
            if (!valResult) return null;
            const valLocal = allocLocal(fctx, `__struct_val_${fctx.locals.length}`, valResult);
            fctx.body.push({ op: "local.set", index: valLocal });
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "local.get", index: valLocal });
            fctx.body.push({ op: "call", funcIdx });
            // Return the assigned value (assignment expression result)
            fctx.body.push({ op: "local.get", index: valLocal });
            return valResult;
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
  const plainIdxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
  if (!plainIdxResult) { ctx.errors.push({ message: "Failed to compile element index", line: getLine(target), column: getCol(target) }); return null; }
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  // Push value
  const plainValResult = compileExpression(ctx, fctx, value, typeDef.element);
  if (!plainValResult) { ctx.errors.push({ message: "Failed to compile element value", line: getLine(target), column: getCol(target) }); return null; }
  // Save value for assignment expression result
  const plainValLocal = allocLocal(fctx, `__arr_assign_${fctx.locals.length}`, plainValResult);
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
    ctx.errors.push({ message: "Unsupported element assignment target type", line: getLine(target), column: getCol(target) });
    return null;
  }

  // Save obj externref to local
  const objLocal = allocLocal(fctx, `__eset_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compile value first so we can save it for return
  const valResult = compileExpression(ctx, fctx, value, { kind: "externref" });
  if (!valResult) return null;
  const valLocal = allocLocal(fctx, `__eset_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  // Push args: obj, key, val
  fctx.body.push({ op: "local.get", index: objLocal });
  compileExpression(ctx, fctx, target.argumentExpression, { kind: "externref" });
  fctx.body.push({ op: "local.get", index: valLocal });

  // Lazily register __extern_set if not already registered
  let funcIdx = ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
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
function compileLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Handle property access logical assignment: obj.prop ??= default
  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyLogicalAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  // Handle element access logical assignment: arr[i] ||= default
  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementLogicalAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  if (!ts.isIdentifier(expr.left)) {
    ctx.errors.push({
      message: "Logical assignment only supported for simple identifiers, property access, or element access",
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
    const savedBody = pushBody(fctx);
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
    const savedBody = pushBody(fctx);
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
  const propName = ts.isPrivateIdentifier(target.name) ? target.name.text.slice(1) : target.name.text;

  // Resolve struct type
  let typeName = resolveStructName(ctx, objType);
  if (!typeName && ts.isIdentifier(target.expression)) {
    typeName = ctx.widenedVarStructMap.get(target.expression.text);
  }
  if (!typeName) {
    // Fallback: treat as externref property access via __extern_get / __extern_set
    return compilePropertyLogicalAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  // Check for accessor properties (get/set) before looking up struct fields
  const accessorKey = `${typeName}_${propName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const getterName = `${typeName}_get_${propName}`;
    const setterName = `${typeName}_set_${propName}`;
    const getterIdx = ctx.funcMap.get(getterName);
    const setterIdx = ctx.funcMap.get(setterName);
    if (getterIdx !== undefined && setterIdx !== undefined) {
      // Compile obj and save to a local for reuse
      const objResult = compileExpression(ctx, fctx, target.expression);
      if (!objResult) return null;
      const objLocal = allocLocal(fctx, `__logprop_acc_obj_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: objLocal });

      const propType = ctx.checker.getTypeAtLocation(target);
      const fieldType = resolveWasmType(ctx, propType);

      const emitFieldGet = () => {
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "call", funcIdx: getterIdx });
      };
      const emitFieldSet = () => {
        const tmpVal = allocLocal(fctx, `__logprop_acc_val_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "local.get", index: tmpVal });
        fctx.body.push({ op: "call", funcIdx: setterIdx });
        fctx.body.push({ op: "local.get", index: tmpVal });
      };

      return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitFieldGet, emitFieldSet);
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    // Struct name resolved but type not in structMap — fall back to externref path
    return compilePropertyLogicalAssignmentExternref(ctx, fctx, target, rhs, op, propName);
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
  const objLocal = allocLocal(fctx, `__logprop_obj_${fctx.locals.length}`, objResult);
  fctx.body.push({ op: "local.set", index: objLocal });

  // Create helpers that read/write the field
  const emitFieldGet = () => {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
  };
  const emitFieldSet = () => {
    // After RHS is on stack, save it, load obj, load value, struct.set, load value again for result
    const tmpVal = allocLocal(fctx, `__logprop_val_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.set", index: tmpVal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: tmpVal });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    fctx.body.push({ op: "local.get", index: tmpVal });
  };

  return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitFieldGet, emitFieldSet);
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
      if (idx === typeIdx) { resolvedTypeName = name; break; }
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
            const tsProp = tsProps.find(p => p.name === propName);
            if (tsProp) {
              const propTsType = ctx.checker.getTypeOfSymbolAtLocation(tsProp, target);
              const propWasmType = resolveWasmType(ctx, propTsType);
              const newField: FieldDef = { name: propName, type: propWasmType, mutable: true };
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
          const objTmp = allocLocal(fctx, `__logprop_ext_obj_${fctx.locals.length}`, objResult);
          fctx.body.push({ op: "local.set", index: objTmp });

          const emitGet = () => {
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          };
          const emitSet = () => {
            const tmpVal = allocLocal(fctx, `__logprop_ext_val_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.set", index: tmpVal });
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
            fctx.body.push({ op: "local.get", index: tmpVal });
          };

          return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitGet, emitSet);
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
  const objLocal = allocLocal(fctx, `__logprop_pobj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compile propName as externref string key
  addStringConstantGlobal(ctx, propName);
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (!keyResult) return null;
  if (keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyLocal = allocLocal(fctx, `__logprop_pkey_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Ensure __extern_get is available
  let getIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  if (getIdx === undefined) return null;

  // Ensure __extern_set is available
  let setIdx = ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
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
    const tmpVal = allocLocal(fctx, `__logprop_pval_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: tmpVal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: tmpVal });
    fctx.body.push({ op: "call", funcIdx: finalSetIdx });
    fctx.body.push({ op: "local.get", index: tmpVal });
  };

  return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, varType, emitGet, emitSet);
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
    ctx.errors.push({ message: "Logical assignment on non-array element access", line: getLine(target), column: getCol(target) });
    return null;
  }

  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle struct bracket notation: obj["prop"] ??= default
  if (typeDef?.kind === "struct") {
    const isVecStruct = typeDef.fields.length === 2 &&
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
        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx !== -1) {
          const fieldType = typeDef.fields[fieldIdx]!.type;

          // Save obj ref
          const objLocal = allocLocal(fctx, `__logelem_obj_${fctx.locals.length}`, arrType);
          fctx.body.push({ op: "local.set", index: objLocal });

          const emitFieldGet = () => {
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          };
          const emitFieldSet = () => {
            const tmpVal = allocLocal(fctx, `__logelem_val_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.set", index: tmpVal });
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
            fctx.body.push({ op: "local.get", index: tmpVal });
          };

          return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitFieldGet, emitFieldSet);
        }
      }
    }

    // Vec struct: array[i] ??= default
    if (isVecStruct) {
      const arrLocal = allocLocal(fctx, `__logelem_arr_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: arrLocal });

      // Compile index
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
      if (!idxResult) return null;
      if (idxResult.kind !== "i32") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      const idxLocal = allocLocal(fctx, `__logelem_idx_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.set", index: idxLocal });

      const dataField = typeDef.fields[1]!;
      const dataTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
      const dataDef = ctx.mod.types[dataTypeIdx];
      if (!dataDef || dataDef.kind !== "array") {
        ctx.errors.push({ message: "Vec struct data field is not an array", line: getLine(target), column: getCol(target) });
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
        const tmpVal = allocLocal(fctx, `__logelem_aval_${fctx.locals.length}`, elemType);
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

      return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, elemType, emitElemGet, emitElemSet);
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
  return t.kind === "ref" || t.kind === "ref_null" || t.kind === "funcref" ||
         t.kind === "externref" || t.kind === "ref_extern" || t.kind === "eqref";
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
    if (!rhsResult) { fctx.body = savedBody; return null; }
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
    if (!rhsResult) { fctx.body = savedBody; return null; }
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
    if (!rhsResult) { fctx.body = savedBody; return null; }
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
  while (scope && !ts.isFunctionDeclaration(scope) && !ts.isFunctionExpression(scope)
         && !ts.isArrowFunction(scope) && !ts.isMethodDeclaration(scope)
         && !ts.isSourceFile(scope)) {
    scope = scope.parent;
  }
  if (!scope) return false;

  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    // Check: name = "stringLiteral" or name = `template`
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && node.left.text === name) {
      if (ts.isStringLiteral(node.right) ||
          ts.isNoSubstitutionTemplateLiteral(node.right) ||
          ts.isTemplateExpression(node.right)) {
        found = true;
        return;
      }
    }
    // Check: var name = "stringLiteral"
    if (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) && node.name.text === name &&
        node.initializer) {
      if (ts.isStringLiteral(node.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
          ts.isTemplateExpression(node.initializer)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(scope, visit);
  return found;
}

function compileCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Handle property access compound assignment: obj.prop += value
  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyCompoundAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  // Handle element access compound assignment: arr[i] += value
  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementCompoundAssignment(ctx, fctx, expr.left, expr.right, op);
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

    const compoundRhsType1 = compileExpression(ctx, fctx, expr.right, { kind: "f64" });
    if (!compoundRhsType1) { ctx.errors.push({ message: "Failed to compile compound assignment RHS", line: getLine(expr), column: getCol(expr) }); return null; }
    if (compoundRhsType1.kind !== "f64") coerceType(ctx, fctx, compoundRhsType1, { kind: "f64" });

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

    const compoundRhsType2 = compileExpression(ctx, fctx, expr.right, { kind: "f64" });
    if (!compoundRhsType2) { ctx.errors.push({ message: "Failed to compile compound assignment RHS", line: getLine(expr), column: getCol(expr) }); return null; }
    if (compoundRhsType2.kind !== "f64") coerceType(ctx, fctx, compoundRhsType2, { kind: "f64" });

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
      undefined, /* propName */
      false, /* throwOnNull — ref cells use default for uninitialized captures */
    );
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
    // Write back to ref cell (skip if ref cell is null #702)
    const tmpResult = allocLocal(fctx, `__box_cmp_${fctx.locals.length}`, boxed.valType);
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
        { op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 } as Instr,
      ],
    });
    fctx.body.push({ op: "local.get", index: tmpResult });
    return boxed.valType;
  }

  const localType = getLocalType(fctx, localIdx) ?? { kind: "f64" as const };
  const needsLocalCoerce = localType.kind !== "f64";

  fctx.body.push({ op: "local.get", index: localIdx });
  if (needsLocalCoerce) coerceType(ctx, fctx, localType, { kind: "f64" });

  const compoundRhsType3 = compileExpression(ctx, fctx, expr.right, { kind: "f64" });
  if (!compoundRhsType3) { ctx.errors.push({ message: "Failed to compile compound assignment RHS", line: getLine(expr), column: getCol(expr) }); return null; }
  if (compoundRhsType3.kind !== "f64") coerceType(ctx, fctx, compoundRhsType3, { kind: "f64" });

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

/** Emit the arithmetic/bitwise operation for a compound assignment operator.
 *  Stack must contain [left_f64, right_f64]. Replaces with result f64. */
function emitCompoundOp(ctx: CodegenContext, fctx: FunctionContext, op: ts.SyntaxKind): void {
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
  const propName = ts.isPrivateIdentifier(target.name) ? target.name.text.slice(1) : target.name.text;

  // Handle static property compound assignment: ClassName.staticProp += value
  if (ts.isIdentifier(target.expression) && ctx.classSet.has(target.expression.text)) {
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
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  // Check for accessor properties (get/set) before looking up struct fields
  const accessorKey = `${typeName}_${propName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const getterName = `${typeName}_get_${propName}`;
    const setterName = `${typeName}_set_${propName}`;
    const getterIdx = ctx.funcMap.get(getterName);
    const setterIdx = ctx.funcMap.get(setterName);
    if (getterIdx !== undefined && setterIdx !== undefined) {
      // Compile the object expression and save to a temp local
      const objResult = compileExpression(ctx, fctx, target.expression);
      if (!objResult) return null;
      const objTmp = allocLocal(fctx, `__cmpd_acc_obj_${fctx.locals.length}`, objResult);
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
      const resultTmp = allocLocal(fctx, `__cmpd_acc_res_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: resultTmp });

      // Store back via setter: obj.set_prop(result)
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "local.get", index: resultTmp });
      // Coerce f64 result to setter's expected value param type
      const cmpSetterParamTypes = getFuncParamTypes(ctx, setterIdx);
      const cmpSetterValType = cmpSetterParamTypes?.[1]; // param 0 = self, param 1 = value
      if (cmpSetterValType && cmpSetterValType.kind === "externref") {
        // f64 → externref: box the number
        addUnionImports(ctx);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boxIdx });
        }
      }
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
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — fall back to externref property access
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  const fieldType = fields[fieldIdx]!.type;

  // Compile the object expression and save to a temp local
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objTmp = allocLocal(fctx, `__cmpd_obj_${fctx.locals.length}`, objResult);
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
  const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, { kind: "f64" });
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
      if (idx === typeIdx) { resolvedTypeName = name; break; }
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
            const tsProp = tsProps.find(p => p.name === propName);
            if (tsProp) {
              const propTsType = ctx.checker.getTypeOfSymbolAtLocation(tsProp, target);
              const propWasmType = resolveWasmType(ctx, propTsType);
              const newField: FieldDef = { name: propName, type: propWasmType, mutable: true };
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
          const objTmp = allocLocal(fctx, `__cmpd_obj_${fctx.locals.length}`, objResult);
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
          const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, { kind: "f64" });
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
  const objLocal = allocLocal(fctx, `__cmpd_pobj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Ensure the property name string constant is registered
  addStringConstantGlobal(ctx, propName);

  // Compile propName as externref string and save to local
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (!keyResult) return null;
  if (keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyLocal = allocLocal(fctx, `__cmpd_pkey_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Read current value: __extern_get(obj, key) -> externref
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  let getIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: getIdx });

  // Ensure union imports (including __unbox_number, __box_number) are registered
  addUnionImports(ctx);

  // Unbox to f64: __unbox_number(externref) -> f64
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (unboxIdx === undefined) {
    ctx.errors.push({ message: "Missing __unbox_number for compound externref property assignment", line: getLine(target), column: getCol(target) });
    return null;
  }
  fctx.body.push({ op: "call", funcIdx: unboxIdx });

  // Compile RHS as f64
  const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
  if (!rhsType) return null;

  // Apply compound operation (stack: [lhs_f64, rhs_f64] -> result_f64)
  emitCompoundOp(ctx, fctx, op);

  // Save result for return value
  const resultLocal = allocLocal(fctx, `__cmpd_pres_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Box result to externref: __box_number(f64) -> externref
  fctx.body.push({ op: "local.get", index: resultLocal });
  const boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    ctx.errors.push({ message: "Missing __box_number for compound externref property assignment", line: getLine(target), column: getCol(target) });
    return null;
  }
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  const boxedLocal = allocLocal(fctx, `__cmpd_pboxed_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: boxedLocal });

  // Write back: __extern_set(obj, key, boxed_result)
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  fctx.body.push({ op: "local.get", index: boxedLocal });
  let setIdx = ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
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
    const objLocal = allocLocal(fctx, `__cmpd_eobj_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: objLocal });

    // Compile key as externref and save to local
    const keyResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "externref" });
    if (!keyResult) return null;
    const keyLocal = allocLocal(fctx, `__cmpd_ekey_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // Read current value: __extern_get(obj, key) -> externref
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    let getIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: getIdx });

    // Ensure union imports (including __unbox_number, __box_number) are registered
    addUnionImports(ctx);

    // Unbox to f64: __unbox_number(externref) -> f64
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx === undefined) {
      ctx.errors.push({ message: "Missing __unbox_number for compound externref assignment", line: getLine(target), column: getCol(target) });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: unboxIdx });

    // Compile RHS as f64
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
    if (!rhsType) return null;

    // Apply compound operation (stack: [lhs_f64, rhs_f64] -> result_f64)
    emitCompoundOp(ctx, fctx, op);

    // Save result for return value
    const resultLocal = allocLocal(fctx, `__cmpd_eres_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: resultLocal });

    // Box result to externref: __box_number(f64) -> externref
    fctx.body.push({ op: "local.get", index: resultLocal });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      ctx.errors.push({ message: "Missing __box_number for compound externref assignment", line: getLine(target), column: getCol(target) });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    const boxedLocal = allocLocal(fctx, `__cmpd_eboxed_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: boxedLocal });

    // Write back: __extern_set(obj, key, boxed_result)
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    let setIdx = ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
    flushLateImportShifts(ctx, fctx);
    if (setIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }

    // Return the result as f64
    fctx.body.push({ op: "local.get", index: resultLocal });
    return { kind: "f64" };
  }

  // For primitive targets (f64, i32, i64), box to externref and re-enter via the externref path
  if (objResult.kind === "f64" || objResult.kind === "i32" || objResult.kind === "i64") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });

    // Save obj as externref local
    const objLocal = allocLocal(fctx, `__cmpd_eobj_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: objLocal });

    // Compile key as externref and save to local
    const keyResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "externref" });
    if (!keyResult) return null;
    const keyLocal = allocLocal(fctx, `__cmpd_ekey_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // Read current value: __extern_get(obj, key) -> externref
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    let getIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: getIdx });

    // Ensure union imports (including __unbox_number, __box_number) are registered
    addUnionImports(ctx);

    // Unbox to f64
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx === undefined) {
      ctx.errors.push({ message: "Missing __unbox_number for compound element assignment", line: getLine(target), column: getCol(target) });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: unboxIdx });

    // Compile RHS as f64
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
    if (!rhsType) return null;

    // Apply compound operation
    emitCompoundOp(ctx, fctx, op);

    // Save result
    const resultLocal = allocLocal(fctx, `__cmpd_eres_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: resultLocal });

    // Box result to externref
    fctx.body.push({ op: "local.get", index: resultLocal });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      ctx.errors.push({ message: "Missing __box_number for compound element assignment", line: getLine(target), column: getCol(target) });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    const boxedLocal = allocLocal(fctx, `__cmpd_eboxed_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: boxedLocal });

    // Write back: __extern_set(obj, key, boxed_result)
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    let setIdx = ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
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
    const isVec = typeDef.fields.length === 2 &&
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
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(ctx, target.argumentExpression);
      }

      if (fieldName !== undefined) {
        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx !== -1) {
          const fieldType = typeDef.fields[fieldIdx]!.type;
          const objTmp = allocLocal(fctx, `__cmpd_obj_${fctx.locals.length}`, objResult);
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
          const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, { kind: "f64" });
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
      const objTmp = allocLocal(fctx, `__cmpd_arr_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: objTmp });

      // Compile index
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression);
      if (!idxResult) return null;
      if (idxResult.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      const idxTmp = allocLocal(fctx, `__cmpd_idx_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.set", index: idxTmp });

      // Get the data array type
      const dataFieldType = typeDef.fields[1]!.type;
      const arrayTypeIdx = (dataFieldType as { typeIdx: number }).typeIdx;
      const arrayDef = ctx.mod.types[arrayTypeIdx];
      const elemType = arrayDef && arrayDef.kind === "array"
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
      const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, { kind: "f64" });
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
    const propName = ts.isPrivateIdentifier(operand.name) ? operand.name.text.slice(1) : operand.name.text;
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
        // Compile the object expression and save to a temp local
        const objResult = compileExpression(ctx, fctx, operand.expression);
        if (!objResult) return null;
        const objTmp = allocLocal(fctx, `__incdec_acc_obj_${fctx.locals.length}`, objResult);
        fctx.body.push({ op: "local.set", index: objTmp });

        // Read current value via getter
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "call", funcIdx: getterIdx });

        if (mode === "postfix") {
          // Save old value, compute new, store via setter, return old
          const oldTmp = allocLocal(fctx, `__incdec_acc_old_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: oldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: f64Op });
          const newTmp = allocLocal(fctx, `__incdec_acc_new_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: newTmp });
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "local.get", index: newTmp });
          // Coerce f64 to setter's expected value param type
          {
            const idParamTypes = getFuncParamTypes(ctx, setterIdx);
            const idValType = idParamTypes?.[1];
            if (idValType && idValType.kind === "externref") {
              addUnionImports(ctx);
              const bIdx = ctx.funcMap.get("__box_number");
              if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
            }
          }
          { const fs = ctx.funcMap.get(setterName) ?? setterIdx; fctx.body.push({ op: "call", funcIdx: fs }); }
          fctx.body.push({ op: "local.get", index: oldTmp });
        } else {
          // Compute new, store via setter, return new
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: f64Op });
          const newTmp = allocLocal(fctx, `__incdec_acc_new_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: newTmp });
          // Store: setter expects [obj, val]
          const valTmp = allocLocal(fctx, `__incdec_acc_val_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: valTmp });
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "local.get", index: valTmp });
          // Coerce f64 to setter's expected value param type
          {
            const idParamTypes = getFuncParamTypes(ctx, setterIdx);
            const idValType = idParamTypes?.[1];
            if (idValType && idValType.kind === "externref") {
              addUnionImports(ctx);
              const bIdx = ctx.funcMap.get("__box_number");
              if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
            }
          }
          { const fs = ctx.funcMap.get(setterName) ?? setterIdx; fctx.body.push({ op: "call", funcIdx: fs }); }
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
    const objTmp = allocLocal(fctx, `__incdec_obj_${fctx.locals.length}`, objResult);
    fctx.body.push({ op: "local.set", index: objTmp });

    // Read current value: obj.prop
    fctx.body.push({ op: "local.get", index: objTmp });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

    if (ctx.fast && fieldType.kind === "i32") {
      if (mode === "postfix") {
        // Save old value, compute new, store new, return old
        const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: oldTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: i32Op });
        const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: "i32" });
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
        const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: "i32" });
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
      const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: oldTmp });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: f64Op });
      // Coerce back to field type if needed
      if (fieldType.kind !== "f64") {
        coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      }
      const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, fieldType);
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
      const newF64Tmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: "f64" });
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
    const elemObjTmp = allocLocal(fctx, `__incdec_eobj_${fctx.locals.length}`, objResult);
    fctx.body.push({ op: "local.set", index: elemObjTmp });

    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[typeIdx];

    // String/numeric literal index on a plain struct — resolve to field
    if (typeDef?.kind === "struct") {
      const isVec = typeDef.fields.length === 2 &&
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
          const fieldIdx = typeDef.fields.findIndex((f: { name: string }) => f.name === fieldName);
          if (fieldIdx !== -1) {
            const fieldType = typeDef.fields[fieldIdx]!.type;

            // Read current value
            fctx.body.push({ op: "local.get", index: elemObjTmp });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });

            if (fieldType.kind !== "f64") {
              coerceType(ctx, fctx, fieldType, { kind: "f64" });
            }

            if (mode === "postfix") {
              const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, { kind: "f64" });
              fctx.body.push({ op: "local.tee", index: oldTmp });
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: f64Op });
              if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
              const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, fieldType);
              fctx.body.push({ op: "local.set", index: newTmp });
              fctx.body.push({ op: "local.get", index: elemObjTmp });
              fctx.body.push({ op: "local.get", index: newTmp });
              fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
              fctx.body.push({ op: "local.get", index: oldTmp });
              return { kind: "f64" };
            } else {
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: f64Op });
              const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: "f64" });
              fctx.body.push({ op: "local.set", index: newTmp });
              fctx.body.push({ op: "local.get", index: elemObjTmp });
              fctx.body.push({ op: "local.get", index: newTmp });
              if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
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
        const idxResult = compileExpression(ctx, fctx, operand.argumentExpression);
        if (!idxResult) return null;
        // Convert index to i32
        if (idxResult.kind === "f64") {
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        }
        const idxTmp = allocLocal(fctx, `__incdec_idx_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.set", index: idxTmp });

        // Get the data array
        const dataFieldType = typeDef.fields[1]!.type;
        const arrayTypeIdx = (dataFieldType as { typeIdx: number }).typeIdx;
        const arrayDef = ctx.mod.types[arrayTypeIdx];
        const elemType = arrayDef && arrayDef.kind === "array" ? arrayDef.element : { kind: "f64" as const };

        // Read current value: arr.data[idx] (bounds-checked)
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.get", index: idxTmp });
        emitBoundsCheckedArrayGet(fctx, arrayTypeIdx, elemType);

        // Coerce to f64 for arithmetic if needed
        if (elemType.kind !== "f64" && elemType.kind !== "i32") {
          coerceType(ctx, fctx, elemType, { kind: "f64" });
        }

        const numType = (ctx.fast && elemType.kind === "i32") ? "i32" as const : "f64" as const;
        const op = numType === "i32" ? i32Op : f64Op;

        if (mode === "postfix") {
          const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, { kind: numType });
          fctx.body.push({ op: "local.tee", index: oldTmp });
          if (numType === "i32") {
            fctx.body.push({ op: "i32.const", value: 1 });
          } else {
            fctx.body.push({ op: "f64.const", value: 1 });
          }
          fctx.body.push({ op });
          const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: numType });
          fctx.body.push({ op: "local.set", index: newTmp });
          // Store: arr.data[idx] = new (bounds-guarded)
          emitBoundsGuardedArraySet(fctx, objTmp, typeIdx, idxTmp, newTmp, arrayTypeIdx);
          fctx.body.push({ op: "local.get", index: oldTmp });
          return { kind: numType };
        } else {
          if (numType === "i32") {
            fctx.body.push({ op: "i32.const", value: 1 });
          } else {
            fctx.body.push({ op: "f64.const", value: 1 });
          }
          fctx.body.push({ op });
          const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: numType });
          fctx.body.push({ op: "local.set", index: newTmp });
          // Store: arr.data[idx] = new (bounds-guarded)
          emitBoundsGuardedArraySet(fctx, objTmp, typeIdx, idxTmp, newTmp, arrayTypeIdx);
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
      if (operandType && (operandType.kind === "ref" || operandType.kind === "ref_null")) {
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
        if (ts.isNumericLiteral(innerOperand) && Number(innerOperand.text) === 0) {
          // Pop the i32.const 0 already on stack, push f64.const -0 directly
          fctx.body.pop();
          fctx.body.push({ op: "f64.const", value: -0 });
          return { kind: "f64" };
        }
        // For non-zero i32 values, integer negation is fine (no -0 concern)
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
      // Unwrap parenthesized expressions: ++(x) -> ++x
      const ppOperand = unwrapParens(expr.operand);
      if (ts.isIdentifier(ppOperand)) {
        const idx = fctx.localMap.get(ppOperand.text);
        if (idx !== undefined) {
          const boxedPP = fctx.boxedCaptures?.get(ppOperand.text);
          if (boxedPP) {
            // ++x through ref cell (null-guarded #702)
            const ppTmp = allocLocal(fctx, `__pp_${fctx.locals.length}`, boxedPP.valType);
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: boxedPP.valType },
              then: defaultValueInstrs(boxedPP.valType),
              else: [
                { op: "local.get", index: idx } as Instr,
                { op: "local.get", index: idx } as Instr,
                { op: "struct.get", typeIdx: boxedPP.refCellTypeIdx, fieldIdx: 0 } as Instr,
                { op: "f64.const", value: 1 } as Instr,
                { op: "f64.add" } as Instr,
                { op: "local.tee", index: ppTmp } as Instr,
                { op: "struct.set", typeIdx: boxedPP.refCellTypeIdx, fieldIdx: 0 } as Instr,
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
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
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
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
            fctx.body.push({ op: "global.set", index: ppModIdx });
            fctx.body.push({ op: "global.get", index: ppModIdx });
            return { kind: "externref" };
          }
          if (ppModGlobalDef && (ppModGlobalDef.type.kind === "ref" || ppModGlobalDef.type.kind === "ref_null")) {
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
          const ppTmp = allocLocal(fctx, `__pp_mod_${fctx.locals.length}`, { kind: "f64" });
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
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
            fctx.body.push({ op: "global.set", index: ppCapIdx });
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            return { kind: "externref" };
          }
          if (ppCapGlobalDef && (ppCapGlobalDef.type.kind === "ref" || ppCapGlobalDef.type.kind === "ref_null")) {
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            coerceType(ctx, fctx, ppCapGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: ppCapIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          const ppTmp = allocLocal(fctx, `__pp_cap_${fctx.locals.length}`, { kind: "f64" });
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
            const tmp = allocLocal(fctx, `__pp_${fctx.locals.length}`, boxed.valType);
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: boxed.valType },
              then: defaultValueInstrs(boxed.valType),
              else: [
                { op: "local.get", index: idx } as Instr,
                { op: "local.get", index: idx } as Instr,
                { op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 } as Instr,
                { op: "f64.const", value: 1 } as Instr,
                { op: arithOp } as Instr,
                { op: "local.tee", index: tmp } as Instr,
                { op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 } as Instr,
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
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
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
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
            fctx.body.push({ op: "global.set", index: mmModIdx });
            fctx.body.push({ op: "global.get", index: mmModIdx });
            return { kind: "externref" };
          }
          if (mmModGlobalDef && (mmModGlobalDef.type.kind === "ref" || mmModGlobalDef.type.kind === "ref_null")) {
            fctx.body.push({ op: "global.get", index: mmModIdx });
            coerceType(ctx, fctx, mmModGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: mmModIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          const mmTmp = allocLocal(fctx, `__mm_mod_${fctx.locals.length}`, { kind: "f64" });
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
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
            fctx.body.push({ op: "global.set", index: mmCapIdx });
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            return { kind: "externref" };
          }
          if (mmCapGlobalDef && (mmCapGlobalDef.type.kind === "ref" || mmCapGlobalDef.type.kind === "ref_null")) {
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            coerceType(ctx, fctx, mmCapGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: mmCapIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          const mmTmp = allocLocal(fctx, `__mm_cap_${fctx.locals.length}`, { kind: "f64" });
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
        const postModGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, postModIdx)];
        if (postModGlobalDef?.type.kind === "externref") {
          // externref global: safe unbox old value, compute new, box and store back
          fctx.body.push({ op: "global.get", index: postModIdx });
          emitSafeExternrefToF64(ctx, fctx);
          const postOldTmp = allocLocal(fctx, `__post_old_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: postOldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          addUnionImports(ctx);
          fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
          fctx.body.push({ op: "global.set", index: postModIdx });
          fctx.body.push({ op: "local.get", index: postOldTmp });
          return { kind: "f64" };
        }
        if (postModGlobalDef && (postModGlobalDef.type.kind === "ref" || postModGlobalDef.type.kind === "ref_null")) {
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
        const postCapGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, postCapIdx)];
        if (postCapGlobalDef?.type.kind === "externref") {
          fctx.body.push({ op: "global.get", index: postCapIdx });
          emitSafeExternrefToF64(ctx, fctx);
          const postCapOldTmp = allocLocal(fctx, `__post_cap_old_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: postCapOldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          addUnionImports(ctx);
          fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
          fctx.body.push({ op: "global.set", index: postCapIdx });
          fctx.body.push({ op: "local.get", index: postCapOldTmp });
          return { kind: "f64" };
        }
        if (postCapGlobalDef && (postCapGlobalDef.type.kind === "ref" || postCapGlobalDef.type.kind === "ref_null")) {
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
      const oldTmp = allocLocal(fctx, `__postbox_${fctx.locals.length}`, boxedPost.valType);
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val" as const, type: boxedPost.valType },
        then: defaultValueInstrs(boxedPost.valType),
        else: [
          { op: "local.get", index: idx } as Instr,
          { op: "struct.get", typeIdx: boxedPost.refCellTypeIdx, fieldIdx: 0 } as Instr,
          { op: "local.tee", index: oldTmp } as Instr,
          { op: "f64.const", value: 1 } as Instr,
          { op: arithOp } as Instr,
          ...(() => {
            const newTmp = allocLocal(fctx, `__postnew_${fctx.locals.length}`, boxedPost.valType);
            return [
              { op: "local.set", index: newTmp } as Instr,
              { op: "local.get", index: idx } as Instr,
              { op: "local.get", index: newTmp } as Instr,
              { op: "struct.set", typeIdx: boxedPost.refCellTypeIdx, fieldIdx: 0 } as Instr,
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
      const tmpOld = allocLocal(fctx, `__postfix_old_${fctx.locals.length}`, { kind: "f64" });
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
    return compilePostfixIncrementProperty(ctx, fctx, expr.operand, isIncrement);
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
  const propName = ts.isPrivateIdentifier(target.name) ? target.name.text.slice(1) : target.name.text;
  const typeName = resolveStructName(ctx, objType);
  if (!typeName) {
    ctx.errors.push({ message: `Cannot resolve struct for prefix increment on property: ${propName}`, line: getLine(target), column: getCol(target) });
    return null;
  }
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    ctx.errors.push({ message: `Unknown struct type for prefix increment: ${typeName}`, line: getLine(target), column: getCol(target) });
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
  const objLocal = allocLocal(fctx, `__inc_obj_${fctx.locals.length}`, objResult);
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
  const newVal = allocLocal(fctx, `__inc_new_${fctx.locals.length}`, { kind: "f64" });
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
    ctx.errors.push({ message: "Prefix increment on non-array element access", line: getLine(target), column: getCol(target) });
    return null;
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // String-literal bracket access on struct: ++obj["prop"]
  if (typeDef?.kind === "struct" && ts.isStringLiteral(target.argumentExpression)) {
    const propName = target.argumentExpression.text;
    const fieldIdx = typeDef.fields.findIndex((f: { name: string }) => f.name === propName);
    if (fieldIdx !== -1) {
      const objLocal = allocLocal(fctx, `__inc_obj_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: objLocal });

      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
      const fieldType = typeDef.fields[fieldIdx]!.type;
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, fieldType, { kind: "f64" });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });
      const newVal = allocLocal(fctx, `__inc_new_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: newVal });
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newVal });
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: newVal });
      return { kind: "f64" };
    }
  }

  // Vec struct (array wrapped in {length, data})
  const isVecStruct = typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      ctx.errors.push({ message: "Prefix increment: vec data is not array", line: getLine(target), column: getCol(target) });
      return null;
    }
    const vecLocal = allocLocal(fctx, `__inc_vec_${fctx.locals.length}`, arrType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
    if (!idxResult) return null;
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const idxLocal = allocLocal(fctx, `__inc_idx_${fctx.locals.length}`, { kind: "i32" });
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
    const newVal = allocLocal(fctx, `__inc_new_${fctx.locals.length}`, { kind: "f64" });
    thenInstrs.push({ op: "local.tee", index: newVal } as Instr);
    // Coerce back for array.set if needed
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, { kind: "f64" }, elemType);
      fctx.body = savedBody;
    }
    const coercedNewVal = allocLocal(fctx, `__inc_cval_${fctx.locals.length}`, elemType);
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

  ctx.errors.push({ message: "Unsupported prefix increment element access target", line: getLine(target), column: getCol(target) });
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
  const propName = ts.isPrivateIdentifier(target.name) ? target.name.text.slice(1) : target.name.text;
  const typeName = resolveStructName(ctx, objType);
  if (!typeName) {
    ctx.errors.push({ message: `Cannot resolve struct for postfix increment on property: ${propName}`, line: getLine(target), column: getCol(target) });
    return null;
  }
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    ctx.errors.push({ message: `Unknown struct type for postfix increment: ${typeName}`, line: getLine(target), column: getCol(target) });
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
  const objLocal = allocLocal(fctx, `__postinc_obj_${fctx.locals.length}`, objResult);
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
  const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: oldVal });

  // Compute new value
  fctx.body.push({ op: "local.get", index: oldVal });
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });

  // Save new value for struct.set
  const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, { kind: "f64" });
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
    ctx.errors.push({ message: "Postfix increment on non-array element access", line: getLine(target), column: getCol(target) });
    return null;
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // String-literal bracket access on struct: obj["prop"]++
  if (typeDef?.kind === "struct" && ts.isStringLiteral(target.argumentExpression)) {
    const propName = target.argumentExpression.text;
    const fieldIdx = typeDef.fields.findIndex((f: { name: string }) => f.name === propName);
    if (fieldIdx !== -1) {
      const objLocal = allocLocal(fctx, `__postinc_obj_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: objLocal });

      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
      const fieldType = typeDef.fields[fieldIdx]!.type;
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, fieldType, { kind: "f64" });
      const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: oldVal });
      fctx.body.push({ op: "local.get", index: oldVal });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });
      const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: newVal });
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newVal });
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: oldVal });
      return { kind: "f64" };
    }
  }

  // Vec struct (array wrapped in {length, data})
  const isVecStruct = typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      ctx.errors.push({ message: "Postfix increment: vec data is not array", line: getLine(target), column: getCol(target) });
      return null;
    }
    const vecLocal = allocLocal(fctx, `__postinc_vec_${fctx.locals.length}`, arrType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
    if (!idxResult) return null;
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const idxLocal = allocLocal(fctx, `__postinc_idx_${fctx.locals.length}`, { kind: "i32" });
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
    const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, { kind: "f64" });
    thenInstrs.push({ op: "local.set", index: oldVal } as Instr);
    // Compute new value
    thenInstrs.push({ op: "local.get", index: oldVal } as Instr);
    thenInstrs.push({ op: "f64.const", value: 1 } as Instr);
    thenInstrs.push({ op: isIncrement ? "f64.add" : "f64.sub" } as Instr);
    // Coerce and write back
    const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, { kind: "f64" });
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

  ctx.errors.push({ message: "Unsupported postfix increment element access target", line: getLine(target), column: getCol(target) });
  return null;
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
export function typeErrorThrowInstrs(ctx: CodegenContext): Instr[] {
  const tagIdx = ensureExnTag(ctx);
  return [
    { op: "ref.null.extern" } as Instr,
    { op: "throw", tagIdx } as Instr,
  ];
}

/**
 * Emit a null check on the ref currently on the stack. If null, throws
 * TypeError via the exception tag. If non-null, the ref remains on the stack.
 * The `refType` should be the nullable ref type of the value on the stack.
 *
 * Stack: [ref_null T] -> [ref_null T]  (non-null at runtime after this point)
 */
export function emitNullCheckThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  refType: ValType,
): void {
  const tmp = allocTempLocal(fctx, refType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: typeErrorThrowInstrs(ctx),
    else: [],
  });
  fctx.body.push({ op: "local.get", index: tmp });
  releaseTempLocal(fctx, tmp);
}

/**
 * Find all struct types (other than excludeTypeIdx) that have a field named
 * propName.  Returns an array of {structTypeIdx, fieldIdx, fieldType} for
 * each matching struct type.  Used for multi-struct dispatch when the primary
 * ref.test fails (the object may be a valid GC struct of a different type).
 * When excludeTypeIdx is -1, no type is excluded (useful for the externref path
 * where there is no primary struct type).
 */
function findAlternateStructsForField(
  ctx: CodegenContext,
  propName: string,
  excludeTypeIdx: number,
): { structTypeIdx: number; fieldIdx: number; fieldType: ValType }[] {
  const result: { structTypeIdx: number; fieldIdx: number; fieldType: ValType }[] = [];
  for (const [typeName, fields] of ctx.structFields) {
    const sIdx = ctx.structMap.get(typeName);
    if (sIdx === undefined || sIdx === excludeTypeIdx) continue;
    const fIdx = fields.findIndex((f) => f.name === propName);
    if (fIdx !== -1) {
      result.push({ structTypeIdx: sIdx, fieldIdx: fIdx, fieldType: fields[fIdx]!.type });
    }
  }
  return result;
}

export function emitNullGuardedStructGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objType: ValType,
  fieldType: ValType,
  typeIdx: number,
  fieldIdx: number,
  propName?: string,
  throwOnNull: boolean = true,
): void {
  // For result type in the if block, normalize ref to ref_null so the null branch is valid
  const resultType: ValType = fieldType.kind === "ref"
    ? { kind: "ref_null", typeIdx: (fieldType as any).typeIdx }
    : fieldType;

  // When propName is provided, the object may be a valid GC struct of a
  // DIFFERENT type (after emitGuardedRefCast returned ref.null for a type
  // mismatch).  We need multi-struct dispatch: try the primary struct type
  // first, then try alternative struct types that have the same field name.
  // We operate on anyref so we can re-test the same value against multiple
  // struct types without losing it.
  if (propName) {
    // Widen the ref_null $T to anyref so we can multi-dispatch
    const tmpAny = allocLocal(fctx, `__ng_any_${fctx.locals.length}`, { kind: "anyref" });
    fctx.body.push({ op: "local.set", index: tmpAny });
    const resultLocal = allocLocal(fctx, `__ng_res_${fctx.locals.length}`, resultType);

    // Try primary struct type
    fctx.body.push({ op: "local.get", index: tmpAny });
    fctx.body.push({ op: "ref.test", typeIdx });

    // Find alternative struct types with the same field name
    const alternates = findAlternateStructsForField(ctx, propName, typeIdx);

    // Build the fallback chain: try alternates, then default
    const buildFallback = (altIdx: number): Instr[] => {
      if (altIdx < alternates.length) {
        const alt = alternates[altIdx]!;
        // Coerce the alternate field type to the expected result type
        const altCoerce = coercionInstrs(ctx, alt.fieldType, resultType);
        return [
          { op: "local.get", index: tmpAny } as Instr,
          { op: "ref.test", typeIdx: alt.structTypeIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: tmpAny } as Instr,
              { op: "ref.cast", typeIdx: alt.structTypeIdx } as Instr,
              { op: "struct.get", typeIdx: alt.structTypeIdx, fieldIdx: alt.fieldIdx } as Instr,
              ...altCoerce,
              { op: "local.set", index: resultLocal } as Instr,
            ],
            else: buildFallback(altIdx + 1),
          } as Instr,
        ];
      }
      // No more alternates — return default value
      return [
        ...defaultValueInstrs(resultType),
        { op: "local.set", index: resultLocal } as Instr,
      ];
    };

    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: tmpAny } as Instr,
        { op: "ref.cast", typeIdx } as Instr,
        { op: "struct.get", typeIdx, fieldIdx } as Instr,
        { op: "local.set", index: resultLocal } as Instr,
      ],
      else: buildFallback(0),
    });
    fctx.body.push({ op: "local.get", index: resultLocal });
    return;
  }

  const tmp = allocLocal(fctx, `__ng_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });
  // When throwOnNull is true, throw TypeError for null/undefined property access (#728).
  // When false (ref cells), return a default value for uninitialized captures.
  const nullBranch = throwOnNull
    ? typeErrorThrowInstrs(ctx)
    : defaultValueInstrs(resultType);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: resultType },
    then: nullBranch,
    else: [
      { op: "local.get", index: tmp } as Instr,
      { op: "struct.get", typeIdx, fieldIdx } as Instr,
    ],
  });
}

/**
 * Emit a struct.get from an externref value. The externref on the stack is
 * converted to anyref via any.convert_extern, then null-safely cast to the
 * target struct type. If the value is the expected struct type, use struct.get.
 * If the value is non-null but wrong type, fall back to __extern_get (dynamic
 * property access) when propName is provided. If the value is null, return a
 * default value.
 *
 * Stack: [externref] -> [fieldType]
 */
export function emitExternrefToStructGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  structTypeIdx: number,
  fieldIdx: number,
  propName?: string,
  throwOnNull: boolean = true,
): void {
  // For result type, normalize ref to ref_null so the null branch is valid
  const resultType: ValType = fieldType.kind === "ref"
    ? { kind: "ref_null", typeIdx: (fieldType as any).typeIdx }
    : fieldType;

  // Convert externref -> anyref for struct type testing
  fctx.body.push({ op: "any.convert_extern" } as Instr);

  // Use multi-struct dispatch: try the primary struct type, then any
  // alternative struct types that have the same field name.  This handles
  // the case where the runtime object is a valid GC struct but of a
  // different type than expected (e.g., {x:1,y:2} compiled as $__anon_0
  // but accessed as $Point).  WasmGC structs are opaque to JS, so
  // __extern_get cannot read their fields — we must use struct.get.
  const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
  fctx.body.push({ op: "local.tee", index: tmpAny });
  const resultLocal = allocTempLocal(fctx, resultType);

  fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });

  // Find alternative struct types with the same field name
  const alternates = propName ? findAlternateStructsForField(ctx, propName, structTypeIdx) : [];

  // Build the fallback chain: try alternates, then default
  const buildFallbackChain = (altIdx: number): Instr[] => {
    if (altIdx < alternates.length) {
      const alt = alternates[altIdx]!;
      const altCoerce = coercionInstrs(ctx, alt.fieldType, resultType);
      return [
        { op: "local.get", index: tmpAny } as Instr,
        { op: "ref.test", typeIdx: alt.structTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: tmpAny } as Instr,
            { op: "ref.cast", typeIdx: alt.structTypeIdx } as Instr,
            { op: "struct.get", typeIdx: alt.structTypeIdx, fieldIdx: alt.fieldIdx } as Instr,
            ...altCoerce,
            { op: "local.set", index: resultLocal } as Instr,
          ],
          else: buildFallbackChain(altIdx + 1),
        } as Instr,
      ];
    }
    // No more alternates — return default value
    return [
      ...defaultValueInstrs(resultType),
      { op: "local.set", index: resultLocal } as Instr,
    ];
  };

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: tmpAny } as Instr,
      { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
      { op: "struct.get", typeIdx: structTypeIdx, fieldIdx } as Instr,
      { op: "local.set", index: resultLocal } as Instr,
    ],
    else: buildFallbackChain(0),
  });

  fctx.body.push({ op: "local.get", index: resultLocal });
  releaseTempLocal(fctx, tmpAny);
  releaseTempLocal(fctx, resultLocal);
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

  // Determine result type from the TS type of the property being accessed
  const tsPropType = ctx.checker.getTypeAtLocation(expr);
  let resultType: ValType = resolveWasmType(ctx, tsPropType);
  // For ref types, use externref as the block type to avoid null-subtyping issues
  if (resultType.kind === "ref" || resultType.kind === "ref_null") {
    resultType = { kind: "externref" };
  }

  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);

  // then branch (null path): push the appropriate null/zero default
  let thenInstrs: Instr[];
  if (resultType.kind === "f64") {
    thenInstrs = [{ op: "f64.const", value: 0 }];
  } else if (resultType.kind === "i32") {
    thenInstrs = [{ op: "i32.const", value: 0 }];
  } else {
    thenInstrs = [{ op: "ref.null.extern" }];
  }

  // else branch (non-null path): get the property from the temp
  fctx.body = [];
  fctx.body.push({ op: "local.get", index: tmp });
  // Compile the property access part without the receiver
  const tsObjType = ctx.checker.getTypeAtLocation(expr.expression);
  const propName = expr.name.text;
  let elseResultType: ValType | null = null;
  if (isExternalDeclaredClass(tsObjType, ctx.checker)) {
    compileExternPropertyGetFromStack(ctx, fctx, tsObjType, propName);
    elseResultType = { kind: "externref" };
  } else if (isStringType(tsObjType) && propName === "length") {
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      // len is field 0 of $AnyString — works for both FlatString and ConsString
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
    } else {
      const funcIdx = ctx.funcMap.get("length");
      if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
    }
    elseResultType = { kind: "i32" };
  } else {
    // General struct field access: look up the struct type and field index
    const structName = resolveStructName(ctx, tsObjType);
    if (structName) {
      const structTypeIdx = ctx.structMap.get(structName);
      const fields = ctx.structFields.get(structName);
      if (structTypeIdx !== undefined && fields) {
        // Check for accessor first
        const accessorKey = `${structName}_${propName}`;
        const getterName = `${structName}_get_${propName}`;
        const getterIdx = ctx.funcMap.get(getterName);
        if (ctx.classAccessorSet.has(accessorKey) && getterIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: getterIdx });
          // Determine getter return type
          const funcDef = ctx.mod.functions[getterIdx - ctx.numImportFuncs];
          if (funcDef) {
            const typeDef = ctx.mod.types[funcDef.typeIdx];
            if (typeDef && typeDef.kind === "func" && typeDef.results.length > 0) {
              elseResultType = typeDef.results[0]!;
            }
          }
        } else {
          const fieldIdx = fields.findIndex((f: any) => f.name === propName);
          if (fieldIdx >= 0) {
            // Cast to the concrete struct type if needed, using ref.test guard to avoid illegal cast traps
            if (objType.kind !== "ref" || objType.typeIdx !== structTypeIdx) {
              // Use ref.test to guard against illegal casts at runtime
              const castTmp = allocLocal(fctx, `__optcast_tmp_${fctx.locals.length}`, objType);
              fctx.body.push({ op: "local.tee", index: castTmp });
              fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val", type: fields[fieldIdx]!.type },
                then: [
                  { op: "local.get", index: castTmp },
                  { op: "ref.cast", typeIdx: structTypeIdx },
                  { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
                ],
                else: [
                  // Type mismatch at runtime — emit a safe default
                  ...(fields[fieldIdx]!.type.kind === "f64" ? [{ op: "f64.const", value: NaN }] :
                     fields[fieldIdx]!.type.kind === "i32" ? [{ op: "i32.const", value: 0 }] :
                     [{ op: "ref.null.extern" }]) as Instr[],
                ],
              });
            } else {
              fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
            }
            elseResultType = fields[fieldIdx]!.type;
          }
        }
      }
    }
  }

  // Coerce else branch result to match the block result type
  if (elseResultType && !valTypesMatch(elseResultType, resultType)) {
    coerceType(ctx, fctx, elseResultType, resultType);
  }
  const elseInstrs = fctx.body;

  popBody(fctx, savedBody);
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

  // Handle super.prop — access parent class property/getter on current `this`
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return compileSuperPropertyAccess(ctx, fctx, expr, propName);
  }

  // Handle import.meta.url and other import.meta properties
  if (ts.isMetaProperty(expr.expression) &&
      expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      expr.expression.name.text === "meta") {
    if (propName === "url") {
      return compileStringLiteral(ctx, fctx, "module.wasm");
    }
    // For any other import.meta property, return undefined
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

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
      // ClassName.prototype — return a singleton prototype global (externref)
      // so that Object.getPrototypeOf(instance) === ClassName.prototype holds.
      if (propName === "prototype") {
        if (emitLazyProtoGet(ctx, fctx, objName)) {
          return { kind: "externref" };
        }
        // Fallback: return null externref
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      // ClassName.constructor — return the constructor function reference
      if (propName === "constructor") {
        const ctorName = `${objName}_constructor`;
        const funcIdx = ctx.funcMap.get(ctorName);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "ref.func", funcIdx });
          fctx.body.push({ op: "extern.convert_any" });
          return { kind: "externref" };
        }
        // Fallback: return null externref
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
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

  // Handle Function.length — return the number of formal parameters
  if (propName === "length") {
    const callSigs = objType.getCallSignatures?.();
    const constructSigs2 = objType.getConstructSignatures?.();
    const lengthSigs = (callSigs && callSigs.length > 0) ? callSigs : (constructSigs2 && constructSigs2.length > 0) ? constructSigs2 : null;
    if (lengthSigs && lengthSigs.length > 0) {
      // Use the first call/construct signature's parameter count (excluding rest params)
      const sig = lengthSigs[0]!;
      const paramCount = sig.parameters.filter(
        (p: any) => {
          const decl = p.valueDeclaration;
          return !decl || !ts.isParameter(decl) || !decl.dotDotDotToken;
        }
      ).length;
      fctx.body.push({ op: "f64.const", value: paramCount });
      return { kind: "f64" };
    }
  }

  // Handle Function.name — return the function name as a string
  if (propName === "name") {
    const callSigs = objType.getCallSignatures?.();
    const constructSigs = objType.getConstructSignatures?.();
    if ((callSigs && callSigs.length > 0) || (constructSigs && constructSigs.length > 0)) {
      // Resolve the function name from the type symbol or the expression
      let funcName = objType.getSymbol()?.name ?? "";
      // __type, __function, __class, __object are anonymous type names from TS checker
      if (funcName === "__type" || funcName === "__function" || funcName === "__class" || funcName === "__object") funcName = "";
      // If the symbol name is empty (anonymous function), infer from context:
      if (funcName === "") {
        if (ts.isIdentifier(expr.expression)) {
          // Direct variable access: f.name => infer "f"
          funcName = expr.expression.text;
        } else if (ts.isPropertyAccessExpression(expr.expression)) {
          // Property access: obj.method.name => infer "method"
          funcName = expr.expression.name.text;
        } else if (ts.isElementAccessExpression(expr.expression) &&
                   ts.isStringLiteral(expr.expression.argumentExpression)) {
          // Element access: obj["method"].name => infer "method"
          funcName = expr.expression.argumentExpression.text;
        }
      }
      // Ensure the string constant is registered before compiling
      addStringConstantGlobal(ctx, funcName);
      return compileStringLiteral(ctx, fctx, funcName);
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
    // Fallback: compile the expression and check the actual wasm return type
    // This handles cases like strings.raw.length where TS doesn't know the type
    {
      const savedLen = fctx.body.length;
      const exprType = compileExpression(ctx, fctx, expr.expression);
      if (exprType && (exprType.kind === "ref" || exprType.kind === "ref_null") && (exprType as { typeIdx: number }).typeIdx !== undefined) {
        const vecTypeIdx = (exprType as { typeIdx: number }).typeIdx;
        const typeDef = ctx.mod.types[vecTypeIdx];
        if (typeDef?.kind === "struct" && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data") {
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
          return ctx.fast ? { kind: "i32" } : { kind: "f64" };
        }
      }
      // Undo the compiled expression if it didn't match
      fctx.body.length = savedLen;
    }
  }

  // Handle .raw on tagged template strings arrays (template vec struct)
  // The strings parameter is typed as a base vec, but at runtime it's a
  // template vec (subtype with an extra raw field). We ref.cast to the
  // template vec type and then struct.get field 2.
  if (propName === "raw" && ctx.templateVecTypeIdx >= 0) {
    const templateVecTypeIdx = ctx.templateVecTypeIdx;
    // Check if the object is a vec-like type (base vec or template vec)
    let isVecLike = false;
    if (ts.isIdentifier(expr.expression)) {
      const localIdx = fctx.localMap.get(expr.expression.text);
      if (localIdx !== undefined) {
        const localType = localIdx < fctx.params.length
          ? fctx.params[localIdx]!.type
          : fctx.locals[localIdx - fctx.params.length]?.type;
        if ((localType?.kind === "ref" || localType?.kind === "ref_null") && localType.typeIdx !== undefined) {
          const typeIdx = (localType as { typeIdx: number }).typeIdx;
          const typeDef = ctx.mod.types[typeIdx];
          if (typeDef?.kind === "struct" && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data") {
            isVecLike = true;
          }
        }
      }
    }
    if (!isVecLike) {
      const objWasmType = resolveWasmType(ctx, objType);
      if (objWasmType.kind === "ref" || objWasmType.kind === "ref_null") {
        const typeIdx = (objWasmType as { typeIdx: number }).typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        if (typeDef?.kind === "struct" && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data") {
          isVecLike = true;
        }
      }
    }
    if (isVecLike) {
      // Compile the object expression, cast to template vec, and get raw field
      compileExpression(ctx, fctx, expr.expression);
      fctx.body.push({ op: "ref.cast", typeIdx: templateVecTypeIdx });
      fctx.body.push({ op: "struct.get", typeIdx: templateVecTypeIdx, fieldIdx: 2 });
      const baseVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
      return { kind: "ref_null", typeIdx: baseVecTypeIdx };
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
      SQRT1_2: Math.SQRT1_2,
      LOG2E: Math.LOG2E,
      LOG10E: Math.LOG10E,
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

  // Handle Symbol.iterator, Symbol.hasInstance, etc. → constant i32
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Symbol"
  ) {
    const symId = getWellKnownSymbolId(propName);
    if (symId !== undefined) {
      fctx.body.push({ op: "i32.const", value: symId });
      return { kind: "i32" };
    }
  }

  // Handle string.length
  if (isStringType(objType) && propName === "length") {
    compileExpression(ctx, fctx, expr.expression);
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
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
    const externResult = compileExternPropertyGet(ctx, fctx, expr, objType, propName);
    if (externResult !== null) return externResult;
    // Fall through to dynamic fallback if import is missing
  }

  // Handle getter accessor on user-defined classes
  let typeName = resolveStructName(ctx, objType);
  // Fallback: check widened variable struct map for empty objects with later-assigned props
  if (!typeName && ts.isIdentifier(expr.expression)) {
    typeName = ctx.widenedVarStructMap.get(expr.expression.text);
  }
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

    // Handle .constructor on class instances — return constructor function ref
    if (propName === "constructor" && ctx.classSet.has(typeName)) {
      // Compile and drop the object expression (for side effects)
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      const ctorName = `${typeName}_constructor`;
      const funcIdx = ctx.funcMap.get(ctorName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "ref.func", funcIdx });
        fctx.body.push({ op: "extern.convert_any" });
        return { kind: "externref" };
      }
      // No named constructor found — return null externref
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle .prototype on class instances — return prototype singleton
    if (propName === "prototype" && ctx.classSet.has(typeName)) {
      // Compile and drop the object expression
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      if (emitLazyProtoGet(ctx, fctx, typeName)) {
        return { kind: "externref" };
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle struct field access (named or anonymous)
    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        const objResult = compileExpression(ctx, fctx, expr.expression);
        const fieldType = fields[fieldIdx]!.type;
        // Null-guard: if the object ref could be null (ref_null), prevent trap
        if (objResult && objResult.kind === "ref_null") {
          emitNullGuardedStructGet(ctx, fctx, objResult, fieldType, structTypeIdx, fieldIdx, propName);
          // The null guard if-block returns ref_null for ref fields
          if (fieldType.kind === "ref") {
            return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
          }
          return fieldType;
        } else if (objResult && objResult.kind === "externref") {
          // The expression returned externref but we need a struct ref for struct.get.
          // Cast externref → anyref → (ref null $StructType), with __extern_get fallback.
          emitExternrefToStructGet(ctx, fctx, fieldType, structTypeIdx, fieldIdx, propName);
          if (fieldType.kind === "ref") {
            return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
          }
          return fieldType;
        } else if (objResult && objResult.kind === "ref") {
          // Even though the type says non-null ref, the value may be null at
          // runtime (e.g. default-initialized locals, chained property access
          // on optional fields).  Wrap in a null guard to avoid trapping.
          const nullableObj: ValType = { kind: "ref_null", typeIdx: (objResult as any).typeIdx ?? structTypeIdx };
          emitNullGuardedStructGet(ctx, fctx, nullableObj, fieldType, structTypeIdx, fieldIdx, propName);
          if (fieldType.kind === "ref") {
            return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
          }
          return fieldType;
        } else {
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx,
          });
        }
        return fieldType;
      }
    }
  }

  // Dynamic property access fallback: instead of erroring, emit a default value.
  // This handles cases where TypeScript cannot resolve the property statically
  // (e.g., properties on Object, {}, undefined, or dynamically-typed values).
  // Determine the expected result type from the TS checker at the access site.
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const accessWasm = resolveWasmType(ctx, accessType);

  // For struct types with the property, try to compile the object and do struct.get
  // but NEVER for class struct types — their fields are fixed at collection time
  if (typeName && !ctx.classSet.has(typeName)) {
    // typeName was already resolved above but field was not found;
    // try auto-registering the property from the TS type
    const props = objType.getProperties?.();
    if (props) {
      const tsProp = props.find(p => p.name === propName);
      if (tsProp) {
        const propTsType = ctx.checker.getTypeOfSymbolAtLocation(tsProp, expr);
        const propWasmType = resolveWasmType(ctx, propTsType);
        // Try to add the field to the struct dynamically
        const structTypeIdx = ctx.structMap.get(typeName);
        const fields = ctx.structFields.get(typeName);
        if (structTypeIdx !== undefined && fields) {
          const typeDef = ctx.mod.types[structTypeIdx];
          if (typeDef?.kind === "struct") {
            // Add the missing field (widen ref to ref_null for default initialization)
            const fieldType = propWasmType.kind === "ref"
              ? { kind: "ref_null" as const, typeIdx: (propWasmType as { typeIdx: number }).typeIdx }
              : propWasmType;
            const newField: FieldDef = { name: propName, type: fieldType, mutable: true };
            fields.push(newField);
            // fields === typeDef.fields (same array ref from structFields map)
            patchStructNewForAddedField(ctx, fctx, structTypeIdx, propWasmType);
            const fieldIdx = fields.length - 1;
          if (fieldIdx !== -1) {
            const fieldType = fields[fieldIdx]!.type;
            const objResult = compileExpression(ctx, fctx, expr.expression);
            if (objResult && objResult.kind === "ref_null") {
              emitNullGuardedStructGet(ctx, fctx, objResult, fieldType, structTypeIdx, fieldIdx, propName);
              if (fieldType.kind === "ref") {
                return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
              }
              return fieldType;
            } else if (objResult && objResult.kind === "externref") {
              emitExternrefToStructGet(ctx, fctx, fieldType, structTypeIdx, fieldIdx, propName);
            } else if (objResult && objResult.kind === "ref") {
              // Null-guard ref-typed objects (may be null at runtime)
              const nullableObj: ValType = { kind: "ref_null", typeIdx: (objResult as any).typeIdx ?? structTypeIdx };
              emitNullGuardedStructGet(ctx, fctx, nullableObj, fieldType, structTypeIdx, fieldIdx, propName);
              if (fieldType.kind === "ref") {
                return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
              }
            } else {
              fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
            }
            return fieldType;
          }
        }
      }
    }
  }
  } // close if (typeName && !ctx.classSet.has(typeName))

  // For externref objects (e.g. results of host calls like RegExp.exec()),
  // use __extern_get(obj, key) to dynamically read the property at runtime.
  {
    const objWasmType = resolveWasmType(ctx, objType);
    const isExternObj = objWasmType.kind === "externref" || (
      ts.isIdentifier(expr.expression) && (() => {
        const localIdx = fctx.localMap.get(expr.expression.text);
        if (localIdx === undefined) return false;
        const localType = localIdx < fctx.params.length
          ? fctx.params[localIdx]!.type
          : fctx.locals[localIdx - fctx.params.length]?.type;
        return localType?.kind === "externref";
      })()
    );
    if (isExternObj) {
      const getIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
      let unboxIdx: number | undefined;
      if (accessWasm.kind === "f64" || accessWasm.kind === "i32") {
        unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      }
      flushLateImportShifts(ctx, fctx);
      if (getIdx !== undefined) {
        const objExprType = compileExpression(ctx, fctx, expr.expression);
        // If the expression produced a ref/ref_null (struct), convert to externref
        // so that __extern_get (which expects externref) can be used.
        if (objExprType && (objExprType.kind === "ref" || objExprType.kind === "ref_null")) {
          fctx.body.push({ op: "extern.convert_any" });
        }
        // If the expression produced f64, box it to externref
        if (objExprType && objExprType.kind === "f64") {
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
        // If the expression produced i32, convert to externref via f64 + box
        if (objExprType && objExprType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
        // Null check: throw TypeError for property access on null/undefined
        const objTmp = allocLocal(fctx, `__nullchk_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.tee", index: objTmp });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: typeErrorThrowInstrs(ctx),
          else: [],
        });
        // Multi-struct dispatch: the externref may actually be a WasmGC struct
        // (converted via extern.convert_any).  JS __extern_get cannot read GC
        // struct fields, so try struct.get first for all struct types that
        // have a field matching propName.  Only fall back to __extern_get for
        // genuine host-provided externref objects.
        const structCandidates = findAlternateStructsForField(ctx, propName, -1);
        if (structCandidates.length > 0) {
          // Convert externref -> anyref for struct type testing
          const tmpAnyExt = allocLocal(fctx, `__sd_any_${fctx.locals.length}`, { kind: "anyref" });
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "any.convert_extern" } as Instr);
          fctx.body.push({ op: "local.set", index: tmpAnyExt });

          const resultWasm = accessWasm.kind === "f64" || accessWasm.kind === "i32" ? accessWasm : { kind: "externref" as const };
          const resultLocal = allocLocal(fctx, `__sd_res_${fctx.locals.length}`, resultWasm);

          // Build the __extern_get fallback instructions
          const externGetFallback: Instr[] = [
            { op: "local.get", index: objTmp } as Instr,
          ];
          addStringConstantGlobal(ctx, propName);
          const strGlobalIdxExt = ctx.stringGlobalMap.get(propName);
          if (strGlobalIdxExt !== undefined) {
            externGetFallback.push({ op: "global.get", index: strGlobalIdxExt } as Instr);
          } else {
            externGetFallback.push({ op: "ref.null.extern" } as Instr);
          }
          externGetFallback.push({ op: "call", funcIdx: getIdx } as Instr);
          if (resultWasm.kind === "f64" && unboxIdx !== undefined) {
            externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
          } else if (resultWasm.kind === "i32" && unboxIdx !== undefined) {
            externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
            externGetFallback.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
          }
          externGetFallback.push({ op: "local.set", index: resultLocal } as Instr);

          // Build nested if/else chain for struct candidates
          const buildStructDispatch = (idx: number): Instr[] => {
            if (idx >= structCandidates.length) {
              return externGetFallback;
            }
            const cand = structCandidates[idx]!;
            const getFieldInstrs: Instr[] = [
              { op: "local.get", index: tmpAnyExt } as Instr,
              { op: "ref.cast", typeIdx: cand.structTypeIdx } as Instr,
              { op: "struct.get", typeIdx: cand.structTypeIdx, fieldIdx: cand.fieldIdx } as Instr,
            ];
            const coerce = coercionInstrs(ctx, cand.fieldType, resultWasm);
            getFieldInstrs.push(...coerce);
            getFieldInstrs.push({ op: "local.set", index: resultLocal } as Instr);

            return [
              { op: "local.get", index: tmpAnyExt } as Instr,
              { op: "ref.test", typeIdx: cand.structTypeIdx } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: getFieldInstrs,
                else: buildStructDispatch(idx + 1),
              } as Instr,
            ];
          };

          fctx.body.push(...buildStructDispatch(0));
          fctx.body.push({ op: "local.get", index: resultLocal });
          if (accessWasm.kind === "f64") {
            return { kind: "f64" };
          }
          if (accessWasm.kind === "i32") {
            return { kind: "i32" };
          }
          return { kind: "externref" };
        }

        // No struct candidates — use __extern_get directly
        fctx.body.push({ op: "local.get", index: objTmp });
        addStringConstantGlobal(ctx, propName);
        compileStringLiteral(ctx, fctx, propName);
        fctx.body.push({ op: "call", funcIdx: getIdx });
        if (accessWasm.kind === "f64") {
          if (unboxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
          return { kind: "f64" };
        }
        if (accessWasm.kind === "i32") {
          if (unboxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
          fctx.body.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
          return { kind: "i32" };
        }
        return { kind: "externref" };
      }
    }
  }

  // Fallback: emit default values for unresolvable property accesses.
  if (accessWasm.kind === "f64" || accessWasm.kind === "i32") {
    fctx.body.push({ op: accessWasm.kind === "f64" ? "f64.const" : "i32.const", value: 0 });
    return accessWasm;
  }
  if (accessWasm.kind === "externref") {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  if (accessWasm.kind === "ref" || accessWasm.kind === "ref_null") {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Last resort: emit null externref as safe default instead of trapping.
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
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

  const importName = `${propOwner.importPrefix}_get_${propName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    // Import not found — return null silently to let the caller's fallback handle it.
    // Do NOT compile the object expression here to avoid dangling stack values.
    return null;
  }

  // Push the object and call the getter
  compileExpression(ctx, fctx, expr.expression);
  fctx.body.push({ op: "call", funcIdx });

  const propInfo = propOwner.properties.get(propName);
  return propInfo?.type ?? { kind: "externref" };
}

/**
 * Emit a bounds-checked array.get.  Stack must contain [arrayref, i32 index].
 * If the index is out of bounds (< 0 or >= array.len), a default value for the
 * element type is produced instead of trapping.
 */
export function emitBoundsCheckedArrayGet(
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
): void {
  // Save index and array ref to locals so we can use them in both branches
  const idxLocal = allocLocal(fctx, `__bounds_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__bounds_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });

  fctx.body.push({ op: "local.set", index: idxLocal });   // save index
  fctx.body.push({ op: "local.set", index: arrLocal });   // save array ref

  // Condition: idx >= 0 && idx < array.len(arr)
  // We use: (unsigned)idx < array.len — this handles negative indices too
  // since negative i32 interpreted as unsigned is > any valid length
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" } as Instr);

  // Build the "then" branch: in-bounds → array.get
  const thenInstrs: Instr[] = [
    { op: "local.get", index: arrLocal } as Instr,
    { op: "local.get", index: idxLocal } as Instr,
    { op: "array.get", typeIdx: arrTypeIdx } as Instr,
  ];

  // Build the "else" branch: out-of-bounds → default value
  const elseInstrs: Instr[] = defaultValueInstrs(elementType);

  // When the element type is a non-null ref, the else branch produces ref.null
  // which is ref_null. Use ref_null as the block type so both branches validate,
  // then narrow back to ref with ref.as_non_null.
  const needsNullableBlock = elementType.kind === "ref";
  const blockType: ValType = needsNullableBlock
    ? { kind: "ref_null", typeIdx: (elementType as { typeIdx: number }).typeIdx }
    : elementType;

  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: blockType },
    then: thenInstrs,
    else: elseInstrs,
  } as Instr);

  // Narrow ref_null back to ref so downstream struct.get etc. validate
  if (needsNullableBlock) {
    fctx.body.push({ op: "ref.as_non_null" });
  }
}

/**
 * Clamp an index for JS array methods: if idx < 0, idx = max(0, len + idx);
 * also clamp to max len.  idxLocal is updated in-place.
 */
export function emitClampIndex(
  fctx: FunctionContext,
  idxLocal: number,
  lenLocal: number,
): void {
  // if (idx < 0) idx = max(0, len + idx)
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: lenLocal } as Instr,
      { op: "local.get", index: idxLocal } as Instr,
      { op: "i32.add" } as Instr,
      { op: "local.set", index: idxLocal } as Instr,
      // if still < 0, clamp to 0
      { op: "local.get", index: idxLocal } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "i32.lt_s" } as Instr,
      { op: "if", blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 } as Instr,
          { op: "local.set", index: idxLocal } as Instr,
        ],
      } as Instr,
    ],
  } as Instr);
  // Clamp to len: if (idx > len) idx = len
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: lenLocal } as Instr,
      { op: "local.set", index: idxLocal } as Instr,
    ],
  } as Instr);
}

/**
 * Clamp a value to be >= 0.  local is updated in-place.
 */
export function emitClampNonNeg(
  fctx: FunctionContext,
  local: number,
): void {
  fctx.body.push({ op: "local.get", index: local });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.set", index: local } as Instr,
    ],
  } as Instr);
}

/**
 * Emit a bounds-guarded array.set on a vec struct.  Only writes if the index
 * is in bounds; otherwise the write is silently skipped (JS semantics for
 * out-of-bounds numeric index assignment on a non-extensible array).
 *
 * Expects: vecLocal holds the vec struct ref, idxLocal holds the i32 index,
 * valLocal holds the value to write.
 */
function emitBoundsGuardedArraySet(
  fctx: FunctionContext,
  vecLocal: number,
  vecTypeIdx: number,
  idxLocal: number,
  valLocal: number,
  arrTypeIdx: number,
): void {
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" as const },
    then: [
      { op: "local.get", index: vecLocal } as Instr,
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
      { op: "local.get", index: idxLocal } as Instr,
      { op: "local.get", index: valLocal } as Instr,
      { op: "array.set", typeIdx: arrTypeIdx } as Instr,
    ],
    else: [],
  } as Instr);
}

/** Produce instructions that leave a default value on the stack for a given type. */
/**
 * Check if an element access expression matches a safe bounds-check-eliminated
 * pattern from a for-loop (e.g., arr[i] inside `for (...; i < arr.length; ...)`).
 */
function isSafeBoundsEliminated(
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): boolean {
  if (!fctx.safeIndexedArrays || fctx.safeIndexedArrays.size === 0) return false;
  // Both the array and the index must be simple identifiers
  if (!ts.isIdentifier(expr.expression) || !ts.isIdentifier(expr.argumentExpression)) return false;
  const arrayVar = expr.expression.text;
  const indexVar = expr.argumentExpression.text;
  return fctx.safeIndexedArrays.has(arrayVar + ":" + indexVar);
}

function compileElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  // Handle super[expr] — access parent class property via computed key on `this`
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return compileSuperElementAccess(ctx, fctx, expr);
  }

  const objType = compileExpression(ctx, fctx, expr.expression);
  if (!objType) return null;

  // Null-guard for ref_null: narrow to ref after null check
  // This prevents traps on null array/struct references
  if (objType.kind === "ref_null") {
    const tmp = allocLocal(fctx, `__ng_ea_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.tee", index: tmp });
    fctx.body.push({ op: "ref.is_null" });

    // Determine the element result type
    const accessTsType = ctx.checker.getTypeAtLocation(expr);
    const accessResultType = resolveWasmType(ctx, accessTsType);
    const resultType: ValType = accessResultType.kind === "ref"
      ? { kind: "ref_null", typeIdx: (accessResultType as any).typeIdx }
      : accessResultType;

    // Build else branch (non-null): local.get tmp, ref.as_non_null, then compile inner
    const savedBody = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tmp });
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
    // Continue with the rest of element access logic using the non-null ref
    const nonNullObjType: ValType = { kind: "ref", typeIdx: (objType as any).typeIdx };
    const innerResult = compileElementAccessBody(ctx, fctx, expr, nonNullObjType);
    const elseInstrs = fctx.body;
    fctx.body = savedBody;

    if (innerResult !== null) {
      // Use the actual inner result type for the if block when it differs from
      // the TS-inferred resultType (e.g., TS says `any` → externref, but the
      // actual array element type is f64). This prevents fallthru type mismatches.
      let blockValType = !valTypesMatch(innerResult, resultType) ? innerResult : resultType;
      // Widen ref to ref_null since defaultValueInstrs produces ref.null (nullable)
      if (blockValType.kind === "ref") {
        blockValType = { kind: "ref_null", typeIdx: (blockValType as any).typeIdx };
      }
      fctx.body.push({
        op: "if",
        blockType: { kind: "val" as const, type: blockValType },
        // Throw TypeError for element access on null (#728)
        then: typeErrorThrowInstrs(ctx),
        else: elseInstrs,
      });
      return blockValType;
    }
    // If inner compilation returned null (error), just fall through with default
    let fallbackType = resultType;
    if (fallbackType.kind === "ref") {
      fallbackType = { kind: "ref_null", typeIdx: (fallbackType as any).typeIdx };
    }
    fctx.body.push({
      op: "if",
      blockType: { kind: "val" as const, type: fallbackType },
      // Throw TypeError for element access on null (#728)
      then: typeErrorThrowInstrs(ctx),
      else: elseInstrs.length > 0 ? elseInstrs : defaultValueInstrs(fallbackType),
    });
    return fallbackType;
  }

  return compileElementAccessBody(ctx, fctx, expr, objType);
}

/** Inner element access logic — assumes objType is on the stack and non-null */
function compileElementAccessBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
  objType: ValType,
): ValType | null {
  // Externref element access: obj[key] → host import __extern_get(obj, externref) → externref
  if (objType.kind === "externref") {
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
    // Lazily register __extern_get if not already registered
    let funcIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    return null;
  }

  if (objType.kind !== "ref" && objType.kind !== "ref_null") {
    // Primitive types (f64, i32): box to externref and use __extern_get
    if (objType.kind === "f64") {
      // Box f64 to externref via __box_number
      let boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else if (objType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      let boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else {
      ctx.errors.push({
        message: "Element access on non-array value",
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }
    // Compile key as externref and call __extern_get
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
    let funcIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    return null;
  }

  const typeIdx = (objType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle tuple struct — element access with literal index → struct.get
  if (typeDef?.kind === "struct") {
    const isVecStructAccess = typeDef.fields[0]?.name === "length" &&
      typeDef.fields[1]?.name === "data" &&
      (typeDef.fields.length === 2 || (typeDef.fields.length === 3 && typeDef.fields[2]?.name === "raw"));

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
      // Also handle computed key expressions (well-known symbols, enums, binary exprs)
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(ctx, expr.argumentExpression);
      }
      if (fieldName !== undefined) {
        // Check for getter accessor first
        const objTsType = ctx.checker.getTypeAtLocation(expr.expression);
        const sName = resolveStructName(ctx, objTsType);
        if (sName) {
          const accessorKey = `${sName}_${fieldName}`;
          if (ctx.classAccessorSet.has(accessorKey)) {
            const getterName = `${sName}_get_${fieldName}`;
            const funcIdx = ctx.funcMap.get(getterName);
            if (funcIdx !== undefined) {
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
      // Non-vec, non-tuple struct: fallback to externref conversion + __extern_get
      // Convert struct ref (already on stack) to externref
      fctx.body.push({ op: "extern.convert_any" });
      // Compile the key as externref
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
      // Call __extern_get(externref, externref) → externref
      {
        let funcIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
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
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    if (isSafeBoundsEliminated(fctx, expr)) {
      // Bounds check elided: loop guard guarantees index < array.length
      fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
    } else {
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef.element);
    }
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
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }

  if (isSafeBoundsEliminated(fctx, expr)) {
    // Bounds check elided: loop guard guarantees index < array.length
    fctx.body.push({ op: "array.get", typeIdx } as Instr);
  } else {
    emitBoundsCheckedArrayGet(fctx, typeIdx, typeDef.element);
  }
  return typeDef.element;
}

export function resolveStructName(ctx: CodegenContext, tsType: ts.Type): string | undefined {
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

/**
 * Ensure that a struct registered for an object literal includes fields for
 * computed property names that TypeScript cannot statically resolve.
 * When TS returns 0 properties (e.g. { [1+1]: 2 }), we resolve the computed
 * keys at compile time and create proper struct fields.
 */
function ensureComputedPropertyFields(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  tsType: ts.Type,
): void {
  const existingName = resolveStructName(ctx, tsType);
  if (!existingName) return;
  const existingFields = ctx.structFields.get(existingName);
  if (!existingFields) return;

  // Collect all property assignments with their resolved names
  const resolvedProps: { name: string; valueExpr: ts.Expression }[] = [];
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const propName = resolvePropertyNameText(ctx, prop);
    if (propName === undefined) continue;
    // Check if this field already exists in the struct
    if (existingFields.some(f => f.name === propName)) continue;
    resolvedProps.push({ name: propName, valueExpr: prop.initializer });
  }

  if (resolvedProps.length === 0) return;

  // Need to add new fields. Create a replacement struct with the combined fields.
  const fields = [...existingFields];
  for (const rp of resolvedProps) {
    const propType = ctx.checker.getTypeAtLocation(rp.valueExpr);
    const wasmType = resolveWasmType(ctx, propType);
    fields.push({ name: rp.name, type: wasmType, mutable: true });
  }

  // Update the existing struct in-place
  const structTypeIdx = ctx.structMap.get(existingName)!;
  const typeDef = ctx.mod.types[structTypeIdx] as any;
  typeDef.fields = fields;
  ctx.structFields.set(existingName, fields);

  // Patch existing struct.new instructions for this type with defaults for new fields
  for (const rp of resolvedProps) {
    const propType = ctx.checker.getTypeAtLocation(rp.valueExpr);
    const wasmType = resolveWasmType(ctx, propType);
    patchStructNewForAddedField(ctx, fctx, structTypeIdx, wasmType);
  }
}

function compileObjectLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  // If this empty object literal is the initializer of a variable with widened
  // properties (from pre-pass), register the struct with those extra fields and
  // compile as a struct.new with default values for the widened fields.
  if (expr.properties.length === 0 && ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
    const widenedProps = ctx.widenedTypeProperties.get(expr.parent.name.text);
    if (widenedProps && widenedProps.length > 0) {
      return compileWidenedEmptyObject(ctx, fctx, expr, widenedProps);
    }
  }

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
      ensureComputedPropertyFields(ctx, fctx, expr, type);
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
    ensureComputedPropertyFields(ctx, fctx, expr, contextType);
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
    ensureComputedPropertyFields(ctx, fctx, expr, inferredType);
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

  // Boolean literals
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 0;
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
        // Also resolve let/var with simple literal initializers
        if (ts.isVariableDeclarationList(declList) && decl.initializer) {
          if (ts.isStringLiteral(decl.initializer) || ts.isNumericLiteral(decl.initializer)) {
            return ts.isStringLiteral(decl.initializer) ? decl.initializer.text : String(Number(decl.initializer.text));
          }
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
      case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
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

  // Conditional (ternary) expression: cond ? a : b
  if (ts.isConditionalExpression(expr)) {
    const cond = resolveConstantExpression(ctx, expr.condition);
    if (cond === undefined) return undefined;
    // Evaluate truthiness: 0, NaN, "" are falsy; everything else is truthy
    const isTruthy = typeof cond === "string" ? cond.length > 0 : (cond !== 0 && !isNaN(cond));
    return resolveConstantExpression(ctx, isTruthy ? expr.whenTrue : expr.whenFalse);
  }

  // Nullish coalescing: a ?? b
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = resolveConstantExpression(ctx, expr.left);
    // In constant expressions, values are never null/undefined, so left always wins
    if (left !== undefined) return left;
    return resolveConstantExpression(ctx, expr.right);
  }

  // Template literal: `prefix${expr}suffix`
  if (ts.isTemplateExpression(expr)) {
    let result = expr.head.text;
    for (const span of expr.templateSpans) {
      const val = resolveConstantExpression(ctx, span.expression);
      if (val === undefined) return undefined;
      result += String(val) + span.literal.text;
    }
    return result;
  }

  // No-substitution template literal: `hello`
  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
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
 * Well-known symbol IDs — fixed i32 constants used internally.
 * User-created symbols start at ID 100 via the global counter.
 */
const WELL_KNOWN_SYMBOLS: Record<string, number> = {
  iterator: 1,
  hasInstance: 2,
  toPrimitive: 3,
  toStringTag: 4,
  species: 5,
  isConcatSpreadable: 6,
  match: 7,
  replace: 8,
  search: 9,
  split: 10,
  unscopables: 11,
  asyncIterator: 12,
};

/**
 * Map a well-known Symbol property name (e.g. "iterator") to a reserved
 * property key string "@@iterator" for use as struct field names.
 */
function resolveWellKnownSymbol(name: string): string | undefined {
  if (name in WELL_KNOWN_SYMBOLS) return `@@${name}`;
  return undefined;
}

/**
 * Get the i32 constant for a well-known symbol, or undefined if not well-known.
 */
function getWellKnownSymbolId(name: string): number | undefined {
  return WELL_KNOWN_SYMBOLS[name];
}


/**
 * Try to evaluate a computed key expression to a static string at compile time.
 * Supports:
 * - String literals: ["x"]
 * - Const variable references: [key] where const key = "x"
 * - Enum member access: [MyEnum.Key]
 */
export function resolveComputedKeyExpression(
  ctx: CodegenContext,
  expr: ts.Expression,
): string | undefined {
  // Well-known Symbol property access: [Symbol.iterator], [Symbol.toPrimitive], etc.
  // Map these to reserved names like "@@iterator", "@@toPrimitive" at compile time.
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    const propName = expr.name.text;

    if (objName === "Symbol") {
      const wellKnown = resolveWellKnownSymbol(propName);
      if (wellKnown !== undefined) return wellKnown;
    }

    // Property access for enum members: [MyEnum.Key]
    // Check this after Symbol since resolveConstantExpression doesn't know about enums.
    const enumKey = `${objName}.${propName}`;
    const enumStrVal = ctx.enumStringValues.get(enumKey);
    if (enumStrVal !== undefined) return enumStrVal;
    // Numeric enum — convert to string
    const enumNumVal = ctx.enumValues.get(enumKey);
    if (enumNumVal !== undefined) return String(enumNumVal);
  }

  // Delegate to resolveConstantExpression which handles literals, const variables,
  // binary expressions (+, -, *, /), ternary, nullish coalescing, template literals,
  // prefix unary, and parenthesized expressions.
  const constVal = resolveConstantExpression(ctx, expr);
  if (constVal !== undefined) return String(constVal);

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

/**
 * Compile an empty object literal ({}) that has widened properties from
 * later property assignments (e.g. `var obj = {}; obj.x = 42;`).
 * Registers a struct type with the widened fields and emits struct.new
 * with default values for each field.
 */
function compileWidenedEmptyObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  widenedProps: { name: string; type: ValType }[],
): ValType | null {
  // The struct was already registered during the pre-pass (collectEmptyObjectWidening).
  // Look it up via the anonTypeMap.
  const type = ctx.checker.getTypeAtLocation(expr);
  let typeName = ctx.anonTypeMap.get(type);
  if (!typeName && ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
    const varType = ctx.checker.getTypeAtLocation(expr.parent.name);
    typeName = ctx.anonTypeMap.get(varType);
  }
  if (!typeName) {
    // Fallback: the pre-pass should have registered it but didn't match type identity.
    // Search by variable name in the struct map.
    if (ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
      // Register now as a last resort
      // Widen ref to ref_null so struct.new can use ref.null defaults
      const fields: FieldDef[] = widenedProps.map(wp => ({
        name: wp.name,
        type: wp.type.kind === "ref"
          ? { kind: "ref_null" as const, typeIdx: (wp.type as { typeIdx: number }).typeIdx }
          : wp.type,
        mutable: true,
      }));
      typeName = `__anon_${ctx.anonTypeCounter++}`;
      const typeIdx = ctx.mod.types.length;
      ctx.mod.types.push({
        kind: "struct",
        name: typeName,
        fields,
      } as StructTypeDef);
      ctx.structMap.set(typeName, typeIdx);
      ctx.structFields.set(typeName, fields);
      ctx.anonTypeMap.set(type, typeName);
      const varType = ctx.checker.getTypeAtLocation(expr.parent.name);
      ctx.anonTypeMap.set(varType, typeName);
    }
  }
  if (!typeName) return null;

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) return null;

  // Emit default values for each field
  for (const field of fields) {
    switch (field.type.kind) {
      case "f64":
        fctx.body.push({ op: "f64.const", value: 0 });
        break;
      case "i32":
        fctx.body.push({ op: "i32.const", value: 0 });
        break;
      case "externref":
        fctx.body.push({ op: "ref.null.extern" });
        break;
      default:
        if (field.type.kind === "ref" || field.type.kind === "ref_null") {
          fctx.body.push({ op: "ref.null", typeIdx: (field.type as { typeIdx: number }).typeIdx });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  return { kind: "ref", typeIdx: structTypeIdx };
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
      // Track closure types for valueOf/toString fields
      const bodyLenBefore = fctx.body.length;
      compileExpression(ctx, fctx, prop.initializer, field.type);
      if ((field.name === "valueOf" || field.name === "toString") && field.type.kind === "eqref") {
        // Find the struct.new instruction that creates the closure struct
        for (let bi = bodyLenBefore; bi < fctx.body.length; bi++) {
          const instr = fctx.body[bi]!;
          if (instr.op === "struct.new" && ctx.closureInfoByTypeIdx.has((instr as any).typeIdx)) {
            const closureTypeIdx = (instr as any).typeIdx as number;
            const existing = ctx.valueOfClosureTypes.get(typeName) ?? [];
            if (!existing.includes(closureTypeIdx)) {
              existing.push(closureTypeIdx);
              ctx.valueOfClosureTypes.set(typeName, existing);
            }
          }
        }
      }
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
        } else if (field.type.kind === "eqref") {
          fctx.body.push({ op: "ref.null.eq" });
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

      // Promote captured locals to globals so the getter body can access them
      promoteAccessorCapturesToGlobals(ctx, fctx, prop.body);

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
        savedBodies: [],
      };
      getterFctx.localMap.set("this", 0);

      const savedFunc = ctx.currentFunc;
      if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
      if (savedFunc) ctx.funcStack.push(savedFunc);
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
      if (savedFunc) ctx.funcStack.pop();
      if (savedFunc) ctx.parentBodiesStack.pop();
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

      // Promote captured locals to globals so the setter body can access them
      promoteAccessorCapturesToGlobals(ctx, fctx, prop.body);

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
        savedBodies: [],
      };
      for (let i = 0; i < setterFctxParams.length; i++) {
        setterFctx.localMap.set(setterFctxParams[i]!.name, i);
      }

      const savedFunc = ctx.currentFunc;
      if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
      if (savedFunc) ctx.funcStack.push(savedFunc);
      ctx.currentFunc = setterFctx;

      // Emit default-value initialization for setter parameters with initializers (#377)
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        if (!param.initializer) continue;

        const paramLocalIdx = pi + 1; // account for 'this' param
        const paramType = setterFctxParams[paramLocalIdx]!.type;

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(setterFctx);
        compileExpression(ctx, setterFctx, param.initializer, paramType);
        setterFctx.body.push({ op: "local.set", index: paramLocalIdx });
        const thenInstrs = setterFctx.body;
        popBody(setterFctx, savedBody);

        // Emit the null/zero check + conditional assignment
        if (paramType.kind === "externref") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "ref.is_null" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "ref.is_null" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "i32") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "i32.eqz" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "f64") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "f64.const", value: 0 });
          setterFctx.body.push({ op: "f64.eq" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        }
      }

      if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, setterFctx, stmt);
        }
      }
      cacheStringLiterals(ctx, setterFctx);
      setterFunc.locals = setterFctx.locals;
      setterFunc.body = setterFctx.body;
      if (savedFunc) ctx.funcStack.pop();
      if (savedFunc) ctx.parentBodiesStack.pop();
      ctx.currentFunc = savedFunc;
    }

    // Object literal methods: { method() { ... } }, { "method"() { ... } }, { [key]() { ... } }
    if (
      ts.isMethodDeclaration(prop) &&
      prop.name &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name) || ts.isComputedPropertyName(prop.name))
    ) {
      const methodName = resolveAccessorPropName(ctx, prop.name);
      if (methodName === undefined) continue;
      const fullName = `${typeName}_${methodName}`;
      ctx.classMethodSet.add(fullName);

      // Check if this is a generator method (*method() { ... })
      const isGeneratorMethod = prop.asteriskToken !== undefined;
      if (isGeneratorMethod) {
        ctx.generatorFunctions.add(fullName);
      }

      const methodParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of prop.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // If the parameter has a default value and is a non-null ref type,
        // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
        if (param.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        methodParams.push(wasmType);
      }

      const sig = ctx.checker.getSignatureFromDeclaration(prop);
      const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;
      const methodResults: ValType[] = isGeneratorMethod
        ? [{ kind: "externref" }]
        : (retType && !isVoidType(retType) ? [resolveWasmType(ctx, retType)] : []);

      const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);

      // Check if a placeholder function was already pre-registered (by ensureStructForType).
      // If so, reuse it instead of pushing a duplicate with an empty body.
      const existingFuncIdx = ctx.funcMap.get(fullName);
      let methodFunc: WasmFunction;
      if (existingFuncIdx !== undefined) {
        const localIdx = existingFuncIdx - ctx.numImportFuncs;
        methodFunc = ctx.mod.functions[localIdx]!;
        // Update type in case it was refined
        methodFunc.typeIdx = methodTypeIdx;
      } else {
        const methodFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
        ctx.funcMap.set(fullName, methodFuncIdx);
        methodFunc = {
          name: fullName,
          typeIdx: methodTypeIdx,
          locals: [],
          body: [],
          exported: false,
        };
        ctx.mod.functions.push(methodFunc);
      }

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
        savedBodies: [],
        isGenerator: isGeneratorMethod,
      };
      for (let i = 0; i < methodFctxParams.length; i++) {
        methodFctx.localMap.set(methodFctxParams[i]!.name, i);
      }

      const savedFunc = ctx.currentFunc;
      if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
      if (savedFunc) ctx.funcStack.push(savedFunc);
      ctx.currentFunc = methodFctx;

      // Emit default-value initialization for parameters with initializers
      emitMethodParamDefaults(ctx, methodFctx, prop.parameters, 1); // 1 to skip 'this'

      // Destructure parameters with binding patterns (e.g. method([...x]) or method({a, b}))
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        const paramLocalIdx = pi + 1; // +1 to skip 'this'
        if (ts.isObjectBindingPattern(param.name)) {
          destructureParamObject(ctx, methodFctx, paramLocalIdx, param.name, methodFctxParams[paramLocalIdx]!.type);
        } else if (ts.isArrayBindingPattern(param.name)) {
          destructureParamArray(ctx, methodFctx, paramLocalIdx, param.name, methodFctxParams[paramLocalIdx]!.type);
        }
      }

      if (isGeneratorMethod && prop.body) {
        // Generator method: eagerly evaluate body, collect yields into a buffer,
        // then wrap with __create_generator to return a Generator-like object.
        const bufferLocal = allocLocal(methodFctx, "__gen_buffer", { kind: "externref" });
        const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
        methodFctx.body.push({ op: "call", funcIdx: createBufIdx });
        methodFctx.body.push({ op: "local.set", index: bufferLocal });

        const bodyInstrs: Instr[] = [];
        const outerBody = methodFctx.body;
        methodFctx.body = bodyInstrs;

        methodFctx.generatorReturnDepth = 0;
        methodFctx.blockDepth++;
        for (let i = 0; i < methodFctx.breakStack.length; i++) methodFctx.breakStack[i]!++;
        for (let i = 0; i < methodFctx.continueStack.length; i++) methodFctx.continueStack[i]!++;

        for (const stmt of prop.body.statements) {
          compileStatement(ctx, methodFctx, stmt);
        }

        methodFctx.blockDepth--;
        for (let i = 0; i < methodFctx.breakStack.length; i++) methodFctx.breakStack[i]!--;
        for (let i = 0; i < methodFctx.continueStack.length; i++) methodFctx.continueStack[i]!--;
        methodFctx.generatorReturnDepth = undefined;

        methodFctx.body = outerBody;
        methodFctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: bodyInstrs,
        });

        // Return __create_generator(__gen_buffer)
        const createGenIdx = ctx.funcMap.get("__create_generator")!;
        methodFctx.body.push({ op: "local.get", index: bufferLocal });
        methodFctx.body.push({ op: "call", funcIdx: createGenIdx });
      } else if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, methodFctx, stmt);
        }
      }
      // Ensure valid return for non-void, non-generator methods
      if (methodFctx.returnType && !isGeneratorMethod) {
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
      if (savedFunc) ctx.funcStack.pop();
      if (savedFunc) ctx.parentBodiesStack.pop();
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

  // Compile each element with the expected field type.
  // If the array literal has fewer elements than the tuple expects,
  // push default values (0 for f64/i32, ref.null for ref types) for
  // the missing fields so struct.new gets the right number of arguments.
  for (let i = 0; i < elemTypes.length; i++) {
    const expectedType = elemTypes[i] ?? { kind: "externref" as const };
    if (i < expr.elements.length) {
      compileExpression(ctx, fctx, expr.elements[i]!, expectedType);
    } else {
      // Push a default value for the missing tuple element
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (expectedType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (expectedType.kind === "externref") {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (expectedType.kind === "ref" || expectedType.kind === "ref_null") {
        fctx.body.push({ op: "ref.null", typeIdx: (expectedType as { typeIdx: number }).typeIdx } as any);
      }
    }
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

  // Determine element type from first non-omitted, non-spread element, or from spread source
  let elemWasm: ValType;
  let elemKind: string;
  const firstSignificantElem = expr.elements.find((el) => !ts.isOmittedExpression(el));
  const firstElem = firstSignificantElem ?? expr.elements[0]!;
  if (ts.isSpreadElement(firstElem)) {
    const spreadType = ctx.checker.getTypeAtLocation(firstElem.expression);
    const typeArgs = ctx.checker.getTypeArguments(spreadType as ts.TypeReference);
    const innerType = typeArgs[0];
    elemWasm = innerType ? resolveWasmType(ctx, innerType) : { kind: "f64" };
  } else if (ts.isOmittedExpression(firstElem)) {
    // All elements are omitted — use externref (undefined)
    elemWasm = { kind: "externref" };
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


// ── Object.defineProperty flag helpers ────────────────────────────────

/**
 * Property descriptor flag encoding for the __pf_ side-table:
 *   bit 0: writable
 *   bit 1: enumerable
 *   bit 2: configurable
 *   bit 3: "defined" marker (always 1 when a descriptor has been stored)
 *   bit 4: is accessor property (get/set vs data)
 */
const PROP_FLAG_WRITABLE     = 1 << 0;  // 1
const PROP_FLAG_ENUMERABLE   = 1 << 1;  // 2
const PROP_FLAG_CONFIGURABLE = 1 << 2;  // 4
const PROP_FLAG_DEFINED      = 1 << 3;  // 8
const PROP_FLAG_ACCESSOR     = 1 << 4;  // 16

/**
 * Compute a compile-time flags integer from parsed descriptor booleans.
 * Unspecified flags default to false per the ES spec for Object.defineProperty.
 */
function computeDescriptorFlags(
  writable: boolean | undefined,
  enumerable: boolean | undefined,
  configurable: boolean | undefined,
  isAccessor: boolean,
): number {
  let flags = PROP_FLAG_DEFINED; // always mark as defined
  if (writable) flags |= PROP_FLAG_WRITABLE;
  if (enumerable) flags |= PROP_FLAG_ENUMERABLE;
  if (configurable) flags |= PROP_FLAG_CONFIGURABLE;
  if (isAccessor) flags |= PROP_FLAG_ACCESSOR;
  return flags;
}

/**
 * Emit code to check existing property flags and throw TypeError if the
 * Object.defineProperty operation violates the spec. Also stores the new flags.
 *
 * Uses __extern_get/set with "__pf_<propName>" keys to store flags as boxed numbers.
 * Uses "__ne" key to check non-extensibility.
 *
 * @param objLocal - local index holding the externref object
 * @param propName - compile-time property name
 * @param newFlags - the flags integer for the new descriptor
 * @param hasValue - whether the new descriptor specifies a value
 */
function emitDefinePropertyFlagCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objLocal: number,
  propName: string,
  newFlags: number,
  hasValue: boolean,
): void {
  const flagKey = `__pf_${propName}`;
  const neKey = "__ne";

  // Ensure __extern_get, __extern_set, __unbox_number, __box_number are available
  const getIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  const setIdx = ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
  const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  if (!getIdx || !setIdx || !unboxIdx || !boxIdx) return;

  // Register the flag key and non-extensible key as string constants
  addStringConstantGlobal(ctx, flagKey);
  addStringConstantGlobal(ctx, neKey);
  const flagKeyGlobal = ctx.stringGlobalMap.get(flagKey)!;
  const neKeyGlobal = ctx.stringGlobalMap.get(neKey)!;

  // Helper to build a TypeError throw instruction sequence
  const typeErrorMessage = "TypeError: Cannot redefine property";
  addStringConstantGlobal(ctx, typeErrorMessage);
  const errMsgGlobal = ctx.stringGlobalMap.get(typeErrorMessage)!;
  const tagIdx = ensureExnTag(ctx);
  const throwInstrs: Instr[] = [
    { op: "global.get", index: errMsgGlobal } as Instr,
    { op: "throw", tagIdx } as Instr,
  ];

  const neErrMessage = "TypeError: Cannot define property, object is not extensible";
  addStringConstantGlobal(ctx, neErrMessage);
  const neErrMsgGlobal = ctx.stringGlobalMap.get(neErrMessage)!;
  const neThrowInstrs: Instr[] = [
    { op: "global.get", index: neErrMsgGlobal } as Instr,
    { op: "throw", tagIdx } as Instr,
  ];

  // Allocate locals for existing flags
  const existingFlagsLocal = allocLocal(fctx, `__pf_existing_${fctx.locals.length}`, { kind: "f64" });
  const existingI32Local = allocLocal(fctx, `__pf_ei32_${fctx.locals.length}`, { kind: "i32" });

  // Read existing flags: __extern_get(obj, "__pf_<propName>") -> externref, unbox to f64
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "global.get", index: flagKeyGlobal } as Instr);
  fctx.body.push({ op: "call", funcIdx: getIdx });
  fctx.body.push({ op: "call", funcIdx: unboxIdx }); // externref -> f64 (NaN if undefined)
  fctx.body.push({ op: "local.set", index: existingFlagsLocal });

  // Convert existing flags to i32 (NaN -> 0 via i32.trunc_sat_f64_s)
  fctx.body.push({ op: "local.get", index: existingFlagsLocal });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
  fctx.body.push({ op: "local.set", index: existingI32Local });

  // Build non-configurable violation checks (only emitted when property is defined AND non-configurable)
  const isAccessor = !!(newFlags & PROP_FLAG_ACCESSOR);
  const nonConfigChecks: Instr[] = [];

  // Check: new descriptor sets configurable to true -> always TypeError
  if (newFlags & PROP_FLAG_CONFIGURABLE) {
    nonConfigChecks.push(...throwInstrs);
  }

  // Check: new descriptor changes enumerable (runtime check against existing)
  const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
  nonConfigChecks.push(
    { op: "local.get", index: existingI32Local } as Instr,
    { op: "i32.const", value: PROP_FLAG_ENUMERABLE } as Instr,
    { op: "i32.and" } as Instr,
    { op: "i32.const", value: newEnumerable } as Instr,
    { op: "i32.ne" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] } as unknown as Instr,
  );

  // Check for data property restrictions
  if (!isAccessor) {
    const nonWritableChecks: Instr[] = [];
    if ((newFlags & PROP_FLAG_WRITABLE) || hasValue) {
      nonWritableChecks.push(...throwInstrs);
    }
    if (nonWritableChecks.length > 0) {
      // if (existing is data property)
      //   if (existing is non-writable)
      //     throw TypeError
      const isDataAndNonWritable: Instr[] = [
        { op: "local.get", index: existingI32Local } as Instr,
        { op: "i32.const", value: PROP_FLAG_WRITABLE } as Instr,
        { op: "i32.and" } as Instr,
        { op: "i32.eqz" } as Instr,
        { op: "if", blockType: { kind: "empty" }, then: nonWritableChecks } as unknown as Instr,
      ];
      nonConfigChecks.push(
        { op: "local.get", index: existingI32Local } as Instr,
        { op: "i32.const", value: PROP_FLAG_ACCESSOR } as Instr,
        { op: "i32.and" } as Instr,
        { op: "i32.eqz" } as Instr,
        { op: "if", blockType: { kind: "empty" }, then: isDataAndNonWritable } as unknown as Instr,
      );
    }
  }

  // Check: cannot change from data to accessor or vice versa on non-configurable
  if (isAccessor) {
    nonConfigChecks.push(
      { op: "local.get", index: existingI32Local } as Instr,
      { op: "i32.const", value: PROP_FLAG_ACCESSOR } as Instr,
      { op: "i32.and" } as Instr,
      { op: "i32.eqz" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] } as unknown as Instr,
    );
  } else if (hasValue || (newFlags & PROP_FLAG_WRITABLE)) {
    nonConfigChecks.push(
      { op: "local.get", index: existingI32Local } as Instr,
      { op: "i32.const", value: PROP_FLAG_ACCESSOR } as Instr,
      { op: "i32.and" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] } as unknown as Instr,
    );
  }

  // Build the outer block structure:
  // block $defprop_check
  //   br_if (not defined) → end of block
  //   br_if (configurable) → end of block
  //   <nonConfigChecks>
  // end
  const blockBody: Instr[] = [
    // Check if property is defined
    { op: "local.get", index: existingI32Local } as Instr,
    { op: "i32.const", value: PROP_FLAG_DEFINED } as Instr,
    { op: "i32.and" } as Instr,
    { op: "i32.eqz" } as Instr,
    { op: "br_if", depth: 0 } as Instr,
    // Check if configurable
    { op: "local.get", index: existingI32Local } as Instr,
    { op: "i32.const", value: PROP_FLAG_CONFIGURABLE } as Instr,
    { op: "i32.and" } as Instr,
    { op: "br_if", depth: 0 } as Instr,
    // Property is non-configurable — apply restrictions
    ...nonConfigChecks,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: blockBody,
  } as unknown as Instr);

  // Check: If property was NOT defined yet, check non-extensibility
  const neCheckBody: Instr[] = [
    { op: "local.get", index: objLocal } as Instr,
    { op: "global.get", index: neKeyGlobal } as Instr,
    { op: "call", funcIdx: getIdx } as Instr,
    { op: "call", funcIdx: unboxIdx } as Instr,
    { op: "i32.trunc_sat_f64_s" } as unknown as Instr,
    { op: "if", blockType: { kind: "empty" }, then: [...neThrowInstrs] } as unknown as Instr,
  ];

  fctx.body.push(
    { op: "local.get", index: existingI32Local },
    { op: "i32.const", value: PROP_FLAG_DEFINED },
    { op: "i32.and" },
    { op: "i32.eqz" },
  );
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: neCheckBody,
  } as unknown as Instr);

  // Store the new flags: __extern_set(obj, "__pf_<propName>", box(newFlags))
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "global.get", index: flagKeyGlobal } as Instr);
  fctx.body.push({ op: "f64.const", value: newFlags });
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  fctx.body.push({ op: "call", funcIdx: setIdx });
}

// ── Object.defineProperty ─────────────────────────────────────────────

/**
 * Compile Object.defineProperty(obj, prop, descriptor).
 *
 * If the descriptor is an object literal with a `value` property, we extract
 * the value and emit __extern_set(obj, prop, value).
 * If the descriptor has `get` and/or `set` properties, we compile them as
 * struct accessor methods (getter/setter functions).
 * Otherwise we compile all arguments for side effects and return the object unchanged.
 *
 * Returns obj (externref).
 */
export function compileObjectDefineProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const objArg = expr.arguments[0]!;
  const propArg = expr.arguments[1]!;
  const descArg = expr.arguments[2]!;

  // Check if descriptor is an object literal with a `value`, `get`, or `set` property
  let valueExpr: ts.Expression | undefined;
  let getNode: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  let setNode: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "value"
      ) {
        valueExpr = prop.initializer;
      }
      // get: function() { ... } or get: () => ...
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "get" &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        getNode = prop.initializer;
      }
      // get() { ... } (method shorthand)
      if (
        ts.isMethodDeclaration(prop) &&
        prop.name &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "get"
      ) {
        getNode = prop;
      }
      // set: function(v) { ... } or set: (v) => ...
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "set" &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        setNode = prop.initializer;
      }
      // set(v) { ... } (method shorthand)
      if (
        ts.isMethodDeclaration(prop) &&
        prop.name &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "set"
      ) {
        setNode = prop;
      }
    }
  }

  // ── Parse descriptor flags (configurable, writable, enumerable) ──────
  // Defaults per spec: all false when using Object.defineProperty
  let descWritable: boolean | undefined;
  let descEnumerable: boolean | undefined;
  let descConfigurable: boolean | undefined;
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const name = prop.name.text;
        if (name === "writable" || name === "enumerable" || name === "configurable") {
          // Resolve boolean literal value
          let boolVal: boolean | undefined;
          if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) boolVal = true;
          else if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) boolVal = false;
          if (name === "writable") descWritable = boolVal;
          else if (name === "enumerable") descEnumerable = boolVal;
          else if (name === "configurable") descConfigurable = boolVal;
        }
      }
    }
  }

  // Resolve the property name at compile time (string literal)
  let propName: string | undefined;
  if (ts.isStringLiteral(propArg)) {
    propName = propArg.text;
  }

  // Check if obj is a struct type with the given field
  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  let structName = resolveStructName(ctx, objTsType)
    || (ts.isIdentifier(objArg) ? ctx.widenedVarStructMap.get(objArg.text) : undefined);

  // Fallback 1: resolve struct name from the local variable's Wasm type.
  // This handles cases where the TS type is `any` but the local holds a struct ref.
  if (!structName && ts.isIdentifier(objArg)) {
    const localIdx = fctx.localMap.get(objArg.text);
    if (localIdx !== undefined) {
      const localType = localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : fctx.locals[localIdx - fctx.params.length]?.type;
      if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
        for (const [name, idx] of ctx.structMap) {
          if (idx === localType.typeIdx) {
            structName = name;
            break;
          }
        }
      }
    }
  }

  // Fallback 2: resolve struct name from the variable's declaration initializer.
  // For `const obj: any = { x: 0 }`, the TS type is `any` and the local is
  // externref, but the initializer is an object literal whose fields match a struct.
  if (!structName && ts.isIdentifier(objArg)) {
    const sym = ctx.checker.getSymbolAtLocation(objArg);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const initType = ctx.checker.getTypeAtLocation(decl.initializer);
      structName = resolveStructName(ctx, initType);
      // If resolveStructName failed (ts.Type identity mismatch), try to match
      // by struct field names against the object literal properties.
      if (!structName && ts.isObjectLiteralExpression(decl.initializer)) {
        const litProps = decl.initializer.properties
          .filter(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
          .map(p => (p.name as ts.Identifier).text)
          .sort();
        if (litProps.length > 0) {
          for (const [sName, sFields] of ctx.structFields) {
            const fieldNames = sFields.map(f => f.name).sort();
            if (fieldNames.length === litProps.length &&
                fieldNames.every((n, i) => n === litProps[i])) {
              structName = sName;
              break;
            }
          }
        }
      }
    }
  }

  const structTypeIdx = structName ? ctx.structMap.get(structName) : undefined;
  const fields = structName ? ctx.structFields.get(structName) : undefined;
  const fieldIdx = (fields && propName) ? fields.findIndex(f => f.name === propName) : -1;
  const useStruct = structTypeIdx !== undefined && fields && fieldIdx >= 0 && valueExpr;

  // ── Getter/setter path ──────────────────────────────────────────────
  // Object.defineProperty(obj, "prop", { get() {...}, set(v) {...} })
  // Compile as struct accessor methods, analogous to object literal getters/setters.
  if ((getNode || setNode) && !valueExpr && structName && structTypeIdx !== undefined && propName) {
    // Compile obj and save to local
    const objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;
    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });

    const accessorKey = `${structName}_${propName}`;
    ctx.classAccessorSet.add(accessorKey);

    // Helper to get body statements from a getter/setter node
    const getBodyStatements = (node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction): ts.Statement[] => {
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        // Arrow with expression body: wrap as return statement
        return [];
      }
      const body = ts.isArrowFunction(node) ? (node.body as ts.Block) : node.body;
      return body ? [...body.statements] : [];
    };

    // Helper to get parameters from a node
    const getParams = (node: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction): readonly ts.ParameterDeclaration[] => {
      return node.parameters;
    };

    // Compile getter
    if (getNode) {
      const getterName = `${structName}_get_${propName}`;
      if (!ctx.funcMap.has(getterName)) {
        // Use ref_null so callers with nullable locals don't need ref.as_non_null
        const getterParams: ValType[] = [{ kind: "ref_null", typeIdx: structTypeIdx }];

        // Determine return type from the getter function signature
        const sig = ctx.checker.getSignatureFromDeclaration(getNode);
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
          params: [{ name: "this", type: { kind: "ref_null", typeIdx: structTypeIdx } }],
          locals: [],
          localMap: new Map(),
          returnType: getterResults.length > 0 ? getterResults[0]! : null,
          body: [],
          blockDepth: 0,
          breakStack: [],
          continueStack: [],
          labelMap: new Map(),
          savedBodies: [],
        };
        getterFctx.localMap.set("this", 0);

        const savedFunc = ctx.currentFunc;
        if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
        if (savedFunc) ctx.funcStack.push(savedFunc);
        ctx.currentFunc = getterFctx;

        if (ts.isArrowFunction(getNode) && !ts.isBlock(getNode.body)) {
          // Arrow with expression body: compile as return expression
          const retType = compileExpression(ctx, getterFctx, getNode.body as ts.Expression, getterFctx.returnType ?? undefined);
          if (retType && getterFctx.returnType && retType.kind !== getterFctx.returnType.kind) {
            coerceType(ctx, getterFctx, retType, getterFctx.returnType);
          }
        } else {
          const stmts = getBodyStatements(getNode);
          for (const stmt of stmts) {
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
        if (savedFunc) ctx.funcStack.pop();
        if (savedFunc) ctx.parentBodiesStack.pop();
        ctx.currentFunc = savedFunc;
      }
    }

    // Compile setter
    if (setNode) {
      const setterName = `${structName}_set_${propName}`;
      if (!ctx.funcMap.has(setterName)) {
        // Use ref_null so callers with nullable locals don't need ref.as_non_null
        const setterParams: ValType[] = [{ kind: "ref_null", typeIdx: structTypeIdx }];
        const allNodeParams = getParams(setNode);
        // Filter out the TS `this` parameter (explicit this type annotation)
        const nodeParams = allNodeParams.filter(p => !(ts.isIdentifier(p.name) && p.name.text === "this"));
        for (const param of nodeParams) {
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
          { name: "this", type: { kind: "ref_null", typeIdx: structTypeIdx } },
        ];
        for (let pi = 0; pi < nodeParams.length; pi++) {
          const param = nodeParams[pi]!;
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
          savedBodies: [],
        };
        for (let i = 0; i < setterFctxParams.length; i++) {
          setterFctx.localMap.set(setterFctxParams[i]!.name, i);
        }

        const savedFunc = ctx.currentFunc;
        if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
        if (savedFunc) ctx.funcStack.push(savedFunc);
        ctx.currentFunc = setterFctx;

        if (ts.isArrowFunction(setNode) && !ts.isBlock(setNode.body)) {
          // Arrow with expression body: compile for side effects
          const retType = compileExpression(ctx, setterFctx, setNode.body as ts.Expression);
          if (retType) setterFctx.body.push({ op: "drop" });
        } else {
          const stmts = getBodyStatements(setNode as ts.MethodDeclaration);
          for (const stmt of stmts) {
            compileStatement(ctx, setterFctx, stmt);
          }
        }

        cacheStringLiterals(ctx, setterFctx);
        setterFunc.locals = setterFctx.locals;
        setterFunc.body = setterFctx.body;
        if (savedFunc) ctx.funcStack.pop();
        if (savedFunc) ctx.parentBodiesStack.pop();
        ctx.currentFunc = savedFunc;
      }
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;
  }

  if (valueExpr && useStruct) {
    // Struct path: Object.defineProperty(obj, "prop", { value: v }) → struct.set

    // Compile obj and save to local
    let objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;

    // If obj is externref but we know it's a struct (e.g. `const obj: any = { x: 0 }`),
    // cast from externref to the struct ref type via any.convert_extern + ref.cast.
    if (objType.kind === "externref" && structTypeIdx !== undefined) {
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
      objType = { kind: "ref", typeIdx: structTypeIdx };
    }

    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });

    // ── Compile-time flag checking for struct path ──
    // Save existing flags BEFORE updating (needed for value comparison below)
    let priorExistingFlags: number | undefined;
    if (propName) {
      const varName = ts.isIdentifier(objArg) ? objArg.text : undefined;
      if (varName) {
        const isAccessor = !!(getNode || setNode);
        const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);
        const key = `${varName}:${propName}`;
        priorExistingFlags = ctx.definedPropertyFlags.get(key);

        // Check non-extensibility
        if (ctx.nonExtensibleVars.has(varName) && !ctx.definedPropertyFlags.has(key)) {
          emitThrowString(ctx, fctx, "TypeError: Cannot define property, object is not extensible");
        }

        // Check existing flags
        const existingFlags = ctx.definedPropertyFlags.get(key);
        if (existingFlags !== undefined) {
          const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
          if (!isExistingConfigurable) {
            // Non-configurable: check for violations
            if (newFlags & PROP_FLAG_CONFIGURABLE) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            const existingEnumerable = existingFlags & PROP_FLAG_ENUMERABLE;
            const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
            if (existingEnumerable !== newEnumerable) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            // Data property writable checks
            if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
              if (!(existingFlags & PROP_FLAG_WRITABLE)) {
                if (newFlags & PROP_FLAG_WRITABLE) {
                  // Cannot change writable from false to true on non-configurable
                  emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
                }
              }
            }
            // Cannot change data<->accessor on non-configurable
            if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            if (!isAccessor && (existingFlags & PROP_FLAG_ACCESSOR)) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
          }
        }

        // Record the new flags
        ctx.definedPropertyFlags.set(key, newFlags);
      }
    }

    // Compile remaining descriptor properties for side effects (before value)
    for (const prop of (descArg as ts.ObjectLiteralExpression).properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") continue;
      if (ts.isPropertyAssignment(prop)) {
        const sideType = compileExpression(ctx, fctx, prop.initializer);
        if (sideType) fctx.body.push({ op: "drop" });
      }
    }

    // Check if this property is non-writable non-configurable (needs runtime value comparison)
    // Uses priorExistingFlags captured BEFORE the current call updated the map
    const needsValueCompare = priorExistingFlags !== undefined &&
      !(priorExistingFlags & PROP_FLAG_CONFIGURABLE) &&
      !(priorExistingFlags & PROP_FLAG_WRITABLE) &&
      !(priorExistingFlags & PROP_FLAG_ACCESSOR);

    // Emit struct.set: push obj, then value, then struct.set
    const fieldType = fields![fieldIdx]!.type;

    if (needsValueCompare) {
      // Save old value for comparison
      const oldValLocal = allocLocal(fctx, `__defprop_oldval_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx!, fieldIdx });
      fctx.body.push({ op: "local.set", index: oldValLocal });

      // Compile new value into temp local
      const newValLocal = allocLocal(fctx, `__defprop_newval_${fctx.locals.length}`, fieldType);
      const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
      if (!valType) {
        fctx.body.push({ op: "local.get", index: objLocal });
        return objType;
      }
      if (valType.kind !== fieldType.kind) {
        coerceType(ctx, fctx, valType, fieldType);
      }
      fctx.body.push({ op: "local.set", index: newValLocal });

      // Compare old and new values. If different, throw TypeError.
      // Use SameValue semantics (for f64: need to handle NaN === NaN, +0 !== -0)
      const tagIdx = ensureExnTag(ctx);
      const errMsg = "TypeError: Cannot redefine property";
      addStringConstantGlobal(ctx, errMsg);
      const errMsgGlobal = ctx.stringGlobalMap.get(errMsg)!;

      if (fieldType.kind === "f64") {
        // f64 comparison: values not equal → throw
        // Note: f64.ne treats NaN != NaN (not SameValue), but sufficient for typical test262 cases
        const compareBody: Instr[] = [
          { op: "global.get", index: errMsgGlobal } as Instr,
          { op: "throw", tagIdx } as Instr,
        ];
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: compareBody,
        } as unknown as Instr);
      } else if (fieldType.kind === "i32") {
        const compareBody: Instr[] = [
          { op: "global.get", index: errMsgGlobal } as Instr,
          { op: "throw", tagIdx } as Instr,
        ];
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "i32.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: compareBody,
        } as unknown as Instr);
      }
      // For externref/ref types, skip value comparison (would need reference equality)

      // Do the struct.set with the new value
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newValLocal });
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx!, fieldIdx });
    } else {
      fctx.body.push({ op: "local.get", index: objLocal });
      const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
      if (!valType) {
        // Drop the obj ref we just pushed
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "local.get", index: objLocal });
        return objType;
      }
      if (valType.kind !== fieldType.kind) {
        coerceType(ctx, fctx, valType, fieldType);
      }
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx!, fieldIdx });
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;

  } else if (valueExpr) {
    // Externref path: Object.defineProperty(obj, prop, { value: v }) → __extern_set(obj, prop, v)

    // Compile obj and coerce to externref
    const objType = compileExpression(ctx, fctx, objArg, { kind: "externref" });
    if (!objType) return null;
    if (objType.kind !== "externref") {
      coerceType(ctx, fctx, objType, { kind: "externref" });
    }
    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: objLocal });

    // ── Flag checking: validate descriptor against existing property flags ──
    if (propName) {
      const isAccessor = !!(getNode || setNode);
      const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);

      // Compile-time tracking
      const varName = ts.isIdentifier(objArg) ? objArg.text : undefined;
      if (varName) {
        const key = `${varName}:${propName}`;
        ctx.definedPropertyFlags.set(key, newFlags);
      }

      // Runtime flag checking
      emitDefinePropertyFlagCheck(ctx, fctx, objLocal, propName, newFlags, true);
    }

    // Compile prop key as externref
    const propType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
    if (!propType) {
      fctx.body.push({ op: "local.get", index: objLocal });
      return { kind: "externref" };
    }
    if (propType.kind !== "externref") {
      coerceType(ctx, fctx, propType, { kind: "externref" });
    }
    const propLocal = allocLocal(fctx, `__defprop_key_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: propLocal });

    // Compile value as externref
    const valType = compileExpression(ctx, fctx, valueExpr, { kind: "externref" });
    if (!valType) {
      fctx.body.push({ op: "local.get", index: objLocal });
      return { kind: "externref" };
    }
    if (valType.kind !== "externref") {
      coerceType(ctx, fctx, valType, { kind: "externref" });
    }
    const valLocal = allocLocal(fctx, `__defprop_val_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: valLocal });

    // Compile remaining descriptor properties for side effects
    for (const prop of (descArg as ts.ObjectLiteralExpression).properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") continue;
      if (ts.isPropertyAssignment(prop)) {
        const sideType = compileExpression(ctx, fctx, prop.initializer);
        if (sideType) fctx.body.push({ op: "drop" });
      }
    }

    // Push args: obj, key, val and call __extern_set
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: propLocal });
    fctx.body.push({ op: "local.get", index: valLocal });

    // Lazily register __extern_set if not already registered
    let funcIdx = ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return { kind: "externref" };

  } else {
    // No value property or descriptor is not an object literal:
    // Compile all args for side effects, return obj
    const objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;

    // Save original obj in its original type
    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });

    const propType = compileExpression(ctx, fctx, propArg);
    if (propType) fctx.body.push({ op: "drop" });

    const descType = compileExpression(ctx, fctx, descArg);
    if (descType) fctx.body.push({ op: "drop" });

    // ── Flag checking for descriptors without value (e.g., { configurable: false }) ──
    if (propName && ts.isObjectLiteralExpression(descArg)) {
      const isAccessor = !!(getNode || setNode);
      const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);

      // Compile-time tracking
      const varName = ts.isIdentifier(objArg) ? objArg.text : undefined;
      if (varName) {
        const key = `${varName}:${propName}`;
        // Compile-time non-extensibility check
        if (ctx.nonExtensibleVars.has(varName) && !ctx.definedPropertyFlags.has(key)) {
          emitThrowString(ctx, fctx, "TypeError: Cannot define property, object is not extensible");
        }
        // Compile-time flag validation
        const existingFlags = ctx.definedPropertyFlags.get(key);
        if (existingFlags !== undefined) {
          const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
          if (!isExistingConfigurable) {
            if (newFlags & PROP_FLAG_CONFIGURABLE) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            if ((existingFlags & PROP_FLAG_ENUMERABLE) !== (newFlags & PROP_FLAG_ENUMERABLE)) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
          }
        }
        ctx.definedPropertyFlags.set(key, newFlags);
      }

      // Runtime flag checking (for externref objects only — struct refs are opaque to JS)
      if (objType.kind === "externref") {
        emitDefinePropertyFlagCheck(ctx, fctx, objLocal, propName, newFlags, false);
      }
    }

    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;
  }
}

// ── Object.keys / Object.values ───────────────────────────────────────

/**
 * Compile Object.keys(obj) or Object.values(obj) by expanding struct fields
 * at compile time. Object.keys returns a string[] of field names,
 * Object.values returns an array of the field values.
 */
export function compileObjectKeysOrValues(
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
    // Non-struct argument (any, externref, etc.) — compile and drop the arg,
    // then return an empty array as a graceful fallback.
    const argResult = compileExpression(ctx, fctx, arg);
    if (argResult) {
      fctx.body.push({ op: "drop" });
    }
    const elemKind = "externref";
    const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      return null;
    }
    // Create empty backing array and wrap in vec struct (length=0)
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: 0 });
    const tmpData = allocLocal(fctx, `__obj_${method}_empty_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
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
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        compileNativeStringLiteral(ctx, fctx, entry.field.name);
        // Object.keys returns externref strings, convert from native
        fctx.body.push({ op: "extern.convert_any" });
      } else {
        const globalIdx = ctx.stringGlobalMap.get(entry.field.name);
        if (globalIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: globalIdx });
        } else {
          const importName = ctx.stringLiteralMap.get(entry.field.name);
          if (importName) {
            const funcIdx = ctx.funcMap.get(importName);
            if (funcIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx });
            }
          }
        }
      }
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

  if (method === "entries") {
    // Build [string, T][] by resolving the TS return type to get the correct
    // tuple struct and vec types that match what resolveWasmType produces.
    const argResult = compileExpression(ctx, fctx, arg);
    if (!argResult) return null;
    const objLocal = allocLocal(fctx, `__obj_entries_src_${fctx.locals.length}`, { kind: "ref", typeIdx: structTypeIdx });
    fctx.body.push({ op: "local.set", index: objLocal });

    // Resolve the return type from the TS signature to get proper tuple/vec types
    const sig = ctx.checker.getResolvedSignature(expr);
    const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;
    const resolvedRet = retType ? resolveWasmType(ctx, retType) : undefined;

    // The return type should be ref_null to a vec struct (Array<[string, T]>)
    // Extract the vec type index and from it the array type index and entry tuple type
    let outerVecTypeIdx: number;
    let outerArrTypeIdx: number;
    let entryTupleTypeIdx: number;

    if (resolvedRet && (resolvedRet.kind === "ref" || resolvedRet.kind === "ref_null") && "typeIdx" in resolvedRet) {
      outerVecTypeIdx = resolvedRet.typeIdx;
      outerArrTypeIdx = getArrTypeIdxFromVec(ctx, outerVecTypeIdx);
      // The array element type is a ref to the tuple struct
      // Get it from the vec's array type definition
      const arrTypeDef = ctx.mod.types[outerArrTypeIdx];
      if (arrTypeDef && arrTypeDef.kind === "array" && (arrTypeDef as any).element &&
          ((arrTypeDef as any).element.kind === "ref" || (arrTypeDef as any).element.kind === "ref_null")) {
        entryTupleTypeIdx = (arrTypeDef as any).element.typeIdx;
      } else {
        // Fallback: create a tuple with [externref, externref]
        entryTupleTypeIdx = getOrRegisterTupleType(ctx, [{ kind: "externref" }, { kind: "externref" }]);
      }
    } else {
      // Fallback: create externref-based types
      entryTupleTypeIdx = getOrRegisterTupleType(ctx, [{ kind: "externref" }, { kind: "externref" }]);
      const entryElemKind = `ref_${entryTupleTypeIdx}`;
      outerVecTypeIdx = getOrRegisterVecType(ctx, entryElemKind, { kind: "ref", typeIdx: entryTupleTypeIdx });
      outerArrTypeIdx = getArrTypeIdxFromVec(ctx, outerVecTypeIdx);
    }

    if (outerArrTypeIdx < 0) {
      ctx.errors.push({
        message: `Object.entries(): cannot resolve outer array type`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    // Get the tuple struct fields to know the value type
    const tupleTypeDef = ctx.mod.types[entryTupleTypeIdx];
    const tupleFields = tupleTypeDef && tupleTypeDef.kind === "struct" ? (tupleTypeDef as any).fields : undefined;
    // Field 0 is the key (string), field 1 is the value
    const valueFieldType: ValType | undefined = tupleFields?.[1]?.type;

    // Ensure union boxing imports are registered (needed for boxing primitives)
    addUnionImports(ctx);

    // For each field, create a tuple struct [key, value]
    for (const entry of userFields) {
      // Push key string (field 0 of tuple)
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        compileNativeStringLiteral(ctx, fctx, entry.field.name);
        // If tuple expects externref for the key, convert
        if (tupleFields && tupleFields[0]?.type?.kind === "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
      } else {
        const globalIdx = ctx.stringGlobalMap.get(entry.field.name);
        if (globalIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: globalIdx });
        } else {
          const importName = ctx.stringLiteralMap.get(entry.field.name);
          if (importName) {
            const funcIdx = ctx.funcMap.get(importName);
            if (funcIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx });
            }
          }
        }
      }

      // Push value (field 1 of tuple)
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });

      // Coerce the struct field value to match the tuple's value field type
      const fieldKind = entry.field.type.kind;
      const targetKind = valueFieldType?.kind ?? "externref";

      if (targetKind === "externref") {
        // Box primitives to externref
        if (fieldKind === "f64") {
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        } else if (fieldKind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        } else if (fieldKind === "ref" || fieldKind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        }
      }
      // If target is f64 and field is f64, no conversion needed
      // If target is i32 and field is i32, no conversion needed

      // Create tuple struct
      fctx.body.push({ op: "struct.new", typeIdx: entryTupleTypeIdx });
    }

    // Create outer array from the entry tuples on the stack
    const count = userFields.length;
    fctx.body.push({ op: "array.new_fixed", typeIdx: outerArrTypeIdx, length: count });
    const outerData = allocLocal(fctx, `__obj_entries_data_${fctx.locals.length}`, { kind: "ref", typeIdx: outerArrTypeIdx });
    fctx.body.push({ op: "local.set", index: outerData });
    fctx.body.push({ op: "i32.const", value: count });
    fctx.body.push({ op: "local.get", index: outerData });
    fctx.body.push({ op: "struct.new", typeIdx: outerVecTypeIdx });
    return { kind: "ref_null", typeIdx: outerVecTypeIdx };
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
    } else if (entry.field.type.kind === "ref" || entry.field.type.kind === "ref_null") {
      // Convert GC ref types (nested structs, etc.) to externref
      fctx.body.push({ op: "extern.convert_any" });
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

// ── String operations (extracted to ./string-ops.ts) ──────────────────
export { compileStringLiteral, compileNativeStringLiteral, compileTemplateExpression, compileTaggedTemplateExpression, emitBoolToString, compileStringBinaryOp, compileNativeStringMethodCall } from "./string-ops.js";
import { compileStringLiteral, compileNativeStringLiteral, compileTemplateExpression, compileTaggedTemplateExpression, emitBoolToString, compileStringBinaryOp, compileNativeStringMethodCall } from "./string-ops.js";
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

/** Check if an expression is statically known to be NaN at compile time */
/**
 * Try to statically determine the numeric value of an expression.
 * Handles: numeric literals, NaN, Infinity, -Infinity, object-with-valueOf, {}.
 * Returns undefined if the value cannot be determined at compile time.
 */
export function tryStaticToNumber(ctx: CodegenContext, expr: ts.Expression): number | undefined {
  // Numeric literal
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  // String literal → ToNumber: "" → 0, "123" → 123, "abc" → NaN
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return Number(expr.text);
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
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = tryStaticToNumber(ctx, expr.operand);
    if (inner !== undefined) return -inner;
  }
  // Binary expressions: fold constant operands at compile time
  if (ts.isBinaryExpression(expr)) {
    // Don't fold string + anything as numeric — JS semantics requires string concat
    if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        (ts.isStringLiteral(expr.left) || ts.isNoSubstitutionTemplateLiteral(expr.left) ||
         ts.isStringLiteral(expr.right) || ts.isNoSubstitutionTemplateLiteral(expr.right))) {
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
          if (isStringType(leftTsType) || isStringType(rightTsType)) return undefined;
          return left + right;
        }
        case ts.SyntaxKind.MinusToken: return left - right;
        case ts.SyntaxKind.AsteriskToken: return left * right;
        case ts.SyntaxKind.SlashToken: return right !== 0 ? left / right : undefined;
        case ts.SyntaxKind.PercentToken: return right !== 0 ? left % right : undefined;
        case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
        case ts.SyntaxKind.AmpersandToken: return left & right;
        case ts.SyntaxKind.BarToken: return left | right;
        case ts.SyntaxKind.CaretToken: return left ^ right;
        case ts.SyntaxKind.LessThanLessThanToken: return left << right;
        case ts.SyntaxKind.GreaterThanGreaterThanToken: return left >> right;
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return left >>> right;
        default: break; // non-numeric binary op, fall through
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
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          return init.text.length;
        }
      }
    }
  }
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
  // Parenthesized expression: unwrap parentheses
  if (ts.isParenthesizedExpression(expr)) {
    return tryStaticToNumber(ctx, expr.expression);
  }
  // Unary + (ToNumber coercion): +expr
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.PlusToken) {
    return tryStaticToNumber(ctx, expr.operand);
  }
  // Variable: trace to initializer (only for const declarations to avoid
  // incorrectly folding mutable variables like `let heapSize = 0`)
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const declList = decl.parent;
      if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
        return tryStaticToNumber(ctx, decl.initializer);
      }
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

export function isStaticNaN(ctx: CodegenContext, expr: ts.Expression): boolean {
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

/**
 * Compile obj.hasOwnProperty(key) / obj.propertyIsEnumerable(key).
 * For WasmGC structs all own fields are enumerable, so both methods behave
 * identically: return true iff `key` names an own field of the struct type.
 *
 * Static resolution (string literal arg): constant fold to i32.const 0/1.
 * Dynamic resolution: runtime string comparison against known field names.
 */
export function compilePropertyIntrospection(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  expr: ts.CallExpression,
): InnerResult {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const receiverWasm = resolveWasmType(ctx, receiverType);

  // Build a set of private member names (without '#') from the TS type.
  // Private fields (#x) are stored in the struct with the '#' stripped, but
  // should never be reported as own properties via hasOwnProperty("x").
  const privateNames = new Set<string>();
  for (const prop of receiverType.getProperties()) {
    if (prop.name.startsWith("#")) {
      privateNames.add(prop.name.slice(1));
    }
  }

  // Collect struct field names from the Wasm struct definition, excluding:
  // - Internal fields (e.g. __tag) that are compiler-generated
  // - Fields that correspond to private members (#-prefixed in TS source)
  let structFieldNames: string[] | null = null;
  if (receiverWasm.kind === "ref" || receiverWasm.kind === "ref_null") {
    const structDef = ctx.mod.types[(receiverWasm as { typeIdx: number }).typeIdx];
    if (structDef?.kind === "struct") {
      structFieldNames = structDef.fields
        .map(f => f.name)
        .filter((n): n is string =>
          n !== undefined &&
          !n.startsWith("__") &&
          !privateNames.has(n)
        );
    }
  }

  // Collect own data properties from the TypeScript type system.
  // In ES spec, hasOwnProperty returns true only for own properties — class
  // methods live on the prototype and private members (starting with #) are
  // never accessible via string property names.  Filter both out.
  const tsProps = new Set<string>();
  for (const prop of receiverType.getProperties()) {
    // Skip private identifiers — they start with '#' and can't be matched by string keys
    if (prop.name.startsWith("#")) continue;

    // Skip methods — they live on the prototype, not on the instance.
    // A TS symbol whose declaration is a MethodDeclaration is a prototype method.
    const decls = prop.getDeclarations();
    if (decls && decls.length > 0 && decls.every(d => ts.isMethodDeclaration(d) || ts.isMethodSignature(d))) {
      continue;
    }

    tsProps.add(prop.name);
  }

  // Get the first argument (the property name to check)
  const arg = expr.arguments[0];
  if (!arg) {
    // No argument — hasOwnProperty() with no args returns false in JS
    // Compile receiver for side effects
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType && recvType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Try to resolve the key at compile time
  let staticKey: string | null = null;
  if (ts.isStringLiteral(arg)) {
    staticKey = arg.text;
  } else if (ts.isNumericLiteral(arg)) {
    staticKey = arg.text;
  } else {
    // Check if TS can resolve the type to a string literal
    const argType = ctx.checker.getTypeAtLocation(arg);
    if (argType.isStringLiteral()) {
      staticKey = argType.value;
    }
  }

  if (staticKey !== null) {
    // Static resolution: check if the key is a known own property
    const hasInStruct = structFieldNames !== null && structFieldNames.includes(staticKey);
    const hasInTs = tsProps.has(staticKey);
    const has = hasInStruct || hasInTs;

    // Compile receiver and argument for side effects, then drop
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType && recvType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    const argType = compileExpression(ctx, fctx, arg);
    if (argType && argType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
    return { kind: "i32" };
  }

  // Dynamic key: runtime string comparison against known field names
  const allFieldNames = new Set<string>();
  if (structFieldNames) {
    for (const f of structFieldNames) allFieldNames.add(f);
  }
  for (const p of tsProps) allFieldNames.add(p);

  if (allFieldNames.size > 0) {
    // Compile receiver for side effects, drop it
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType && recvType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }

    // Compile the key argument
    const keyType = compileExpression(ctx, fctx, arg);
    if (keyType) {
      const equalsIdx = ctx.funcMap.get("__str_eq") ?? ctx.funcMap.get("string_equals");
      const jsStrEquals = ctx.mod.imports.findIndex(
        imp => imp.module === "wasm:js-string" && imp.name === "equals"
      );
      const eqFunc = jsStrEquals >= 0 ? jsStrEquals : equalsIdx;
      if (eqFunc !== undefined && eqFunc >= 0) {
        const keyLocal = allocLocal(fctx, `__hop_key_${fctx.locals.length}`, keyType);
        fctx.body.push({ op: "local.set", index: keyLocal });
        // Start with false (0)
        fctx.body.push({ op: "i32.const", value: 0 });
        for (const fieldName of allFieldNames) {
          fctx.body.push({ op: "local.get", index: keyLocal });
          const strGlobal = ctx.stringGlobalMap.get(fieldName);
          if (strGlobal !== undefined) {
            fctx.body.push({ op: "global.get", index: strGlobal });
            fctx.body.push({ op: "call", funcIdx: eqFunc });
            fctx.body.push({ op: "i32.or" });
          }
        }
        return { kind: "i32" };
      }
    }
  }

  // Fallback: compile both sides for side effects, return false
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType !== VOID_RESULT) {
    fctx.body.push({ op: "drop" });
  }
  const argType = compileExpression(ctx, fctx, arg);
  if (argType && argType !== VOID_RESULT) {
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "i32.const", value: 0 });
  return { kind: "i32" };
}

export function getLine(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    return line + 1;
  } catch {
    return 0;
  }
}

export function getCol(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { character } = sf.getLineAndCharacterOfPosition(node.getStart());
    return character + 1;
  } catch {
    return 0;
  }
}
