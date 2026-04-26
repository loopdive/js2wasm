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
import {
  asVal,
  irTypeEquals,
  irVal,
  type IrBinop,
  type IrFunction,
  type IrObjectShape,
  type IrType,
  type IrUnop,
  type IrValueId,
} from "./nodes.js";

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
      const cond = lowerExpr(s.expression, cx, irVal({ kind: "i32" }));
      const condType = cx.builder.typeOf(cond);
      if (asVal(condType)?.kind !== "i32") {
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
    const cond = lowerExpr(stmt.expression, cx, irVal({ kind: "i32" }));
    const condType = cx.builder.typeOf(cond);
    if (asVal(condType)?.kind !== "i32") {
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
    // Slice 2 (#1169b): non-primitive type annotations on locals
    // (TypeLiteral / TypeReference) can't be resolved to an IrType
    // here without a TS checker. Defer those to inference from the
    // initializer — `typeNodeToIr` only fires for primitive type
    // keywords; everything else falls through to inference.
    const annotated =
      d.type && isPrimitiveTypeNode(d.type) ? typeNodeToIr(d.type, `local ${name} of ${cx.funcName}`) : undefined;
    const hint: IrType = annotated ?? irVal({ kind: "f64" });
    const value = lowerExpr(d.initializer, cx, hint);
    const inferred = cx.builder.typeOf(value);
    if (annotated) {
      // Slice 1 (#1169a): the IrType discriminator includes a `string` arm
      // alongside `val`, so use `irTypeEquals` for a structural match
      // rather than `asVal`-only kind comparison (which silently drops
      // the string case).
      if (!irTypeEquals(annotated, inferred)) {
        throw new Error(
          `ir/from-ast: local '${name}' annotated as ${describeIrType(annotated)} but initializer is ${describeIrType(inferred)} in ${cx.funcName}`,
        );
      }
    }
    cx.scope.set(name, { value, type: inferred });
  }
}

function typeNodeToIr(node: ts.TypeNode | undefined, where: string): IrType {
  if (!node) throw new Error(`ir/from-ast: missing type annotation (${where})`);
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return irVal({ kind: "f64" });
    case ts.SyntaxKind.BooleanKeyword:
      return irVal({ kind: "i32" });
    case ts.SyntaxKind.StringKeyword:
      return { kind: "string" };
    default:
      throw new Error(`ir/from-ast: unsupported type in Phase 1 (${where})`);
  }
}

/**
 * Quick predicate: does this TypeNode resolve to a primitive IrType
 * without needing a TS checker? Used by `lowerVarDecl` and
 * `resolveIrType` to decide whether to consult the override map.
 */
function isPrimitiveTypeNode(node: ts.TypeNode): boolean {
  return (
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword
  );
}

/** Short debug string for IrType, used in error messages. */
function describeIrType(t: IrType): string {
  if (t.kind === "val") return t.val.kind;
  if (t.kind === "string") return "string";
  if (t.kind === "object") {
    return `object{${t.shape.fields.map((f) => `${f.name}:${describeIrType(f.type)}`).join(",")}}`;
  }
  if (t.kind === "union") return `union<${t.members.map((m) => m.kind).join(",")}>`;
  return `boxed<${t.inner.kind}>`;
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
  if (node && isPrimitiveTypeNode(node)) {
    const fromNode = typeNodeToIr(node, where);
    if (override && !irTypeEquals(override, fromNode)) {
      throw new Error(
        `ir/from-ast: type override (${describeIrType(override)}) disagrees with annotation (${describeIrType(fromNode)}) at ${where}`,
      );
    }
    return fromNode;
  }
  // Slice 2 (#1169b): non-primitive TypeNodes (TypeLiteral / TypeReference)
  // need a TS checker to resolve into an IrType.object — we don't have
  // one inside the IR layer. The caller (codegen/index.ts:resolvePositionType)
  // pre-resolves these and passes the result via `override`, so we
  // simply prefer the override here. If neither is present, the
  // selector and override builder are out of sync — that's a bug.
  if (override) return override;
  throw new Error(`ir/from-ast: missing type annotation and no override (${where})`);
}

