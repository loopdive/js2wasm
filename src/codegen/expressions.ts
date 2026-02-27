import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import { allocLocal } from "./index.js";
import {
  isNumberType,
  isBooleanType,
  isVoidType,
} from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";

/**
 * Compile an expression, pushing its result onto the Wasm stack.
 * Returns the Wasm type of the result.
 */
export function compileExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): ValType | null {
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text);
    fctx.body.push({ op: "f64.const", value });
    return { kind: "f64" };
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
    return compileExpression(ctx, fctx, expr.expression);
  }

  if (ts.isCallExpression(expr)) {
    return compileCallExpression(ctx, fctx, expr);
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
    return compileExpression(ctx, fctx, expr.expression);
  }

  if (ts.isNonNullExpression(expr)) {
    return compileExpression(ctx, fctx, expr.expression);
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
  const leftType = compileExpression(ctx, fctx, expr.left);
  const rightType = compileExpression(ctx, fctx, expr.right);

  if (!leftType || !rightType) return null;

  const tsType = ctx.checker.getTypeAtLocation(expr.left);

  if (isNumberType(tsType) || leftType.kind === "f64") {
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
  if (isBooleanType(tsType) || leftType.kind === "i32") {
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
      // a % b = a - floor(a/b) * b
      // Stack has [a, b]. We need a fresh approach:
      // We need a and b available multiple times. Use locals.
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
  // Stack currently has [a, b] from the caller having compiled both operands.
  // We need: a - floor(a/b) * b
  // Problem: we need a and b multiple times. Pop them into temp locals.
  const tmpB = allocLocal(fctx, `__mod_b_${fctx.locals.length}`, { kind: "f64" });
  const tmpA = allocLocal(fctx, `__mod_a_${fctx.locals.length}`, { kind: "f64" });

  // Stack: [a, b]
  fctx.body.push({ op: "local.set", index: tmpB }); // b saved
  fctx.body.push({ op: "local.set", index: tmpA }); // a saved

  // a - floor(a / b) * b
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
  // Short-circuit: if left is false, result is 0; else evaluate right
  compileExpression(ctx, fctx, expr.left);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: (() => {
      const saved = fctx.body;
      fctx.body = [];
      compileExpression(ctx, fctx, expr.right);
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
  // Short-circuit: if left is true, result is 1; else evaluate right
  compileExpression(ctx, fctx, expr.left);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 1 } as Instr],
    else: (() => {
      const saved = fctx.body;
      fctx.body = [];
      compileExpression(ctx, fctx, expr.right);
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
      const resultType = compileExpression(ctx, fctx, expr.right);
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

  ctx.errors.push({
    message: "Unsupported assignment target",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

function compilePropertyAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const typeName = objType.symbol?.name;
  if (!typeName) return null;

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) return null;

  const fieldName = target.name.text;
  const fieldIdx = fields.findIndex((f) => f.name === fieldName);
  if (fieldIdx === -1) return null;

  // Compile: obj value struct.set
  compileExpression(ctx, fctx, target.expression);
  const resultType = compileExpression(ctx, fctx, value);
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  // struct.set doesn't leave value on stack, but assignment expressions should.
  // For simplicity in statement context this is fine. If needed as expression,
  // the caller should handle.
  return null;
}

function compileElementAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
): ValType | null {
  // array[idx] = value
  // TODO: Implement array element assignment with GC arrays
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

  // Load current value
  fctx.body.push({ op: "local.get", index: localIdx });
  // Compile right side
  compileExpression(ctx, fctx, expr.right);

  // Apply operation
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

  // Store and leave value on stack
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
      compileExpression(ctx, fctx, expr.operand);
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

  // Return old value, then update
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

function compileCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  // Handle console.log
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const propAccess = expr.expression;
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "console" &&
      propAccess.name.text === "log"
    ) {
      return compileConsoleLog(ctx, fctx, expr);
    }

    // Handle Math.xxx
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Math"
    ) {
      return compileMathCall(ctx, fctx, propAccess.name.text, expr);
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

    // Compile arguments
    for (const arg of expr.arguments) {
      compileExpression(ctx, fctx, arg);
    }

    fctx.body.push({ op: "call", funcIdx });

    // Determine return type from function signature
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (isVoidType(retType)) return null;
      return { kind: isNumberType(retType) ? "f64" : isBooleanType(retType) ? "i32" : "f64" };
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

function compileConsoleLog(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  for (const arg of expr.arguments) {
    const argType = ctx.checker.getTypeAtLocation(arg);
    compileExpression(ctx, fctx, arg);

    if (isBooleanType(argType)) {
      const funcIdx = ctx.funcMap.get("console_log_bool");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else {
      // Default to number logging
      const funcIdx = ctx.funcMap.get("console_log_number");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    }
  }
  return null; // console.log returns void
}

function compileMathCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  expr: ts.CallExpression,
): ValType | null {
  switch (method) {
    case "sqrt":
      if (expr.arguments.length >= 1) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
        fctx.body.push({ op: "f64.sqrt" });
        return { kind: "f64" };
      }
      break;
    case "abs":
      if (expr.arguments.length >= 1) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
        fctx.body.push({ op: "f64.abs" });
        return { kind: "f64" };
      }
      break;
    case "floor":
      if (expr.arguments.length >= 1) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
        fctx.body.push({ op: "f64.floor" });
        return { kind: "f64" };
      }
      break;
    case "ceil":
      if (expr.arguments.length >= 1) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
        fctx.body.push({ op: "f64.ceil" });
        return { kind: "f64" };
      }
      break;
    case "min":
      if (expr.arguments.length >= 2) {
        // min(a, b) = if a < b then a else b
        compileExpression(ctx, fctx, expr.arguments[0]!);
        compileExpression(ctx, fctx, expr.arguments[1]!);
        // Use select: a b (a < b) select
        // We need a and b available twice. Use temp locals.
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
      break;
    case "max":
      if (expr.arguments.length >= 2) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
        compileExpression(ctx, fctx, expr.arguments[1]!);
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
      break;
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
  // condition ? then : else
  compileExpression(ctx, fctx, expr.condition);

  // Determine result type
  const thenType = ctx.checker.getTypeAtLocation(expr.whenTrue);
  const resultValType: ValType = isNumberType(thenType)
    ? { kind: "f64" }
    : { kind: "i32" };

  // Compile then branch in isolation
  const savedBody = fctx.body;
  fctx.body = [];
  compileExpression(ctx, fctx, expr.whenTrue);
  const thenInstrs = fctx.body;

  // Compile else branch in isolation
  fctx.body = [];
  compileExpression(ctx, fctx, expr.whenFalse);
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

function compilePropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(expr.expression);
  const propName = expr.name.text;

  // Handle Math.PI etc (constants)
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Math"
  ) {
    if (propName === "PI") {
      fctx.body.push({ op: "f64.const", value: Math.PI });
      return { kind: "f64" };
    }
  }

  // Handle struct field access
  const typeName = objType.symbol?.name;
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

function compileElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  // TODO: Implement array element access with GC arrays
  ctx.errors.push({
    message: "Array element access not yet supported",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

function compileObjectLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  // Determine the target struct type from the contextual type
  const contextType = ctx.checker.getContextualType(expr);
  if (!contextType) {
    // Try getting type at location
    const type = ctx.checker.getTypeAtLocation(expr);
    const typeName = type.symbol?.name;
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

  const typeName = contextType.symbol?.name;
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

  // Push field values in order
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
      // Default value
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
  // TODO: Implement array literals with GC arrays
  ctx.errors.push({
    message: "Array literals not yet supported",
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
