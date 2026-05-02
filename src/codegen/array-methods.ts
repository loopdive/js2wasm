// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Array method compilation — extracted from expressions.ts.
 *
 * All array prototype and functional method implementations live here.
 * This module imports compileExpression and compileArrowAsClosure from
 * shared.ts (NOT expressions.ts) to avoid circular dependencies.
 */
import ts from "typescript";
import { isStringType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { reportError } from "./context/errors.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { addArrayIteratorImports, addStringImports, resolveWasmType } from "./index.js";
import { addStringConstantGlobal, ensureExnTag, localGlobalIdx } from "./registry/imports.js";
import { getArrTypeIdxFromVec, getOrRegisterArrayType, getOrRegisterVecType } from "./registry/types.js";
import {
  compileArrowAsClosure,
  compileExpression,
  ensureLateImport,
  flushLateImportShifts,
  registerEmitBoundsCheckedArrayGet,
  VOID_RESULT,
} from "./shared.js";
import { ensureTimsortHelper } from "./timsort.js";
import { coerceType, coercionInstrs, defaultValueInstrs } from "./type-coercion.js";

type ArrayMethodAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** Emit throw with a string message (local version to avoid circular dep on expressions.ts) */
function emitThrowString(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  addStringConstantGlobal(ctx, message);
  const strIdx = ctx.stringGlobalMap.get(message)!;
  fctx.body.push({ op: "global.get", index: strIdx } as Instr);
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}

function throwStringInstrs(ctx: CodegenContext, message: string): Instr[] {
  addStringConstantGlobal(ctx, message);
  const strIdx = ctx.stringGlobalMap.get(message)!;
  const tagIdx = ensureExnTag(ctx);
  return [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr];
}

/**
 * Check if a callback argument is known to be non-callable at compile time.
 * Returns true if the argument is null, undefined, a number, string, or boolean literal.
 */
function isKnownNonCallable(ctx: CodegenContext, arg: ts.Expression): boolean {
  if (arg.kind === ts.SyntaxKind.NullKeyword) return true;
  if (arg.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (arg.kind === ts.SyntaxKind.TrueKeyword || arg.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isNumericLiteral(arg)) return true;
  if (ts.isStringLiteral(arg)) return true;
  if (ts.isIdentifier(arg) && arg.text === "undefined") return true;
  // Check TS type flags for known non-function types
  const tsType = ctx.checker.getTypeAtLocation(arg);
  const NON_CALLABLE_FLAGS =
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.StringLike |
    ts.TypeFlags.BigIntLike;
  if (tsType.flags & NON_CALLABLE_FLAGS) return true;
  return false;
}

/**
 * Emit TypeError for missing or non-callable callback argument.
 * Called by array callback methods (every, some, forEach, filter, map, reduce).
 * Returns true if a throw was emitted (caller should return early).
 */
function emitCallbackTypeCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
): boolean {
  // No callback argument → always throw
  if (callExpr.arguments.length < 1) {
    emitThrowString(ctx, fctx, `TypeError: ${methodName} callback is not a function`);
    return true;
  }
  // Known non-callable literal → compile arg for side effects, then throw
  const cbArg = callExpr.arguments[0]!;
  if (isKnownNonCallable(ctx, cbArg)) {
    const cbType = compileExpression(ctx, fctx, cbArg);
    if (cbType) fctx.body.push({ op: "drop" });
    emitThrowString(ctx, fctx, `TypeError: ${methodName} callback is not a function`);
    return true;
  }
  return false;
}

// ── Guarded funcref cast (ref.test before ref.cast to avoid illegal cast traps) ──
function guardedFuncRefCastInstrs(fctx: FunctionContext, funcTypeIdx: number): Instr[] {
  const tmpFunc = allocLocal(fctx, `__gfc_${fctx.locals.length}`, { kind: "funcref" } as ValType);
  return [
    { op: "local.tee", index: tmpFunc } as unknown as Instr,
    { op: "ref.test", typeIdx: funcTypeIdx } as unknown as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: funcTypeIdx } as ValType },
      then: [
        { op: "local.get", index: tmpFunc } as unknown as Instr,
        { op: "ref.cast_null", typeIdx: funcTypeIdx } as unknown as Instr,
      ],
      else: [{ op: "ref.null", typeIdx: funcTypeIdx } as unknown as Instr],
    } as Instr,
  ];
}

// ── Null guard for array method receivers ─────────────────────────────

/**
 * Emit a null check on the vec ref that was just tee'd into `localIdx`.
 * If null, throws TypeError via the exception tag instead of letting
 * struct.get trap with an unrecoverable Wasm trap.
 *
 * Stack: [ref_null] -> [ref_null]  (value is still on stack, unchanged)
 * The local already holds the value via local.tee before this call.
 */
function emitReceiverNullGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  localIdx: number,
  receiverExpr?: ts.Expression,
): void {
  // Skip null guard if receiver is provably non-null (e.g. const initialized from array literal)
  if (receiverExpr && isReceiverNonNull(receiverExpr, ctx.checker)) return;
  // Check if the value in the local is null
  fctx.body.push({ op: "local.get", index: localIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: throwStringInstrs(ctx, "TypeError: Array method called on null or undefined"),
    else: [],
  });
}

/** Check if an expression is provably non-null (e.g. const initialized from array literal). */
function isReceiverNonNull(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  let inner: ts.Expression = expr;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  switch (inner.kind) {
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
      return true;
    default:
      break;
  }
  if (ts.isIdentifier(inner)) {
    const sym = checker.getSymbolAtLocation(inner);
    if (sym) {
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const declList = decl.parent;
        if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
          return isReceiverNonNull(decl.initializer, checker);
        }
      }
    }
  }
  return false;
}

// ── Bounds-checked array access ───────────────────────────────────────

/**
 * Emit a bounds-checked array.get.  Stack must contain [arrayref, i32 index].
 * If the index is out of bounds (< 0 or >= array.len), a default value for the
 * element type is produced instead of trapping.
 */
