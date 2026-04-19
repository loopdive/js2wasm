// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Per-function selector — decides which functions to route through the IR
// path vs. the legacy direct AST→Wasm emission.
//
// Phase 1 numeric/bool subset: a function is claimed when
//   - all params are typed `number` or `boolean`;
//   - return type is typed `number` or `boolean`;
//   - body is exactly `return <expr>;`;
//   - `<expr>` is composed only of literals, param references, and the
//     supported unary / binary operators (see `isPhase1Expr`).
//
// Any function that deviates from this shape falls through to the legacy
// path — the IR cannot handle it yet. Widening the selector in lockstep
// with the builder/lower passes is how Phase 1 grows.

import ts from "typescript";

export interface IrSelection {
  readonly funcs: ReadonlySet<string>;
}

export interface IrSelectionOptions {
  readonly experimentalIR?: boolean;
}

const EMPTY: IrSelection = { funcs: new Set<string>() };

export function planIrCompilation(sourceFile: ts.SourceFile, options?: IrSelectionOptions): IrSelection {
  if (!options?.experimentalIR) return EMPTY;

  const funcs = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (!stmt.name) continue;
    if (!isPhase1Function(stmt)) continue;
    funcs.add(stmt.name.text);
  }
  return { funcs };
}

function isPhase1Function(fn: ts.FunctionDeclaration): boolean {
  if (fn.typeParameters && fn.typeParameters.length > 0) return false;
  if (fn.modifiers && fn.modifiers.some((m) => m.kind !== ts.SyntaxKind.ExportKeyword)) return false;
  if (!fn.type || !isPhase1TypeNode(fn.type)) return false;

  const paramNames = new Set<string>();
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name)) return false;
    if (p.questionToken) return false;
    if (p.dotDotDotToken) return false;
    if (p.initializer) return false;
    if (!p.type || !isPhase1TypeNode(p.type)) return false;
    paramNames.add(p.name.text);
  }

  const body = fn.body;
  if (!body) return false;
  if (body.statements.length !== 1) return false;
  const ret = body.statements[0];
  if (!ts.isReturnStatement(ret)) return false;
  if (!ret.expression) return false;
  return isPhase1Expr(ret.expression, paramNames);
}

function isPhase1TypeNode(node: ts.TypeNode): boolean {
  return node.kind === ts.SyntaxKind.NumberKeyword || node.kind === ts.SyntaxKind.BooleanKeyword;
}

function isPhase1Expr(expr: ts.Expression, paramNames: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedExpression(expr)) return isPhase1Expr(expr.expression, paramNames);
  if (ts.isNumericLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(expr)) return paramNames.has(expr.text);
  if (ts.isPrefixUnaryExpression(expr)) {
    if (!isPhase1PrefixOp(expr.operator)) return false;
    return isPhase1Expr(expr.operand, paramNames);
  }
  if (ts.isBinaryExpression(expr)) {
    if (!isPhase1BinaryOp(expr.operatorToken.kind)) return false;
    return isPhase1Expr(expr.left, paramNames) && isPhase1Expr(expr.right, paramNames);
  }
  return false;
}

function isPhase1PrefixOp(op: ts.PrefixUnaryOperator): boolean {
  return op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.ExclamationToken;
}

function isPhase1BinaryOp(op: ts.SyntaxKind): boolean {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandToken:
    case ts.SyntaxKind.BarBarToken:
      return true;
    default:
      return false;
  }
}
