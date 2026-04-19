// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// AST → IR lowering.
//
// Phase 1 numeric/bool subset. The selector in `select.ts` restricts us to
// functions whose params are number/boolean, whose return type is
// number/boolean, and whose body is `(let|const <id> = <expr>;)* return <expr>;`.
// `<expr>` may be:
//   - NumericLiteral / TrueKeyword / FalseKeyword
//   - Identifier referring to a parameter or a previously-declared local
//   - BinaryExpression with an arithmetic / comparison / logical operator
//   - PrefixUnaryExpression with `-`, `+`, `!`
//   - ParenthesizedExpression (unwrap)
//
// Everything else throws — the selector must keep those functions on the
// legacy path.

import ts from "typescript";

import { IrFunctionBuilder } from "./builder.js";
import type { IrBinop, IrFunction, IrType, IrUnop, IrValueId } from "./nodes.js";

export interface AstToIrOptions {
  readonly exported?: boolean;
}

export function lowerFunctionAstToIr(fn: ts.FunctionDeclaration, options: AstToIrOptions = {}): IrFunction {
  if (!fn.name) {
    throw new Error("ir/from-ast: function declaration without a name");
  }
  if (!fn.body) {
    throw new Error(`ir/from-ast: function ${fn.name.text} has no body`);
  }

  const name = fn.name.text;
  const returnType = typeNodeToIr(fn.type, `return type of ${name}`);
  const params: { name: string; type: IrType }[] = fn.parameters.map((p) => {
    if (!ts.isIdentifier(p.name)) {
      throw new Error(`ir/from-ast: destructuring params not supported in Phase 1 (${name})`);
    }
    return { name: p.name.text, type: typeNodeToIr(p.type, `param ${p.name.text} of ${name}`) };
  });

  const builder = new IrFunctionBuilder(name, [returnType], options.exported ?? false);

  // Single scope map for both params and let/const locals. Phase 1 forbids
  // shadowing (enforced by the selector) so there is no nesting to track.
  const scope = new Map<string, { value: IrValueId; type: IrType }>();
  for (const p of params) {
    const v = builder.addParam(p.name, p.type);
    scope.set(p.name, { value: v, type: p.type });
  }

  builder.openBlock();

  const stmts = fn.body.statements;
  if (stmts.length < 1) {
    throw new Error(`ir/from-ast: Phase 1 expects at least 1 statement in ${name}`);
  }

  const cx: LowerCtx = { builder, scope, funcName: name };

  for (let i = 0; i < stmts.length - 1; i++) {
    const s = stmts[i];
    if (!ts.isVariableStatement(s)) {
      throw new Error(
        `ir/from-ast: Phase 1 expects a VariableStatement before the return (got ${ts.SyntaxKind[s.kind]} in ${name})`,
      );
    }
    lowerVarDecl(s, cx);
  }

  const last = stmts[stmts.length - 1];
  if (!ts.isReturnStatement(last) || !last.expression) {
    throw new Error(`ir/from-ast: Phase 1 expects a trailing return with expression in ${name}`);
  }

  const returned = lowerExpr(last.expression, cx, returnType);
  builder.terminate({ kind: "return", values: [returned] });

  return builder.finish();
}

interface LowerCtx {
  readonly builder: IrFunctionBuilder;
  readonly scope: Map<string, { value: IrValueId; type: IrType }>;
  readonly funcName: string;
}

function lowerVarDecl(stmt: ts.VariableStatement, cx: LowerCtx): void {
  for (const d of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(d.name)) {
      throw new Error(`ir/from-ast: destructuring declarations not supported in Phase 1 (${cx.funcName})`);
    }
    const name = d.name.text;
    if (cx.scope.has(name)) {
      throw new Error(`ir/from-ast: redeclaration of '${name}' in ${cx.funcName}`);
    }
    if (!d.initializer) {
      throw new Error(`ir/from-ast: Phase 1 requires an initializer for '${name}' in ${cx.funcName}`);
    }
    const annotated = d.type ? typeNodeToIr(d.type, `local ${name} of ${cx.funcName}`) : undefined;
    const hint = annotated ?? { kind: "f64" as const };
    const value = lowerExpr(d.initializer, cx, hint);
    const inferred = cx.builder.typeOf(value);
    if (annotated && annotated.kind !== inferred.kind) {
      throw new Error(
        `ir/from-ast: local '${name}' annotated as ${annotated.kind} but initializer is ${inferred.kind} in ${cx.funcName}`,
      );
    }
    cx.scope.set(name, { value, type: inferred });
  }
}

function typeNodeToIr(node: ts.TypeNode | undefined, where: string): IrType {
  if (!node) throw new Error(`ir/from-ast: missing type annotation (${where})`);
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return { kind: "f64" };
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: "i32" };
    default:
      throw new Error(`ir/from-ast: unsupported type in Phase 1 (${where})`);
  }
}