export function emitBoundsCheckedArrayGet(fctx: FunctionContext, arrTypeIdx: number, elementType: ValType): void {
  // Save index and array ref to locals so we can use them in both branches
  const idxLocal = allocLocal(fctx, `__bounds_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__bounds_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });

  fctx.body.push({ op: "local.set", index: idxLocal }); // save index
  fctx.body.push({ op: "local.set", index: arrLocal }); // save array ref

  // Condition: idx >= 0 && idx < array.len(arr)
  // We use: (unsigned)idx < array.len — this handles negative indices too
  // since negative i32 interpreted as unsigned is > any valid length
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" } as Instr);

  // Build the "then" branch: in-bounds -> array.get
  const thenInstrs: Instr[] = [
    { op: "local.get", index: arrLocal } as Instr,
    { op: "local.get", index: idxLocal } as Instr,
    { op: "array.get", typeIdx: arrTypeIdx } as Instr,
  ];

  // Build the "else" branch: out-of-bounds -> default value
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
export function emitClampIndex(fctx: FunctionContext, idxLocal: number, lenLocal: number): void {
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
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: idxLocal } as Instr],
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
    then: [{ op: "local.get", index: lenLocal } as Instr, { op: "local.set", index: idxLocal } as Instr],
  } as Instr);
}

/**
 * Clamp a value to be >= 0.  local is updated in-place.
 */
export function emitClampNonNeg(fctx: FunctionContext, local: number): void {
  fctx.body.push({ op: "local.get", index: local });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: local } as Instr],
  } as Instr);
}

// ── Array method calls (pure Wasm, no host imports) ─────────────────

/** Resolve array type info from a TS type. Returns null if not a Wasm GC vec struct. */
export function resolveArrayInfo(
  ctx: CodegenContext,
  tsType: ts.Type,
): { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | null {
  // In fast mode, strings are NativeString structs that look like arrays
  // (struct { len: i32, data: ref array }). Reject them here so string
  // methods are dispatched via compileNativeStringMethodCall instead.
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && isStringType(tsType)) return null;
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
function getReceiverLocalIdx(fctx: FunctionContext, expr: ts.Expression): number | null {
  if (ts.isIdentifier(expr)) {
    const idx = fctx.localMap.get(expr.text);
    return idx !== undefined ? idx : null;
  }
  return null;
}

/** Methods supported by the array-like (externref receiver) path.
 * NOTE: map/filter/reduce/reduceRight are excluded because:
 * - map/filter: `length: "Infinity"` → Infinity → 2B iterations → compile_timeout
 * - reduce/reduceRight: different callback signature (acc, elem, i, arr) — handled by __proto_method_call
 */
const ARRAY_LIKE_METHOD_SET = new Set([
  "every",
  "some",
  "forEach",
  "find",
  "findIndex",
  "filter",
  "map",
  "reduce",
  "reduceRight",
]);

/**
 * Compile Array.prototype.METHOD.call(anyReceiver, callback, ...args) for any-typed receivers.
 * Uses __extern_length + __extern_get_idx to iterate and call_ref for Wasm closure callbacks.
 * Only handles callbacks that compile to Wasm closures (arrow functions, function declarations).
 * Returns undefined if the pattern is not handled (caller should fall through).
 */
export function compileArrayLikePrototypeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
  receiverArg: ts.Expression,
): ValType | null | typeof VOID_RESULT | undefined {
  if (!ARRAY_LIKE_METHOD_SET.has(methodName)) return undefined;

  // For null/undefined receivers, let __proto_method_call throw TypeError (spec-correct behavior).
  // We cannot detect this at runtime in the Wasm loop, so bail out early.
  const isNullReceiver =
    receiverArg.kind === ts.SyntaxKind.NullKeyword ||
    receiverArg.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(receiverArg) && receiverArg.text === "undefined");
  if (isNullReceiver) return undefined;

  // Bail out on primitive literal receivers (boolean, number, string). Our `extern.convert_any`
  // coercion only works on ref/anyref values; a primitive compiled to i32/f64 would produce
  // invalid Wasm. The legacy __proto_method_call path handles ToObject(primitive) correctly.
  if (
    receiverArg.kind === ts.SyntaxKind.TrueKeyword ||
    receiverArg.kind === ts.SyntaxKind.FalseKeyword ||
    receiverArg.kind === ts.SyntaxKind.NumericLiteral ||
    receiverArg.kind === ts.SyntaxKind.StringLiteral ||
    receiverArg.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return undefined;
  }

  // Bail out only for real Array vectors (`__vec_*`) and the raw array element
  // types (`__arr_*`). Those structs are opaque to `__sget_*` getters (excluded
  // in `emitStructFieldGetters`), so `__extern_length` / `__extern_get_idx`
  // would see length 0 / undefined. Real arrays take the dedicated
  // `compileArrayMethodCall` path via the caller's `resolveArrayInfo` branch.
  //
  // Other struct receivers (instance classes, anonymous object types like
  // `{0:..,1:..,length:..}`) have per-field `__sget_*` getters emitted, so
  // `__extern_length`/`__extern_get_idx` read them correctly (#983, #1090).
  // Those must be allowed through — the prior blanket bailout routed them
  // to `__proto_method_call`, which passes the callback as a `__fn_wrap`
  // externref that the host cannot invoke (regression from PR #195, #1152).
  {
    const recvTsType = ctx.checker.getTypeAtLocation(receiverArg);
    if (recvTsType) {
      const recvWasmType = resolveWasmType(ctx, recvTsType);
      if (recvWasmType.kind === "ref" || recvWasmType.kind === "ref_null") {
        const typeIdx = (recvWasmType as { typeIdx: number }).typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        const typeName = typeDef && "name" in typeDef ? (typeDef as { name?: string }).name : undefined;
        if (typeName && (typeName.startsWith("__vec_") || typeName.startsWith("__arr_"))) {
          return undefined;
        }
      }
    }
  }

  // Bail out if the call site is inside `assert_throws(...)` (test262 rewrites `assert.throws`
  // to this helper). The Wasm-native loop calls __extern_length / __extern_get_idx directly
  // and does not currently propagate host-side JS exceptions to the surrounding try/catch,
  // so any test that expects a throw from the length/index getter or the callback would
  // silently pass where it should trap. The legacy __proto_method_call bridge handles
  // exception propagation, so let it own those cases.
  {
    let p: ts.Node | undefined = callExpr.parent;
    while (p) {
      if (
        ts.isCallExpression(p) &&
        ts.isIdentifier(p.expression) &&
        (p.expression.text === "assert_throws" || p.expression.text === "assert_throwsAsync")
      ) {
        return undefined;
      }
      p = p.parent;
    }
  }

  // every/some/forEach/find/findIndex: callback is args[1]
  if (callExpr.arguments.length < 2) return undefined;
  const cbArg = callExpr.arguments[1]!;

  // Only handle callbacks that produce Wasm closures.
  // If the callback is a real JS function (externref), __proto_method_call handles it correctly.
  const willBeClosure =
    ts.isArrowFunction(cbArg) ||
    ts.isFunctionExpression(cbArg) ||
    (ts.isIdentifier(cbArg) && (ctx.funcMap.has(cbArg.text) || ctx.closureMap.has(cbArg.text)));
  if (!willBeClosure) return undefined;

  // Ensure host imports
  const lenFn = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  const getIdxFn = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  const hasIdxFn = ensureLateImport(
    ctx,
    "__extern_has_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "i32" }],
  );
  // __is_truthy for JS-correct truthiness when callback returns externref
  // (boxed boolean false is non-null, so ref.is_null alone is wrong).
  const isTruthyFn = ensureLateImport(ctx, "__is_truthy", [{ kind: "externref" }], [{ kind: "i32" }]);
  if (lenFn === undefined || getIdxFn === undefined || hasIdxFn === undefined || isTruthyFn === undefined)
    return undefined;
  flushLateImportShifts(ctx, fctx);

  // Compile receiver to externref
  const receiverTmp = allocLocal(fctx, `__ali_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, receiverArg, { kind: "externref" });
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
  }
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "local.set", index: receiverTmp });

  // len = i32(f64(__extern_length(receiver)))
  const lenTmp = allocLocal(fctx, `__ali_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: receiverTmp });
  fctx.body.push({ op: "call", funcIdx: lenFn });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Compile callback to closure
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return undefined;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return undefined;

  const closureTmp = allocLocal(fctx, `__ali_cl_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  // i = 0
  const iTmp = allocLocal(fctx, `__ali_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  // elem local (externref)
  const elemTmp = allocLocal(fctx, `__ali_elem_${fctx.locals.length}`, { kind: "externref" });

  const numParams = closureInfo.paramTypes.length;

  /** Load receiver[i] into elemTmp */
  const loadElem: Instr[] = [
    { op: "local.get", index: receiverTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: "f64.convert_i32_s" } as unknown as Instr,
    { op: "call", funcIdx: getIdxFn } as Instr,
    { op: "local.set", index: elemTmp } as Instr,
  ];

  /** Callback invocation: closure(elem?, i?, receiver?) */
  const callClosure: Instr[] = [
    { op: "local.get", index: closureTmp } as Instr,
    // Only push elem if callback expects at least 1 param (0-param callback causes Wasm validation error)
    ...(numParams >= 1
      ? [
          { op: "local.get", index: elemTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
        ]
      : []),
    ...(numParams >= 2
      ? [
          { op: "local.get", index: iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    ...(numParams >= 3
      ? [
          { op: "local.get", index: receiverTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[2] ?? { kind: "externref" }, fctx),
        ]
      : []),
    { op: "local.get", index: closureTmp } as Instr,
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
  ];

  /** Convert callback result to i32 truthy flag */
  const toTruthy: Instr[] =
    closureInfo.returnType === null
      ? // void callback: call_ref leaves nothing on stack — just push truthy (1).
        // The callback never returns a meaningful value; void → always truthy so
        // every/find/some behave as if all elements match (correct for empty loops).
        [{ op: "i32.const", value: 1 } as Instr]
      : closureInfo.returnType.kind === "f64"
        ? // NaN is falsy in JS; f64.ne(0) treats NaN as truthy. Use |x|>0 instead.
          [{ op: "f64.abs" } as Instr, { op: "f64.const", value: 0 } as Instr, { op: "f64.gt" } as Instr]
        : closureInfo.returnType.kind === "i32"
          ? []
          : closureInfo.returnType.kind === "externref"
            ? // Boxed value: __is_truthy unwraps JS semantics (false/0/NaN/""/null → falsy).
              [{ op: "call", funcIdx: isTruthyFn } as Instr]
            : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
              ? // Non-externref struct/string refs: fall back to null check. JS truthiness on
                // these uncommon shapes is not observable here (callbacks usually return any).
                [{ op: "ref.is_null" } as Instr, { op: "i32.eqz" } as Instr]
              : [{ op: "drop" } as Instr, { op: "i32.const", value: 1 } as Instr];

  /** Increment i */
  const incrI: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  /** Loop exit condition: if i >= len, break */
  const exitIfDone: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
  ];

  /** Push `__extern_has_idx(receiver, i)` — spec HasProperty used to skip holes. */
  const hasIdxCheck: Instr[] = [
    { op: "local.get", index: receiverTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: "f64.convert_i32_s" } as unknown as Instr,
    { op: "call", funcIdx: hasIdxFn } as Instr,
  ];

  /**
   * Wrap the per-iteration body so it runs only when HasProperty(receiver, i).
   * Absent indices fall through to incrI. Any `br depth: N` inside `inner` that
   * targets a level OUTSIDE the new `if` must use depth+1 (the if adds one
   * nesting level).
   */
  const gatedBody = (inner: Instr[]): Instr[] => [
    ...hasIdxCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: inner,
    } as Instr,
  ];

  switch (methodName) {
    case "every": {
      const resTmp = allocLocal(fctx, `__ali_ev_res_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...toTruthy,
                { op: "i32.eqz" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 0 } as Instr,
                    { op: "local.set", index: resTmp } as Instr,
                    { op: "br", depth: 3 } as Instr,
                  ],
                } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "i32" };
    }

    case "some": {
      const resTmp = allocLocal(fctx, `__ali_sm_res_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 1 } as Instr,
                    { op: "local.set", index: resTmp } as Instr,
                    { op: "br", depth: 3 } as Instr,
                  ],
                } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "i32" };
    }

    case "forEach": {
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                // drop return value if any
                ...(closureInfo.returnType !== null ? [{ op: "drop" } as Instr] : []),
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      return VOID_RESULT;
    }

    case "find": {
      const resTmp = allocLocal(fctx, `__ali_fd_res_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: elemTmp } as Instr,
                    { op: "local.set", index: resTmp } as Instr,
                    { op: "br", depth: 3 } as Instr,
                  ],
                } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "externref" };
    }

    case "findIndex": {
      const resTmp = allocLocal(fctx, `__ali_fi_res_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "f64.const", value: -1 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: iTmp } as Instr,
                    { op: "f64.convert_i32_s" } as unknown as Instr,
                    { op: "local.set", index: resTmp } as Instr,
                    { op: "br", depth: 3 } as Instr,
                  ],
                } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "f64" };
    }

    case "filter": {
      const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      if (arrNewIdx === undefined || arrPushIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const resultTmp = allocLocal(fctx, `__ali_fl_res_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      fctx.body.push({ op: "local.set", index: resultTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: resultTmp } as Instr,
                    { op: "local.get", index: elemTmp } as Instr,
                    { op: "call", funcIdx: arrPushIdx } as Instr,
                  ],
                } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "externref" };
    }

    case "map": {
      const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      if (arrNewIdx === undefined || arrPushIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const resultTmp = allocLocal(fctx, `__ali_mp_res_${fctx.locals.length}`, { kind: "externref" });
      const mappedTmp = allocLocal(fctx, `__ali_mp_mapped_${fctx.locals.length}`, { kind: "externref" });
      // Convert map result to externref
      const mapBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (mapBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const mapReturnToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback leaves nothing on the stack; push null so local.set
            // has a value. Maps produced from void callbacks fill with undefined.
            [{ op: "ref.null.extern" } as Instr]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: mapBoxIdx } as Instr]
            : closureInfo.returnType.kind === "i32"
              ? [{ op: "f64.convert_i32_s" } as unknown as Instr, { op: "call", funcIdx: mapBoxIdx } as Instr]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" } as unknown as Instr]
                : []; // externref: already right type
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      fctx.body.push({ op: "local.set", index: resultTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...mapReturnToExternref,
                { op: "local.set", index: mappedTmp } as Instr,
                { op: "local.get", index: resultTmp } as Instr,
                { op: "local.get", index: mappedTmp } as Instr,
                { op: "call", funcIdx: arrPushIdx } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "externref" };
    }

    case "reduce": {
      // reduce(callback, initialValue?) — callback(acc, elem, i, receiver) -> acc
      // args: [receiver, callback, initialValue?]
      const accTmp = allocLocal(fctx, `__ali_rd_acc_${fctx.locals.length}`, { kind: "externref" });
      const hasInitial = callExpr.arguments.length >= 3;
      if (hasInitial) {
        const initType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "externref" });
        if (initType && initType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
        }
        if (initType === null) fctx.body.push({ op: "ref.null.extern" });
      } else {
        // No initial value: acc = receiver[0], start from i=1
        fctx.body.push({ op: "local.get", index: receiverTmp });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "call", funcIdx: getIdxFn });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "local.set", index: iTmp });
      }
      fctx.body.push({ op: "local.set", index: accTmp });

      // Reduce callback has 4 params: acc, elem, i, array
      // Build the reduce call instructions (similar to callClosure but with accTmp first).
      // Only push each argument if the closure declares that parameter — pushing an unused
      // local on the stack produces invalid Wasm because call_ref expects exactly numParams values.
      const reduceNumParams = closureInfo.paramTypes.length;
      const reduceCallClosure: Instr[] = [
        { op: "local.get", index: closureTmp } as Instr,
        ...(reduceNumParams >= 1
          ? [
              { op: "local.get", index: accTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
            ]
          : []),
        ...(reduceNumParams >= 2
          ? [
              { op: "local.get", index: elemTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? { kind: "externref" }, fctx),
            ]
          : []),
        ...(reduceNumParams >= 3
          ? [
              { op: "local.get", index: iTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[2] ?? { kind: "i32" }, fctx),
            ]
          : []),
        ...(reduceNumParams >= 4
          ? [
              { op: "local.get", index: receiverTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[3] ?? { kind: "externref" }, fctx),
            ]
          : []),
        { op: "local.get", index: closureTmp } as Instr,
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
        ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
        { op: "ref.as_non_null" } as Instr,
        { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
      ];

      // Convert reduce result to externref for accumulator
      const rdBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (rdBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const reduceResultToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback leaves nothing on the stack; push null so local.set
            // has a value. Subsequent iterations pass undefined as acc.
            [{ op: "ref.null.extern" } as Instr]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: rdBoxIdx } as Instr]
            : closureInfo.returnType.kind === "i32"
              ? [{ op: "f64.convert_i32_s" } as unknown as Instr, { op: "call", funcIdx: rdBoxIdx } as Instr]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" } as unknown as Instr]
                : []; // externref: already right type

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...reduceCallClosure,
                ...reduceResultToExternref,
                { op: "local.set", index: accTmp } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: accTmp });
      return { kind: "externref" };
    }

    case "reduceRight": {
      // Similar to reduce but from len-1 down to 0
      const accTmp = allocLocal(fctx, `__ali_rr_acc_${fctx.locals.length}`, { kind: "externref" });
      const hasInitial = callExpr.arguments.length >= 3;

      // Set i to last index
      fctx.body.push({ op: "local.get", index: lenTmp });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.sub" });
      fctx.body.push({ op: "local.set", index: iTmp });

      if (hasInitial) {
        const initType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "externref" });
        if (initType && initType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
        }
        if (initType === null) fctx.body.push({ op: "ref.null.extern" });
      } else {
        // No initial: acc = receiver[len-1], start from i = len-2
        fctx.body.push({ op: "local.get", index: receiverTmp });
        fctx.body.push({ op: "local.get", index: iTmp });
        fctx.body.push({ op: "f64.convert_i32_s" } as unknown as Instr);
        fctx.body.push({ op: "call", funcIdx: getIdxFn });
        fctx.body.push({ op: "local.get", index: iTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.sub" });
        fctx.body.push({ op: "local.set", index: iTmp });
      }
      fctx.body.push({ op: "local.set", index: accTmp });

      const rrNumParams = closureInfo.paramTypes.length;
      const rrCallClosure: Instr[] = [
        { op: "local.get", index: closureTmp } as Instr,
        ...(rrNumParams >= 1
          ? [
              { op: "local.get", index: accTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
            ]
          : []),
        ...(rrNumParams >= 2
          ? [
              { op: "local.get", index: elemTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? { kind: "externref" }, fctx),
            ]
          : []),
        ...(rrNumParams >= 3
          ? [
              { op: "local.get", index: iTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[2] ?? { kind: "i32" }, fctx),
            ]
          : []),
        ...(rrNumParams >= 4
          ? [
              { op: "local.get", index: receiverTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[3] ?? { kind: "externref" }, fctx),
            ]
          : []),
        { op: "local.get", index: closureTmp } as Instr,
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
        ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
        { op: "ref.as_non_null" } as Instr,
        { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
      ];

      const rrBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (rrBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const rrResultToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback — see note in reduce case.
            [{ op: "ref.null.extern" } as Instr]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: rrBoxIdx } as Instr]
            : closureInfo.returnType.kind === "i32"
              ? [{ op: "f64.convert_i32_s" } as unknown as Instr, { op: "call", funcIdx: rrBoxIdx } as Instr]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" } as unknown as Instr]
                : [];

      // Loop: while i >= 0
      /** Exit when i < 0 */
      const exitIfNeg: Instr[] = [
        { op: "local.get", index: iTmp } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "i32.lt_s" } as Instr,
        { op: "br_if", depth: 1 } as Instr,
      ];
      const decrI: Instr[] = [
        { op: "local.get", index: iTmp } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "local.set", index: iTmp } as Instr,
        { op: "br", depth: 0 } as Instr,
      ];

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfNeg,
              ...gatedBody([
                ...loadElem,
                ...rrCallClosure,
                ...rrResultToExternref,
                { op: "local.set", index: accTmp } as Instr,
              ]),
              ...decrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: accTmp });
      return { kind: "externref" };
    }

    default:
      return undefined;
  }
}

