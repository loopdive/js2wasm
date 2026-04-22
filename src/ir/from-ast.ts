// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// AST → IR lowering.
//
// Phase 1 numeric/bool subset. The selector in `select.ts` restricts us to
// functions whose params are number/boolean, whose return type is
// number/boolean, and whose body is a "tail":
//   - zero or more `(let|const) <id> = <expr>;` declarations, followed by
//   - either `return <expr>;` OR `if (<expr>) <tail> else <tail>`,
//   - where each if-arm is itself a valid tail (terminates via return).
//
// `<expr>` may be:
//   - NumericLiteral / TrueKeyword / FalseKeyword
//   - Identifier referring to a parameter or a previously-declared local
//   - BinaryExpression with an arithmetic / comparison / logical operator
//   - PrefixUnaryExpression with `-`, `+`, `!`
//   - ConditionalExpression (`a ? b : c`)
//   - CallExpression to a locally-declared function (Phase 2)
//   - ParenthesizedExpression (unwrap)
//
// Everything else throws — the selector must keep those functions on the
// legacy path.
//
// Control flow is represented as basic blocks with `br_if` terminators. The
// entry block holds the pre-branch `let`/`const` decls; each if-arm is its
// own block (fork scope so declarations don't leak). Arms always terminate
// with `return` — Phase 1 doesn't model join blocks yet.
//
// Phase 2 extensions:
//   - Explicit TS `: number` / `: boolean` annotations are optional. When
//     absent, the caller passes `paramTypeOverrides` / `returnTypeOverride`
//     from the propagated TypeMap. This is what lets a recursive `fib`
//     whose `n` is untyped in source compile as `(f64) -> f64`.
//   - CallExpression to a local function lowers to `IrInstrCall`. The
//     call's return type comes from `callReturnTypes` (same TypeMap),
//     with arg types validated against the propagated callee param types.

import ts from "typescript";

import { IrFunctionBuilder } from "./builder.js";
import type { IrBinop, IrFunction, IrType, IrUnop, IrValueId } from "./nodes.js";

export interface AstToIrOptions {
  readonly exported?: boolean;
  /**
   * If present, overrides the IR types for the function's own parameters.
   * Indexed by parameter position. Used when the AST lacks explicit TS
   * type annotations and the Phase-2 propagation pass has inferred types.
   */
  readonly paramTypeOverrides?: readonly IrType[];
  /**
   * If present, overrides the IR return type. Same rationale as
   * `paramTypeOverrides`.
   */
  readonly returnTypeOverride?: IrType;
  /**
   * Map from callee function name to that callee's IR types (param +
   * return). Consulted when lowering a CallExpression whose callee is a
   * local function. Missing entries cause the lowerer to throw — the
   * selector's call-graph closure should guarantee every call we reach
   * has an entry.
   */
  readonly calleeTypes?: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType }>;
}

