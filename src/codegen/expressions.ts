import ts from "typescript";
import type { CodegenContext, FunctionContext, ClosureInfo, RestParamInfo } from "./index.js";
import { allocLocal, resolveWasmType, getOrRegisterArrayType, addFuncType, addUnionImports } from "./index.js";
import {
  mapTsTypeToWasm,
  isNumberType,
  isBooleanType,
  isStringType,
  isVoidType,
  isExternalDeclaredClass,
  isHeterogeneousUnion,
} from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction, FieldDef, StructTypeDef } from "../ir/types.js";
import { ensureI32Condition } from "./index.js";
import { compileStatement } from "./statements.js";

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
  const bodyLenBefore = fctx.body.length;
  const result = compileExpressionInner(ctx, fctx, expr);
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
  const wasmType =
    expectedType ?? mapTsTypeToWasm(ctx.checker.getTypeAtLocation(expr), ctx.checker);
  pushDefaultValue(fctx, wasmType);
  return wasmType;
}

/** Coerce a value on the stack from one type to another */
function coerceType(ctx: CodegenContext, fctx: FunctionContext, from: ValType, to: ValType): void {
  if (from.kind === to.kind) return;
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
  // externref → i32 (non-null check)
  if (from.kind === "externref" && to.kind === "i32") {
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
    return;
  }
  // externref → f64
  if (from.kind === "externref" && to.kind === "f64") {
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
  // i32 → externref (box boolean)
  if (from.kind === "i32" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_boolean");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
  }
  // i32/f64 → externref (fallback)
  if (to.kind === "externref") {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // Fallback: drop + push default
  fctx.body.push({ op: "drop" });
  pushDefaultValue(fctx, to);
}

function compileExpressionInner(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): ValType | null {
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text);
    fctx.body.push({ op: "f64.const", value });
    return { kind: "f64" };
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return compileStringLiteral(ctx, fctx, expr.text);
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

  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return compileArrowFunction(ctx, fctx, expr);
  }

  ctx.errors.push({
    message: `Unsupported expression: ${ts.SyntaxKind[expr.kind]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Arrow function callbacks ──────────────────────────────────────────

/** Collect all identifiers referenced in a node */
function collectReferencedIdentifiers(node: ts.Node, names: Set<string>): void {
  if (ts.isIdentifier(node)) {
    names.add(node.text);
  }
  ts.forEachChild(node, (child) => collectReferencedIdentifiers(child, names));
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

  const captures: { name: string; type: ValType; localIdx: number }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    // Skip if the name is the arrow's own parameter
    const isOwnParam = arrow.parameters.some(
      (p) => ts.isIdentifier(p.name) && p.name.text === name,
    );
    if (isOwnParam) continue;
    const type = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" };
    captures.push({ name, type, localIdx });
  }

  // 3. Create struct type: field 0 = funcref, fields 1..N = captured vars
  const closureResults: ValType[] = closureReturnType ? [closureReturnType] : [];

  const structFields = [
    { name: "func", type: { kind: "funcref" as const }, mutable: false },
    ...captures.map((c) => ({
      name: c.name,
      type: c.type,
      mutable: false,
    })),
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
  const liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);

  // 5. Build the lifted function body
  const liftedFctx: FunctionContext = {
    name: closureName,
    params: [
      { name: "__self", type: { kind: "ref", typeIdx: structTypeIdx } },
      ...arrow.parameters.map((p, i) => ({
        name: (p.name as ts.Identifier).text,
        type: arrowParams[i]!,
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType: closureReturnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
  };

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // Initialize locals for captured variables from struct fields
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
    liftedFctx.body.push({ op: "local.get", index: 0 }); // __self
    liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
    liftedFctx.body.push({ op: "local.set", index: localIdx });
  }

  const savedFunc = ctx.currentFunc;
  ctx.currentFunc = liftedFctx;

  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    const exprType = compileExpression(ctx, liftedFctx, body);
    if (exprType !== null && closureReturnType) {
      // Expression result is the return value - already on stack
    } else if (exprType !== null) {
      liftedFctx.body.push({ op: "drop" });
    }
  }

  // Ensure return value for non-void functions
  if (closureReturnType) {
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
    fctx.body.push({ op: "local.get", index: cap.localIdx });
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // 8. Register closure info so call sites can emit call_ref
  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
  };

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
        name: (p.name as ts.Identifier).text,
        type: cbParams[i + 1]!,
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType: cbReturnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
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

  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, cbFctx, stmt);
    }
  } else {
    const exprType = compileExpression(ctx, cbFctx, body);
    if (exprType !== null && cbReturnType) {
      // Expression result is the return value
    } else if (exprType !== null) {
      cbFctx.body.push({ op: "drop" });
    }
  }

  if (cbReturnType) {
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
    const globalDef = ctx.mod.globals[capturedIdx];
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
    const globalDef = ctx.mod.globals[moduleIdx];
    return globalDef?.type ?? { kind: "f64" };
  }

  // Check declared globals (e.g. document, window)
  const globalInfo = ctx.declaredGlobals.get(name);
  if (globalInfo) {
    fctx.body.push({ op: "call", funcIdx: globalInfo.funcIdx });
    return globalInfo.type;
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
  const leftClassName = leftTsType.getSymbol()?.name;
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
  const operand = typeofExpr.expression;
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
): ValType | null {
  const op = expr.operatorToken.kind;

  // Handle assignment
  if (op === ts.SyntaxKind.EqualsToken) {
    return compileAssignment(ctx, fctx, expr);
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

  // Regular binary ops: evaluate both sides
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);

  // String operations
  if (isStringType(leftTsType)) {
    return compileStringBinaryOp(ctx, fctx, expr, op);
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
  const hintF64: ValType | undefined = isNumericOp ? { kind: "f64" } : undefined;

  const leftType = compileExpression(ctx, fctx, expr.left, hintF64);
  const rightType = compileExpression(ctx, fctx, expr.right, hintF64);

  if (!leftType || !rightType) return null;

  if (isNumberType(leftTsType) || leftType.kind === "f64") {
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
  if (isBooleanType(leftTsType) || leftType.kind === "i32") {
    return compileBooleanBinaryOp(ctx, fctx, op);
  }

  // Externref equality (general case, not null comparison)
  // ref.eq only works on eqref, not externref — use a temp + ref.is_null fallback
  if ((leftType.kind === "externref" || rightType.kind === "externref") && (isEqOp || isNeqOp)) {
    // Both values are on the stack; store right in a temp, check if left is null
    // Simple approach: drop both, push false (externref identity comparison is not
    // meaningful without host support; null checks are handled above)
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: isNeqOp ? 1 : 0 });
    return { kind: "i32" };
  }

  ctx.errors.push({
    message: `Unsupported binary operator for type`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
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

/** Truncate two f64 operands to i32, apply an i32 bitwise op, convert back to f64 */
function compileBitwiseBinaryOp(
  fctx: FunctionContext,
  i32op: "i32.and" | "i32.or" | "i32.xor" | "i32.shl" | "i32.shr_s" | "i32.shr_u",
  unsigned: boolean,
): ValType {
  // Stack: [left_f64, right_f64]
  // Save right, truncate left, restore right, truncate right
  const tmpR = allocLocal(fctx, `__bw_r_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmpR });
  fctx.body.push({ op: "i32.trunc_f64_s" });
  fctx.body.push({ op: "local.get", index: tmpR });
  fctx.body.push({ op: "i32.trunc_f64_s" });
  fctx.body.push({ op: i32op });
  fctx.body.push({ op: unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s" });
  return { kind: "f64" };
}

function compileModulo(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  const tmpB = allocLocal(fctx, `__mod_b_${fctx.locals.length}`, { kind: "f64" });
  const tmpA = allocLocal(fctx, `__mod_a_${fctx.locals.length}`, { kind: "f64" });

  fctx.body.push({ op: "local.set", index: tmpB });
  fctx.body.push({ op: "local.set", index: tmpA });

  fctx.body.push({ op: "local.get", index: tmpA });
  fctx.body.push({ op: "local.get", index: tmpA });
  fctx.body.push({ op: "local.get", index: tmpB });
  fctx.body.push({ op: "f64.div" });
  fctx.body.push({ op: "f64.floor" });
  fctx.body.push({ op: "local.get", index: tmpB });
  fctx.body.push({ op: "f64.mul" });
  fctx.body.push({ op: "f64.sub" });

  return { kind: "f64" };
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
  const leftType = compileExpression(ctx, fctx, expr.left);
  ensureI32Condition(fctx, leftType);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: (() => {
      const saved = fctx.body;
      fctx.body = [];
      const rightType = compileExpression(ctx, fctx, expr.right, { kind: "i32" });
      ensureI32Condition(fctx, rightType);
      const result = fctx.body;
      fctx.body = saved;
      return result;
    })(),
    else: [{ op: "i32.const", value: 0 } as Instr],
  });

  return { kind: "i32" };
}