/**
 * Detect and compile Array.prototype.METHOD.call(obj, ...args) patterns.
 * When `obj` is a shape-inferred array-like variable, we reuse the existing
 * array method compilers by treating `obj` as the receiver.
 *
 * Returns undefined if the pattern is not matched (caller should continue).
 * Returns ValType | null for successful/failed compilation.
 */
export function compileArrayPrototypeCall(
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

  // Check if the method is a known array method
  if (!ARRAY_METHODS.has(methodName)) return undefined;

  // Resolve array info from shape map or TypeScript type
  let receiverTsType: ts.Type | undefined;
  if (ts.isIdentifier(receiverArg)) {
    const shapeInfo = ctx.shapeMap.get(receiverArg.text);
    if (shapeInfo) {
      // Shape-inferred path: dispatch to existing dedicated implementations
      const { vecTypeIdx, arrTypeIdx, elemType } = shapeInfo;
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
        // For filter/map/reduce/reduceRight/find/findIndex there's no shape-specific fast
        // path yet; fall through to the generic array-like loop so array-like receivers
        // ({length, [idx]}, arguments) are iterated via [[Get]] + HasProperty (issue #1131).
      }
    }
    receiverTsType = ctx.checker.getTypeAtLocation(receiverArg);
  } else {
    receiverTsType = ctx.checker.getTypeAtLocation(receiverArg);
  }

  if (!receiverTsType) return undefined;
  const arrInfo = resolveArrayInfo(ctx, receiverTsType);
  if (!arrInfo) {
    // For any-typed receivers, use the array-like implementation that iterates
    // using __extern_length/__extern_get_idx and calls the callback directly in Wasm.
    return compileArrayLikePrototypeCall(ctx, fctx, callExpr, methodName, receiverArg as ts.Expression);
  }

  // Create a synthetic PropertyAccessExpression: receiverArg.METHOD
  const syntheticPropAccess = ts.factory.createPropertyAccessExpression(receiverArg as ts.Expression, methodName);
  // Copy parent for error reporting
  (syntheticPropAccess as any).parent = callExpr.parent;

  // Create a synthetic CallExpression with the remaining args (skip the receiver)
  const remainingArgs = callExpr.arguments.slice(1);
  const syntheticCall = ts.factory.createCallExpression(
    syntheticPropAccess,
    undefined,
    remainingArgs as unknown as readonly ts.Expression[],
  );
  (syntheticCall as any).parent = callExpr.parent;

  // Route through the existing array method compiler
  return compileArrayMethodCall(ctx, fctx, syntheticPropAccess, syntheticCall, receiverTsType);
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
    reportError(ctx, callExpr, "Array.prototype.indexOf.call requires at least 2 arguments");
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
  emitReceiverNullGuard(ctx, fctx, vecTmp);

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

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // For externref elements, use the `equals` string import (JS ===) for comparison
  // For ref/ref_null elements, use ref.eq for reference identity comparison
  let apcEqInstrs: Instr[];
  if (elemType.kind === "externref") {
    addStringImports(ctx);
    const equalsIdx = ctx.jsStringImports.get("equals")!;
    apcEqInstrs = [{ op: "call", funcIdx: equalsIdx } as Instr];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    apcEqInstrs = [{ op: "ref.eq" }];
  } else {
    const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
    apcEqInstrs = [{ op: eqOp } as Instr];
  }

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when indexOf is inlined.
  const resType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const resTmp = allocLocal(fctx, `__apc_iof_res_${fctx.locals.length}`, resType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    ...apcEqInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp } as Instr,
            { op: "local.set", index: resTmp } as Instr,
            { op: "br", depth: 2 } as Instr,
          ]
        : [
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "local.set", index: resTmp } as Instr,
            { op: "br", depth: 2 } as Instr,
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });

  if (ctx.fast) {
    return { kind: "i32" };
  }
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
    reportError(ctx, callExpr, "Array.prototype.includes.call requires at least 2 arguments");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__apc_inc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_inc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_inc_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_inc_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__apc_inc_val_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
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

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when includes is inlined.
  const resTmp = allocLocal(fctx, `__apc_inc_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resTmp });

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
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr, // break out of block
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
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
    reportError(ctx, callExpr, "Array.prototype.every.call requires at least 2 arguments");
    return null;
  }

  const cbArg = callExpr.arguments[1]!;

  // The callback must be an arrow function or function expression for inline compilation
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) {
    return undefined as unknown as null;
  }

  // Compile the callback as a closure and get its info
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
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
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";
  const numParams = closureInfo.paramTypes.length;

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when every is inlined.
  const resTmp = allocLocal(fctx, `__apc_ev_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 1 }); // default: all passed
  fctx.body.push({ op: "local.set", index: resTmp });

  // Loop: for each element, call the closure; if it returns falsy, set result to 0
  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 }, // break out of block

    // Call closure(element, index, array): push closure ref, then args.
    // Gate elem/index/array on numParams — 0-param callback must not receive them.
    { op: "local.get", index: closureTmp },
    ...(numParams >= 1
      ? [
          { op: "local.get", index: dataTmp } as Instr,
          { op: "local.get", index: iTmp } as Instr,
          { op: getOp, typeIdx: arrTypeIdx } as Instr,
          ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0] ?? elemType, fctx),
        ]
      : []),
    // Push index (2nd user param) if callback expects it
    ...(numParams >= 2
      ? [
          { op: "local.get", index: iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    // Push array (3rd user param) if callback expects it
    ...(numParams >= 3
      ? [
          { op: "local.get", index: vecTmp } as Instr,
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ]
      : []),
    // Get function ref from closure struct field 0 and call_ref
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,

    // Check if result is falsy (0 for i32, 0.0 for f64)
    ...(closureInfo.returnType?.kind === "f64"
      ? [{ op: "f64.const", value: 0 } as Instr, { op: "f64.eq" } as Instr]
      : closureInfo.returnType?.kind === "i32"
        ? [{ op: "i32.eqz" } as Instr]
        : [{ op: "i32.eqz" } as Instr]),

    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr, // break out of block
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
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

  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
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
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";
  const numParams = closureInfo.paramTypes.length;

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when some is inlined.
  const resTmp = allocLocal(fctx, `__apc_some_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 }); // default: none matched
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: closureTmp },
    ...(numParams >= 1
      ? [
          { op: "local.get", index: dataTmp } as Instr,
          { op: "local.get", index: iTmp } as Instr,
          { op: getOp, typeIdx: arrTypeIdx } as Instr,
          ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0] ?? elemType, fctx),
        ]
      : []),
    // Push index (2nd user param) if callback expects it
    ...(numParams >= 2
      ? [
          { op: "local.get", index: iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    // Push array (3rd user param) if callback expects it
    ...(numParams >= 3
      ? [
          { op: "local.get", index: vecTmp } as Instr,
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ]
      : []),
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
    ...(closureInfo.returnType?.kind === "f64"
      ? [{ op: "f64.const", value: 0 } as Instr, { op: "f64.ne" } as Instr]
      : []),
    ...(closureInfo.returnType?.kind === "i32" ? [] : [{ op: "i32.eqz" } as Instr, { op: "i32.eqz" } as Instr]),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr, // break out of block
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
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

  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
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
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const numParams = closureInfo.paramTypes.length;

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: closureTmp },
    ...(numParams >= 1
      ? [
          { op: "local.get", index: dataTmp } as Instr,
          { op: "local.get", index: iTmp } as Instr,
          { op: getOp, typeIdx: arrTypeIdx } as Instr,
          ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0] ?? elemType, fctx),
        ]
      : []),
    // Push index (2nd user param) if callback expects it
    ...(numParams >= 2
      ? [
          { op: "local.get", index: iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    // Push array (3rd user param) if callback expects it
    ...(numParams >= 3
      ? [
          { op: "local.get", index: vecTmp } as Instr,
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ]
      : []),
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  return VOID_RESULT as any;
}

const ARRAY_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "indexOf",
  "includes",
  "slice",
  "concat",
  "join",
  "reverse",
  "splice",
  "at",
  "fill",
  "copyWithin",
  "lastIndexOf",
  "sort",
  "filter",
  "map",
  "reduce",
  "reduceRight",
  "forEach",
  "find",
  "findIndex",
  "some",
  "every",
  "entries",
  "keys",
  "values",
  "@@iterator", // Array.prototype[Symbol.iterator] === Array.prototype.values (#854)
  "toReversed",
  "toSorted",
  "toSpliced",
  "with",
  "flat",
  "flatMap",
]);

/**
 * Compile array method calls to inline Wasm instructions.
 * Returns undefined if the call is not an array method (caller should continue).
 * Returns ValType for successful compilation, VOID_RESULT for void methods,
 * or null for failed compilation.
 */
export function compileArrayMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
  overrideMethodName?: string,
): ValType | null | undefined | typeof VOID_RESULT {
  const methodName =
    overrideMethodName ?? (ts.isPropertyAccessExpression(propAccess) ? propAccess.name.text : undefined);
  if (!methodName || !ARRAY_METHODS.has(methodName)) return undefined;

  const arrInfo = resolveArrayInfo(ctx, receiverType);
  if (!arrInfo) return undefined;

  let { vecTypeIdx, arrTypeIdx, elemType } = arrInfo;

  // The receiver's actual Wasm type may differ from the TS type — e.g.
  // `[0, true].lastIndexOf(...)` infers i32 elements during construction,
  // but resolveArrayInfo resolves (number|boolean)[] → __vec_externref.
  // Probe-compile the receiver to determine the actual Wasm type (#826).
  const receiverExpr = ts.isPropertyAccessExpression(propAccess) ? propAccess.expression : undefined;
  if (receiverExpr) {
    // Fast path: check the Wasm local/global type directly
    let actualType: ValType | undefined;
    if (ts.isIdentifier(receiverExpr)) {
      const name = receiverExpr.text;
      const localIdx = fctx.localMap.get(name);
      if (localIdx !== undefined) {
        // #1247: localIdx is the wasm-level index (params + locals);
        // `fctx.locals` indexes only locals (no params). Use getLocalType
        // to handle the offset correctly. Without this, in functions with
        // params, `paths.shift()` looks up the wrong local and dispatches
        // through a stale vec type idx, producing struct-type mismatches
        // at instantiation.
        actualType = getLocalType(fctx, localIdx);
      } else {
        const gIdx = ctx.moduleGlobals.get(name);
        if (gIdx !== undefined) {
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, gIdx)];
          actualType = globalDef?.type;
        }
      }
    }
    // Slow path: probe-compile the receiver to determine its actual type.
    // Compiles the expression, captures the result type, then rolls back.
    if (!actualType || actualType.kind === "externref" || actualType.kind === "f64" || actualType.kind === "i32") {
      const savedLen = fctx.body.length;
      const probeResult = compileExpression(ctx, fctx, receiverExpr);
      // Roll back — the method function will re-compile the receiver
      fctx.body.length = savedLen;
      if (
        probeResult &&
        (probeResult.kind === "ref" || probeResult.kind === "ref_null") &&
        (probeResult as any).typeIdx !== undefined
      ) {
        actualType = probeResult;
      }
    }
    if (
      actualType &&
      (actualType.kind === "ref" || actualType.kind === "ref_null") &&
      (actualType as { typeIdx: number }).typeIdx !== vecTypeIdx
    ) {
      const actualVecIdx = (actualType as { typeIdx: number }).typeIdx;
      const actualArrIdx = getArrTypeIdxFromVec(ctx, actualVecIdx);
      if (actualArrIdx >= 0) {
        const actualArrDef = ctx.mod.types[actualArrIdx];
        if (actualArrDef && actualArrDef.kind === "array") {
          vecTypeIdx = actualVecIdx;
          arrTypeIdx = actualArrIdx;
          elemType = actualArrDef.element;
        }
      }
    }
  }

  const methodAccess = propAccess as ts.PropertyAccessExpression;

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
      result = compileArrayIndexOf(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "includes":
      result = compileArrayIncludes(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "reverse":
      result = compileArrayReverse(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "push":
      result = compileArrayPush(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "pop":
      result = compileArrayPop(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "shift":
      result = compileArrayShift(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "slice":
      result = compileArraySlice(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "concat":
      result = compileArrayConcat(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "join":
      result = compileArrayJoin(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "splice":
      result = compileArraySplice(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "at":
      result = compileArrayAt(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "fill":
      result = compileArrayFill(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "copyWithin":
      result = compileArrayCopyWithin(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "lastIndexOf":
      result = compileArrayLastIndexOf(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "sort":
      result =
        elemType.kind === "f64" || elemType.kind === "i32"
          ? compileArraySort(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    // Functional array methods -- supported for numeric (f64, i32) and externref element types
    case "filter":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayFilter(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "map":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayMap(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "reduce":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayReduce(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "reduceRight":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayReduceRight(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "forEach": {
      const feResult =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayForEach(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      // forEach returns void; use VOID_RESULT so compileExpression doesn't rollback
      result = feResult === null ? (VOID_RESULT as any) : feResult;
      break;
    }
    case "find":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayFind(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "findIndex":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayFindIndex(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "some":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArraySome(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "every":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayEvery(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "toReversed":
      result = compileArrayToReversed(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "toSorted":
      result =
        elemType.kind === "f64" || elemType.kind === "i32"
          ? compileArrayToSorted(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "toSpliced":
      result = compileArrayToSpliced(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "with":
      result = compileArrayWith(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "entries":
    case "keys":
    case "values":
      result = compileArrayIteratorMethod(ctx, fctx, methodAccess, methodName);
      break;
    case "flat":
      result = compileArrayFlat(ctx, fctx, methodAccess, callExpr);
      break;
    case "flatMap":
      result = compileArrayFlatMap(ctx, fctx, methodAccess, callExpr);
      break;
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

// ── ES2023 non-mutating array methods (toReversed, toSorted, toSpliced, with) ──

/**
 * arr.toReversed() -> returns a new reversed copy of the array.
 * Non-mutating: creates a copy, reverses the copy, returns it.
 */
function compileArrayToReversed(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType {
  const vecTmp = allocLocal(fctx, `__arr_trev_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_trev_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_trev_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_trev_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_trev_i_${fctx.locals.length}`, { kind: "i32" });
  const jTmp = allocLocal(fctx, `__arr_trev_j_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // newData = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy src[0..len] -> newData[0..len]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, lenTmp);

  // Now reverse newData in-place: i = 0, j = len - 1
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: jTmp });

  const swapTmp = allocLocal(fctx, `__arr_trev_sw_${fctx.locals.length}`, elemType);
  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: jTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // swap = newData[i]
    { op: "local.get", index: newData },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: swapTmp },

    // newData[i] = newData[j]
    { op: "local.get", index: newData },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: newData },
    { op: "local.get", index: jTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "array.set", typeIdx: arrTypeIdx },

    // newData[j] = swap
    { op: "local.get", index: newData },
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  // Return new vec struct: { len, newData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.toSorted(compareFn?) -> returns a new sorted copy of the array.
 * Non-mutating: creates a copy, sorts the copy in-place via timsort, returns it.
 * Only supports i32/f64 element types (same as sort()).
 */
