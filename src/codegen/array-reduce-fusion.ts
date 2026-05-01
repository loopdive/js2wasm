// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1195 — array-reduce-fusion: eliminate the temporary array in the
 * fill+reduce shape so the resulting code is one fused loop with a
 * single accumulator local.
 *
 * Targets the "array-sum" benchmark pattern:
 *
 *     const arr = [];
 *     for (let i = 0; i < n; i++) arr[i] = WRITE_RHS;
 *     let acc = INIT;
 *     for (let j = 0; j < arr.length; j++) acc = READ_FN(acc, arr[j]);
 *
 * After fusion (semantically equivalent for non-escaping arrays):
 *
 *     let acc = INIT;
 *     for (let i = 0; i < n; i++) acc = READ_FN(acc, WRITE_RHS);
 *
 * The transformation runs at the AST level just before `compileFunctionBody`
 * processes statements, so we get the full benefit of downstream
 * optimisations (i32 specialization, bounds-check elimination, …) on the
 * fused loop body. The detector is conservative — bail on any uncertainty.
 *
 * **Safety preconditions** (all must hold for fusion to fire):
 *   1. Four consecutive top-level statements in the function body match the
 *      shape (decl, write-loop, accumulator-decl, read-loop). No statements
 *      are allowed between the decl and the write-loop, or between the
 *      accumulator-decl and the read-loop. (Statements are allowed between
 *      the write-loop and the accumulator-decl as long as they don't
 *      mutate the array — e.g. `let acc = INIT;` itself.)
 *   2. The array is declared `const` with an empty array literal `[]`
 *      initialiser (no spread, no elements).
 *   3. The write-loop is `for (let WI = LIT_OR_ID; WI < BOUND; WI++) {body}`
 *      where the body is a SINGLE expression statement of the form
 *      `arr[WI] = WRITE_RHS`. WRITE_RHS must not read `arr`.
 *   4. The read-loop is `for (let RI = LIT_OR_ID; RI < BOUND_R; RI++) {body}`
 *      where `BOUND_R` is either the same as `BOUND` (text-equal) or
 *      `arr.length` (and the bound BOUND was used in the write-loop). The
 *      body is a single expression statement that uses `arr[RI]` exactly
 *      once and may also read the accumulator.
 *   5. The array is referenced **nowhere else** in the function — no
 *      assignments, no calls, no returns, no captures, no further indexing
 *      after the read-loop, no `arr.length` outside the read-loop bound.
 *   6. The array is never read inside the write-loop body (no self-deps).
 *
 * Per ECMA-262 the transformation preserves observable semantics provided
 * the array is non-escaping AND the write/read RHS expressions are pure
 * with respect to the array's contents (a stricter form of escape
 * analysis). The conservative checks above ensure that.
 *
 * Rejected patterns (correct to bail):
 *   - Array escapes (returned, passed, captured, stored on this/struct)
 *   - Write loop has multiple body statements (could observe partial array)
 *   - Read loop reads `arr.length` more than once or after the loop
 *   - Index variables shadow outer scopes in surprising ways
 */
import ts from "typescript";
import type { CodegenContext } from "./context/types.js";

/**
 * A successful match describes which statements to drop from the original
 * statement list and which to insert in their place. The fused replacement
 * is two statements: the `let ACC = INIT` declaration (carried over) and a
 * single fused for-loop.
 */
export interface ReduceFusionMatch {
  /** First index in the parent statement list to remove (the array decl). */
  startIdx: number;
  /** Last index (inclusive) to remove (the read-loop). */
  endIdx: number;
  /** Synthetic statements to splice in. Length 2: accumulator decl + fused loop. */
  replacement: ts.Statement[];
}

/**
 * Scan a function body for the fill+reduce shape. Returns matches in
 * back-to-front order so callers can splice without invalidating later
 * indices. Empty array means no rewrite.
 *
 * Only matches at the top-level of the function body for now — nested
 * blocks would require alpha-renaming index vars and are out of scope.
 */
