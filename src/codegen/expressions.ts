import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import { allocLocal, resolveWasmType, getOrRegisterArrayType, addFuncType } from "./index.js";
import {
  mapTsTypeToWasm,
  isNumberType,
  isBooleanType,
  isStringType,
  isVoidType,
  isExternalDeclaredClass,
} from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
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
      coerceType(fctx, result, expectedType);
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
function coerceType(fctx: FunctionContext, from: ValType, to: ValType): void {
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
  // i32/f64 → externref
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

function compileArrowFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  const cbId = ctx.callbackCounter++;
  const cbName = `__cb_${cbId}`;

  // 1. Analyze captured variables: identifiers in body that resolve to locals in fctx
  const referencedNames = new Set<string>();
  const body = arrow.body;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames);
  }

  // Build capture list: names that are locals/params in the enclosing function
  const captures: { name: string; type: ValType; localIdx: number }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    // Skip if it's a function name (not a variable)
    if (ctx.funcMap.has(name)) continue;
    const type = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" };
    captures.push({ name, type, localIdx });
  }

  // 2. Promote captured variables to mutable globals
  for (const cap of captures) {
    if (!ctx.capturedGlobals.has(cap.name)) {
      const globalIdx = ctx.mod.globals.length;
      const init: Instr[] = cap.type.kind === "f64"
        ? [{ op: "f64.const", value: 0 }]
        : cap.type.kind === "i32"
          ? [{ op: "i32.const", value: 0 }]
          : [{ op: "ref.null.extern" }];
      ctx.mod.globals.push({
        name: `__cap_${cap.name}`,
        type: cap.type,
        mutable: true,
        init,
      });
      ctx.capturedGlobals.set(cap.name, globalIdx);
    }
  }

  // 3. Emit global.set in enclosing function to initialize captured globals from locals
  for (const cap of captures) {
    const globalIdx = ctx.capturedGlobals.get(cap.name)!;
    fctx.body.push({ op: "local.get", index: cap.localIdx });
    fctx.body.push({ op: "global.set", index: globalIdx });
  }

  // 4. Also rewrite enclosing function: any local.get/set for captured vars
  //    must use global.get/set from now on. We do this by updating localMap
  //    to point to a sentinel, and patching compileIdentifier/compileAssignment
  //    via the capturedGlobals map (they check it before localMap).
  //    Actually, the simpler approach: we leave localMap intact, but the
  //    enclosing function already compiled its earlier code with local.get/set.
  //    After the arrow function point, the enclosing code should also use globals.
  //    For now, we don't rewrite the enclosing function's subsequent code -
  //    we rely on the pattern that captured vars are typically set before the
  //    callback and read inside it. The global.set above syncs the value.

  // 5. Create the callback WasmFunction
  const cbParams: ValType[] = [];
  // Arrow function parameters
  for (const p of arrow.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    cbParams.push(resolveWasmType(ctx, paramType));
  }

  // Determine return type
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

  // Build callback function context
  const cbFctx: FunctionContext = {
    name: cbName,
    params: arrow.parameters.map((p, i) => ({
      name: (p.name as ts.Identifier).text,
      type: cbParams[i]!,
    })),
    locals: [],
    localMap: new Map(),
    returnType: cbReturnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
  };

  // Register params as locals
  for (let i = 0; i < cbFctx.params.length; i++) {
    cbFctx.localMap.set(cbFctx.params[i]!.name, i);
  }

  // Set current function context for the callback compilation
  const savedFunc = ctx.currentFunc;
  ctx.currentFunc = cbFctx;

  // Compile the callback body
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, cbFctx, stmt);
    }
  } else {
    // Expression body: compile and drop if void, or leave on stack
    const exprType = compileExpression(ctx, cbFctx, body);
    if (exprType !== null && cbReturnType) {
      // Expression result is the return value - already on stack
    } else if (exprType !== null) {
      cbFctx.body.push({ op: "drop" });
    }
  }

  // Ensure return value for non-void callbacks
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

  // Register the callback function
  const cbFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const cbFunc: WasmFunction = {
    name: cbName,
    typeIdx: cbTypeIdx,
    locals: cbFctx.locals,
    body: cbFctx.body,
    exported: true,
  };
  ctx.mod.functions.push(cbFunc);
  ctx.funcMap.set(cbName, cbFuncIdx);

  // Export the callback
  ctx.mod.exports.push({
    name: cbName,
    desc: { kind: "func", index: cbFuncIdx },
  });

  // 6. Emit i32.const cbId + call __make_callback → externref
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
    // Determine type from params or locals
    if (localIdx < fctx.params.length) {
      return fctx.params[localIdx]!.type;
    }
    const localDef = fctx.locals[localIdx - fctx.params.length];
    return localDef?.type ?? { kind: "f64" };
  }

  // Check captured globals (variables promoted from enclosing scope for callbacks)
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: capturedIdx });
    const globalDef = ctx.mod.globals[capturedIdx];
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
    op === ts.SyntaxKind.SlashToken ||
    op === ts.SyntaxKind.PercentToken ||
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken;
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
    default:
      ctx.errors.push({
        message: `Unsupported numeric binary operator: ${ts.SyntaxKind[op]}`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return { kind: "f64" };
  }
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
  if (isExternalDeclaredClass(objType)) {
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
    op === ts.SyntaxKind.SlashEqualsToken
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
      case ts.SyntaxKind.SlashEqualsToken:
        fctx.body.push({ op: "f64.div" });
        break;
    }

    fctx.body.push({ op: "global.set", index: capturedIdx });
    fctx.body.push({ op: "global.get", index: capturedIdx });
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
    case ts.SyntaxKind.SlashEqualsToken:
      fctx.body.push({ op: "f64.div" });
      break;
  }

  fctx.body.push({ op: "local.tee", index: localIdx });
  return { kind: "f64" };
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
    if (isExternalDeclaredClass(receiverType)) {
      return compileExternMethodCall(ctx, fctx, propAccess, expr);
    }

    // Primitive method calls: number.toString()
    if (isNumberType(receiverType) && propAccess.name.text === "toString") {
      compileExpression(ctx, fctx, propAccess.expression);
      const funcIdx = ctx.funcMap.get("number_toString");
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
    const funcIdx = ctx.funcMap.get(funcName);
    if (funcIdx === undefined) {
      ctx.errors.push({
        message: `Unknown function: ${funcName}`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    // Compile provided arguments with type hints from function signature
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
    default:
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
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
  if (isExternalDeclaredClass(tsObjType)) {
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
  if (isExternalDeclaredClass(tsReceiverType)) {
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
  if (isExternalDeclaredClass(objType)) {
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
  if (!objType || (objType.kind !== "ref" && objType.kind !== "ref_null")) {
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

  for (const field of fields) {
    const prop = expr.properties.find(
      (p) =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === field.name,
    );
    if (prop && ts.isPropertyAssignment(prop)) {
      compileExpression(ctx, fctx, prop.initializer);
    } else {
      if (field.type.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else {
        fctx.body.push({ op: "i32.const", value: 0 });
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
    // Empty array — default to externref element type
    const arrTypeIdx = getOrRegisterArrayType(ctx, "externref");
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: 0 });
    return { kind: "ref", typeIdx: arrTypeIdx };
  }

  // Determine element type from first element
  const firstElemType = ctx.checker.getTypeAtLocation(expr.elements[0]!);
  const elemWasm = mapTsTypeToWasm(firstElemType, ctx.checker);
  const elemKind = elemWasm.kind;
  const arrTypeIdx = getOrRegisterArrayType(ctx, elemKind);

  // Push all elements onto stack
  for (const el of expr.elements) {
    compileExpression(ctx, fctx, el, elemWasm);
  }

  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: expr.elements.length });
  return { kind: "ref", typeIdx: arrTypeIdx };
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