function compileLogicalOr(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  const leftType = compileExpression(ctx, fctx, expr.left);
  ensureI32Condition(fctx, leftType);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 1 } as Instr],
    else: (() => {
      const saved = fctx.body;
      fctx.body = [];
      const rightType = compileExpression(ctx, fctx, expr.right, { kind: "i32" });
      ensureI32Condition(fctx, rightType);
      const result = fctx.body;
      fctx.body = saved;
      return result;
    })(),
  });

  return { kind: "i32" };
}

/** Nullish coalescing: a ?? b → if a is null, return b, else return a */
function compileNullishCoalescing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // Compile LHS and store in temp
  const leftType = compileExpression(ctx, fctx, expr.left);
  const resultKind: ValType = leftType ?? { kind: "externref" };
  const tmp = allocLocal(fctx, `__nullish_${fctx.locals.length}`, resultKind);
  fctx.body.push({ op: "local.tee", index: tmp });

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
): ValType | null {
  if (ts.isIdentifier(expr.left)) {
    const name = expr.left.text;
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) {
      const localType = localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : fctx.locals[localIdx - fctx.params.length]?.type;
      const resultType = compileExpression(ctx, fctx, expr.right, localType);
      fctx.body.push({ op: "local.tee", index: localIdx });
      return resultType;
    }
    // Check captured globals
    const capturedIdx = ctx.capturedGlobals.get(name);
    if (capturedIdx !== undefined) {
      const globalDef = ctx.mod.globals[capturedIdx];
      const resultType = compileExpression(ctx, fctx, expr.right, globalDef?.type);
      fctx.body.push({ op: "global.set", index: capturedIdx });
      // global.set consumes the value; re-push it for expression result
      fctx.body.push({ op: "global.get", index: capturedIdx });
      return resultType;
    }
    // Check module-level globals
    const moduleIdx = ctx.moduleGlobals.get(name);
    if (moduleIdx !== undefined) {
      const globalDef = ctx.mod.globals[moduleIdx];
      const resultType = compileExpression(ctx, fctx, expr.right, globalDef?.type);
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
): ValType | null {
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
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);

  // Handle externref property set
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    return compileExternPropertySet(ctx, fctx, target, value, objType);
  }

  const typeName = resolveStructName(ctx, objType);
  if (!typeName) return null;

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) return null;

  const fieldName = target.name.text;
  const fieldIdx = fields.findIndex((f) => f.name === fieldName);
  if (fieldIdx === -1) return null;

  compileExpression(ctx, fctx, target.expression);
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
): ValType | null {
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
  compileExpression(ctx, fctx, target.expression);
  const propInfo = propOwner.properties.get(propName);
  compileExpression(ctx, fctx, value, propInfo?.type);

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
): ValType | null {
  // Push array ref
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) {
    ctx.errors.push({ message: "Assignment to non-array", line: 0, column: 0 });
    return null;
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "array") {
    ctx.errors.push({ message: "Assignment to non-array type", line: 0, column: 0 });
    return null;
  }
  // Push index (as i32)
  compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_f64_s" });
  // Push value
  compileExpression(ctx, fctx, value, typeDef.element);
  fctx.body.push({ op: "array.set", typeIdx });
  return VOID_RESULT;
}