export function lowerFunctionAstToIr(fn: ts.FunctionDeclaration, options: AstToIrOptions = {}): IrFunction {
  if (!fn.name) {
    throw new Error("ir/from-ast: function declaration without a name");
  }
  if (!fn.body) {
    throw new Error(`ir/from-ast: function ${fn.name.text} has no body`);
  }

  const name = fn.name.text;
  const returnType = resolveIrType(fn.type, options.returnTypeOverride, `return type of ${name}`);
  const params: { name: string; type: IrType }[] = fn.parameters.map((p, idx) => {
    if (!ts.isIdentifier(p.name)) {
      throw new Error(`ir/from-ast: destructuring params not supported in Phase 1 (${name})`);
    }
    const override = options.paramTypeOverrides?.[idx];
    return {
      name: p.name.text,
      type: resolveIrType(p.type, override, `param ${p.name.text} of ${name}`),
    };
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

  const cx: LowerCtx = {
    builder,
    scope,
    funcName: name,
    returnType,
    calleeTypes: options.calleeTypes,
  };
  lowerStatementList(stmts, cx);

  return builder.finish();
}

function lowerStatementList(stmts: readonly ts.Statement[], cx: LowerCtx): void {
  if (stmts.length < 1) {
    throw new Error(`ir/from-ast: empty statement list in ${cx.funcName}`);
  }
  for (let i = 0; i < stmts.length - 1; i++) {
    const s = stmts[i]!;
    if (ts.isVariableStatement(s)) {
      lowerVarDecl(s, cx);
      continue;
    }
    // Phase 2: early-return `if` with no else + subsequent statements.
    // Structurally: `if (cond) <tail>; <rest>` ≡ `if (cond) <tail> else { <rest> }`.
    // The then-arm lowers to its own block that terminates in `return`
    // (lowerTail enforces that); the else-arm opens a reserved block and
    // recursively lowers the remaining statements.
    if (ts.isIfStatement(s) && !s.elseStatement) {
      const cond = lowerExpr(s.expression, cx, { kind: "i32" });
      const condType = cx.builder.typeOf(cond);
      if (condType.kind !== "i32") {
        throw new Error(`ir/from-ast: if condition must be bool in ${cx.funcName}`);
      }
      const thenId = cx.builder.reserveBlockId();
      const elseId = cx.builder.reserveBlockId();
      cx.builder.terminate({
        kind: "br_if",
        condition: cond,
        ifTrue: { target: thenId, args: [] },
        ifFalse: { target: elseId, args: [] },
      });

      cx.builder.openReservedBlock(thenId);
      lowerTail(s.thenStatement, { ...cx, scope: new Map(cx.scope) });

      cx.builder.openReservedBlock(elseId);
      const rest = stmts.slice(i + 1);
      lowerStatementList(rest, { ...cx, scope: new Map(cx.scope) });
      return;
    }
    throw new Error(`ir/from-ast: unexpected statement before tail (got ${ts.SyntaxKind[s.kind]} in ${cx.funcName})`);
  }
  lowerTail(stmts[stmts.length - 1]!, cx);
}

/**
 * Lower a "tail" statement — one that must end in a return on every path.
 * Phase 1 tails are: `return <expr>;`, a `Block { ... }` whose own tail is a
 * tail, or `if (<cond>) <tail> else <tail>`.
 */
function lowerTail(stmt: ts.Statement, cx: LowerCtx): void {
  if (ts.isReturnStatement(stmt)) {
    if (!stmt.expression) {
      throw new Error(`ir/from-ast: Phase 1 return must have an expression in ${cx.funcName}`);
    }
    const v = lowerExpr(stmt.expression, cx, cx.returnType);
    cx.builder.terminate({ kind: "return", values: [v] });
    return;
  }
  if (ts.isBlock(stmt)) {
    // Fork scope — declarations inside the block stay local to this arm.
    const childCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
    lowerStatementList(stmt.statements, childCx);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    if (!stmt.elseStatement) {
      throw new Error(`ir/from-ast: Phase 1 if must have an else arm in ${cx.funcName}`);
    }
    const cond = lowerExpr(stmt.expression, cx, { kind: "i32" });
    const condType = cx.builder.typeOf(cond);
    if (condType.kind !== "i32") {
      throw new Error(`ir/from-ast: if condition must be bool in ${cx.funcName}`);
    }
    // Reserve block IDs for both arms BEFORE terminating the current block.
    // The else ID must be fixed when we emit br_if, even though it opens after
    // any nested blocks the then-arm allocates.
    const thenId = cx.builder.reserveBlockId();
    const elseId = cx.builder.reserveBlockId();
    cx.builder.terminate({
      kind: "br_if",
      condition: cond,
      ifTrue: { target: thenId, args: [] },
      ifFalse: { target: elseId, args: [] },
    });

    cx.builder.openReservedBlock(thenId);
    lowerTail(stmt.thenStatement, { ...cx, scope: new Map(cx.scope) });

    cx.builder.openReservedBlock(elseId);
    lowerTail(stmt.elseStatement, { ...cx, scope: new Map(cx.scope) });
    return;
  }
  throw new Error(`ir/from-ast: unsupported tail statement ${ts.SyntaxKind[stmt.kind]} in ${cx.funcName}`);
}

interface LowerCtx {
  readonly builder: IrFunctionBuilder;
  readonly scope: Map<string, { value: IrValueId; type: IrType }>;
  readonly funcName: string;
  readonly returnType: IrType;
  readonly calleeTypes?: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType }>;
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

/**
 * Resolve the IR type for a function param or return.
 *
 * If the AST has an explicit TypeNode, it must agree with the override
 * (if any). If the AST has no TypeNode, the override is authoritative.
 * If neither is present, that's a compiler bug — the selector should not
 * have claimed this function.
 */
function resolveIrType(node: ts.TypeNode | undefined, override: IrType | undefined, where: string): IrType {
  if (node) {
    const fromNode = typeNodeToIr(node, where);
    if (override && override.kind !== fromNode.kind) {
      throw new Error(
        `ir/from-ast: type override (${override.kind}) disagrees with annotation (${fromNode.kind}) at ${where}`,
      );
    }
    return fromNode;
  }
  if (override) return override;
  throw new Error(`ir/from-ast: missing type annotation and no override (${where})`);
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
  if (ts.isConditionalExpression(expr)) {
    return lowerConditional(expr, cx);
  }
  if (ts.isCallExpression(expr)) {
    return lowerCall(expr, cx);
  }
  throw new Error(`ir/from-ast: unsupported expression kind ${ts.SyntaxKind[expr.kind]} in ${cx.funcName}`);
}

/**
 * Lower a direct call to a locally-declared function. The callee's signature
 * comes from `calleeTypes` (seeded by the Phase-2 TypeMap via the caller).
 * If the callee isn't in the map, the selector's call-graph closure was
 * violated — we throw so the caller can fall back to the legacy path.
 *
 * Arg type mismatch is fatal too: the selector is supposed to keep the
 * whole strongly-connected component on the IR path only when the types
 * are consistent. If we land here with a mismatch, the TypeMap was stale
 * or the propagation pass converged on a dynamic type that the selector
 * ignored — both are bugs.
 */
function lowerCall(expr: ts.CallExpression, cx: LowerCtx): IrValueId {
  if (!ts.isIdentifier(expr.expression)) {
    throw new Error(`ir/from-ast: only direct calls supported in Phase 2 (${cx.funcName})`);
  }
  const calleeName = expr.expression.text;
  const calleeSig = cx.calleeTypes?.get(calleeName);
  if (!calleeSig) {
    throw new Error(`ir/from-ast: call to unknown function "${calleeName}" in ${cx.funcName}`);
  }
  if (expr.arguments.length !== calleeSig.params.length) {
    throw new Error(
      `ir/from-ast: call to ${calleeName} has ${expr.arguments.length} args, expected ${calleeSig.params.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < expr.arguments.length; i++) {
    const argExpr = expr.arguments[i]!;
    const expected = calleeSig.params[i]!;
    const argVal = lowerExpr(argExpr, cx, expected);
    const argType = cx.builder.typeOf(argVal);
    if (argType.kind !== expected.kind) {
      throw new Error(
        `ir/from-ast: arg ${i} of call to ${calleeName} is ${argType.kind}, expected ${expected.kind} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  const result = cx.builder.emitCall({ kind: "func", name: calleeName }, args, calleeSig.returnType);
  if (result === null) {
    throw new Error(`ir/from-ast: call to ${calleeName} returned void used as expression in ${cx.funcName}`);
  }
  return result;
}

function lowerConditional(expr: ts.ConditionalExpression, cx: LowerCtx): IrValueId {
  const cond = lowerExpr(expr.condition, cx, { kind: "i32" });
  const condType = cx.builder.typeOf(cond);
  if (condType.kind !== "i32") {
    throw new Error(`ir/from-ast: ternary condition must be bool in ${cx.funcName}`);
  }
  const whenTrue = lowerExpr(expr.whenTrue, cx, { kind: "f64" });
  const whenFalse = lowerExpr(expr.whenFalse, cx, { kind: "f64" });
  const ttype = cx.builder.typeOf(whenTrue);
  const ftype = cx.builder.typeOf(whenFalse);
  if (ttype.kind !== ftype.kind) {
    throw new Error(
      `ir/from-ast: ternary branches have different types (${ttype.kind} vs ${ftype.kind}) in ${cx.funcName}`,
    );
  }
  return cx.builder.emitSelect(cond, whenTrue, whenFalse, ttype);
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