function lowerExpr(expr: ts.Expression, cx: LowerCtx, hint: IrType): IrValueId {
  if (ts.isParenthesizedExpression(expr)) {
    return lowerExpr(expr.expression, cx, hint);
  }
  if (ts.isNumericLiteral(expr)) {
    return cx.builder.emitConst({ kind: "f64", value: Number(expr.text) }, irVal({ kind: "f64" }));
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: true }, irVal({ kind: "i32" }));
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: false }, irVal({ kind: "i32" }));
  }
  // Slice 1 (#1169a) — strings, templates, typeof, .length, null-keyword.
  if (ts.isStringLiteral(expr) || expr.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    const lit = expr as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
    return cx.builder.emitStringConst(lit.text);
  }
  if (ts.isTemplateExpression(expr)) {
    return lowerTemplateExpression(expr, cx);
  }
  if (ts.isTypeOfExpression(expr)) {
    return lowerTypeOf(expr, cx);
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    // Bare `null` is only valid inside `=== null` / `!== null` (handled by
    // `tryFoldNullCompare` before we recurse into operands). Reaching here
    // means the selector accepted a context this slice can't lower.
    throw new Error(`ir/from-ast: bare 'null' outside === / !== is not supported in slice 1 (${cx.funcName})`);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return lowerPropertyAccess(expr, cx);
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return lowerObjectLiteral(expr, cx);
  }
  if (ts.isElementAccessExpression(expr)) {
    return lowerElementAccess(expr, cx);
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
 * Lower a template literal with substitutions. Slice 1 (#1169a) restricts
 * substitutions to expressions that lower to `IrType.string`. Mixed-type
 * substitutions (number/boolean coerced to string) require `number_toString`
 * plumbing through `IrInstrCall` and are deferred.
 *
 * Even when the head text is empty (`${x}rest`) we emit a `string.const ""`
 * to give the chain a consistent left operand for the first concat — same
 * convention as the legacy `compileTemplateExpression`. The IR
 * constant-folder may collapse trivial empty-concats downstream.
 */
function lowerTemplateExpression(expr: ts.TemplateExpression, cx: LowerCtx): IrValueId {
  let acc = cx.builder.emitStringConst(expr.head.text);
  for (const span of expr.templateSpans) {
    const sub = lowerExpr(span.expression, cx, { kind: "string" });
    const subType = cx.builder.typeOf(sub);
    if (subType.kind !== "string") {
      throw new Error(
        `ir/from-ast: template substitution must be string in slice 1 (got ${describeIrType(subType)} in ${cx.funcName})`,
      );
    }
    acc = cx.builder.emitStringConcat(acc, sub);
    if (span.literal.text) {
      const lit = cx.builder.emitStringConst(span.literal.text);
      acc = cx.builder.emitStringConcat(acc, lit);
    }
  }
  return acc;
}

/**
 * Lower `typeof <expr>` by static fold (slice 1). Operand IrType must be
 * statically known; union/boxed operands are deferred to a follow-up
 * slice that emits a runtime tag dispatch via `tag.test`.
 */
function lowerTypeOf(expr: ts.TypeOfExpression, cx: LowerCtx): IrValueId {
  const inner = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const innerType = cx.builder.typeOf(inner);
  const tag = staticTypeOfFor(innerType);
  if (tag === null) {
    throw new Error(
      `ir/from-ast: typeof of non-static IrType (${describeIrType(innerType)}) is deferred (${cx.funcName})`,
    );
  }
  return cx.builder.emitStringConst(tag);
}

/**
 * Map an IR type to the JS `typeof` tag string that any value of that type
 * would produce at runtime. Returns `null` for types whose runtime tag
 * varies (unions, boxed, references) — those need a runtime dispatch and
 * are out of slice 1's scope.
 */
function staticTypeOfFor(t: IrType): string | null {
  if (t.kind === "string") return "string";
  if (t.kind === "val") {
    if (t.val.kind === "f64" || t.val.kind === "f32" || t.val.kind === "i64") return "number";
    if (t.val.kind === "i32") return "boolean"; // i32 represents bool in slice 1
  }
  return null;
}

/**
 * Lower a property access expression.
 *
 * Slice 1 (#1169a) handles `<string>.length` (the only `.length` form
 * relevant before slice 2). Slice 2 (#1169b) extends to named property
 * reads on `IrType.object` receivers — the lowerer resolves the field
 * by name against the receiver shape's canonical field list and emits
 * `object.get`.
 *
 * Receivers of any other IrType (boxed, union, val with non-string
 * representation) are out of slice 2's scope and throw, so the
 * containing function falls back to legacy.
 */
function lowerPropertyAccess(expr: ts.PropertyAccessExpression, cx: LowerCtx): IrValueId {
  if (!ts.isIdentifier(expr.name)) {
    throw new Error(`ir/from-ast: computed property access not in slice 2 (${cx.funcName})`);
  }
  const propName = expr.name.text;

  // Receiver type is unknown until we lower it; pass an f64 hint (the
  // numeric default) and inspect the resulting IrType. The hint is
  // advisory — string / object lowerings ignore it.
  const recv = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  if (recvType.kind === "string") {
    // Slice 1 — only `.length` is supported on string receivers.
    if (propName !== "length") {
      throw new Error(`ir/from-ast: .${propName} on string is not in slice 2 (${cx.funcName})`);
    }
    return cx.builder.emitStringLen(recv);
  }

  if (recvType.kind === "object") {
    // Slice 2 — named field read on a known shape.
    const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === propName);
    if (fieldIdx < 0) {
      throw new Error(
        `ir/from-ast: object has no field "${propName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
      );
    }
    const fieldType = recvType.shape.fields[fieldIdx]!.type;
    return cx.builder.emitObjectGet(recv, propName, fieldType);
  }

  throw new Error(
    `ir/from-ast: property access .${propName} on ${describeIrType(recvType)} is not in slice 2 (${cx.funcName})`,
  );
}

/**
 * Lower an object literal to an IR `object.new`. The shape is derived
 * from the literal's properties: each PropertyAssignment /
 * ShorthandPropertyAssignment contributes one field. Field types come
 * from the lowered initializer's IrType (no TS-checker introspection
 * — we're already past type resolution by the time we lower).
 *
 * The shape is sorted by name AFTER lowering so the canonical form
 * compares equal across literals with different syntactic ordering. The
 * value list is reordered to match.
 */
function lowerObjectLiteral(expr: ts.ObjectLiteralExpression, cx: LowerCtx): IrValueId {
  if (expr.properties.length === 0) {
    throw new Error(`ir/from-ast: empty object literal not in slice 2 (${cx.funcName})`);
  }
  const built: { name: string; type: IrType; value: IrValueId }[] = [];
  const seen = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = phase1PropertyName(prop.name);
      if (name === null) {
        throw new Error(`ir/from-ast: object literal property name not in slice 2 (${cx.funcName})`);
      }
      if (seen.has(name)) {
        throw new Error(`ir/from-ast: duplicate object literal key "${name}" not in slice 2 (${cx.funcName})`);
      }
      seen.add(name);
      const v = lowerExpr(prop.initializer, cx, irVal({ kind: "f64" }));
      const type = cx.builder.typeOf(v);
      built.push({ name, type, value: v });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      if (seen.has(name)) {
        throw new Error(`ir/from-ast: duplicate object literal key "${name}" not in slice 2 (${cx.funcName})`);
      }
      seen.add(name);
      const found = cx.scope.get(name);
      if (!found) {
        throw new Error(`ir/from-ast: shorthand "${name}" not in scope in ${cx.funcName}`);
      }
      built.push({ name, type: found.type, value: found.value });
      continue;
    }
    throw new Error(`ir/from-ast: object literal element ${ts.SyntaxKind[prop.kind]} not in slice 2 (${cx.funcName})`);
  }
  built.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shape: IrObjectShape = {
    fields: built.map((b) => ({ name: b.name, type: b.type })),
  };
  return cx.builder.emitObjectNew(
    shape,
    built.map((b) => b.value),
  );
}

/**
 * Lower an element access whose argument is a string literal — sugar
 * for property access on a known shape. Numeric / computed keys are
 * out of slice 2's scope and throw, so the function falls back to
 * legacy.
 */
function lowerElementAccess(expr: ts.ElementAccessExpression, cx: LowerCtx): IrValueId {
  const arg = expr.argumentExpression;
  if (!ts.isStringLiteral(arg) && arg.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    throw new Error(`ir/from-ast: non-string-literal element access not in slice 2 (${cx.funcName})`);
  }
  const propName = (arg as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
  const recv = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);
  if (recvType.kind !== "object") {
    throw new Error(`ir/from-ast: element access on ${describeIrType(recvType)} is not in slice 2 (${cx.funcName})`);
  }
  const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === propName);
  if (fieldIdx < 0) {
    throw new Error(
      `ir/from-ast: object has no field "${propName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
    );
  }
  const fieldType = recvType.shape.fields[fieldIdx]!.type;
  return cx.builder.emitObjectGet(recv, propName, fieldType);
}

/**
 * Resolve an object literal property name to a string. Identifier and
 * StringLiteral keys produce their text. NumericLiteral keys produce
 * the canonical JS toString of the number. ComputedPropertyName always
 * returns null. Duplicated locally from select.ts to avoid a circular
 * import.
 */
function phase1PropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
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
    if (!irTypeEquals(argType, expected)) {
      throw new Error(
        `ir/from-ast: arg ${i} of call to ${calleeName} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
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
  const cond = lowerExpr(expr.condition, cx, irVal({ kind: "i32" }));
  const condType = cx.builder.typeOf(cond);
  if (asVal(condType)?.kind !== "i32") {
    throw new Error(`ir/from-ast: ternary condition must be bool in ${cx.funcName}`);
  }
  const whenTrue = lowerExpr(expr.whenTrue, cx, irVal({ kind: "f64" }));
  const whenFalse = lowerExpr(expr.whenFalse, cx, irVal({ kind: "f64" }));
  const ttype = cx.builder.typeOf(whenTrue);
  const ftype = cx.builder.typeOf(whenFalse);
  const tVal = asVal(ttype);
  const fVal = asVal(ftype);
  if (!tVal || !fVal || tVal.kind !== fVal.kind) {
    throw new Error(
      `ir/from-ast: ternary branches have different types (${describeIrType(ttype)} vs ${describeIrType(ftype)}) in ${cx.funcName}`,
    );
  }
  return cx.builder.emitSelect(cond, whenTrue, whenFalse, ttype);
}

function lowerPrefixUnary(expr: ts.PrefixUnaryExpression, cx: LowerCtx): IrValueId {
  const rand = lowerExpr(expr.operand, cx, irVal({ kind: "f64" }));
  switch (expr.operator) {
    case ts.SyntaxKind.MinusToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "f64") {
        throw new Error(`ir/from-ast: unary '-' expects number in ${cx.funcName}`);
      }
      return cx.builder.emitUnary("f64.neg", rand, irVal({ kind: "f64" }));
    }
    case ts.SyntaxKind.PlusToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "f64") {
        throw new Error(`ir/from-ast: unary '+' expects number in ${cx.funcName}`);
      }
      return rand;
    }
    case ts.SyntaxKind.ExclamationToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "i32") {
        throw new Error(`ir/from-ast: unary '!' expects bool in ${cx.funcName}`);
      }
      return cx.builder.emitUnary("i32.eqz", rand, irVal({ kind: "i32" }));
    }
    default:
      throw new Error(`ir/from-ast: unsupported prefix operator ${ts.SyntaxKind[expr.operator]} in ${cx.funcName}`);
  }
}

function lowerBinary(expr: ts.BinaryExpression, cx: LowerCtx): IrValueId {
  const op = expr.operatorToken.kind;

  // === / !== / == / != with a `null` literal: slice 1 has no nullable IR
  // types yet, so every operand we can lower trivially evaluates to false
  // for === null / true for !== null. Try this fold first; it short-
  // circuits the standard f64-hint lowering below (which would otherwise
  // recurse into a bare NullKeyword and throw).
  const nullFold = tryFoldNullCompare(expr, op, cx);
  if (nullFold !== null) return nullFold;

  const lhs = lowerExpr(expr.left, cx, irVal({ kind: "f64" }));
  const rhs = lowerExpr(expr.right, cx, irVal({ kind: "f64" }));
  const lt = typeOfValue(lhs, cx);
  const rt = typeOfValue(rhs, cx);

  // String operand path (slice 1, #1169a) — `+`, `===`, `!==`, `==`, `!=`.
  // Any other operator with a string operand throws so the function falls
  // back to legacy.
  if (lt.kind === "string" || rt.kind === "string") {
    if (lt.kind !== "string" || rt.kind !== "string") {
      throw new Error(
        `ir/from-ast: mixed string/non-string operand for '${ts.tokenToString(op)}' is not in slice 1 (${cx.funcName})`,
      );
    }
    switch (op) {
      case ts.SyntaxKind.PlusToken:
        return cx.builder.emitStringConcat(lhs, rhs);
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
        return cx.builder.emitStringEq(lhs, rhs, false);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return cx.builder.emitStringEq(lhs, rhs, true);
      default:
        throw new Error(`ir/from-ast: string operator '${ts.tokenToString(op)}' not in slice 1 (${cx.funcName})`);
    }
  }

  const ltVal = asVal(lt);
  const rtVal = asVal(rt);
  if (!ltVal || !rtVal || ltVal.kind !== rtVal.kind) {
    throw new Error(
      `ir/from-ast: Phase 1 requires matching operand types for '${ts.tokenToString(op)}' in ${cx.funcName}`,
    );
  }

  const isF64 = ltVal.kind === "f64";
  const isI32 = ltVal.kind === "i32";

  let binop: IrBinop;
  let resultType: IrType;

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      requireF64(isF64, "+", cx.funcName);
      binop = "f64.add";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.MinusToken:
      requireF64(isF64, "-", cx.funcName);
      binop = "f64.sub";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.AsteriskToken:
      requireF64(isF64, "*", cx.funcName);
      binop = "f64.mul";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.SlashToken:
      requireF64(isF64, "/", cx.funcName);
      binop = "f64.div";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.LessThanToken:
      requireF64(isF64, "<", cx.funcName);
      binop = "f64.lt";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      requireF64(isF64, "<=", cx.funcName);
      binop = "f64.le";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.GreaterThanToken:
      requireF64(isF64, ">", cx.funcName);
      binop = "f64.gt";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      requireF64(isF64, ">=", cx.funcName);
      binop = "f64.ge";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      binop = isF64 ? "f64.eq" : "i32.eq";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      binop = isF64 ? "f64.ne" : "i32.ne";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.AmpersandAmpersandToken:
      requireI32(isI32, "&&", cx.funcName);
      binop = "i32.and";
      resultType = irVal({ kind: "i32" });
      break;
    case ts.SyntaxKind.BarBarToken:
      requireI32(isI32, "||", cx.funcName);
      binop = "i32.or";
      resultType = irVal({ kind: "i32" });
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

/**
 * Compile-time fold for `expr === null` / `expr !== null` / `expr == null` /
 * `expr != null` when the non-null operand has a non-nullable IR type.
 *
 * Slice 1 (#1169a) has no nullable IR types yet (no `nullable union`,
 * no `boxed-null`), so any operand we can lower is provably non-null:
 *   - `expr === null`  → `false`
 *   - `expr !== null`  → `true`
 *
 * The non-null operand IS lowered (rather than skipped) so its side
 * effects are preserved; the IR DCE pass strips the unused value when
 * the producing instructions are pure. If the operand's IR type is
 * `boxed` (deferred to a later slice), we return `null` so the fold
 * doesn't fire and the caller's standard binary path throws cleanly,
 * letting the function fall back to legacy.
 *
 * Returns `null` when this isn't a `null`-compare (so the caller
 * proceeds with the normal lowering).
 */
function tryFoldNullCompare(expr: ts.BinaryExpression, op: ts.SyntaxKind, cx: LowerCtx): IrValueId | null {
  const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  let other: ts.Expression | null = null;
  if (expr.left.kind === ts.SyntaxKind.NullKeyword) other = expr.right;
  else if (expr.right.kind === ts.SyntaxKind.NullKeyword) other = expr.left;
  else return null;

  // Lower the non-null side to learn its IrType AND keep any side effects
  // emitted (the IR DCE pass drops the unused result if the producing
  // instructions are pure).
  const v = lowerExpr(other, cx, irVal({ kind: "f64" }));
  const otherType = cx.builder.typeOf(v);

  // Slice 1 only knows non-nullable types: `val<...>`, `string`, and
  // unions whose members are non-null (V1 unions only carry f64/i32).
  // `boxed` is deferred; bail so the caller errors cleanly.
  if (otherType.kind === "boxed") return null;

  return cx.builder.emitConst({ kind: "bool", value: isNeq }, irVal({ kind: "i32" }));
}

/** Result-type hints aren't used in Phase 1 (we always know from the op). */
export type _Unused = IrUnop;
