// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Statement lowering dispatcher.
 *
 * This file serves as the public API for statement compilation.
 * The actual implementation is split into focused sub-modules under statements/:
 *
 *   - statements/tdz.ts            — temporal dead zone helpers
 *   - statements/variables.ts      — variable declaration lowering
 *   - statements/destructuring.ts  — destructuring patterns (object, array, string)
 *   - statements/control-flow.ts   — return, if, switch, break, continue, labeled
 *   - statements/loops.ts          — while, for, do-while, for-of, for-in
 *   - statements/exceptions.ts     — throw and try-catch
 *   - statements/nested-declarations.ts — nested functions/classes, arguments object
 *   - statements/shared.ts         — utilities shared across all sub-modules
 */
import ts from "typescript";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { attachSourcePos, getSourcePos } from "./context/source-pos.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression, registerCompileStatement } from "./shared.js";
import { restoreBlockScopedShadows, saveBlockScopedShadows } from "./statements/shared.js";

// Sub-module imports — statement-family functions
import {
  compileBreakStatement,
  compileContinueStatement,
  compileIfStatement,
  compileLabeledStatement,
  compileReturnStatement,
  compileSwitchStatement,
} from "./statements/control-flow.js";
import { compileThrowStatement, compileTryStatement } from "./statements/exceptions.js";
import {
  compileDoWhileStatement,
  compileForInStatement,
  compileForOfStatement,
  compileForStatement,
  compileWhileStatement,
} from "./statements/loops.js";
import { compileNestedClassDeclaration, compileNestedFunctionDeclaration } from "./statements/nested-declarations.js";
import { compileVariableStatement } from "./statements/variables.js";

// ---------------------------------------------------------------------------
// Re-exports — preserve the existing public API surface
// ---------------------------------------------------------------------------
export {
  compileExternrefArrayDestructuringDecl,
  compileExternrefObjectDestructuringDecl,
  emitDefaultValueCheck,
  emitExternrefDefaultCheck,
  emitNestedBindingDefault,
  ensureBindingLocals,
} from "./statements/destructuring.js";
export { bodyUsesArguments, emitArgumentsObject, hoistFunctionDeclarations } from "./statements/nested-declarations.js";
export { collectInstrs } from "./statements/shared.js";
export { emitTdzCheck } from "./statements/tdz.js";

// ---------------------------------------------------------------------------
// Dispatcher helpers
// ---------------------------------------------------------------------------

/**
 * Mark the first instruction emitted for a statement with its source position.
 */
function markStatementPos(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement, compile: () => void): void {
  const pos = getSourcePos(ctx, stmt);
  const bodyLenBefore = fctx.body.length;
  compile();
  if (pos && fctx.body.length > bodyLenBefore) {
    attachSourcePos(fctx.body[bodyLenBefore]!, pos);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compile a statement, appending instructions to the function body */
export function compileStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  // Track the last known good AST node for error location fallback (#931)
  if (stmt) ctx.lastKnownNode = stmt;

  // Guard: if the AST node is undefined/null, report an error and return
  // instead of crashing with "Cannot read 'kind' of undefined".
  if (!stmt) {
    reportErrorNoNode(ctx, "unexpected undefined AST node in compileStatement");
    return;
  }

  try {
    compileStatementInner(ctx, fctx, stmt);
  } catch (e) {
    // Defensive: catch any unhandled crash in statement compilation
    const msg = e instanceof Error ? e.message : String(e);
    reportErrorNoNode(ctx, `Internal error compiling statement: ${msg}`);
  }
}

function compileStatementInner(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  // Skip import declarations — module imports not supported
  if (ts.isImportDeclaration(stmt)) return;

  // Skip export declarations — `export { x }`, `export * from '...'`
  // These are module-level metadata with no runtime effect in our compilation.
  if (ts.isExportDeclaration(stmt)) return;

  // Export assignment — `export default expr` or `export = expr`
  // Evaluate the expression (for side effects) but discard the result.
  if (ts.isExportAssignment(stmt)) {
    const resultType = compileExpression(ctx, fctx, stmt.expression);
    if (resultType !== null) {
      fctx.body.push({ op: "drop" });
    }
    return;
  }

  if (ts.isVariableStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileVariableStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isReturnStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileReturnStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isIfStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileIfStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isWhileStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileWhileStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isForStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileForStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isBlock(stmt)) {
    // Save localMap entries for any block-scoped (let/const) names that shadow
    // existing variables.  Wasm locals are flat (no block scope), so we need to
    // restore the outer mapping after the block ends.
    const savedLocals = saveBlockScopedShadows(fctx, stmt);
    for (const s of stmt.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedLocals);
    return;
  }

  if (ts.isExpressionStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => {
      const resultType = compileExpression(ctx, fctx, stmt.expression);
      // Drop the result if the expression left something on the stack
      if (resultType !== null) {
        fctx.body.push({ op: "drop" });
      }
    });
    return;
  }

  if (ts.isDoStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileDoWhileStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isSwitchStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileSwitchStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isForOfStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileForOfStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isForInStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileForInStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isLabeledStatement(stmt)) {
    compileLabeledStatement(ctx, fctx, stmt);
    return;
  }

  if (ts.isBreakStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileBreakStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isContinueStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileContinueStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isThrowStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileThrowStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isTryStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileTryStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isFunctionDeclaration(stmt)) {
    // Skip if already hoisted (pre-compiled in function hoisting pass)
    if (stmt.name && ctx.funcMap.has(stmt.name.text)) return;
    // Re-attempt compilation even if hoisting failed — the failure may have been
    // due to const/let captures not yet in scope during the hoisting pre-pass.
    // Now that we're in statement order, those locals should be available.
    compileNestedFunctionDeclaration(ctx, fctx, stmt);
    return;
  }

  // ClassDeclaration in statement position (e.g., inside for loops, if blocks,
  // switch cases, labeled statements, try/catch/finally, etc.)
  if (ts.isClassDeclaration(stmt)) {
    compileNestedClassDeclaration(ctx, fctx, stmt);
    return;
  }

  // Empty statement (`;`) — no-op
  if (stmt.kind === ts.SyntaxKind.EmptyStatement) {
    return;
  }

  // Class member nodes that can leak into compileStatement when iterating
  // class body or constructor body — treat as no-ops since field initializers
  // are handled separately in compileClassBodies (index.ts).
  if (stmt.kind === ts.SyntaxKind.PropertyDeclaration) {
    // Field declarations (e.g., `x = 5`, `#y: string`) — initializers are
    // compiled in compileClassBodies via struct.set; skip here.
    return;
  }
  if (stmt.kind === ts.SyntaxKind.SemicolonClassElement) {
    // Stray `;` inside class body — no-op.
    return;
  }
  if (stmt.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) {
    // `static { ... }` block — compile the statements inside.
    const staticBlock = stmt as unknown as ts.ClassStaticBlockDeclaration;
    if (staticBlock.body) {
      for (const s of staticBlock.body.statements) {
        compileStatement(ctx, fctx, s);
      }
    }
    return;
  }

  reportError(ctx, stmt, `Unsupported statement: ${ts.SyntaxKind[stmt.kind]}`);
}

// Register compileStatement delegate in shared.ts so index.ts (and any other
// module) can call compileStatement without importing statements.ts directly.
registerCompileStatement(compileStatement);