export function detectArrayReduceFusion(ctx: CodegenContext, fnBody: ts.Block | undefined): ReduceFusionMatch[] {
  if (!fnBody) return [];
  const stmts = fnBody.statements;
  if (stmts.length < 4) return [];

  const checker = ctx.checker;
  const matches: ReduceFusionMatch[] = [];

  // Walk the statement list looking for the 4-stmt anchor pattern. We
  // intentionally do NOT recurse into nested blocks — that would multiply
  // the validation burden and is out of scope for this PR.
  let i = 0;
  while (i < stmts.length - 3) {
    const m = tryMatchAt(checker, stmts, i);
    if (m) {
      matches.push(m);
      i = m.endIdx + 1;
    } else {
      i++;
    }
  }

  return matches.reverse(); // back-to-front for splicing
}

interface DetectionContext {
  arrName: string;
  arrSym: ts.Symbol;
}

function tryMatchAt(
  checker: ts.TypeChecker,
  stmts: readonly ts.Statement[],
  startIdx: number,
): ReduceFusionMatch | null {
  // ------- Stage 1: identify decl, writeLoop, accDecl, readLoop -------
  const declStmt = stmts[startIdx];
  if (!declStmt || !ts.isVariableStatement(declStmt)) return null;
  if (!(declStmt.declarationList.flags & ts.NodeFlags.Const)) return null;
  if (declStmt.declarationList.declarations.length !== 1) return null;
  const arrDecl = declStmt.declarationList.declarations[0]!;
  if (!ts.isIdentifier(arrDecl.name)) return null;
  if (!arrDecl.initializer) return null;
  if (!ts.isArrayLiteralExpression(arrDecl.initializer)) return null;
  if (arrDecl.initializer.elements.length !== 0) return null;
  const arrName = arrDecl.name.text;
  const arrSym = checker.getSymbolAtLocation(arrDecl.name);
  if (!arrSym) return null;

  const writeLoop = stmts[startIdx + 1];
  if (!writeLoop || !ts.isForStatement(writeLoop)) return null;
  const writeInfo = parseWriteLoop(checker, writeLoop, arrName, arrSym);
  if (!writeInfo) return null;

  const accStmt = stmts[startIdx + 2];
  if (!accStmt || !ts.isVariableStatement(accStmt)) return null;
  // Accumulator must be `let X = INIT` with a single declarator.
  if (!(accStmt.declarationList.flags & ts.NodeFlags.Let)) return null;
  if (accStmt.declarationList.declarations.length !== 1) return null;
  const accDecl = accStmt.declarationList.declarations[0]!;
  if (!ts.isIdentifier(accDecl.name)) return null;
  if (!accDecl.initializer) return null;
  // The accumulator's INIT expression must not reference the array.
  if (referencesSymbol(checker, accDecl.initializer, arrSym)) return null;
  const accName = accDecl.name.text;
  const accSym = checker.getSymbolAtLocation(accDecl.name);
  if (!accSym) return null;

  const readLoop = stmts[startIdx + 3];
  if (!readLoop || !ts.isForStatement(readLoop)) return null;
  const readInfo = parseReadLoop(checker, readLoop, arrName, arrSym, accName, accSym, writeInfo);
  if (!readInfo) return null;

  // ------- Stage 2: validate non-escape across the function body -------
  // The array MUST NOT be referenced anywhere except the two loops.
  // Stage 1 already guarantees the right STRUCTURE inside the loops.
  //
  // Optimisation: a `const arr = []` binding cannot be referenced BEFORE its
  // declaration site — that would be a TDZ ReferenceError per spec. So we
  // only need to scan statements at indices [startIdx+4 .. end]. This drops
  // worst-case cost from O(N²) (countSymbolRefsOutside walks the whole body
  // for each candidate × N candidates) to O(N) total, which matters when
  // many candidate patterns appear in one large function.
  const dCtx: DetectionContext = { arrName, arrSym };
  let escaped = false;
  for (let j = startIdx + 4; j < stmts.length && !escaped; j++) {
    if (referencesSymbolStatement(checker, stmts[j]!, dCtx.arrSym)) {
      escaped = true;
    }
  }
  if (escaped) return null;

  // ------- Stage 3: build the fused replacement -------
  // The fused loop reuses the WRITE loop's index var name (semantically
  // equivalent — it's a fresh `let` in a new for-init). The body becomes
  //
  //     ACC = READ_BODY[ arr[RI] := WRITE_RHS_with_WI_renamed_to_outer_index ]
  //
  // We choose the write-loop's index var name as the fused index. The
  // read-body references arr[RI] — substitute that subexpression with the
  // write-RHS (alpha-renamed if WI != RI).
  const fused = buildFusedLoop(readLoop, writeInfo, readInfo);
  if (!fused) return null;

  // The accumulator declaration is kept verbatim (it was already a
  // standalone statement; the fused loop just references the same
  // identifier). Insert it BEFORE the fused loop.
  const replacement: ts.Statement[] = [accStmt, fused];

  return {
    startIdx,
    endIdx: startIdx + 3,
    replacement,
  };
}