function isCompoundAssignment(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.PlusEqualsToken ||
    op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken ||
    op === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    op === ts.SyntaxKind.SlashEqualsToken ||
    op === ts.SyntaxKind.AmpersandEqualsToken ||
    op === ts.SyntaxKind.BarEqualsToken ||
    op === ts.SyntaxKind.CaretEqualsToken ||
    op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
  );
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

  // Check captured globals first
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined && fctx.localMap.get(name) === undefined) {
    fctx.body.push({ op: "global.get", index: capturedIdx });
    compileExpression(ctx, fctx, expr.right, { kind: "f64" });

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
    compileExpression(ctx, fctx, expr.right, { kind: "f64" });

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

  fctx.body.push({ op: "local.get", index: localIdx });
  compileExpression(ctx, fctx, expr.right, { kind: "f64" });

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
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      emitBitwiseCompoundOp(fctx, op);
      break;
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
  fctx.body.push({ op: "i32.trunc_f64_s" });
  fctx.body.push({ op: "local.get", index: tmpR });
  fctx.body.push({ op: "i32.trunc_f64_s" });
  fctx.body.push({ op: entry.i32op });
  fctx.body.push({ op: entry.unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s" });
}

function compilePrefixUnary(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PrefixUnaryExpression,
): ValType | null {
  switch (expr.operator) {
    case ts.SyntaxKind.MinusToken: {
      compileExpression(ctx, fctx, expr.operand);
      fctx.body.push({ op: "f64.neg" });
      return { kind: "f64" };
    }
    case ts.SyntaxKind.ExclamationToken: {
      const operandType = compileExpression(ctx, fctx, expr.operand);
      ensureI32Condition(fctx, operandType);
      fctx.body.push({ op: "i32.eqz" });
      return { kind: "i32" };
    }
    case ts.SyntaxKind.TildeToken: {
      // ~x => f64.convert_i32_s(i32.xor(i32.trunc_f64_s(x), -1))
      compileExpression(ctx, fctx, expr.operand, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_f64_s" });
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.xor" });
      fctx.body.push({ op: "f64.convert_i32_s" });
      return { kind: "f64" };
    }
    case ts.SyntaxKind.PlusPlusToken: {
      if (ts.isIdentifier(expr.operand)) {
        const idx = fctx.localMap.get(expr.operand.text);
        if (idx !== undefined) {
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

  // Push the funcref from the closure struct (field 0)
  fctx.body.push({ op: "local.get", index: localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: info.structTypeIdx, fieldIdx: 0 });

  // call_ref with the lifted function's type index
  fctx.body.push({ op: "call_ref", typeIdx: info.funcTypeIdx });

  return info.returnType;
}

function compileCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  // Optional chaining on calls: obj?.method()
  if (expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
    return compileOptionalCallExpression(ctx, fctx, expr);
  }

  // Handle property access calls: console.log, Math.xxx, extern methods
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const propAccess = expr.expression;
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "console" &&
      propAccess.name.text === "log"
    ) {
      return compileConsoleLog(ctx, fctx, expr);
    }

    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Math"
    ) {
      return compileMathCall(ctx, fctx, propAccess.name.text, expr);
    }

    // Check if receiver is an externref object
    const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
    if (isExternalDeclaredClass(receiverType, ctx.checker)) {
      return compileExternMethodCall(ctx, fctx, propAccess, expr);
    }

    // Check if receiver is a local class instance
    const receiverClassName = receiverType.getSymbol()?.name;
    if (receiverClassName && ctx.classSet.has(receiverClassName)) {
      const methodName = propAccess.name.text;
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
          if (isVoidType(retType)) return null;
          return resolveWasmType(ctx, retType);
        }
        return null;
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
      // Pack remaining arguments into an array
      const restArgCount = Math.max(0, expr.arguments.length - restInfo.restIndex);
      for (let i = restInfo.restIndex; i < expr.arguments.length; i++) {
        compileExpression(ctx, fctx, expr.arguments[i]!, restInfo.elemType);
      }
      fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: restArgCount });
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

    fctx.body.push({ op: "call", funcIdx });

    // Determine return type from function signature
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (isVoidType(retType)) return VOID_RESULT;
      return resolveWasmType(ctx, retType);
    }
    return { kind: "f64" };
  }

  ctx.errors.push({
    message: "Unsupported call expression",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── New expressions ──────────────────────────────────────────────────

function compileNewExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | null {
  const type = ctx.checker.getTypeAtLocation(expr);
  const symbol = type.getSymbol();
  const className = symbol?.name;

  if (!className) {
    ctx.errors.push({
      message: "Cannot resolve class for new expression",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
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
): ValType | null {
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
    // Remaining args should be a single spread element — pass the array directly
    if (argIdx < expr.arguments.length) {
      const restArg = expr.arguments[argIdx]!;
      if (ts.isSpreadElement(restArg)) {
        compileExpression(ctx, fctx, restArg.expression);
      } else {
        // Single non-spread arg as rest — wrap in array
        compileExpression(ctx, fctx, restArg, restInfo.elemType);
        fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: 1 });
      }
    } else {
      // No rest args provided — pass empty array
      fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: 0 });
    }
    return;
  }

  // Non-rest target: fn(...arr) — unpack array elements into locals then push them
  // Strategy: for each spread arg, store the array in a local and extract elements by index
  // For simplicity, we handle the common case: fn(...arr) where arr has known length from the
  // function's parameter count.
  if (!paramTypes) return;

  // Collect all arguments, resolving spreads
  let paramIdx = 0;
  for (const arg of expr.arguments) {
    if (ts.isSpreadElement(arg)) {
      // Compile the spread source array
      const arrType = compileExpression(ctx, fctx, arg.expression);
      if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) continue;

      const arrTypeDef = ctx.mod.types[arrType.typeIdx];
      if (!arrTypeDef || arrTypeDef.kind !== "array") continue;

      // Store array in temp local
      const arrLocal = allocLocal(fctx, `__spread_arr_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: arrLocal });

      // Extract elements up to the remaining parameter count
      const remainingParams = paramTypes.length - paramIdx;
      for (let i = 0; i < remainingParams; i++) {
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "i32.const", value: i });
        fctx.body.push({ op: "array.get", typeIdx: arrType.typeIdx });
        paramIdx++;
      }
    } else {
      compileExpression(ctx, fctx, arg, paramTypes[paramIdx]);
      paramIdx++;
    }
  }
}

// ── Builtins ─────────────────────────────────────────────────────────

function compileConsoleLog(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  for (const arg of expr.arguments) {
    const argType = ctx.checker.getTypeAtLocation(arg);
    compileExpression(ctx, fctx, arg);

    if (isStringType(argType)) {
      const funcIdx = ctx.funcMap.get("console_log_string");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isBooleanType(argType)) {
      const funcIdx = ctx.funcMap.get("console_log_bool");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isNumberType(argType)) {
      const funcIdx = ctx.funcMap.get("console_log_number");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else {
      // externref: DOM objects, class instances, anything else
      const funcIdx = ctx.funcMap.get("console_log_externref");
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
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "f64.nearest" } as Instr);
    return { kind: "f64" };
  }

  if (method in nativeUnary && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: nativeUnary[method]! } as Instr);
    return { kind: "f64" };
  }

  if (method === "min" && expr.arguments.length >= 2) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
    const tmpA = allocLocal(fctx, `__min_a_${fctx.locals.length}`, { kind: "f64" });
    const tmpB = allocLocal(fctx, `__min_b_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: tmpB });
    fctx.body.push({ op: "local.set", index: tmpA });
    fctx.body.push({ op: "local.get", index: tmpA });
    fctx.body.push({ op: "local.get", index: tmpB });
    fctx.body.push({ op: "local.get", index: tmpA });
    fctx.body.push({ op: "local.get", index: tmpB });
    fctx.body.push({ op: "f64.lt" });
    fctx.body.push({ op: "select" });
    return { kind: "f64" };
  }

  if (method === "max" && expr.arguments.length >= 2) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
    const tmpA = allocLocal(fctx, `__max_a_${fctx.locals.length}`, { kind: "f64" });
    const tmpB = allocLocal(fctx, `__max_b_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: tmpB });
    fctx.body.push({ op: "local.set", index: tmpA });
    fctx.body.push({ op: "local.get", index: tmpA });
    fctx.body.push({ op: "local.get", index: tmpB });
    fctx.body.push({ op: "local.get", index: tmpA });
    fctx.body.push({ op: "local.get", index: tmpB });
    fctx.body.push({ op: "f64.gt" });
    fctx.body.push({ op: "select" });
    return { kind: "f64" };
  }

  if (method === "sign" && expr.arguments.length >= 1) {
    // sign(x) = x > 0 ? 1 : x < 0 ? -1 : 0
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    const tmp = allocLocal(fctx, `__sign_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.tee", index: tmp });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.gt" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: 1 }],
      else: [
        { op: "local.get", index: tmp },
        { op: "f64.const", value: 0 },
        { op: "f64.lt" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [{ op: "f64.const", value: -1 }],
          else: [{ op: "f64.const", value: 0 }],
        },
      ],
    });
    return { kind: "f64" };
  }

  // Host-imported Math methods (1-arg): sin, cos, tan, exp, log, etc.
  const hostUnary = new Set([
    "exp", "log", "log2", "log10",
    "sin", "cos", "tan", "asin", "acos", "atan",
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
  ensureI32Condition(fctx, condType);

  const savedBody = fctx.body;
  fctx.body = [];
  const thenResultType = compileExpression(ctx, fctx, expr.whenTrue);
  const thenInstrs = fctx.body;

  const resultValType: ValType = thenResultType ?? { kind: "i32" };

  // Pass the then-branch type as hint so else-branch fallback matches
  fctx.body = [];
  compileExpression(ctx, fctx, expr.whenFalse, resultValType);
  const elseInstrs = fctx.body;

  fctx.body = savedBody;

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
    const funcIdx = ctx.funcMap.get("length");
    if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
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
  const propName = expr.name.text;

  // Check for enum member access: EnumName.Member
  if (ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    const enumKey = `${objName}.${propName}`;
    const enumVal = ctx.enumValues.get(enumKey);
    if (enumVal !== undefined) {
      fctx.body.push({ op: "f64.const", value: enumVal });
      return { kind: "f64" };
    }
  }

  // Handle array.length
  if (propName === "length") {
    const objWasmType = resolveWasmType(ctx, objType);
    if (objWasmType.kind === "ref" || objWasmType.kind === "ref_null") {
      const typeDef = ctx.mod.types[(objWasmType as { typeIdx: number }).typeIdx];
      if (typeDef?.kind === "array") {
        compileExpression(ctx, fctx, expr.expression);
        fctx.body.push({ op: "array.len" });
        fctx.body.push({ op: "f64.convert_i32_s" });
        return { kind: "f64" };
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

  // Handle string.length
  if (isStringType(objType) && propName === "length") {
    compileExpression(ctx, fctx, expr.expression);
    const funcIdx = ctx.funcMap.get("length");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
  }

  // Handle externref property access
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    return compileExternPropertyGet(ctx, fctx, expr, objType, propName);
  }

  // Handle struct field access (named or anonymous)
  const typeName = resolveStructName(ctx, objType);
  if (typeName) {
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
      column: 0,
    });
    return null;
  }

  if (objType.kind !== "ref" && objType.kind !== "ref_null") {
    ctx.errors.push({
      message: "Element access on non-array value",
      line: getLine(expr),
      column: 0,
    });
    return null;
  }

  const typeIdx = (objType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "array") {
    ctx.errors.push({
      message: "Element access on non-array type",
      line: 0,
      column: 0,
    });
    return null;
  }

  // Compile index and convert to i32
  compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_f64_s" });

  fctx.body.push({ op: "array.get", typeIdx });
  return typeDef.element;
}

function resolveStructName(ctx: CodegenContext, tsType: ts.Type): string | undefined {
  const name = tsType.symbol?.name;
  if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) {
    return name;
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
    const typeName = resolveStructName(ctx, type);
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

  const typeName = resolveStructName(ctx, contextType);
  if (typeName) {
    return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
  }

  ctx.errors.push({
    message: "Object literal type not mapped to struct",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
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
          compileExpression(ctx, fctx, prop.expression);
          fctx.body.push({ op: "local.set", index: srcLocal });
          spreadSources.push({ local: srcLocal, srcStructTypeIdx, srcFields });
        }
      }
    }
  }

  for (const field of fields) {
    // First check for an explicit property assignment
    const prop = expr.properties.find(
      (p) =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === field.name,
    );
    if (prop && ts.isPropertyAssignment(prop)) {
      compileExpression(ctx, fctx, prop.initializer);
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
  return { kind: "ref", typeIdx: structTypeIdx };
}

function compileArrayLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
): ValType | null {
  if (expr.elements.length === 0) {
    // Empty array — try to determine element type from contextual type (e.g. number[])
    let emptyElemKind = "externref";
    const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
    if (ctxType) {
      const sym = (ctxType as ts.TypeReference).symbol ?? ctxType.symbol;
      if (sym?.name === "Array") {
        const typeArgs = ctx.checker.getTypeArguments(ctxType as ts.TypeReference);
        if (typeArgs[0]) {
          emptyElemKind = mapTsTypeToWasm(typeArgs[0], ctx.checker).kind;
        }
      }
    }
    const arrTypeIdx = getOrRegisterArrayType(ctx, emptyElemKind);
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: 0 });
    return { kind: "ref_null", typeIdx: arrTypeIdx };
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
  const arrTypeIdx = getOrRegisterArrayType(ctx, elemKind, elemWasm);

  if (!hasSpread) {
    // No spread — use the fast array.new_fixed path
    for (const el of expr.elements) {
      compileExpression(ctx, fctx, el, elemWasm);
    }
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: expr.elements.length });
    return { kind: "ref_null", typeIdx: arrTypeIdx };
  }

  // Has spread elements — compute total length, create array, then fill
  // Step 1: Compute total length and store spread sources in locals
  const spreadLocals: { local: number; elemIdx: number }[] = [];
  const nonSpreadCount = expr.elements.filter((el) => !ts.isSpreadElement(el)).length;

  // Push the non-spread count as the initial length
  fctx.body.push({ op: "i32.const", value: nonSpreadCount });

  // For each spread source, compile it, store in local, and add its length
  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isSpreadElement(el)) {
      const srcType = compileExpression(ctx, fctx, el.expression);
      if (!srcType || (srcType.kind !== "ref" && srcType.kind !== "ref_null")) continue;
      const srcLocal = allocLocal(fctx, `__spread_src_${fctx.locals.length}`, srcType);
      fctx.body.push({ op: "local.tee", index: srcLocal });
      fctx.body.push({ op: "array.len" });
      fctx.body.push({ op: "i32.add" }); // accumulate total length
      spreadLocals.push({ local: srcLocal, elemIdx: i });
    }
  }

  // Step 2: Create the result array with computed length, default-initialized
  const resultArrType: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
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

      const readIdx = allocLocal(fctx, `__spread_ri_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: readIdx });

      // loop: while readIdx < srcArr.len
      const loopBody: Instr[] = [];
      // Condition: readIdx >= srcArr.len → break
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "local.get", index: spreadInfo.local });
      loopBody.push({ op: "array.len" });
      loopBody.push({ op: "i32.ge_s" });
      loopBody.push({ op: "br_if", depth: 1 }); // break out of block
      // result[writeIdx] = src[readIdx]
      loopBody.push({ op: "local.get", index: resultLocal });
      loopBody.push({ op: "local.get", index: writeIdx });
      loopBody.push({ op: "local.get", index: spreadInfo.local });
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "array.get", typeIdx: arrTypeIdx });
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

  // Push the result array onto the stack
  fctx.body.push({ op: "local.get", index: resultLocal });
  return resultArrType;
}

// ── String operations ─────────────────────────────────────────────────

function compileStringLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
): ValType | null {
  const importName = ctx.stringLiteralMap.get(value);
  if (!importName) {
    ctx.errors.push({
      message: `String literal not registered: "${value}"`,
      line: 0,
      column: 0,
    });
    return null;
  }

  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) return null;

  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

function compileTemplateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TemplateExpression,
): ValType | null {
  const concatIdx = ctx.funcMap.get("concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  if (concatIdx === undefined) return null;

  // Start with the head text (may be empty string "")
  if (expr.head.text) {
    compileStringLiteral(ctx, fctx, expr.head.text);
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
      compileStringLiteral(ctx, fctx, span.literal.text);
      fctx.body.push({ op: "call", funcIdx: concatIdx });
    }
  }

  return { kind: "externref" };
}

function compileStringBinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  compileExpression(ctx, fctx, expr.left);
  compileExpression(ctx, fctx, expr.right);

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
  }

  ctx.errors.push({
    message: `Unsupported string operator: ${ts.SyntaxKind[op]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Array method calls (pure Wasm, no host imports) ─────────────────

/** Resolve array type info from a TS type. Returns null if not a Wasm GC array. */
function resolveArrayInfo(
  ctx: CodegenContext,
  tsType: ts.Type,
): { typeIdx: number; elemType: ValType } | null {
  const wasmType = resolveWasmType(ctx, tsType);
  if (wasmType.kind !== "ref" && wasmType.kind !== "ref_null") return null;
  const typeDef = ctx.mod.types[(wasmType as { typeIdx: number }).typeIdx];
  if (!typeDef || typeDef.kind !== "array") return null;
  return { typeIdx: (wasmType as { typeIdx: number }).typeIdx, elemType: typeDef.element };
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

const ARRAY_METHODS = new Set([
  "push", "pop", "shift", "indexOf", "includes",
  "slice", "concat", "join", "reverse", "splice",
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

  const { typeIdx, elemType } = arrInfo;

  // If receiver is a module global, proxy it through a temp local so
  // getReceiverLocalIdx succeeds and mutating methods can write back.
  let moduleGlobalIdx: number | undefined;
  let savedLocal: number | undefined;
  const MUTATING = new Set(["push", "pop", "shift", "reverse", "splice"]);
  if (ts.isIdentifier(propAccess.expression)) {
    const name = propAccess.expression.text;
    const gIdx = ctx.moduleGlobals.get(name);
    if (gIdx !== undefined && !fctx.localMap.has(name)) {
      moduleGlobalIdx = gIdx;
      const globalDef = ctx.mod.globals[gIdx];
      const tempLocal = allocLocal(fctx, `__mod_proxy_${name}`, globalDef!.type);
      fctx.body.push({ op: "global.get", index: gIdx });
      fctx.body.push({ op: "local.set", index: tempLocal });
      fctx.localMap.set(name, tempLocal);
      savedLocal = tempLocal;
    }
  }

  let result: ValType | null | undefined;
  switch (methodName) {
    case "indexOf":
      result = compileArrayIndexOf(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
    case "includes":
      result = compileArrayIncludes(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
    case "reverse":
      result = compileArrayReverse(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
    case "push":
      result = compileArrayPush(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
    case "pop":
      result = compileArrayPop(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
    case "shift":
      result = compileArrayShift(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
    case "slice":
      result = compileArraySlice(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
    case "concat":
      result = compileArrayConcat(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
    case "join":
      result = compileArrayJoin(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
    case "splice":
      result = compileArraySplice(ctx, fctx, propAccess, callExpr, typeIdx, elemType); break;
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

/** Helper: emit a block+loop copy from srcArr[srcOffset+i] to dstArr[dstOffset+i] for count iterations */
function emitArrayCopyLoop(
  fctx: FunctionContext,
  typeIdx: number,
  elemType: ValType,
  dstArr: number,
  dstOffset: number | null, // local index, or null for 0
  srcArr: number,
  srcOffset: number | null, // local index, or null for 0
  count: number, // local index holding iteration count
): void {
  const iTmp = allocLocal(fctx, `__cpy_i_${fctx.locals.length}`, { kind: "i32" });
  const getOp = elemType.kind === "i32" ? "array.get_s" : "array.get";

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: count },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // dst[dstOffset + i]
    { op: "local.get", index: dstArr },
    ...(dstOffset !== null
      ? [{ op: "local.get", index: dstOffset } as Instr, { op: "local.get", index: iTmp } as Instr, { op: "i32.add" } as Instr]
      : [{ op: "local.get", index: iTmp } as Instr]),

    // src[srcOffset + i]
    { op: "local.get", index: srcArr },
    ...(srcOffset !== null
      ? [{ op: "local.get", index: srcOffset } as Instr, { op: "local.get", index: iTmp } as Instr, { op: "i32.add" } as Instr]
      : [{ op: "local.get", index: iTmp } as Instr]),
    { op: getOp, typeIdx } as Instr,
    { op: "array.set", typeIdx },

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
}

/**
 * arr.indexOf(val) → loop through array, return index (as f64) or -1.
 */
function compileArrayIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "indexOf requires 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const arrTmp = allocLocal(fctx, `__arr_iof_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const iTmp = allocLocal(fctx, `__arr_iof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_iof_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_iof_val_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: arrTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  fctx.body.push({ op: "local.get", index: arrTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
  const getOp = elemType.kind === "i32" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: arrTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx } as Instr,
    { op: "local.get", index: valTmp },
    { op: eqOp } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: [
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

  fctx.body.push({ op: "f64.const", value: -1 });
  return { kind: "f64" };
}

/**
 * arr.includes(val) → like indexOf but returns i32 (0 or 1)
 */
function compileArrayIncludes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "includes requires 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const arrTmp = allocLocal(fctx, `__arr_inc_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const iTmp = allocLocal(fctx, `__arr_inc_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_inc_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_inc_val_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: arrTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  fctx.body.push({ op: "local.get", index: arrTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
  const getOp = elemType.kind === "i32" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: arrTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx } as Instr,
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
 * arr.reverse() → swap elements in place, return same array ref.
 */
function compileArrayReverse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType {
  const arrTmp = allocLocal(fctx, `__arr_rev_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const iTmp = allocLocal(fctx, `__arr_rev_i_${fctx.locals.length}`, { kind: "i32" });
  const jTmp = allocLocal(fctx, `__arr_rev_j_${fctx.locals.length}`, { kind: "i32" });
  const swapTmp = allocLocal(fctx, `__arr_rev_sw_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: arrTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  fctx.body.push({ op: "local.get", index: arrTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: jTmp });

  const getOp = elemType.kind === "i32" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: jTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // swap = arr[i]
    { op: "local.get", index: arrTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx } as Instr,
    { op: "local.set", index: swapTmp },

    // arr[i] = arr[j]
    { op: "local.get", index: arrTmp },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: arrTmp },
    { op: "local.get", index: jTmp },
    { op: getOp, typeIdx } as Instr,
    { op: "array.set", typeIdx },

    // arr[j] = swap
    { op: "local.get", index: arrTmp },
    { op: "local.get", index: jTmp },
    { op: "local.get", index: swapTmp },
    { op: "array.set", typeIdx },

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

  fctx.body.push({ op: "local.get", index: arrTmp });
  return { kind: "ref_null", typeIdx };
}

/**
 * arr.push(val) → create new array of len+1, copy, set last = val,
 * reassign receiver local, return new length as f64.
 */
function compileArrayPush(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "push requires at least 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const receiverLocal = getReceiverLocalIdx(fctx, propAccess.expression);
  if (receiverLocal === null) {
    ctx.errors.push({ message: "push requires a local variable receiver", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const oldArr = allocLocal(fctx, `__arr_push_old_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const newArr = allocLocal(fctx, `__arr_push_new_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const lenTmp = allocLocal(fctx, `__arr_push_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_push_val_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: oldArr });

  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // len = array.len(old)
  fctx.body.push({ op: "local.get", index: oldArr });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // new_arr = array.new_default(len + 1)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "array.new_default", typeIdx });
  fctx.body.push({ op: "local.set", index: newArr });

  // Copy old elements
  emitArrayCopyLoop(fctx, typeIdx, elemType, newArr, null, oldArr, null, lenTmp);

  // new_arr[len] = val
  fctx.body.push({ op: "local.get", index: newArr });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: valTmp });
  fctx.body.push({ op: "array.set", typeIdx });

  // Reassign receiver local
  fctx.body.push({ op: "local.get", index: newArr });
  fctx.body.push({ op: "local.set", index: receiverLocal });

  // Return new length as f64
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "f64.convert_i32_s" });
  return { kind: "f64" };
}

/**
 * arr.pop() → get last element, create new array of len-1, copy, reassign, return element.
 */
function compileArrayPop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType | null {
  const receiverLocal = getReceiverLocalIdx(fctx, propAccess.expression);
  if (receiverLocal === null) {
    ctx.errors.push({ message: "pop requires a local variable receiver", line: getLine(propAccess), column: getCol(propAccess) });
    return null;
  }

  const oldArr = allocLocal(fctx, `__arr_pop_old_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const newArr = allocLocal(fctx, `__arr_pop_new_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const lenTmp = allocLocal(fctx, `__arr_pop_len_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_pop_nl_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_pop_res_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: oldArr });

  fctx.body.push({ op: "local.get", index: oldArr });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // result = old[len - 1]
  const getOp = elemType.kind === "i32" ? "array.get_s" : "array.get";
  fctx.body.push({ op: "local.get", index: oldArr });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: getOp, typeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: resultTmp });

  // newLen = len - 1
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: newLenTmp });

  // new_arr = array.new_default(newLen)
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx });
  fctx.body.push({ op: "local.set", index: newArr });

  // Copy old elements [0, newLen)
  emitArrayCopyLoop(fctx, typeIdx, elemType, newArr, null, oldArr, null, newLenTmp);

  // Reassign receiver
  fctx.body.push({ op: "local.get", index: newArr });
  fctx.body.push({ op: "local.set", index: receiverLocal });

  fctx.body.push({ op: "local.get", index: resultTmp });
  return elemType;
}

/**
 * arr.shift() → get first element, create new array of len-1, copy from [1..], reassign, return element.
 */
function compileArrayShift(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType | null {
  const receiverLocal = getReceiverLocalIdx(fctx, propAccess.expression);
  if (receiverLocal === null) {
    ctx.errors.push({ message: "shift requires a local variable receiver", line: getLine(propAccess), column: getCol(propAccess) });
    return null;
  }

  const oldArr = allocLocal(fctx, `__arr_sft_old_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const newArr = allocLocal(fctx, `__arr_sft_new_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const lenTmp = allocLocal(fctx, `__arr_sft_len_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_sft_nl_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_sft_res_${fctx.locals.length}`, elemType);
  const oneTmp = allocLocal(fctx, `__arr_sft_one_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: oldArr });

  fctx.body.push({ op: "local.get", index: oldArr });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // result = old[0]
  const getOp = elemType.kind === "i32" ? "array.get_s" : "array.get";
  fctx.body.push({ op: "local.get", index: oldArr });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: getOp, typeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: resultTmp });

  // newLen = len - 1
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: newLenTmp });

  // new_arr = array.new_default(newLen)
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx });
  fctx.body.push({ op: "local.set", index: newArr });

  // Copy from old[1..] to new[0..]: srcOffset = 1
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: oneTmp });
  emitArrayCopyLoop(fctx, typeIdx, elemType, newArr, null, oldArr, oneTmp, newLenTmp);

  // Reassign receiver
  fctx.body.push({ op: "local.get", index: newArr });
  fctx.body.push({ op: "local.set", index: receiverLocal });

  fctx.body.push({ op: "local.get", index: resultTmp });
  return elemType;
}

/**
 * arr.slice(start?, end?) → create new sub-array
 */
function compileArraySlice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType {
  const arrTmp = allocLocal(fctx, `__arr_slc_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const newArr = allocLocal(fctx, `__arr_slc_new_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const startTmp = allocLocal(fctx, `__arr_slc_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_slc_e_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_slc_len_${fctx.locals.length}`, { kind: "i32" });
  const sliceLenTmp = allocLocal(fctx, `__arr_slc_sl_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: arrTmp });

  fctx.body.push({ op: "local.get", index: arrTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });

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

  fctx.body.push({ op: "local.get", index: sliceLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx });
  fctx.body.push({ op: "local.set", index: newArr });

  // Copy: new[i] = old[start + i] for i in [0, sliceLen)
  emitArrayCopyLoop(fctx, typeIdx, elemType, newArr, null, arrTmp, startTmp, sliceLenTmp);

  fctx.body.push({ op: "local.get", index: newArr });
  return { kind: "ref_null", typeIdx };
}

/**
 * arr.concat(other) → create new array of combined length, copy both
 */
function compileArrayConcat(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "concat requires at least 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const arrA = allocLocal(fctx, `__arr_cat_a_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const arrB = allocLocal(fctx, `__arr_cat_b_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const newArr = allocLocal(fctx, `__arr_cat_new_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const lenA = allocLocal(fctx, `__arr_cat_la_${fctx.locals.length}`, { kind: "i32" });
  const lenB = allocLocal(fctx, `__arr_cat_lb_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: arrA });

  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.set", index: arrB });

  fctx.body.push({ op: "local.get", index: arrA });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenA });

  fctx.body.push({ op: "local.get", index: arrB });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenB });

  // new_arr = array.new_default(lenA + lenB)
  fctx.body.push({ op: "local.get", index: lenA });
  fctx.body.push({ op: "local.get", index: lenB });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "array.new_default", typeIdx });
  fctx.body.push({ op: "local.set", index: newArr });

  // Copy A: new[i] = A[i] for i in [0, lenA)
  emitArrayCopyLoop(fctx, typeIdx, elemType, newArr, null, arrA, null, lenA);

  // Copy B: new[lenA + i] = B[i] for i in [0, lenB)
  emitArrayCopyLoop(fctx, typeIdx, elemType, newArr, lenA, arrB, null, lenB);

  fctx.body.push({ op: "local.get", index: newArr });
  return { kind: "ref_null", typeIdx };
}

/**
 * arr.join(sep?) → convert elements to strings and concatenate.
 * Requires number_toString and wasm:js-string concat imports.
 */
function compileArrayJoin(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType | null {
  const concatIdx = ctx.funcMap.get("concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  if (concatIdx === undefined) {
    ctx.errors.push({ message: "join requires string support (wasm:js-string concat)", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const arrTmp = allocLocal(fctx, `__arr_join_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const lenTmp = allocLocal(fctx, `__arr_join_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_join_i_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_join_res_${fctx.locals.length}`, { kind: "externref" });
  const sepTmp = allocLocal(fctx, `__arr_join_sep_${fctx.locals.length}`, { kind: "externref" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: arrTmp });

  // separator
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!);
  } else {
    // Default separator "," — check if registered
    const commaImport = ctx.stringLiteralMap.get(",");
    if (commaImport) {
      const funcIdx = ctx.funcMap.get(commaImport);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
  }
  fctx.body.push({ op: "local.set", index: sepTmp });

  fctx.body.push({ op: "local.get", index: arrTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // result starts as null (empty)
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "local.set", index: resultTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i32" ? "array.get_s" : "array.get";

  // Build element-to-string instructions
  const elemToStr: Instr[] = [
    { op: "local.get", index: arrTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx } as Instr,
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
 * arr.splice(start, deleteCount?) → basic implementation without item insertion.
 * Returns array of deleted elements. Reassigns receiver.
 */
function compileArraySplice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  typeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    ctx.errors.push({ message: "splice requires at least 1 argument", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const receiverLocal = getReceiverLocalIdx(fctx, propAccess.expression);
  if (receiverLocal === null) {
    ctx.errors.push({ message: "splice requires a local variable receiver", line: getLine(callExpr), column: getCol(callExpr) });
    return null;
  }

  const oldArr = allocLocal(fctx, `__arr_spl_old_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const newArr = allocLocal(fctx, `__arr_spl_new_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const delArr = allocLocal(fctx, `__arr_spl_del_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
  const lenTmp = allocLocal(fctx, `__arr_spl_len_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_spl_s_${fctx.locals.length}`, { kind: "i32" });
  const delCountTmp = allocLocal(fctx, `__arr_spl_dc_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_spl_nl_${fctx.locals.length}`, { kind: "i32" });
  const tailLenTmp = allocLocal(fctx, `__arr_spl_tl_${fctx.locals.length}`, { kind: "i32" });
  const tailStartTmp = allocLocal(fctx, `__arr_spl_ts_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: oldArr });

  fctx.body.push({ op: "local.get", index: oldArr });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // start
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

  // Create deleted elements array and copy
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "array.new_default", typeIdx });
  fctx.body.push({ op: "local.set", index: delArr });

  emitArrayCopyLoop(fctx, typeIdx, elemType, delArr, null, oldArr, startTmp, delCountTmp);

  // newLen = len - delCount
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: newLenTmp });

  // Create new array
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx });
  fctx.body.push({ op: "local.set", index: newArr });

  // Copy [0, start) from old to new
  emitArrayCopyLoop(fctx, typeIdx, elemType, newArr, null, oldArr, null, startTmp);

  // Copy [start + delCount, len) from old to new[start..]
  // tailStart = start + delCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: tailStartTmp });

  // tailLen = len - tailStart
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: tailStartTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailLenTmp });

  emitArrayCopyLoop(fctx, typeIdx, elemType, newArr, startTmp, oldArr, tailStartTmp, tailLenTmp);

  // Reassign receiver
  fctx.body.push({ op: "local.get", index: newArr });
  fctx.body.push({ op: "local.set", index: receiverLocal });

  // Return deleted array
  fctx.body.push({ op: "local.get", index: delArr });
  return { kind: "ref_null", typeIdx };
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