function compileArrayToSorted(
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

  const vecTmp = allocLocal(fctx, `__arr_tsrt_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_tsrt_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_tsrt_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_tsrt_len_${fctx.locals.length}`, { kind: "i32" });
  const newVec = allocLocal(fctx, `__arr_tsrt_nv_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // newData = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy src[0..len] -> newData[0..len]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, lenTmp);

  // Create new vec struct: { len, newData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.tee", index: newVec });

  // Sort the new vec in-place via timsort
  fctx.body.push({ op: "call", funcIdx: timsortIdx });

  // Return the new vec
  fctx.body.push({ op: "local.get", index: newVec });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.toSpliced(start, deleteCount, ...items) -> returns a new array with splice applied.
 * Non-mutating: builds a new array = [arr[0..start], ...items, arr[start+deleteCount..len]].
 */
function compileArrayToSpliced(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const vecTmp = allocLocal(fctx, `__arr_tspl_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_tspl_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_tspl_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_tspl_len_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_tspl_s_${fctx.locals.length}`, { kind: "i32" });
  const delCountTmp = allocLocal(fctx, `__arr_tspl_dc_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_tspl_nl_${fctx.locals.length}`, { kind: "i32" });
  const tailStartTmp = allocLocal(fctx, `__arr_tspl_ts_${fctx.locals.length}`, { kind: "i32" });
  const tailCountTmp = allocLocal(fctx, `__arr_tspl_tc_${fctx.locals.length}`, { kind: "i32" });
  const writeTmp = allocLocal(fctx, `__arr_tspl_w_${fctx.locals.length}`, { kind: "i32" });

  const insertCount = Math.max(0, callExpr.arguments.length - 2);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg -- clamp negative indices
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // deleteCount (default: len - start) -- clamp >= 0 and to remaining len
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.sub" });
  }
  fctx.body.push({ op: "local.set", index: delCountTmp });
  emitClampNonNeg(fctx, delCountTmp);
  // Clamp delCount to not exceed remaining elements: min(delCount, len - start)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp }); // reuse as temp
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "local.get", index: tailCountTmp });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "local.get", index: tailCountTmp } as Instr, { op: "local.set", index: delCountTmp } as Instr],
  } as Instr);
  emitClampNonNeg(fctx, delCountTmp);

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
  emitClampNonNeg(fctx, tailCountTmp);

  // newLen = start + insertCount + tailCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.const", value: insertCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.get", index: tailCountTmp });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: newLenTmp });

  // newData = array.new_default(newLen)
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy part 1: src[0..start] -> newData[0..start]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, startTmp);

  // Part 2: insert items at newData[start..start+insertCount]
  if (insertCount > 0) {
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "local.set", index: writeTmp });
    for (let i = 0; i < insertCount; i++) {
      fctx.body.push({ op: "local.get", index: newData });
      fctx.body.push({ op: "local.get", index: writeTmp });
      compileExpression(ctx, fctx, callExpr.arguments[2 + i]!, elemType);
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      if (i < insertCount - 1) {
        fctx.body.push({ op: "local.get", index: writeTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.add" });
        fctx.body.push({ op: "local.set", index: writeTmp });
      }
    }
  }

  // Part 3: copy tail: src[tailStart..tailStart+tailCount] -> newData[start+insertCount..end]
  // Compute destination offset = start + insertCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.const", value: insertCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: writeTmp });
  emitArrayCopy(fctx, arrTypeIdx, newData, writeTmp, dataTmp, tailStartTmp, tailCountTmp);

  // Return new vec struct: { newLen, newData }
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.with(index, value) -> returns a new array with the element at index replaced.
 * Non-mutating: creates a copy, sets element at index, returns it.
 */
function compileArrayWith(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "with() requires 2 arguments (index, value)");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_with_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_with_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_with_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_with_len_${fctx.locals.length}`, { kind: "i32" });
  const idxTmp = allocLocal(fctx, `__arr_with_idx_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile index arg, handle negative indices
  compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: idxTmp });
  emitClampIndex(fctx, idxTmp, lenTmp);

  // newData = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy src[0..len] -> newData[0..len]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, lenTmp);

  // Set newData[idx] = value
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "local.get", index: idxTmp });
  compileExpression(ctx, fctx, callExpr.arguments[1]!, elemType);
  fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });

  // Return new vec struct: { len, newData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Compile Array.prototype.entries/keys/values — delegates to host import
 * that creates a proper JS iterator over the WasmGC vec struct.
 */
function compileArrayIteratorMethod(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  methodName: string,
): ValType | null {
  addArrayIteratorImports(ctx);
  const importName = `__array_${methodName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) return null;

  // Compile receiver and convert to externref for the host import
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "extern.convert_any" });

  // Call the host import: (externref) → externref
  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

