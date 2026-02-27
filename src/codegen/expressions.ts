import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import { allocLocal, resolveWasmType } from "./index.js";
import {
  mapTsTypeToWasm,
  isNumberType,
  isBooleanType,
  isStringType,
  isVoidType,
  isExternalDeclaredClass,
} from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { ensureI32Condition } from "./index.js";

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

  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32" };
  }

  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
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

  ctx.errors.push({
    message: `Unsupported expression: ${ts.SyntaxKind[expr.kind]}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
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

  // Could be a global or constant reference
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

  const externInfo = ctx.externClasses.get(className);
  if (!externInfo) {
    ctx.errors.push({
      message: `Unknown extern class: ${className}`,
      line: getLine(target),
      column: getCol(target),
    });
    return null;
  }

  // Push object, then value (with type hint from property type)
  compileExpression(ctx, fctx, target.expression);
  const propInfo = externInfo.properties.get(propName);
  compileExpression(ctx, fctx, value, propInfo?.type);

  const importName = `${externInfo.importPrefix}_set_${propName}`;
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
  ctx.errors.push({
    message: "Array element assignment not yet supported",
    line: getLine(target),
    column: getCol(target),
  });
  return null;
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

  const externInfo = ctx.externClasses.get(className);
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
  const methodInfo = externInfo.methods.get(methodName);
  for (let i = 0; i < callExpr.arguments.length; i++) {
    const hint = methodInfo?.params[i + 1]; // +1 to skip 'this'
    compileExpression(ctx, fctx, callExpr.arguments[i]!, hint);
  }

  const importName = `${externInfo.importPrefix}_${methodName}`;
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
    } else {
      const funcIdx = ctx.funcMap.get("console_log_number");
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

// ── Property access ──────────────────────────────────────────────────

function compilePropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(expr.expression);
  const propName = expr.name.text;

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

  const externInfo = ctx.externClasses.get(className);
  if (!externInfo) return null;

  // Push the object
  compileExpression(ctx, fctx, expr.expression);

  const importName = `${externInfo.importPrefix}_get_${propName}`;
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

  const propInfo = externInfo.properties.get(propName);
  return propInfo?.type ?? { kind: "externref" };
}

function compileElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  ctx.errors.push({
    message: "Array element access not yet supported",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
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
  ctx.errors.push({
    message: "Array literals not yet supported",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
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
