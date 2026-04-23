// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static eval inlining (#1163).
 *
 * When the argument to `eval(...)` is a compile-time-constant string (a string
 * literal, template literal with no substitutions, or a `+` concatenation of
 * the above), we parse that string as a Script and splice its statements into
 * the current function at compile time — no runtime eval is required.
 *
 * This replaces the dynamic `__extern_eval` host-import call (#1006) for the
 * common literal-argument case.  Per ECMA-262 §19.2.1 PerformEval, the last
 * value produced by the evaluated script becomes the result of the call; if
 * the script does not produce a value (e.g., a var declaration only),
 * `undefined` is returned.
 *
 * Non-literal arguments and parse failures fall through to the existing
 * dynamic-eval path.
 */
import ts from "typescript";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { hoistFunctionDeclarations } from "../statements/nested-declarations.js";
import { hoistLetConstWithTdz, hoistVarDeclarations } from "../index.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, compileStatement } from "../shared.js";
import { emitUndefined } from "./late-imports.js";

/**
 * Recursively resolve a compile-time-constant string from an expression.
 * Returns the string value, or null if the expression is not a constant.
 */
export function resolveConstantString(expr: ts.Expression): string | null {
  // Unwrap parentheses: ("foo") / (("foo"))
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;

  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return e.text;
  }

  // String-literal concatenation: "a" + "b", possibly chained.
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveConstantString(e.left);
    if (left === null) return null;
    const right = resolveConstantString(e.right);
    if (right === null) return null;
    return left + right;
  }

  return null;
}

/**
 * Try to inline `eval("<constant>")` at compile time.
 *
 * Returns:
 *   - InnerResult (ValType or null) on success — caller treats this as the
 *     compiled call result and does NOT invoke the dynamic-eval fallback.
 *   - undefined if the call is not eligible (non-literal arg, parse errors,
 *     etc.) — caller should fall through to the dynamic-eval path.
 *
 * On success we always push a single externref value onto the stack (the
 * result of the inlined script, coerced to externref to match eval's `any`
 * return type).  When the inlined code is statically unreachable (the last
 * statement is a throw, etc.) we return `null` so the caller knows no value
 * was produced.
 */
export function tryStaticEvalInline(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (expr.arguments.length === 0) return undefined;

  const src = resolveConstantString(expr.arguments[0]!);
  if (src === null) return undefined;

  // Evaluate any additional arguments for side effects, then drop them.
  // Per §19.2.1, eval only looks at its first argument, but extra args must
  // still be evaluated (they could throw).
  for (let ai = 1; ai < expr.arguments.length; ai++) {
    const t = compileExpression(ctx, fctx, expr.arguments[ai]!);
    if (t !== null) fctx.body.push({ op: "drop" });
  }

  // Parse the eval source as a Script with parent pointers set so the
  // nested codegen paths (which walk upward via node.parent) work.
  const sf = ts.createSourceFile("<eval>.ts", src, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.JS);

  // If the parse produced diagnostics we're looking at malformed eval source.
  // Real JS would throw SyntaxError at runtime — for now, fall through to the
  // dynamic path so the host can signal the error correctly.  `parseDiagnostics`
  // is an internal field on SourceFile, so access it through a cast.
  const parseDiag = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiag && parseDiag.length > 0) {
    return undefined;
  }

  const stmts = sf.statements;

  // Empty program — eval returns undefined.
  if (stmts.length === 0) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // Scan the parsed AST for node kinds we cannot safely lower from a foreign
  // SourceFile.  The TypeScript checker has no bindings for nodes created via
  // `ts.createSourceFile`, so anything that requires static type information
  // to compile correctly (function/arrow/class expressions, for-of loops that
  // need iterator types, etc.) would silently mis-compile.  When we detect
  // such a node we bail out and let the dynamic `__extern_eval` path handle
  // the call — correctness first, inlining is a best-effort fast path.
  if (!allNodesInlineSupported(sf)) {
    return undefined;
  }

  // Hoist var / function declarations into the enclosing function scope
  // before compiling any statements.  `let`/`const` enter the block scope
  // in source order (handled by compileVariableStatement itself).
  try {
    hoistVarDeclarations(ctx, fctx, stmts);
    hoistLetConstWithTdz(ctx, fctx, stmts);
    hoistFunctionDeclarations(ctx, fctx, stmts);
  } catch {
    // If hoisting blows up (e.g. the checker can't type a foreign node),
    // fall back to the dynamic-eval path.
    return undefined;
  }

  // Compile all but the last statement for side effects.
  const lastIdx = stmts.length - 1;
  for (let i = 0; i < lastIdx; i++) {
    compileStatement(ctx, fctx, stmts[i]!);
  }

  const last = stmts[lastIdx]!;

  // ExpressionStatement — the expression's value is the eval result.
  if (ts.isExpressionStatement(last)) {
    const t = compileExpression(ctx, fctx, last.expression);
    if (t === null) {
      // Unreachable (e.g. the expression compiled to a throw).
      return null;
    }
    if (t.kind !== "externref") {
      coerceType(ctx, fctx, t, { kind: "externref" });
    }
    return { kind: "externref" };
  }

  // Non-expression last statement (throw, var, if, etc.) — compile it and
  // push `undefined` as the eval result.  A throw statement compiles to a
  // `throw` op which leaves the block polymorphic, so the trailing
  // `undefined` push is still well-formed (it's dead code after throw, but
  // keeps the stack types consistent from the caller's perspective).
  compileStatement(ctx, fctx, last);
  emitUndefined(ctx, fctx);
  return { kind: "externref" };
}

/**
 * Walk the parsed eval AST and return false if it contains any node kind that
 * requires TypeScript checker bindings (or binding analysis) we can't provide
 * for foreign nodes.  Currently: function/arrow/class expressions and
 * declarations, for-of loops, yield/await, and dynamic import.  The check is
 * conservative — unsupported constructs simply fall through to runtime eval.
 */
function allNodesInlineSupported(node: ts.Node): boolean {
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok) return;
    switch (n.kind) {
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.ClassExpression:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.YieldExpression:
      case ts.SyntaxKind.AwaitExpression:
      case ts.SyntaxKind.ImportDeclaration:
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.ExportAssignment:
        ok = false;
        return;
      default:
        n.forEachChild(visit);
    }
  };
  node.forEachChild(visit);
  return ok;
}