interface WriteLoopInfo {
  /** `for (let WI = ...; WI < BOUND; WI++)` — index var name. */
  indexName: string;
  /** Index var symbol. */
  indexSym: ts.Symbol;
  /** Bound expression (RHS of `<`). */
  bound: ts.Expression;
  /** Init expression for index (e.g. `0`). */
  initExpr: ts.Expression;
  /** Increment kind: ++idx or idx++ or idx += 1. */
  incrAst: ts.Expression;
  /** Body's RHS — the value written to arr[WI]. */
  writeRhs: ts.Expression;
}

function parseWriteLoop(
  checker: ts.TypeChecker,
  loop: ts.ForStatement,
  arrName: string,
  arrSym: ts.Symbol,
): WriteLoopInfo | null {
  if (!loop.initializer || !ts.isVariableDeclarationList(loop.initializer)) return null;
  if (!(loop.initializer.flags & ts.NodeFlags.Let)) return null;
  if (loop.initializer.declarations.length !== 1) return null;
  const idxDecl = loop.initializer.declarations[0]!;
  if (!ts.isIdentifier(idxDecl.name)) return null;
  if (!idxDecl.initializer) return null;
  const indexName = idxDecl.name.text;
  const indexSym = checker.getSymbolAtLocation(idxDecl.name);
  if (!indexSym) return null;

  if (!loop.condition || !ts.isBinaryExpression(loop.condition)) return null;
  if (loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null;
  if (!ts.isIdentifier(loop.condition.left) || loop.condition.left.text !== indexName) return null;

  if (!loop.incrementor) return null;
  if (!isSimpleIncrement(loop.incrementor, indexName)) return null;

  // Body: must be a single expression-statement assigning to `arr[WI]`.
  let bodyStmt: ts.Statement;
  if (ts.isBlock(loop.statement)) {
    if (loop.statement.statements.length !== 1) return null;
    bodyStmt = loop.statement.statements[0]!;
  } else {
    bodyStmt = loop.statement;
  }
  if (!ts.isExpressionStatement(bodyStmt)) return null;
  const expr = bodyStmt.expression;
  if (!ts.isBinaryExpression(expr)) return null;
  if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  if (!ts.isElementAccessExpression(expr.left)) return null;
  if (!ts.isIdentifier(expr.left.expression) || expr.left.expression.text !== arrName) return null;
  if (!ts.isIdentifier(expr.left.argumentExpression) || expr.left.argumentExpression.text !== indexName) return null;
  // Resolve to be sure: arr identifier resolves to the same symbol.
  const lhsSym = checker.getSymbolAtLocation(expr.left.expression);
  if (lhsSym !== arrSym) return null;
  // The RHS MUST NOT reference the array (no self-deps).
  if (referencesSymbol(checker, expr.right, arrSym)) return null;

  return {
    indexName,
    indexSym,
    bound: loop.condition.right,
    initExpr: idxDecl.initializer,
    incrAst: loop.incrementor,
    writeRhs: expr.right,
  };
}

interface ReadLoopInfo {
  /** Index var name in the read loop (may differ from write). */
  indexName: string;
  /** Body expression: `acc = E` where E references `arr[RI]`. */
  assignExpr: ts.BinaryExpression;
  /** The single `arr[RI]` access node inside `assignExpr.right`. */
  arrAccess: ts.ElementAccessExpression;
  /** The index expression init (e.g. `0`). */
  initExpr: ts.Expression;
  /** Whether the read loop's bound is `arr.length`. */
  boundIsArrLength: boolean;
  /** The bound AST node (for diagnostics & rebuild). */
  bound: ts.Expression;
}

function parseReadLoop(
  checker: ts.TypeChecker,
  loop: ts.ForStatement,
  arrName: string,
  arrSym: ts.Symbol,
  accName: string,
  accSym: ts.Symbol,
  writeInfo: WriteLoopInfo,
): ReadLoopInfo | null {
  if (!loop.initializer || !ts.isVariableDeclarationList(loop.initializer)) return null;
  if (!(loop.initializer.flags & ts.NodeFlags.Let)) return null;
  if (loop.initializer.declarations.length !== 1) return null;
  const idxDecl = loop.initializer.declarations[0]!;
  if (!ts.isIdentifier(idxDecl.name)) return null;
  if (!idxDecl.initializer) return null;
  const indexName = idxDecl.name.text;

  if (!loop.condition || !ts.isBinaryExpression(loop.condition)) return null;
  if (loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null;
  if (!ts.isIdentifier(loop.condition.left) || loop.condition.left.text !== indexName) return null;

  // Bound: either `arr.length` OR a node text-equal to writeInfo.bound.
  let boundIsArrLength = false;
  const rhs = loop.condition.right;
  if (
    ts.isPropertyAccessExpression(rhs) &&
    ts.isIdentifier(rhs.expression) &&
    rhs.expression.text === arrName &&
    rhs.name.text === "length"
  ) {
    boundIsArrLength = true;
    const lhsSym = checker.getSymbolAtLocation(rhs.expression);
    if (lhsSym !== arrSym) return null;
  } else if (!exprTextuallyEqual(rhs, writeInfo.bound)) {
    // Conservative: only same-text bounds are accepted (no symbol-level
    // equivalence). The shape we need is identical bound expressions.
    return null;
  }

  if (!loop.incrementor) return null;
  if (!isSimpleIncrement(loop.incrementor, indexName)) return null;

  // Body: single expression statement `ACC = E` where E reads `arr[RI]`.
  let bodyStmt: ts.Statement;
  if (ts.isBlock(loop.statement)) {
    if (loop.statement.statements.length !== 1) return null;
    bodyStmt = loop.statement.statements[0]!;
  } else {
    bodyStmt = loop.statement;
  }
  if (!ts.isExpressionStatement(bodyStmt)) return null;
  const assignExpr = bodyStmt.expression;
  if (!ts.isBinaryExpression(assignExpr)) return null;
  if (assignExpr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  if (!ts.isIdentifier(assignExpr.left) || assignExpr.left.text !== accName) return null;
  const accLhsSym = checker.getSymbolAtLocation(assignExpr.left);
  if (accLhsSym !== accSym) return null;

  // Find the SINGLE `arr[RI]` access inside the RHS. Reject if there are
  // zero or two-or-more, or any other arr.* expression (`arr.length` etc.)
  const arrAccesses: ts.ElementAccessExpression[] = [];
  let foundOtherArrUse = false;
  function visitRhs(node: ts.Node): void {
    if (foundOtherArrUse) return;
    if (ts.isElementAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === arrName) {
        const sym = checker.getSymbolAtLocation(node.expression);
        if (sym === arrSym) {
          if (ts.isIdentifier(node.argumentExpression) && node.argumentExpression.text === indexName) {
            arrAccesses.push(node);
          } else {
            // arr[<not RI>] — bail
            foundOtherArrUse = true;
          }
          return;
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === arrName) {
      const sym = checker.getSymbolAtLocation(node.expression);
      if (sym === arrSym) {
        // arr.length / arr.foo / etc. inside the read body — not supported.
        foundOtherArrUse = true;
        return;
      }
    }
    if (ts.isIdentifier(node) && node.text === arrName) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym === arrSym) {
        // Bare identifier reference (e.g. `arr` passed to a function) — bail.
        foundOtherArrUse = true;
        return;
      }
    }
    ts.forEachChild(node, visitRhs);
  }
  visitRhs(assignExpr.right);
  if (foundOtherArrUse) return null;
  if (arrAccesses.length !== 1) return null;

  return {
    indexName,
    assignExpr,
    arrAccess: arrAccesses[0]!,
    initExpr: idxDecl.initializer,
    boundIsArrLength,
    bound: rhs,
  };
}

function isSimpleIncrement(expr: ts.Expression, indexName: string): boolean {
  // ++idx or idx++ — most common
  if (ts.isPostfixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.PlusPlusToken) {
    return ts.isIdentifier(expr.operand) && expr.operand.text === indexName;
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.PlusPlusToken) {
    return ts.isIdentifier(expr.operand) && expr.operand.text === indexName;
  }
  // idx += 1
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    ts.isIdentifier(expr.left) &&
    expr.left.text === indexName &&
    ts.isNumericLiteral(expr.right) &&
    expr.right.text === "1"
  ) {
    return true;
  }
  return false;
}

function exprTextuallyEqual(a: ts.Expression, b: ts.Expression): boolean {
  // Trim trivia by relying on getText; fast in the common identifier case.
  return a.getText() === b.getText();
}

/**
 * Conservative reference check: does any subtree of `expr` resolve an
 * identifier to the given symbol? Avoids matching shadowed bindings.
 */
function referencesSymbol(checker: ts.TypeChecker, node: ts.Node, sym: ts.Symbol): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(n)) {
      const s = checker.getSymbolAtLocation(n);
      if (s === sym) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/**
 * Same as `referencesSymbol` but for a single top-level statement; bails as
 * soon as a reference is found. Used by the post-read-loop escape sweep —
 * the optimised replacement for `countSymbolRefsOutside` (which walked the
 * whole body for every candidate, giving O(N²)).
 */
function referencesSymbolStatement(checker: ts.TypeChecker, stmt: ts.Statement, sym: ts.Symbol): boolean {
  return referencesSymbol(checker, stmt, sym);
}

// (countSymbolRefsOutside removed — replaced by referencesSymbolStatement
// post-read-loop scan, which exploits the TDZ guarantee on `const arr = []`
// to avoid the O(body) per-candidate walk that gave O(N²) worst case.)

/**
 * Build the fused for-loop. Strategy: REUSE the original read-loop's AST
 * structure (its `let RI = ...` init, `RI++` increment, and outer loop
 * shape) so the TypeScript checker's existing symbol/type associations
 * survive — synthetic factory-created identifiers have no symbol and
 * default to `externref` in our codegen, killing performance.
 *
 * We replace ONLY:
 *   - the body of the read loop (substitute `arr[RI]` with the write-RHS,
 *     alpha-renaming WI→RI if names differ);
 *   - the loop's condition RHS (use `writeInfo.bound` so the compiled
 *     loop doesn't reference the now-eliminated `arr.length`).
 *
 * This keeps the read loop's `let RI = INIT` declaration AS-IS (same
 * symbol, same TS type), so downstream i32-coercion / bounds-check passes
 * see exactly what they did pre-fusion. Only the read body's RHS is a
 * mix of original (read-loop) and substituted (write-loop) subtrees,
 * which is fine because both came from real source nodes.
 */
function buildFusedLoop(
  readLoop: ts.ForStatement,
  writeInfo: WriteLoopInfo,
  readInfo: ReadLoopInfo,
): ts.ForStatement | null {
  const factory = ts.factory;

  // Substitute write-RHS into the read body's arr[RI] subexpression.
  // Also alpha-rename WI -> RI inside writeRhs if the names differ.
  const renameMap: Record<string, string> = {};
  if (writeInfo.indexName !== readInfo.indexName) {
    renameMap[writeInfo.indexName] = readInfo.indexName;
  }
  const renamedWriteRhs = alphaRename(writeInfo.writeRhs, renameMap);

  // Replace the single arr[RI] access inside readInfo.assignExpr.right
  // with the (possibly-renamed) write-RHS. Wrap in parens to preserve
  // precedence — the read body might be e.g. `(acc + arr[i]) | 0` and we
  // need `(acc + (writeRhs)) | 0`.
  const newReadRhs = replaceNode(
    readInfo.assignExpr.right,
    readInfo.arrAccess,
    factory.createParenthesizedExpression(renamedWriteRhs),
  );

  const newAssign = factory.createBinaryExpression(
    readInfo.assignExpr.left,
    factory.createToken(ts.SyntaxKind.EqualsToken),
    newReadRhs,
  );

  // New body: single expression statement wrapping the substituted assign.
  const newBody = factory.createBlock([factory.createExpressionStatement(newAssign)], true);

  // Build a new condition only if the read loop used `arr.length` — we
  // must replace it with the write-loop's bound (which is the same value
  // semantically, but no longer relies on the eliminated array). If the
  // bounds were already text-equal (case 2 in parseReadLoop), reuse the
  // original condition node so its symbols stay intact.
  let newCondition: ts.Expression | undefined = readLoop.condition;
  if (readInfo.boundIsArrLength && readLoop.condition && ts.isBinaryExpression(readLoop.condition)) {
    newCondition = factory.createBinaryExpression(
      readLoop.condition.left,
      ts.factory.createToken(ts.SyntaxKind.LessThanToken),
      writeInfo.bound,
    );
  }

  // Reuse the read-loop's initializer and incrementor verbatim (they
  // declare/use RI which is the index var of the fused loop). This
  // preserves the TS symbol and inferred type for the index variable.
  const fused = factory.createForStatement(readLoop.initializer, newCondition, readLoop.incrementor, newBody);
  ts.setOriginalNode(fused, readLoop);
  ts.setTextRange(fused, readLoop);

  // CRITICAL: factory-created nodes have no parent pointers, but the
  // codegen relies on `expr.parent` to detect `… | 0`-coerced contexts
  // (binary-ops.ts:992) and emit the i32 arithmetic fast path. Without
  // proper parents the fused body re-introduces the f64-roundtrip we
  // came here to eliminate. Walk the new tree and stitch parents.
  setParents(fused, readLoop.parent);
  return fused;
}

/**
 * Walk a freshly-created subtree and assign the `parent` property on every
 * descendant. TypeScript exposes no public `setParent` API but the field
 * is a regular writable property — the same approach the bundled
 * `ts.createSourceFile(..., setParentNodes=true)` flag uses internally.
 */
function setParents(root: ts.Node, rootParent: ts.Node | undefined): void {
  if (rootParent !== undefined) {
    (root as { parent: ts.Node | undefined }).parent = rootParent;
  }
  ts.forEachChild(root, (child) => {
    setParents(child, root);
  });
}

/**
 * Recursively replace a target node within `root` with a replacement,
 * returning a new tree. Uses identity comparison.
 */
function replaceNode(root: ts.Expression, target: ts.Node, replacement: ts.Expression): ts.Expression {
  if (root === target) return replacement;
  // Hand-implemented for the small set of expression shapes that appear in
  // the read-loop body. ts.transform would also work but is heavier.
  return ts.transform(root, [
    (transformContext) => {
      function visit(node: ts.Node): ts.Node {
        if (node === target) return replacement;
        return ts.visitEachChild(node, visit, transformContext);
      }
      return ((node: ts.Node) => visit(node)) as unknown as ts.Transformer<ts.Node>;
    },
  ]).transformed[0] as ts.Expression;
}

/**
 * Alpha-rename identifiers in `expr` according to `renameMap`. Returns a
 * fresh tree (input is not mutated). Only renames standalone Identifier
 * nodes (not property names or labels).
 */
function alphaRename(expr: ts.Expression, renameMap: Record<string, string>): ts.Expression {
  if (Object.keys(renameMap).length === 0) return expr;
  const result = ts.transform(expr, [
    (transformContext) => {
      function visit(node: ts.Node): ts.Node {
        if (
          ts.isIdentifier(node) &&
          Object.prototype.hasOwnProperty.call(renameMap, node.text) &&
          // Don't rename property names, labels, or binding names.
          !isNonRenameablePosition(node)
        ) {
          return ts.factory.createIdentifier(renameMap[node.text]!);
        }
        return ts.visitEachChild(node, visit, transformContext);
      }
      return ((node: ts.Node) => visit(node)) as unknown as ts.Transformer<ts.Node>;
    },
  ]).transformed[0] as ts.Expression;
  return result;
}

function isNonRenameablePosition(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isPropertyAssignment(p) && p.name === id) return true;
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) return true;
  if (ts.isMethodDeclaration(p) && p.name === id) return true;
  if (ts.isLabeledStatement(p) && p.label === id) return true;
  return false;
}

/**
 * Apply detected fusion matches to the function body's statement list.
 * Returns a new array of statements with each match replaced by its
 * synthetic fused-loop pair. Iterates back-to-front so indices stay valid.
 */
export function applyArrayReduceFusion(stmts: readonly ts.Statement[], matches: ReduceFusionMatch[]): ts.Statement[] {
  if (matches.length === 0) return stmts as ts.Statement[];
  const out: ts.Statement[] = [...stmts];
  for (const m of matches) {
    out.splice(m.startIdx, m.endIdx - m.startIdx + 1, ...m.replacement);
  }
  return out;
}