function lowerExpr(expr: ts.Expression, cx: LowerCtx, hint: IrType): IrValueId {
  if (ts.isParenthesizedExpression(expr)) {
    return lowerExpr(expr.expression, cx, hint);
  }
  if (ts.isNumericLiteral(expr)) {
    return cx.builder.emitConst({ kind: "f64", value: Number(expr.text) }, { kind: "f64" });
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: true }, { kind: "i32" });
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: false }, { kind: "i32" });
  }
  if (ts.isIdentifier(expr)) {
    const p = cx.scope.get(expr.text);
    if (!p) throw new Error(`ir/from-ast: identifier "${expr.text}" is not in scope in ${cx.funcName}`);
    return p.value;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    return lowerPrefixUnary(expr, cx);
  }
  if (ts.isBinaryExpression(expr)) {
    return lowerBinary(expr, cx);
  }
  throw new Error(`ir/from-ast: unsupported expression kind ${ts.SyntaxKind[expr.kind]} in ${cx.funcName}`);
}

function lowerPrefixUnary(expr: ts.PrefixUnaryExpression, cx: LowerCtx): IrValueId {
  const rand = lowerExpr(expr.operand, cx, { kind: "f64" });
  switch (expr.operator) {
    case ts.SyntaxKind.MinusToken: {
      const randType = typeOfValue(rand, cx);
      if (randType.kind !== "f64") {
        throw new Error(`ir/from-ast: unary '-' expects number in ${cx.funcName}`);
      }
      return cx.builder.emitUnary("f64.neg", rand, { kind: "f64" });
    }
    case ts.SyntaxKind.PlusToken: {
      const randType = typeOfValue(rand, cx);
      if (randType.kind !== "f64") {
        throw new Error(`ir/from-ast: unary '+' expects number in ${cx.funcName}`);
      }
      return rand;
    }
    case ts.SyntaxKind.ExclamationToken: {
      const randType = typeOfValue(rand, cx);
      if (randType.kind !== "i32") {
        throw new Error(`ir/from-ast: unary '!' expects bool in ${cx.funcName}`);
      }
      return cx.builder.emitUnary("i32.eqz", rand, { kind: "i32" });
    }
    default:
      throw new Error(`ir/from-ast: unsupported prefix operator ${ts.SyntaxKind[expr.operator]} in ${cx.funcName}`);
  }
}

function lowerBinary(expr: ts.BinaryExpression, cx: LowerCtx): IrValueId {
  const op = expr.operatorToken.kind;
  const lhs = lowerExpr(expr.left, cx, { kind: "f64" });
  const rhs = lowerExpr(expr.right, cx, { kind: "f64" });
  const lt = typeOfValue(lhs, cx);
  const rt = typeOfValue(rhs, cx);
  if (lt.kind !== rt.kind) {
    throw new Error(
      `ir/from-ast: Phase 1 requires matching operand types for '${ts.tokenToString(op)}' in ${cx.funcName}`,
    );
  }

  const isF64 = lt.kind === "f64";
  const isI32 = lt.kind === "i32";

  let binop: IrBinop;
  let resultType: IrType;

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      requireF64(isF64, "+", cx.funcName);
      binop = "f64.add";
      resultType = { kind: "f64" };
      break;
    case ts.SyntaxKind.MinusToken:
      requireF64(isF64, "-", cx.funcName);
      binop = "f64.sub";
      resultType = { kind: "f64" };
      break;
    case ts.SyntaxKind.AsteriskToken:
      requireF64(isF64, "*", cx.funcName);
      binop = "f64.mul";
      resultType = { kind: "f64" };
      break;
    case ts.SyntaxKind.SlashToken:
      requireF64(isF64, "/", cx.funcName);
      binop = "f64.div";
      resultType = { kind: "f64" };
      break;
    case ts.SyntaxKind.LessThanToken:
      requireF64(isF64, "<", cx.funcName);
      binop = "f64.lt";
      resultType = { kind: "i32" };
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      requireF64(isF64, "<=", cx.funcName);
      binop = "f64.le";
      resultType = { kind: "i32" };
      break;
    case ts.SyntaxKind.GreaterThanToken:
      requireF64(isF64, ">", cx.funcName);
      binop = "f64.gt";
      resultType = { kind: "i32" };
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      requireF64(isF64, ">=", cx.funcName);
      binop = "f64.ge";
      resultType = { kind: "i32" };
      break;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      binop = isF64 ? "f64.eq" : "i32.eq";
      resultType = { kind: "i32" };
      break;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      binop = isF64 ? "f64.ne" : "i32.ne";
      resultType = { kind: "i32" };
      break;
    case ts.SyntaxKind.AmpersandAmpersandToken:
      requireI32(isI32, "&&", cx.funcName);
      binop = "i32.and";
      resultType = { kind: "i32" };
      break;
    case ts.SyntaxKind.BarBarToken:
      requireI32(isI32, "||", cx.funcName);
      binop = "i32.or";
      resultType = { kind: "i32" };
      break;
    default:
      throw new Error(`ir/from-ast: unsupported binary operator ${ts.tokenToString(op)} in ${cx.funcName}`);
  }

  return cx.builder.emitBinary(binop, lhs, rhs, resultType);
}

function requireF64(isF64: boolean, op: string, fn: string): void {
  if (!isF64) throw new Error(`ir/from-ast: operator '${op}' requires number operands in ${fn}`);
}

function requireI32(isI32: boolean, op: string, fn: string): void {
  if (!isI32) throw new Error(`ir/from-ast: operator '${op}' requires bool operands in ${fn}`);
}

function typeOfValue(v: IrValueId, cx: LowerCtx): IrType {
  return cx.builder.typeOf(v);
}

/** Result-type hints aren't used in Phase 1 (we always know from the op). */
export type _Unused = IrUnop;