/** Helper: emit array.copy instruction.
 * Stack: [dstArr, dstOffset, srcArr, srcOffset, count] -> []
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
 * arr.at(index) -> supports negative indexing.
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
    reportError(ctx, callExpr, "at() requires 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_at_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const idxTmp = allocLocal(fctx, `__arr_at_idx_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_at_len_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Compile index argument
  const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "i32" });
  if (argType && argType.kind === "f64") {
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
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

  // Access element: data[idx] with bounds check
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.get", index: idxTmp });
  emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);

  return elemType;
}

/**
 * arr.indexOf(val) -> loop through array, return index (as f64) or -1.
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
    reportError(ctx, callExpr, "indexOf requires 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_iof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_iof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_iof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_iof_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_iof_val_${fctx.locals.length}`, elemType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length from vec struct field 0
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array from vec struct field 1
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // fromIndex (optional 2nd arg, default 0)
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    // Clamp negative fromIndex: if (fromIndex < 0) fromIndex = max(0, length + fromIndex)
    const fromTmp = allocLocal(fctx, `__arr_iof_from_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: fromTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp } as Instr,
        { op: "local.get", index: fromTmp } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.tee", index: fromTmp } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "i32.lt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: fromTmp } as Instr],
        } as Instr,
      ],
    } as Instr);
    fctx.body.push({ op: "local.get", index: fromTmp });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // For externref elements, use the `equals` string import (JS ===) for comparison
  // For ref/ref_null elements, use ref.eq for reference identity comparison
  let eqInstrs: Instr[];
  if (elemType.kind === "externref") {
    addStringImports(ctx);
    const equalsIdx = ctx.jsStringImports.get("equals")!;
    eqInstrs = [{ op: "call", funcIdx: equalsIdx } as Instr];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    eqInstrs = [{ op: "ref.eq" }];
  } else {
    const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
    eqInstrs = [{ op: eqOp } as Instr];
  }

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when indexOf is inlined.
  const resType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const resTmp = allocLocal(fctx, `__arr_iof_res_${fctx.locals.length}`, resType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    ...eqInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp } as Instr,
            { op: "local.set", index: resTmp } as Instr,
            { op: "br", depth: 2 } as Instr, // break out of block
          ]
        : [
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "local.set", index: resTmp } as Instr,
            { op: "br", depth: 2 } as Instr, // break out of block
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });

  if (ctx.fast) {
    return { kind: "i32" };
  }
  return { kind: "f64" };
}

/**
 * arr.includes(val) -> like indexOf but returns i32 (0 or 1)
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
    reportError(ctx, callExpr, "includes requires 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_inc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_inc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_inc_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_inc_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_inc_val_${fctx.locals.length}`, elemType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // fromIndex (optional 2nd arg, default 0)
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    // Clamp negative fromIndex: if (fromIndex < 0) fromIndex = max(0, length + fromIndex)
    const fromTmp = allocLocal(fctx, `__arr_inc_from_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: fromTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp } as Instr,
        { op: "local.get", index: fromTmp } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.tee", index: fromTmp } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "i32.lt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: fromTmp } as Instr],
        } as Instr,
      ],
    } as Instr);
    fctx.body.push({ op: "local.get", index: fromTmp });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // SameValueZero comparison for includes:
  // - For f64: a === b OR (isNaN(a) AND isNaN(b))
  // - For externref: use JS === via equals import
  // - For ref/ref_null: ref.eq
  // - For i32: i32.eq
  //
  // We build a comparison that leaves i32 (0/1) on the stack.
  // For f64, we need a temp local to hold the element for the NaN check.
  let incNeedsElemTmp = false;
  let incElemTmp: number | undefined;
  if (elemType.kind === "f64") {
    incNeedsElemTmp = true;
    incElemTmp = allocLocal(fctx, `__arr_inc_el_${fctx.locals.length}`, { kind: "f64" });
  }

  // Use a result local instead of `return` to avoid type mismatch with enclosing function
  const resTmp = allocLocal(fctx, `__arr_inc_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resTmp });

  // Build the comparison instructions for the loop body
  let comparisonInstrs: Instr[];
  if (elemType.kind === "f64") {
    // SameValueZero for f64: (elem == val) | (isNaN(elem) & isNaN(val))
    comparisonInstrs = [
      // Load element and save to temp
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      { op: "local.tee", index: incElemTmp! } as Instr,
      // elem == val
      { op: "local.get", index: valTmp } as Instr,
      { op: "f64.eq" } as Instr,
      // isNaN(elem) = elem != elem
      { op: "local.get", index: incElemTmp! } as Instr,
      { op: "local.get", index: incElemTmp! } as Instr,
      { op: "f64.ne" } as Instr,
      // isNaN(val) = val != val
      { op: "local.get", index: valTmp } as Instr,
      { op: "local.get", index: valTmp } as Instr,
      { op: "f64.ne" } as Instr,
      // isNaN(elem) & isNaN(val)
      { op: "i32.and" } as Instr,
      // (elem == val) | (both NaN)
      { op: "i32.or" } as Instr,
    ];
  } else if (elemType.kind === "externref") {
    addStringImports(ctx);
    const equalsIdx = ctx.jsStringImports.get("equals")!;
    comparisonInstrs = [
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      { op: "local.get", index: valTmp } as Instr,
      { op: "call", funcIdx: equalsIdx } as Instr,
    ];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    comparisonInstrs = [
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      { op: "local.get", index: valTmp } as Instr,
      { op: "ref.eq" } as Instr,
    ];
  } else {
    const eqOp = "i32.eq";
    comparisonInstrs = [
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      { op: "local.get", index: valTmp } as Instr,
      { op: eqOp } as Instr,
    ];
  }

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    ...comparisonInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr, // break out of block
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * arr.reverse() -> swap elements in place on the data array, return same vec ref.
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

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.push(val, ...) -> capacity-based amortized push supporting multiple arguments.
 * Mutates vec struct in-place: grows backing array if needed, sets elements, increments length.
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
  // 0-arg push: no-op, return current length
  if (callExpr.arguments.length === 0) {
    const vecTmp0 = allocLocal(fctx, `__arr_push_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.tee", index: vecTmp0 });
    emitReceiverNullGuard(ctx, fctx, vecTmp0, propAccess.expression);
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
    if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }

  const argCount = callExpr.arguments.length;
  const vecTmp = allocLocal(fctx, `__arr_push_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_push_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_push_len_${fctx.locals.length}`, { kind: "i32" });
  const newCapTmp = allocLocal(fctx, `__arr_push_ncap_${fctx.locals.length}`, { kind: "i32" });
  const newDataTmp = allocLocal(fctx, `__arr_push_ndata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp, propAccess.expression);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.tee", index: dataTmp });

  // Check: length + argCount > capacity?
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "i32.lt_s" });

  // if (capacity < length + argCount) -> grow
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // newCap = max((len + argCount) * 2, 4)
      { op: "local.get", index: lenTmp } as Instr,
      { op: "i32.const", value: argCount } as Instr,
      { op: "i32.add" } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.shl" } as Instr, // (len + argCount) * 2
      { op: "i32.const", value: 4 } as Instr,
      // select: if (len+argCount)*2 > 4 then (len+argCount)*2 else 4
      { op: "local.get", index: lenTmp } as Instr,
      { op: "i32.const", value: argCount } as Instr,
      { op: "i32.add" } as Instr,
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

  // Set elements: data[length + i] = args[i] for each argument (compile-time unrolled)
  for (let i = 0; i < argCount; i++) {
    fctx.body.push({ op: "local.get", index: dataTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    if (i > 0) {
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "i32.add" });
    }
    compileExpression(ctx, fctx, callExpr.arguments[i]!, elemType);
    fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
  }

  // Update length: vec.length = len + argCount
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // Return new length (i32 in fast mode, f64 otherwise)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.pop() -> O(1), decrement length and return last element.
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
  const lenTmp = allocLocal(fctx, `__arr_pop_len_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Guard: if length > 0, do pop; else result stays default (0/NaN/null)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });

  const thenInstrs: Instr[] = [
    // newLen = length - 1
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "local.set", index: newLenTmp } as Instr,
    // result = data[newLen]
    { op: "local.get", index: vecTmp } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.get", index: newLenTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: resultTmp } as Instr,
    // Decrement length: vec.length = newLen
    { op: "local.get", index: vecTmp } as Instr,
    { op: "local.get", index: newLenTmp } as Instr,
    { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
  ];

  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs } as Instr);

  // Return result (default value if empty, popped value if non-empty)
  fctx.body.push({ op: "local.get", index: resultTmp });
  return elemType;
}

/**
 * arr.shift() -> O(n) in-place: read data[0], shift data left, decrement length.
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

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Guard: if length > 0, do shift; else result stays default (0/NaN/null)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });

  const thenInstrs: Instr[] = [
    // result = data[0]
    { op: "local.get", index: dataTmp } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: resultTmp } as Instr,
    // newLen = len - 1
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "local.set", index: newLenTmp } as Instr,
    // Shift left: array.copy data[0..newLen] = data[1..len]
    { op: "local.get", index: dataTmp } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.get", index: dataTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "local.get", index: newLenTmp } as Instr,
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
    // Decrement length: vec.length = newLen
    { op: "local.get", index: vecTmp } as Instr,
    { op: "local.get", index: newLenTmp } as Instr,
    { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
  ];

  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs } as Instr);

  // Return result (default value if empty, shifted value if non-empty)
  fctx.body.push({ op: "local.get", index: resultTmp });
  return elemType;
}

/**
 * arr.slice(start?, end?) -> create new vec struct with sliced data.
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

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg -- clamp negative: if start < 0, start = max(0, len + start)
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // end arg -- clamp negative: if end < 0, end = max(0, len + end); clamp to len
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });
  emitClampIndex(fctx, endTmp, lenTmp);

  // sliceLen = max(0, end - start)
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: sliceLenTmp });
  emitClampNonNeg(fctx, sliceLenTmp);

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
 * arr.concat(other) -> create new vec struct with combined data.
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
  // 0-arg concat: shallow copy of the receiver array
  if (callExpr.arguments.length === 0) {
    const vecA = allocLocal(fctx, `__arr_cat_va_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
    const dataA = allocLocal(fctx, `__arr_cat_da_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
    const newData = allocLocal(fctx, `__arr_cat_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
    const lenA = allocLocal(fctx, `__arr_cat_la_${fctx.locals.length}`, { kind: "i32" });

    // Compile receiver -> vec ref
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.tee", index: vecA });
    emitReceiverNullGuard(ctx, fctx, vecA);
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.set", index: lenA });
    fctx.body.push({ op: "local.get", index: vecA });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.set", index: dataA });

    // newData = array.new_default(lenA)
    fctx.body.push({ op: "local.get", index: lenA });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: newData });

    // array.copy newData[0..lenA] = dataA[0..lenA]
    emitArrayCopy(fctx, arrTypeIdx, newData, null, dataA, null, lenA);

    // Create new vec struct: { lenA, newData }
    fctx.body.push({ op: "local.get", index: lenA });
    fctx.body.push({ op: "local.get", index: newData });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Check if argument B is a known WasmGC array type. If not (e.g. `any`, `object`,
  // array-like with Symbol.isConcatSpreadable), struct.get would cause an illegal cast at runtime.
  // Fall back to __extern_method_call("concat") for non-array arguments.
  const argNode = callExpr.arguments[0]!;
  const argTsType = ctx.checker.getTypeAtLocation(argNode);
  const argArrayInfo = resolveArrayInfo(ctx, argTsType);

  if (!argArrayInfo) {
    return compileArrayConcatExtern(ctx, fctx, propAccess, callExpr);
  }

  const vecA = allocLocal(fctx, `__arr_cat_va_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const vecB = allocLocal(fctx, `__arr_cat_vb_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataA = allocLocal(fctx, `__arr_cat_da_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const dataB = allocLocal(fctx, `__arr_cat_db_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_cat_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenA = allocLocal(fctx, `__arr_cat_la_${fctx.locals.length}`, { kind: "i32" });
  const lenB = allocLocal(fctx, `__arr_cat_lb_${fctx.locals.length}`, { kind: "i32" });
  const totalLen = allocLocal(fctx, `__arr_cat_tl_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver A -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecA });
  emitReceiverNullGuard(ctx, fctx, vecA);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenA });
  fctx.body.push({ op: "local.get", index: vecA });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataA });

  // Compile argument B -> vec ref (safe — argArrayInfo confirmed it's a WasmGC array)
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
 * Fallback for arr.concat(arg...) when any arg is not a known WasmGC array type
 * (e.g. `any`, array-like with Symbol.isConcatSpreadable, or plain objects).
 *
 * Uses __array_concat_any(receiver_ext, args_js_array) host import, which:
 * 1. Converts the WasmGC receiver to a real JS array via __vec_len/__vec_get exports
 * 2. Calls Array.prototype.concat with all arguments (supports isConcatSpreadable)
 * 3. Returns the result as externref (a new JS Array)
 */
function compileArrayConcatExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  // __array_concat_any(receiver: externref, args: externref) -> externref
  // Converts WasmGC receiver to JS array, then calls .concat(...args)
  const concatAnyIdx = ensureLateImport(
    ctx,
    "__array_concat_any",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);

  if (arrNewIdx === undefined || arrPushIdx === undefined || concatAnyIdx === undefined) {
    return null;
  }

  // Compile receiver as externref (WasmGC vec struct → extern ref), save to local
  const recvLocal = allocLocal(fctx, `__cat_ext_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
  }
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Build JS args array from all concat arguments
  fctx.body.push({ op: "call", funcIdx: arrNewIdx });
  const argsLocal = allocLocal(fctx, `__cat_ext_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argsLocal });

  for (const arg of callExpr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
    }
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  }

  // Call __array_concat_any(receiver_ext, args_array) -> externref JS array
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: concatAnyIdx });
  return { kind: "externref" };
}

/**
 * arr.join(sep?) -> convert elements to strings and concatenate.
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
  const concatIdx = ctx.jsStringImports.get("concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  if (concatIdx === undefined) {
    reportError(ctx, callExpr, "join requires string support (wasm:js-string concat)");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_join_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_join_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_join_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_join_i_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_join_res_${fctx.locals.length}`, { kind: "externref" });
  const sepTmp = allocLocal(fctx, `__arr_join_sep_${fctx.locals.length}`, { kind: "externref" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

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
    // Default separator "," -- check if registered as string constant global
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
      then: [...elemToStr, { op: "local.set", index: resultTmp } as Instr],
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resultTmp });
  return { kind: "externref" };
}

/**
 * arr.splice(start, deleteCount?) -> in-place shift, returns new vec with deleted elements.
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
  // 0-arg splice: no mutation, return empty array
  if (callExpr.arguments.length === 0) {
    // Still need to evaluate receiver for side effects
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "drop" });
    // Return empty vec struct: { 0, array.new_default(0) }
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
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

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg -- clamp negative indices
  compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // deleteCount (default: len - start) -- clamp >= 0 and to remaining len
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.sub" });
  }
  fctx.body.push({ op: "local.set", index: delCountTmp });
  emitClampNonNeg(fctx, delCountTmp);
  // Clamp delCount to not exceed remaining elements: min(delCount, len - start)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp }); // reuse as temp
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "local.get", index: tailCountTmp });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "local.get", index: tailCountTmp } as Instr, { op: "local.set", index: delCountTmp } as Instr],
  } as Instr);
  emitClampNonNeg(fctx, delCountTmp);

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

  // tailCount = max(0, len - tailStart)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: tailStartTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp });
  emitClampNonNeg(fctx, tailCountTmp);

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

// ── Functional array methods (filter, map, reduce, forEach, find, findIndex, some, every) ──
// Shared helpers to reduce duplication across callback-based array methods.

/** Result of setting up a callback for an array method (closure or host bridge). */
interface ArrayCallbackSetup {
  closureInfo?: ClosureInfo;
  closureTypeIdx?: number;
  closureTmp?: number;
  callBridgeIdx?: number;
  cbTmp?: number;
}

/**
 * Compile the callback argument and set up either a closure (call_ref) path
 * or a host bridge fallback. Returns null if setup fails (error pushed).
 */
function setupArrayCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
  tag: string,
  bridgeName?: string,
): ArrayCallbackSetup | null {
  const cbArg = callExpr.arguments[0]!;
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);

  let closureInfo: ClosureInfo | undefined;
  let closureTypeIdx: number | undefined;
  let closureTmp: number | undefined;

  if (cbResult && (cbResult.kind === "ref" || cbResult.kind === "ref_null")) {
    closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
    closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
    if (closureInfo) {
      closureTmp = allocLocal(fctx, `__arr_${tag}_clcb_${fctx.locals.length}`, cbResult);
      fctx.body.push({ op: "local.set", index: closureTmp });
    }
  }

  let callBridgeIdx: number | undefined;
  let cbTmp: number | undefined;
  if (!closureInfo) {
    const bridge = bridgeName ?? (ctx.fast ? "__call_1_i32" : "__call_1_f64");
    callBridgeIdx = ctx.funcMap.get(bridge);
    if (callBridgeIdx === undefined) {
      reportError(ctx, callExpr, `Missing ${bridge} import for ${methodName}`);
      return null;
    }
    cbTmp = allocLocal(fctx, `__arr_${tag}_cb_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: cbTmp });
  }

  return { closureInfo, closureTypeIdx, closureTmp, callBridgeIdx, cbTmp };
}

/** Common locals for array iteration loops. */
interface ArrayLoopLocals {
  vecTmp: number;
  dataTmp: number;
  lenTmp: number;
  iTmp: number;
  getOp: string;
}

/**
 * Compile receiver, extract vec/data/len, alloc loop locals, set i = 0.
 * The caller (compileArrayMethodCall) has already resolved the correct
 * vec/arr/elem types via probe-compile (#826).
 */
function setupArrayLoop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  tag: string,
): ArrayLoopLocals {
  compileExpression(ctx, fctx, propAccess.expression);

  const vecTmp = allocLocal(fctx, `__arr_${tag}_vec_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: vecTypeIdx,
  });
  const dataTmp = allocLocal(fctx, `__arr_${tag}_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  const lenTmp = allocLocal(fctx, `__arr_${tag}_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_${tag}_i_${fctx.locals.length}`, { kind: "i32" });

  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";
  return { vecTmp, dataTmp, lenTmp, iTmp, getOp };
}

/**
 * Build closure call_ref instructions for a 1-arg callback (element, [index, [array]]).
 * The element source can be either an elemTmp local or inline data[i].
 */
function buildClosureCallInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  setup: ArrayCallbackSetup,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
  elemSource: { kind: "local"; index: number } | { kind: "inline" },
): Instr[] {
  const { closureInfo, closureTypeIdx, closureTmp } = setup;
  if (!closureInfo || closureTypeIdx === undefined || closureTmp === undefined) return [];
  const numParams = closureInfo.paramTypes.length;
  const elemCoerce = closureInfo.paramTypes[0] ? coercionInstrs(ctx, elemType, closureInfo.paramTypes[0], fctx) : [];

  return [
    { op: "local.get", index: closureTmp } as Instr,
    // Element value (1st user param) — only pushed if callback declares ≥1 param.
    // A 0-arg callback (e.g. `function() {}`) compiles to a funcref that takes only
    // the closure env, so pushing elem here produces a call_ref signature mismatch.
    ...(numParams >= 1
      ? [
          ...(elemSource.kind === "local"
            ? [{ op: "local.get", index: elemSource.index } as Instr]
            : [
                { op: "local.get", index: loop.dataTmp } as Instr,
                { op: "local.get", index: loop.iTmp } as Instr,
                { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
              ]),
          ...elemCoerce,
        ]
      : []),
    // Index (2nd user param)
    ...(numParams >= 2
      ? [
          { op: "local.get", index: loop.iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    // Array (3rd user param)
    ...(numParams >= 3
      ? [
          { op: "local.get", index: loop.vecTmp } as Instr,
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ]
      : []),
    { op: "local.get", index: closureTmp } as Instr,
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
  ];
}

/**
 * Build host bridge call instructions for a 1-arg callback.
 * The element is always loaded inline from data[i].
 */
function buildBridgeCallInstrs(
  ctx: CodegenContext,
  setup: ArrayCallbackSetup,
  elemType: ValType,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
  elemSource: { kind: "local"; index: number } | { kind: "inline" },
): Instr[] {
  return [
    { op: "local.get", index: setup.cbTmp! } as Instr,
    ...(elemSource.kind === "local"
      ? [
          { op: "local.get", index: elemSource.index } as Instr,
          ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
        ]
      : [
          { op: "local.get", index: loop.dataTmp } as Instr,
          { op: "local.get", index: loop.iTmp } as Instr,
          { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
          ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
        ]),
    { op: "call", funcIdx: setup.callBridgeIdx! } as Instr,
  ];
}

/** Build instructions to check truthiness of a callback result (-> i32). */
function buildTruthyCheck(ctx: CodegenContext, setup: ArrayCallbackSetup): Instr[] {
  if (setup.closureInfo) {
    const retKind = setup.closureInfo.returnType?.kind;
    if (retKind === "f64") {
      return [{ op: "f64.const", value: 0 } as Instr, { op: "f64.ne" } as Instr];
    }
    if (retKind === "i32") {
      return []; // i32 is already truthy/falsy
    }
    // externref / ref / ref_null: non-null is truthy
    if (retKind === "externref" || retKind === "ref" || retKind === "ref_null") {
      return [{ op: "ref.is_null" } as Instr, { op: "i32.eqz" } as Instr];
    }
    return []; // default: assume i32
  }
  return ctx.fast ? [] : [{ op: "f64.const", value: 0 } as Instr, { op: "f64.ne" } as Instr];
}

/** Build instructions to check falsiness of a callback result (-> i32). */
function buildFalsyCheck(ctx: CodegenContext, setup: ArrayCallbackSetup): Instr[] {
  if (setup.closureInfo) {
    const retKind = setup.closureInfo.returnType?.kind;
    if (retKind === "f64") {
      return [{ op: "f64.const", value: 0 } as Instr, { op: "f64.eq" } as Instr];
    }
    if (retKind === "i32") {
      return [{ op: "i32.eqz" } as Instr];
    }
    // externref / ref / ref_null: null is falsy
    if (retKind === "externref" || retKind === "ref" || retKind === "ref_null") {
      return [{ op: "ref.is_null" } as Instr];
    }
    return [{ op: "i32.eqz" } as Instr];
  }
  return ctx.fast ? [{ op: "i32.eqz" } as Instr] : [{ op: "f64.const", value: 0 } as Instr, { op: "f64.eq" } as Instr];
}

/**
 * Emit the standard block/loop wrapper used by all functional array methods.
 */
function emitArrayLoop(fctx: FunctionContext, loopBody: Instr[]): void {
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });
}

/**
 * Build the standard loop-exit check: if (i >= len) br 1.
 */
function loopExitCheck(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: "local.get", index: loop.lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
  ];
}

/**
 * Build the standard i++ / br 0 at the end of each iteration.
 */
function loopIncrement(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: loop.iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];
}

/**
 * Build callback call + optional truthiness/falsiness check for a 1-arg callback.
 * Used by filter, find, findIndex, some, every, forEach.
 */
function buildCallAndCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  setup: ArrayCallbackSetup,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
  elemSource: { kind: "local"; index: number } | { kind: "inline" },
  check: "truthy" | "falsy" | "none",
): Instr[] {
  const callInstrs = setup.closureInfo
    ? buildClosureCallInstrs(ctx, fctx, setup, elemType, vecTypeIdx, arrTypeIdx, loop, elemSource)
    : buildBridgeCallInstrs(ctx, setup, elemType, arrTypeIdx, loop, elemSource);
  const checkInstrs =
    check === "truthy" ? buildTruthyCheck(ctx, setup) : check === "falsy" ? buildFalsyCheck(ctx, setup) : [];
  return [...callInstrs, ...checkInstrs];
}

// ── Individual method implementations using shared helpers ──

/**
 * arr.filter(cb) -> iterate elements, call callback, build new array from truthy results.
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
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.filter")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "filter", "flt");
  if (!setup) return null;

  const resData = allocLocal(fctx, `__arr_flt_rd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const resLen = allocLocal(fctx, `__arr_flt_rl_${fctx.locals.length}`, { kind: "i32" });
  const elemTmp = allocLocal(fctx, `__arr_flt_el_${fctx.locals.length}`, elemType);

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "flt");

  // Allocate result array with same capacity as source
  fctx.body.push({ op: "local.get", index: loop.lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: resData });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resLen });

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "local", index: elemTmp },
    "truthy",
  );

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    // elem = data[i]
    { op: "local.get", index: loop.dataTmp } as Instr,
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: elemTmp } as Instr,

    ...callAndCheck,

    // if result is truthy, add element to result
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resData } as Instr,
        { op: "local.get", index: resLen } as Instr,
        { op: "local.get", index: elemTmp } as Instr,
        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
        { op: "local.get", index: resLen } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.set", index: resLen } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: resLen });
  fctx.body.push({ op: "local.get", index: resData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.map(cb) -> iterate elements, call callback, store results in new array.
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
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.map")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const cbArg = callExpr.arguments[0]!;
  // Determine the result element type from the callback's own return type
  let mapResultElemType: ValType = elemType;
  let mapArrTypeIdx = arrTypeIdx;
  let mapVecTypeIdx = vecTypeIdx;

  if (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)) {
    const cbSig = ctx.checker.getSignatureFromDeclaration(cbArg);
    if (cbSig) {
      const retType = ctx.checker.getReturnTypeOfSignature(cbSig);
      const mapped = resolveWasmType(ctx, retType);
      if (mapped.kind !== elemType.kind) {
        mapResultElemType = mapped;
        mapArrTypeIdx = getOrRegisterArrayType(ctx, mapResultElemType.kind, mapResultElemType);
        mapVecTypeIdx = getOrRegisterVecType(ctx, mapResultElemType.kind, mapResultElemType);
      }
    }
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "map", "map");
  if (!setup) return null;

  // Update map result type from closure return type if available
  if (setup.closureInfo?.returnType && setup.closureInfo.returnType.kind !== mapResultElemType.kind) {
    mapResultElemType = setup.closureInfo.returnType;
    mapArrTypeIdx = getOrRegisterArrayType(ctx, mapResultElemType.kind, mapResultElemType);
    mapVecTypeIdx = getOrRegisterVecType(ctx, mapResultElemType.kind, mapResultElemType);
  }

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "map");

  const resData = allocLocal(fctx, `__arr_map_rd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: mapArrTypeIdx });

  // Allocate result array with same length
  fctx.body.push({ op: "local.get", index: loop.lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: mapArrTypeIdx });
  fctx.body.push({ op: "local.set", index: resData });

  // Build callback invocation (result stays on stack)
  let callInstrs: Instr[];
  if (setup.closureInfo) {
    const retType = setup.closureInfo.returnType;
    callInstrs = [
      ...buildClosureCallInstrs(ctx, fctx, setup, elemType, vecTypeIdx, arrTypeIdx, loop, { kind: "inline" }),
      // Coerce closure return type to map result element type if needed
      ...(retType && retType.kind !== mapResultElemType.kind
        ? coercionInstrs(ctx, retType, mapResultElemType, fctx)
        : []),
    ];
  } else {
    callInstrs = [
      ...buildBridgeCallInstrs(ctx, setup, elemType, arrTypeIdx, loop, { kind: "inline" }),
      // Convert result to target element type if needed
      ...(!ctx.fast && mapResultElemType.kind === "i32" ? [{ op: "i32.trunc_sat_f64_s" } as Instr] : []),
    ];
  }

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    // resData[i] = cb(data[i])
    { op: "local.get", index: resData } as Instr,
    { op: "local.get", index: loop.iTmp } as Instr,
    ...callInstrs,
    { op: "array.set", typeIdx: mapArrTypeIdx } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: loop.lenTmp });
  fctx.body.push({ op: "local.get", index: resData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: mapVecTypeIdx });
  return { kind: "ref_null", typeIdx: mapVecTypeIdx };
}

/**
 * arr.reduce(cb, initial) -> iterate elements, accumulate result via callback.
 * Reduce has a 2-arg callback (acc, elem) so it uses custom call logic.
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
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.reduce")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return elemType;
  }

  const numKind = ctx.fast ? "i32" : "f64";
  const bridgeName = ctx.fast ? "__call_2_i32" : "__call_2_f64";
  const setup = setupArrayCallback(ctx, fctx, callExpr, "reduce", "red", bridgeName);
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "red");
  const accTmp = allocLocal(fctx, `__arr_red_acc_${fctx.locals.length}`, { kind: numKind as any });

  // Compile initial value or use arr[0] as default
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: numKind as any });
    fctx.body.push({ op: "local.set", index: accTmp });
    // i already = 0 from setupArrayLoop
  } else {
    // No initial value: throw TypeError on empty array, else acc = data[0], start from i = 1
    fctx.body.push({ op: "local.get", index: loop.lenTmp });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwStringInstrs(ctx, "TypeError: Reduce of empty array with no initial value"),
    } as Instr);
    fctx.body.push({ op: "local.get", index: loop.dataTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: elemType.kind === "i16" ? "array.get_s" : "array.get", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: accTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "local.set", index: loop.iTmp });
  }

  // Build reduce-specific callback invocation (2-arg: acc, elem)
  let callInstrs: Instr[];
  if (setup.closureInfo && setup.closureTypeIdx !== undefined && setup.closureTmp !== undefined) {
    const ci = setup.closureInfo;
    const numParams = ci.paramTypes.length;
    const accCoerce = ci.paramTypes[0] ? coercionInstrs(ctx, { kind: numKind as any }, ci.paramTypes[0], fctx) : [];
    const elemCoerce = ci.paramTypes[1] ? coercionInstrs(ctx, elemType, ci.paramTypes[1], fctx) : [];
    callInstrs = [
      { op: "local.get", index: setup.closureTmp } as Instr,
      // Accumulator (1st user param) — gate on numParams >= 1.
      ...(numParams >= 1 ? [{ op: "local.get", index: accTmp } as Instr, ...accCoerce] : []),
      // Element (2nd user param) — gate on numParams >= 2.
      ...(numParams >= 2
        ? [
            { op: "local.get", index: loop.dataTmp } as Instr,
            { op: "local.get", index: loop.iTmp } as Instr,
            { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
            ...elemCoerce,
          ]
        : []),
      ...(numParams >= 3
        ? [
            { op: "local.get", index: loop.iTmp } as Instr,
            ...coercionInstrs(ctx, { kind: "i32" }, ci.paramTypes[2] ?? { kind: "i32" }, fctx),
          ]
        : []),
      ...(numParams >= 4
        ? [
            { op: "local.get", index: loop.vecTmp } as Instr,
            ...coercionInstrs(
              ctx,
              { kind: "ref_null", typeIdx: vecTypeIdx },
              ci.paramTypes[3] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
              fctx,
            ),
          ]
        : []),
      { op: "local.get", index: setup.closureTmp } as Instr,
      { op: "struct.get", typeIdx: setup.closureTypeIdx, fieldIdx: 0 } as Instr,
      ...guardedFuncRefCastInstrs(fctx, ci.funcTypeIdx),
      { op: "ref.as_non_null" } as Instr,
      { op: "call_ref", typeIdx: ci.funcTypeIdx } as Instr,
      // Coerce closure return type to accumulator type if needed
      ...(ci.returnType && ci.returnType.kind !== numKind
        ? coercionInstrs(ctx, ci.returnType, { kind: numKind as any }, fctx)
        : []),
      { op: "local.set", index: accTmp } as Instr,
    ];
  } else {
    callInstrs = [
      { op: "local.get", index: setup.cbTmp! } as Instr,
      { op: "local.get", index: accTmp } as Instr,
      { op: "local.get", index: loop.dataTmp } as Instr,
      { op: "local.get", index: loop.iTmp } as Instr,
      { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
      ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
      { op: "call", funcIdx: setup.callBridgeIdx! } as Instr,
      { op: "local.set", index: accTmp } as Instr,
    ];
  }

  const loopBody: Instr[] = [...loopExitCheck(loop), ...callInstrs, ...loopIncrement(loop)];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: accTmp });
  return { kind: numKind as any };
}

/**
 * arr.reduceRight(cb, init?) -> iterate elements right-to-left, accumulate via callback.
 */
function compileArrayReduceRight(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.reduceRight")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return elemType;
  }

  const numKind = ctx.fast ? "i32" : "f64";
  const bridgeName = ctx.fast ? "__call_2_i32" : "__call_2_f64";
  const setup = setupArrayCallback(ctx, fctx, callExpr, "reduceRight", "rr", bridgeName);
  if (!setup) return null;

  // Set up receiver: vec/data/len
  const vecTmp = allocLocal(fctx, `__arr_rr_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_rr_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_rr_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_rr_i_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";
  const accTmp = allocLocal(fctx, `__arr_rr_acc_${fctx.locals.length}`, { kind: numKind as any });

  // Compile initial value or use arr[length-1] as default
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: numKind as any });
    fctx.body.push({ op: "local.set", index: accTmp });
    // Start from length - 1
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: iTmp });
  } else {
    // No initial value: throw TypeError on empty array, else acc = data[length-1], start from length - 2
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwStringInstrs(ctx, "TypeError: Reduce of empty array with no initial value"),
    } as Instr);
    fctx.body.push({ op: "local.get", index: dataTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: getOp, typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: accTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 2 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: iTmp });
  }

  // Build the loop locals struct for buildClosureCallInstrs compatibility
  const loop: ArrayLoopLocals = {
    vecTmp,
    dataTmp,
    lenTmp,
    iTmp,
    getOp,
  };

  // Build reduce-specific callback invocation (2-arg: acc, elem)
  let callInstrs: Instr[];
  if (setup.closureInfo && setup.closureTypeIdx !== undefined && setup.closureTmp !== undefined) {
    const ci = setup.closureInfo;
    const numParams = ci.paramTypes.length;
    const accCoerce = ci.paramTypes[0] ? coercionInstrs(ctx, { kind: numKind as any }, ci.paramTypes[0], fctx) : [];
    const elemCoerce = ci.paramTypes[1] ? coercionInstrs(ctx, elemType, ci.paramTypes[1], fctx) : [];
    callInstrs = [
      { op: "local.get", index: setup.closureTmp } as Instr,
      ...(numParams >= 1 ? [{ op: "local.get", index: accTmp } as Instr, ...accCoerce] : []),
      ...(numParams >= 2
        ? [
            { op: "local.get", index: dataTmp } as Instr,
            { op: "local.get", index: iTmp } as Instr,
            { op: getOp, typeIdx: arrTypeIdx } as Instr,
            ...elemCoerce,
          ]
        : []),
      ...(numParams >= 3
        ? [
            { op: "local.get", index: iTmp } as Instr,
            ...coercionInstrs(ctx, { kind: "i32" }, ci.paramTypes[2] ?? { kind: "i32" }, fctx),
          ]
        : []),
      ...(numParams >= 4
        ? [
            { op: "local.get", index: vecTmp } as Instr,
            ...coercionInstrs(
              ctx,
              { kind: "ref_null", typeIdx: vecTypeIdx },
              ci.paramTypes[3] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
              fctx,
            ),
          ]
        : []),
      { op: "local.get", index: setup.closureTmp } as Instr,
      { op: "struct.get", typeIdx: setup.closureTypeIdx, fieldIdx: 0 } as Instr,
      ...guardedFuncRefCastInstrs(fctx, ci.funcTypeIdx),
      { op: "ref.as_non_null" } as Instr,
      { op: "call_ref", typeIdx: ci.funcTypeIdx } as Instr,
      // Coerce closure return type to accumulator type if needed
      ...(ci.returnType && ci.returnType.kind !== numKind
        ? coercionInstrs(ctx, ci.returnType, { kind: numKind as any }, fctx)
        : []),
      { op: "local.set", index: accTmp } as Instr,
    ];
  } else {
    callInstrs = [
      { op: "local.get", index: setup.cbTmp! } as Instr,
      { op: "local.get", index: accTmp } as Instr,
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
      { op: "call", funcIdx: setup.callBridgeIdx! } as Instr,
      { op: "local.set", index: accTmp } as Instr,
    ];
  }

  // Loop: while (i >= 0) { acc = cb(acc, data[i], i, arr); i--; }
  const loopBody: Instr[] = [
    // Exit check: if (i < 0) break
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.lt_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    // Callback
    ...callInstrs,
    // i--
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: accTmp });
  return { kind: numKind as any };
}

/**
 * arr.forEach(cb) -> iterate elements, call callback, return void.
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
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.forEach")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return null; // void method
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "forEach", "fe");
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "fe");

  if (setup.closureInfo) {
    const callInstrs = buildClosureCallInstrs(ctx, fctx, setup, elemType, vecTypeIdx, arrTypeIdx, loop, {
      kind: "inline",
    });
    const dropInstrs: Instr[] = setup.closureInfo.returnType ? [{ op: "drop" } as Instr] : [];

    const loopBody: Instr[] = [...loopExitCheck(loop), ...callInstrs, ...dropInstrs, ...loopIncrement(loop)];

    emitArrayLoop(fctx, loopBody);
  } else {
    const callInstrs = buildBridgeCallInstrs(ctx, setup, elemType, arrTypeIdx, loop, { kind: "inline" });

    const loopBody: Instr[] = [...loopExitCheck(loop), ...callInstrs, { op: "drop" } as Instr, ...loopIncrement(loop)];

    emitArrayLoop(fctx, loopBody);
  }

  return null;
}

/**
 * arr.find(cb) -> iterate, return first element where cb returns truthy, else NaN.
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
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.find")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return elemType;
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "find", "find");
  if (!setup) return null;

  const elemTmpLocal = allocLocal(fctx, `__arr_find_el_${fctx.locals.length}`, elemType);

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "find");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "local", index: elemTmpLocal },
    "truthy",
  );

  // Result local -- NaN (not found) or element value
  const findResType: ValType = ctx.fast ? elemType : { kind: "f64" };
  const findResTmp = allocLocal(fctx, `__arr_find_res_${fctx.locals.length}`, findResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.div" }); // NaN
  }
  fctx.body.push({ op: "local.set", index: findResTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    { op: "local.get", index: loop.dataTmp } as Instr,
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: elemTmpLocal } as Instr,

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: elemTmpLocal } as Instr,
        ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
        { op: "local.set", index: findResTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: findResTmp });
  return ctx.fast ? elemType : { kind: "f64" };
}

/**
 * arr.findIndex(cb) -> iterate, return index (f64) of first truthy cb result, else -1.
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
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.findIndex")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "findIndex", "fi");
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "fi");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "truthy",
  );

  const fiResType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const fiResTmp = allocLocal(fctx, `__arr_fi_res_${fctx.locals.length}`, fiResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: fiResTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: loop.iTmp } as Instr,
        ...(ctx.fast ? [] : [{ op: "f64.convert_i32_s" } as Instr]),
        { op: "local.set", index: fiResTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: fiResTmp });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.some(cb) -> returns i32 (1 if any element passes callback, 0 otherwise).
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
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.some")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "some", "some");
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "some");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "truthy",
  );

  const resTmp = allocLocal(fctx, `__arr_some_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * arr.every(cb) -> returns i32 (1 if all elements pass callback, 0 otherwise).
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
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.every")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "every", "evr");
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "evr");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "falsy",
  );

  const resTmp = allocLocal(fctx, `__arr_evr_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * arr.sort() -> in-place Timsort, return same vec ref.
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
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Call timsort(vec)
  fctx.body.push({ op: "call", funcIdx: timsortIdx });

  // Return the same vec ref (sort is in-place)
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.fill(value, start?, end?) -> fill elements with value, return same vec ref.
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
    reportError(ctx, callExpr, "fill requires at least 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_fill_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_fill_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_fill_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_fill_val_${fctx.locals.length}`, elemType);
  const startTmp = allocLocal(fctx, `__arr_fill_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_fill_e_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_fill_i_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

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

  // start (default: 0) -- clamp negative
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // end (default: length) -- clamp negative
  if (callExpr.arguments.length >= 3) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });
  emitClampIndex(fctx, endTmp, lenTmp);

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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.copyWithin(target, start, end?) -> copy elements within the same array, return same vec ref.
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
    reportError(ctx, callExpr, "copyWithin requires at least 2 arguments (target, start)");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_cw_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_cw_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_cw_len_${fctx.locals.length}`, { kind: "i32" });
  const targetTmp = allocLocal(fctx, `__arr_cw_tgt_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_cw_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_cw_e_${fctx.locals.length}`, { kind: "i32" });
  const countTmp = allocLocal(fctx, `__arr_cw_cnt_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // target arg -- clamp negative
  if (ctx.fast) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: targetTmp });
  emitClampIndex(fctx, targetTmp, lenTmp);

  // start arg -- clamp negative
  if (ctx.fast) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // end arg (default: length) -- clamp negative
  if (callExpr.arguments.length >= 3) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });
  emitClampIndex(fctx, endTmp, lenTmp);

  // count = max(0, min(end - start, len - target))
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
  emitClampNonNeg(fctx, countTmp);

  // array.copy data[target..target+count] = data[start..start+count]
  emitArrayCopy(fctx, arrTypeIdx, dataTmp, targetTmp, dataTmp, startTmp, countTmp);

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.lastIndexOf(value, fromIndex?) -> reverse linear scan, return index or -1.
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
    reportError(ctx, callExpr, "lastIndexOf requires 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_liof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_liof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_liof_i_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_liof_val_${fctx.locals.length}`, elemType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  const lenTmp = allocLocal(fctx, `__arr_liof_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  if (callExpr.arguments.length >= 2) {
    // fromIndex provided -- clamp negative and clamp to length - 1
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    fctx.body.push({ op: "local.set", index: iTmp });
    // If negative, add length: if (i < 0) i = len + i
    fctx.body.push({ op: "local.get", index: iTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp } as Instr,
        { op: "local.get", index: iTmp } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.set", index: iTmp } as Instr,
      ],
    } as Instr);
    // Clamp to len - 1
    fctx.body.push({ op: "local.get", index: iTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "i32.gt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "local.set", index: iTmp } as Instr,
      ],
    } as Instr);
  } else {
    // Default: length - 1
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: iTmp });
  }

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile search value
  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  const getOp = elemType.kind === "i16" ? "array.get_s" : "array.get";

  // For externref elements, use the `equals` string import (JS ===) for comparison
  // For ref/ref_null elements, use ref.eq for reference identity comparison
  let liofEqInstrs: Instr[];
  if (elemType.kind === "externref") {
    addStringImports(ctx);
    const equalsIdx = ctx.jsStringImports.get("equals")!;
    liofEqInstrs = [{ op: "call", funcIdx: equalsIdx } as Instr];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    liofEqInstrs = [{ op: "ref.eq" }];
  } else {
    const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
    liofEqInstrs = [{ op: eqOp } as Instr];
  }

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when lastIndexOf is inlined.
  const liofResType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const liofResTmp = allocLocal(fctx, `__arr_liof_res_${fctx.locals.length}`, liofResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: liofResTmp });

  // Loop: while (i >= 0) { if data[i] == val, store i and break; i--; }
  const loopBody: Instr[] = [
    // if (i < 0) break
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "br_if", depth: 1 },

    // if (data[i] == val) store result and break
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    ...liofEqInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp } as Instr,
            { op: "local.set", index: liofResTmp } as Instr,
            { op: "br", depth: 2 } as Instr, // break out of block
          ]
        : [
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "local.set", index: liofResTmp } as Instr,
            { op: "br", depth: 2 } as Instr, // break out of block
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: liofResTmp });

  if (ctx.fast) {
    return { kind: "i32" };
  }
  return { kind: "f64" };
}

/**
 * Compile arr.flat(depth?) — delegates to __array_flat host import (#1136).
 * Converts WasmGC vec receiver to externref, passes depth arg, returns externref.
 */
function compileArrayFlat(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  // __array_flat(receiver: externref, depth: externref) -> externref
  const flatIdx = ensureLateImport(
    ctx,
    "__array_flat",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (flatIdx === undefined) return null;

  // Compile receiver as externref
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
  }

  // Compile depth argument (or push undefined)
  if (callExpr.arguments.length > 0) {
    const depthType = compileExpression(ctx, fctx, callExpr.arguments[0]!);
    if (depthType && depthType.kind !== "externref") {
      coerceType(ctx, fctx, depthType, { kind: "externref" });
    } else if (!depthType) {
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: flatIdx });
  return { kind: "externref" };
}

/**
 * Compile arr.flatMap(callback, thisArg?) — delegates to __array_flatMap host import (#1136).
 * Converts WasmGC vec receiver to externref, passes callback and optional thisArg, returns externref.
 */
function compileArrayFlatMap(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  if (callExpr.arguments.length < 1) return null; // flatMap requires a callback

  // __array_flatMap(receiver: externref, fn: externref, thisArg: externref) -> externref
  const flatMapIdx = ensureLateImport(
    ctx,
    "__array_flatMap",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (flatMapIdx === undefined) return null;

  // Compile receiver as externref
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
  }

  // Compile callback as externref
  const cbType = compileExpression(ctx, fctx, callExpr.arguments[0]!);
  if (cbType && cbType.kind !== "externref") {
    coerceType(ctx, fctx, cbType, { kind: "externref" });
  } else if (!cbType) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Compile thisArg (or push undefined)
  if (callExpr.arguments.length > 1) {
    const thisArgType = compileExpression(ctx, fctx, callExpr.arguments[1]!);
    if (thisArgType && thisArgType.kind !== "externref") {
      coerceType(ctx, fctx, thisArgType, { kind: "externref" });
    } else if (!thisArgType) {
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: flatMapIdx });
  return { kind: "externref" };
}

// Register the emitBoundsCheckedArrayGet delegate so closures.ts (and any
// other module) can call it via shared.ts without depending on array-methods.ts.
registerEmitBoundsCheckedArrayGet(emitBoundsCheckedArrayGet);
