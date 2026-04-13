// Copyright (c) 2026 Loopdive GmbH. Licensed under AGPL-3.0.
/**
 * Loop statement lowering: while, for, do-while, for-of, for-in.
 */
import ts from "typescript";
import { isStringType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError, reportErrorNoNode } from "../context/errors.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitCoercedLocalSet } from "../expressions/helpers.js";
import { shiftLateImportIndices } from "../expressions/late-imports.js";
import {
  addIteratorImports,
  ensureI32Condition,
  ensureNativeStringHelpers,
  nativeStringType,
  resolveWasmType,
} from "../index.js";
import { resolveComputedKeyExpression } from "../literals.js";
import { addImport, addStringConstantGlobal, ensureExnTag, localGlobalIdx } from "../registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec } from "../registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  emitBoundsCheckedArrayGet,
  valTypesMatch,
} from "../shared.js";
import {
  compileArrayDestructuring,
  compileExternrefArrayDestructuringDecl,
  compileExternrefObjectDestructuringDecl,
  compileObjectDestructuring,
  emitDefaultValueCheck,
  emitNullGuard,
  ensureAsyncIterator,
  syncDestructuredLocalsToGlobals,
} from "./destructuring.js";
import { adjustRethrowDepth, collectInstrs, restoreBlockScopedShadows, saveBlockScopedShadows } from "./shared.js";

export function compileWhileStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.WhileStatement): void {
  // block $break
  //   loop $continue
  //     <condition>
  //     i32.eqz
  //     br_if $break (depth to block)
  //     <body>
  //     br $continue (depth to loop)
  //   end
  // end

  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;
  adjustRethrowDepth(fctx, 2);

  // Track break/continue depths
  // Inside the generated structure, br 1 = break, br 0 = continue
  fctx.breakStack.push(1); // break: exit the outer block
  fctx.continueStack.push(0); // continue: restart the loop

  // Compile condition
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break out of block

  // Compile body — must save/restore block-scoped shadows so that let/const
  // declarations inside the loop body do not leak into the outer scope (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 }); // continue loop
  const loopBody = fctx.body;

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;
  adjustRethrowDepth(fctx, -2);

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

/**
 * Detect integer loop counter pattern: for (let i = INT; i < EXPR; i++)
 * Returns the variable name and initial integer value if the pattern matches,
 * or null if it doesn't match.
 */
function detectI32LoopVar(stmt: ts.ForStatement): { name: string; initValue: number } | null {
  // 1. Check initializer: must be a single variable declaration with an integer literal
  if (!stmt.initializer || !ts.isVariableDeclarationList(stmt.initializer)) return null;
  const decls = stmt.initializer.declarations;
  if (decls.length !== 1) return null;
  const decl = decls[0];
  if (!ts.isIdentifier(decl.name)) return null;
  const name = decl.name.text;
  if (!decl.initializer || !ts.isNumericLiteral(decl.initializer)) return null;
  const initValue = Number(decl.initializer.text.replace(/_/g, ""));
  if (!Number.isInteger(initValue) || initValue < -2147483648 || initValue > 2147483647) return null;

  // 2. Check condition: must be i < EXPR, i <= EXPR, EXPR > i, or EXPR >= i
  if (!stmt.condition || !ts.isBinaryExpression(stmt.condition)) return null;
  const cond = stmt.condition;
  const op = cond.operatorToken.kind;
  let isValidCondition = false;
  if (
    (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) &&
    ts.isIdentifier(cond.left) &&
    cond.left.text === name
  ) {
    isValidCondition = true;
  }
  if (
    (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken) &&
    ts.isIdentifier(cond.right) &&
    cond.right.text === name
  ) {
    isValidCondition = true;
  }
  if (!isValidCondition) return null;

  // 3. Check incrementor: must be i++, ++i, i--, --i, i += INT, or i -= INT
  if (!stmt.incrementor) return null;
  const incr = stmt.incrementor;
  if (ts.isPostfixUnaryExpression(incr)) {
    if (!ts.isIdentifier(incr.operand) || incr.operand.text !== name) return null;
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken && incr.operator !== ts.SyntaxKind.MinusMinusToken) return null;
  } else if (ts.isPrefixUnaryExpression(incr)) {
    if (!ts.isIdentifier(incr.operand) || incr.operand.text !== name) return null;
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken && incr.operator !== ts.SyntaxKind.MinusMinusToken) return null;
  } else if (ts.isBinaryExpression(incr)) {
    if (!ts.isIdentifier(incr.left) || incr.left.text !== name) return null;
    if (
      incr.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken &&
      incr.operatorToken.kind !== ts.SyntaxKind.MinusEqualsToken
    )
      return null;
    // The RHS must be an integer literal
    if (!ts.isNumericLiteral(incr.right)) return null;
    const stepVal = Number(incr.right.text.replace(/_/g, ""));
    if (!Number.isInteger(stepVal)) return null;
  } else {
    return null;
  }

  return { name, initValue };
}

export function compileForStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForStatement): void {
  // Save localMap entries for let/const initializers that shadow outer variables.
  // `for (let x = ...; ...)` creates a block scope that ends after the loop.
  let savedForScope: Map<string, number> | null = null;
  let savedForTdz: Map<string, number> | null = null;
  let savedForConstBindings: Map<string, boolean> | null = null;
  if (
    stmt.initializer &&
    ts.isVariableDeclarationList(stmt.initializer) &&
    stmt.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)
  ) {
    for (const decl of stmt.initializer.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const name = decl.name.text;
        if (!savedForConstBindings) savedForConstBindings = new Map();
        savedForConstBindings.set(name, fctx.constBindings?.has(name) ?? false);
        fctx.constBindings?.delete(name);

        const existing = fctx.localMap.get(name);
        if (existing !== undefined) {
          if (!savedForScope) savedForScope = new Map();
          savedForScope.set(name, existing);
          fctx.localMap.delete(name);
        }
        const existingTdz = fctx.tdzFlagLocals?.get(name);
        if (existingTdz !== undefined) {
          if (!savedForTdz) savedForTdz = new Map();
          savedForTdz.set(name, existingTdz);
          fctx.tdzFlagLocals?.delete(name);
        }
      }
    }
  }

  // Compile initializer (outside the loop)
  if (stmt.initializer) {
    if (ts.isVariableDeclarationList(stmt.initializer)) {
      const isVar = !(stmt.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
      for (const decl of stmt.initializer.declarations) {
        if (ts.isObjectBindingPattern(decl.name)) {
          compileObjectDestructuring(ctx, fctx, decl);
          continue;
        }
        if (ts.isArrayBindingPattern(decl.name)) {
          compileArrayDestructuring(ctx, fctx, decl);
          continue;
        }
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;

        // Check if this variable is a module-level global (e.g., for(var i...)
        // at the top level). If so, use global.set instead of local.set.
        const moduleGlobalIdx = ctx.moduleGlobals.get(name);
        if (moduleGlobalIdx !== undefined) {
          if (decl.initializer) {
            const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
            const wasmType = globalDef?.type ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(decl));
            compileExpression(ctx, fctx, decl.initializer, wasmType);
            fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
          }
          continue;
        }

        // Class expression: skip, already handled as class declaration
        if (decl.initializer && ts.isClassExpression(decl.initializer)) {
          continue;
        }

        // Arrow/function expression: compile first to get closure struct ref type
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const actualType = compileExpression(ctx, fctx, decl.initializer);
          const closureType = actualType ?? { kind: "externref" as const };
          // Reuse existing local for var re-declaration
          const existingIdx = fctx.localMap.get(name);
          const localIdx =
            isVar && existingIdx !== undefined && existingIdx >= fctx.params.length
              ? existingIdx
              : allocLocal(fctx, name, closureType);
          // Update local type if hoisted slot has a less precise type
          if (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length) {
            const localSlot = fctx.locals[localIdx - fctx.params.length];
            if (localSlot) localSlot.type = closureType;
          }
          emitCoercedLocalSet(ctx, fctx, localIdx, closureType);
          continue;
        }

        const varType = ctx.checker.getTypeAtLocation(decl);
        let wasmType = resolveWasmType(ctx, varType);

        // Integer loop inference: if this variable is detected as an integer loop
        // counter (e.g. for (let i = 0; i < n; i++)), use i32 instead of f64
        const i32LoopInfo = detectI32LoopVar(stmt);
        const isI32LoopVar = i32LoopInfo !== null && i32LoopInfo.name === name && wasmType.kind === "f64";
        if (isI32LoopVar) {
          wasmType = { kind: "i32" };
        }

        // Reuse existing local for var re-declaration
        const existingIdx = fctx.localMap.get(name);
        const localIdx =
          isVar && existingIdx !== undefined && existingIdx >= fctx.params.length
            ? existingIdx
            : allocLocal(fctx, name, wasmType);
        // If reusing a pre-hoisted slot, update the local's type to match
        if (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length) {
          const localSlot = fctx.locals[localIdx - fctx.params.length];
          if (localSlot && !valTypesMatch(wasmType, localSlot.type)) {
            localSlot.type = wasmType;
          }
        }
        if (decl.initializer) {
          if (isI32LoopVar) {
            // Emit i32.const directly for the integer init value
            fctx.body.push({ op: "i32.const", value: i32LoopInfo!.initValue });
            fctx.body.push({ op: "local.set", index: localIdx });
          } else {
            const forInitType = compileExpression(ctx, fctx, decl.initializer, wasmType);
            if (forInitType && !valTypesMatch(forInitType, wasmType)) {
              coerceType(ctx, fctx, forInitType, wasmType);
            }
            emitCoercedLocalSet(ctx, fctx, localIdx, forInitType ?? wasmType);
          }
        }
        // Set TDZ flag for let/const loop vars so they are no longer in TDZ (#790)
        if (!isVar) {
          const tdzFlagIdx = fctx.tdzFlagLocals?.get(name);
          if (tdzFlagIdx !== undefined) {
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: "local.set", index: tdzFlagIdx });
          }
        }
      }
    } else {
      const resultType = compileExpression(ctx, fctx, stmt.initializer);
      if (resultType !== null) fctx.body.push({ op: "drop" });
    }
  }

  // Loop structure:
  // block $break {                    ; break target (depth 2 from body)
  //   loop $loop {                    ; loop restart (continue outer target)
  //     condition_check
  //     block $continue {             ; continue target (depth 0 from body)
  //       body
  //     }
  //     incrementor
  //     br $loop
  //   }
  // }
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  // From body inside $continue block:
  //   break = br 2 (exits $break block)
  //   continue = br 0 (exits $continue block, falls through to incrementor)
  fctx.breakStack.push(2);
  fctx.continueStack.push(0);

  // Condition (inside $loop, before $continue block)
  const condInstrs: Instr[] = [];
  if (stmt.condition) {
    const condBody = fctx.body;
    fctx.body = [];
    const condType = compileExpression(ctx, fctx, stmt.condition);
    ensureI32Condition(fctx, condType, ctx);
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({ op: "br_if", depth: 1 }); // break: exits $break (depth 1 from $loop body)
    condInstrs.push(...fctx.body);
    fctx.body = condBody;
  }

  // --- Bounds check elimination: detect `i < arr.length` pattern ---
  // When the condition is `indexVar < arrayVar.length` (or `arrayVar.length > indexVar`),
  // mark the pair so element accesses like `arrayVar[indexVar]` can skip bounds checks.
  const savedSafeIndexed = fctx.safeIndexedArrays;
  if (stmt.condition && ts.isBinaryExpression(stmt.condition)) {
    const cond = stmt.condition;
    const op = cond.operatorToken.kind;
    let indexExpr: ts.Expression | undefined;
    let lengthExpr: ts.Expression | undefined;
    // i < arr.length  OR  i <= arr.length - 1
    if (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) {
      indexExpr = cond.left;
      lengthExpr = cond.right;
    }
    // arr.length > i  OR  arr.length >= i + 1
    if (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken) {
      indexExpr = cond.right;
      lengthExpr = cond.left;
    }
    if (
      indexExpr &&
      lengthExpr &&
      ts.isIdentifier(indexExpr) &&
      ts.isPropertyAccessExpression(lengthExpr) &&
      ts.isIdentifier(lengthExpr.name) &&
      lengthExpr.name.text === "length" &&
      ts.isIdentifier(lengthExpr.expression)
    ) {
      const indexVar = indexExpr.text;
      const arrayVar = lengthExpr.expression.text;
      if (!fctx.safeIndexedArrays) {
        fctx.safeIndexedArrays = new Set();
      }
      fctx.safeIndexedArrays.add(`${arrayVar}:${indexVar}`);
    }
  }

  // Body (inside $continue block) — save/restore block-scoped shadows so that
  // let/const declarations inside the loop body do not leak into outer scope (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;

  // Restore previous safeIndexedArrays (scoped to this loop)
  fctx.safeIndexedArrays = savedSafeIndexed;

  // Incrementor (inside $loop, after $continue block)
  fctx.body = [];
  if (stmt.incrementor) {
    const resultType = compileExpression(ctx, fctx, stmt.incrementor);
    if (resultType !== null) fctx.body.push({ op: "drop" });
  }
  const incrInstrs = fctx.body;

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  // Build the loop body: condition + block $continue { body } + incrementor + br $loop
  const loopBody: Instr[] = [
    ...condInstrs,
    {
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    },
    ...incrInstrs,
    { op: "br", depth: 0 }, // restart $loop
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // Restore localMap entries for for-loop let/const initializers
  if (savedForScope) {
    for (const [name, idx] of savedForScope) {
      fctx.localMap.set(name, idx);
    }
  }
  if (savedForTdz) {
    if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
    for (const [name, idx] of savedForTdz) {
      fctx.tdzFlagLocals.set(name, idx);
    }
  }
  if (savedForConstBindings) {
    if (!fctx.constBindings) fctx.constBindings = new Set();
    for (const [name, hadConstBinding] of savedForConstBindings) {
      if (hadConstBinding) fctx.constBindings.add(name);
      else fctx.constBindings.delete(name);
    }
  }
}

export function compileDoWhileStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.DoStatement): void {
  // block $break {                    ; break target (depth 2 from body)
  //   loop $loop {                    ; loop restart
  //     block $continue {             ; continue target (depth 0 from body)
  //       <body>
  //     }
  //     <condition>
  //     br_if $loop                   ; true → restart loop (depth 0 from loop level)
  //   }
  // }

  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  // From body inside $continue block:
  //   break = br 2 (exits $break block)
  //   continue = br 0 (exits $continue block, falls through to condition)
  fctx.breakStack.push(2);
  fctx.continueStack.push(0);

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;

  // Compile condition — true means continue looping
  fctx.body = [];
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);
  fctx.body.push({ op: "br_if", depth: 0 }); // restart $loop if true
  const condInstrs = fctx.body;

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  // Build: block { loop { block { body } condition br_if } }
  const loopBody: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    },
    ...condInstrs,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

function compileForOfDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern,
  elemLocal: number,
  elemType: ValType,
  stmt: ts.ForOfStatement,
): void {
  if (ts.isObjectBindingPattern(pattern)) {
    // Resolve the struct type from the element type
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      if (elemType.kind === "externref") {
        // Externref elements: use __extern_get to extract properties (e.g. iterator protocol)
        fctx.body.push({ op: "local.get", index: elemLocal });
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, elemType);
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
      // Primitives (bool, number, string) are object-coercible in JS.
      // Empty binding pattern `for (let {} of [val])` is a no-op — just iterate.
      // Non-empty patterns: properties don't exist on primitives, so use defaults
      // or the appropriate undefined sentinel.
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;
        if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingType);
        if (element.initializer) {
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, element.initializer!, bindingType);
            fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          });
          fctx.body.push(...instrs);
        } else {
          // No default — use "undefined" sentinel matching the local's type
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[structTypeIdx];
    if (!typeDef || typeDef.kind !== "struct") {
      reportErrorNoNode(ctx, "for-of destructuring: element type is not a struct");
      return;
    }

    // Find the struct fields by looking up the struct name from reverse map
    const structName = ctx.typeIdxToStructName.get(structTypeIdx);
    const fields = structName ? ctx.structFields.get(structName) : undefined;
    if (!fields) {
      reportError(ctx, stmt, "for-of destructuring: cannot find struct fields");
      return;
    }

    // Null guard: collect field extractions for ref_null types
    emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;

        // Handle rest element: for (const { a, ...rest } of arr)
        if (element.dotDotDotToken) {
          if (ts.isIdentifier(element.name)) {
            const restName = element.name.text;
            let restIdx = fctx.localMap.get(restName);
            if (restIdx === undefined) {
              restIdx = allocLocal(fctx, restName, { kind: "externref" });
            }
            // Collect excluded keys
            const excludedKeys: string[] = [];
            for (const el of pattern.elements) {
              if (!ts.isBindingElement(el) || el.dotDotDotToken) continue;
              const pn = el.propertyName ?? el.name;
              if (ts.isIdentifier(pn)) excludedKeys.push(pn.text);
              else if (ts.isStringLiteral(pn)) excludedKeys.push(pn.text);
              else if (ts.isNumericLiteral(pn)) excludedKeys.push(pn.text);
            }
            let restObjIdx = ctx.funcMap.get("__extern_rest_object");
            if (restObjIdx === undefined) {
              const importsBefore = ctx.numImportFuncs;
              const restObjType = addFuncType(
                ctx,
                [{ kind: "externref" }, { kind: "externref" }],
                [{ kind: "externref" }],
              );
              addImport(ctx, "env", "__extern_rest_object", { kind: "func", typeIdx: restObjType });
              shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
              restObjIdx = ctx.funcMap.get("__extern_rest_object");
            }
            if (restObjIdx !== undefined) {
              const excludedStr = excludedKeys.join(",");
              addStringConstantGlobal(ctx, excludedStr);
              const excludedStrIdx = ctx.stringGlobalMap.get(excludedStr);
              if (excludedStrIdx !== undefined) {
                fctx.body.push({ op: "local.get", index: elemLocal });
                fctx.body.push({ op: "extern.convert_any" } as Instr);
                fctx.body.push({ op: "global.get", index: excludedStrIdx });
                fctx.body.push({ op: "call", funcIdx: restObjIdx });
                fctx.body.push({ op: "local.set", index: restIdx });
              }
            }
          }
          continue;
        }

        const propNameNode = element.propertyName ?? element.name;
        let propNameText = ts.isIdentifier(propNameNode)
          ? propNameNode.text
          : ts.isStringLiteral(propNameNode)
            ? propNameNode.text
            : ts.isNumericLiteral(propNameNode)
              ? propNameNode.text
              : undefined;
        // Try resolving computed property names at compile time
        if (!propNameText && ts.isComputedPropertyName(propNameNode)) {
          propNameText = resolveComputedKeyExpression(ctx, propNameNode.expression);
        }
        if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
        const localName = element.name.text;
        if (!propNameText) continue; // skip truly unresolvable computed property names

        const fieldIdx = fields.findIndex((f) => f.name === propNameText);
        if (fieldIdx === -1) {
          // Field not found in struct — property is "undefined" at runtime.
          // Use the default value if one is provided, otherwise use the
          // appropriate "undefined" sentinel for the target type.
          const bindingTsType = ctx.checker.getTypeAtLocation(element);
          const bindingType = resolveWasmType(ctx, bindingTsType);
          const localIdx = allocLocal(fctx, localName, bindingType);
          if (element.initializer) {
            const instrs = collectInstrs(fctx, () => {
              compileExpression(ctx, fctx, element.initializer!, bindingType);
              fctx.body.push({ op: "local.set", index: localIdx } as Instr);
            });
            fctx.body.push(...instrs);
          } else {
            // No default — use "undefined" sentinel matching the local's type
            if (bindingType.kind === "f64") {
              fctx.body.push({ op: "f64.const", value: NaN });
            } else if (bindingType.kind === "i32") {
              fctx.body.push({ op: "i32.const", value: 0 });
            } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
              const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
              fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "local.set", index: localIdx });
          }
          continue;
        }

        const fieldEntry = fields[fieldIdx];
        if (!fieldEntry) continue;
        const fieldType = fieldEntry.type;
        const localIdx = allocLocal(fctx, localName, fieldType);

        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

        // Handle default value
        if (element.initializer) {
          emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer);
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }); // end null guard for for-of object destructuring
  } else if (ts.isArrayBindingPattern(pattern)) {
    // Array destructuring in for-of: for (var [a, b] of arr)
    // Element may be a vec struct (array wrapper) OR a tuple struct.

    // Handle externref elements: use __extern_get to extract indexed properties
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      if (elemType.kind === "externref") {
        // Externref elements: use __extern_get(elem, box(i)) for each binding (e.g. iterator protocol)
        fctx.body.push({ op: "local.get", index: elemLocal });
        compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, elemType);
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
      // Non-ref, non-externref (f64, i32): assign defaults or undefined sentinels
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (!ts.isBindingElement(element)) continue;
        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingType);
        if (element.initializer) {
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, element.initializer!, bindingType);
            fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          });
          fctx.body.push(...instrs);
        } else {
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const structDef = ctx.mod.types[structTypeIdx];

    // Check if element is a tuple struct (fields named _0, _1, etc.)
    const isTupleStruct =
      structDef &&
      structDef.kind === "struct" &&
      structDef.fields.length > 0 &&
      structDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

    if (isTupleStruct) {
      // Tuple destructuring: extract fields directly from the struct by index
      const tupleFields = (structDef as { fields: { name?: string; type: ValType }[] }).fields;

      emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
        for (let i = 0; i < pattern.elements.length; i++) {
          const element = pattern.elements[i]!;
          if (ts.isOmittedExpression(element)) continue;

          if (i >= tupleFields.length) break; // more bindings than tuple fields

          const fieldType = tupleFields[i]!.type;

          // Handle rest element — convert tuple to externref and slice
          if (ts.isBindingElement(element) && element.dotDotDotToken) {
            const restName = ts.isIdentifier(element.name) ? element.name.text : `__rest_${fctx.locals.length}`;
            let restIdx = fctx.localMap.get(restName);
            if (restIdx === undefined) {
              restIdx = allocLocal(fctx, restName, { kind: "externref" });
            }
            let sliceIdx = ctx.funcMap.get("__extern_slice");
            if (sliceIdx === undefined) {
              const importsBefore = ctx.numImportFuncs;
              const sliceType = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
              addImport(ctx, "env", "__extern_slice", { kind: "func", typeIdx: sliceType });
              shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
              sliceIdx = ctx.funcMap.get("__extern_slice");
            }
            if (sliceIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: elemLocal });
              fctx.body.push({ op: "extern.convert_any" } as Instr);
              fctx.body.push({ op: "f64.const", value: i });
              fctx.body.push({ op: "call", funcIdx: sliceIdx });
              fctx.body.push({ op: "local.set", index: restIdx });
            }
            continue;
          }

          // Handle nested binding patterns: for (const [{ a, b }] of arr)
          if (
            ts.isBindingElement(element) &&
            (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
          ) {
            const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.get", index: elemLocal });
            fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i });
            fctx.body.push({ op: "local.set", index: nestedLocal });
            compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, fieldType, stmt);
            continue;
          }

          if (!ts.isIdentifier(element.name)) continue;
          const localName = element.name.text;
          const bindingTsType = ctx.checker.getTypeAtLocation(element);
          const bindingWasmType = resolveWasmType(ctx, bindingTsType);
          const localIdx = allocLocal(fctx, localName, bindingWasmType);

          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i });

          if (!valTypesMatch(fieldType, bindingWasmType)) {
            coerceType(ctx, fctx, fieldType, bindingWasmType);
          }

          if (element.initializer) {
            emitDefaultValueCheck(ctx, fctx, bindingWasmType, localIdx, element.initializer);
          } else {
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        }
      }); // end null guard for for-of tuple destructuring
      return;
    }

    // Vec array destructuring: element is a vec struct { length, data }
    const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, structTypeIdx);
    const arrDef = ctx.mod.types[innerArrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      reportError(ctx, stmt, "for-of array destructuring: element is not an array type");
      return;
    }

    const innerElemType = arrDef.element;

    emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
      for (let i = 0; i < pattern.elements.length; i++) {
        const element = pattern.elements[i]!;
        if (ts.isOmittedExpression(element)) continue;

        // Handle nested binding patterns: for (const [{ a, b }] of arr)
        if (
          ts.isBindingElement(element) &&
          (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
        ) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, innerElemType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, innerElemType, stmt);
          continue;
        }

        // Handle rest element: for (const [...rest] of arr) or for (const [a, ...rest] of arr)
        if (ts.isBindingElement(element) && element.dotDotDotToken) {
          const restName = ts.isIdentifier(element.name) ? element.name.text : `__rest_${fctx.locals.length}`;

          // Compute rest length: max(0, original.length - i)
          const restLenLocal = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 0 }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.sub" } as Instr);
          fctx.body.push({ op: "local.set", index: restLenLocal });
          // Clamp to 0 if negative
          fctx.body.push({ op: "i32.const", value: 0 } as Instr);
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "i32.const", value: 0 } as Instr);
          fctx.body.push({ op: "i32.lt_s" } as Instr);
          fctx.body.push({ op: "select" } as Instr);
          fctx.body.push({ op: "local.set", index: restLenLocal });

          // Create new data array: array.new_default(restLen)
          const restArrLocal = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: innerArrTypeIdx,
          });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "array.new_default", typeIdx: innerArrTypeIdx } as Instr);
          fctx.body.push({ op: "local.set", index: restArrLocal });

          // array.copy(restArr, 0, srcData, i, restLen)
          fctx.body.push({ op: "local.get", index: restArrLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 1 }); // src data
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "array.copy", dstTypeIdx: innerArrTypeIdx, srcTypeIdx: innerArrTypeIdx } as Instr);

          // Create new vec struct: struct.new(restLen, restArr)
          const restVecType: ValType = { kind: "ref", typeIdx: structTypeIdx };
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "local.get", index: restArrLocal });
          fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx } as Instr);

          let restIdx = fctx.localMap.get(restName);
          if (restIdx === undefined) {
            restIdx = allocLocal(fctx, restName, restVecType);
          }
          fctx.body.push({ op: "local.set", index: restIdx });
          continue;
        }

        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingWasmType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingWasmType);

        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "i32.const", value: i });
        emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);

        if (!valTypesMatch(innerElemType, bindingWasmType)) {
          coerceType(ctx, fctx, innerElemType, bindingWasmType);
        }

        if (element.initializer) {
          emitDefaultValueCheck(ctx, fctx, bindingWasmType, localIdx, element.initializer);
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }); // end null guard for for-of array destructuring
  }
}

/**
 * Handle assignment destructuring in for-of expression form:
 *   for ({a, b} of arr) — assigns to already-declared variables
 *   for ([x, y] of arr) — assigns to already-declared variables
 */
function compileForOfAssignDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  elemLocal: number,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  stmt: ts.ForOfStatement,
): void {
  if (ts.isObjectLiteralExpression(expr)) {
    // for ({a, b} of arr) — elem is a struct ref, extract fields
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      // Primitives (bool, number, string) are object-coercible in JS.
      // Empty destructuring `for ({} of [val])` is a no-op — just iterate.
      // Non-empty patterns: properties don't exist on primitives, so use defaults.
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) continue;
        if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;
        const targetName = ts.isShorthandPropertyAssignment(prop)
          ? prop.name.text
          : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
            ? prop.initializer.text
            : ts.isIdentifier(prop.name)
              ? prop.name.text
              : undefined;
        if (!targetName) continue; // skip computed property names
        const targetLocal = fctx.localMap.get(targetName);
        if (targetLocal === undefined) continue;

        // Property doesn't exist on primitive — use default if provided
        const init = ts.isShorthandPropertyAssignment(prop) ? prop.objectAssignmentInitializer : undefined;
        if (init) {
          const targetType = getLocalType(fctx, targetLocal);
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, init, targetType ?? { kind: "externref" });
            fctx.body.push({ op: "local.set", index: targetLocal } as Instr);
          });
          fctx.body.push(...instrs);
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[structTypeIdx];
    if (!typeDef || typeDef.kind !== "struct") return;

    const structName = ctx.typeIdxToStructName.get(structTypeIdx);
    const fields = structName ? ctx.structFields.get(structName) : undefined;
    if (!fields) return;

    for (const prop of expr.properties) {
      if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;
      let propName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : undefined;
      // Try resolving computed property names at compile time
      if (!propName && ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name)) {
        propName = resolveComputedKeyExpression(ctx, prop.name.expression);
      }
      if (!propName) continue; // skip truly unresolvable computed property names
      const targetName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
          ? prop.initializer.text
          : propName;

      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) continue;

      let targetLocal = fctx.localMap.get(targetName);
      let targetSyncGlobalIdx: number | undefined;
      if (targetLocal === undefined) {
        const globalIdx = ctx.moduleGlobals.get(targetName);
        if (globalIdx === undefined) continue;
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const globalType = globalDef?.type ?? { kind: "externref" as const };
        targetLocal = allocLocal(fctx, targetName, globalType);
        targetSyncGlobalIdx = globalIdx;
      }

      const fieldEntry2 = fields[fieldIdx];
      if (!fieldEntry2) continue;
      const fieldType = fieldEntry2.type;
      const targetType = getLocalType(fctx, targetLocal);
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
      const effectiveStackType = targetType && !valTypesMatch(fieldType, targetType) ? targetType : fieldType;
      if (targetType && !valTypesMatch(fieldType, targetType)) {
        coerceType(ctx, fctx, fieldType, targetType);
      }
      emitCoercedLocalSet(ctx, fctx, targetLocal, effectiveStackType);
      if (targetSyncGlobalIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "global.set", index: targetSyncGlobalIdx });
      }
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // for ([x, y] of arr) — elem is a vec struct or tuple struct, extract by index
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      // Externref elements: use __extern_get to extract indexed properties
      if (elemType.kind === "externref") {
        compileForOfAssignDestructuringExternref(ctx, fctx, expr, elemLocal);
      }
      return;
    }

    const innerVecTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const innerStructDef = ctx.mod.types[innerVecTypeIdx];

    // Check if element is a tuple struct (fields named _0, _1, etc.)
    const isTuple =
      innerStructDef &&
      innerStructDef.kind === "struct" &&
      innerStructDef.fields.length > 0 &&
      innerStructDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

    // Handle 0-field structs (empty tuples like []) — all elements are OOB, apply defaults
    if (innerStructDef && innerStructDef.kind === "struct" && innerStructDef.fields.length === 0) {
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;
        let oobTarget: ts.Expression = el;
        let oobInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          oobTarget = el.left;
          oobInit = el.right;
        }
        if (oobInit && ts.isIdentifier(oobTarget)) {
          let oobLocal = fctx.localMap.get(oobTarget.text);
          let oobSyncGlobalIdx: number | undefined;
          if (oobLocal === undefined) {
            const globalIdx = ctx.moduleGlobals.get(oobTarget.text);
            if (globalIdx !== undefined) {
              const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
              const globalType = globalDef?.type ?? { kind: "externref" as const };
              oobLocal = allocLocal(fctx, oobTarget.text, globalType);
              oobSyncGlobalIdx = globalIdx;
            }
          }
          if (oobLocal !== undefined) {
            const oobType = getLocalType(fctx, oobLocal);
            const instrs = collectInstrs(fctx, () => {
              compileExpression(ctx, fctx, oobInit!, oobType ?? { kind: "f64" });
              fctx.body.push({ op: "local.set", index: oobLocal! } as Instr);
            });
            fctx.body.push(...instrs);
            if (oobSyncGlobalIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: oobLocal });
              fctx.body.push({ op: "global.set", index: oobSyncGlobalIdx });
            }
          }
        }
      }
      return;
    }

    if (isTuple) {
      // Tuple assignment destructuring: extract fields directly
      const tupleFields = (innerStructDef as { fields: { name?: string; type: ValType }[] }).fields;
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;

        // OOB: tuple has fewer fields than destructuring targets
        if (i >= tupleFields.length) {
          // If element has a default initializer, apply it directly (value is undefined/OOB)
          let oobTarget: ts.Expression = el;
          let oobInit: ts.Expression | undefined;
          if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            oobTarget = el.left;
            oobInit = el.right;
          }
          if (oobInit && ts.isIdentifier(oobTarget)) {
            let oobLocal = fctx.localMap.get(oobTarget.text);
            let oobSyncGlobalIdx: number | undefined;
            if (oobLocal === undefined) {
              const globalIdx = ctx.moduleGlobals.get(oobTarget.text);
              if (globalIdx !== undefined) {
                const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
                const globalType = globalDef?.type ?? { kind: "externref" as const };
                oobLocal = allocLocal(fctx, oobTarget.text, globalType);
                oobSyncGlobalIdx = globalIdx;
              }
            }
            if (oobLocal !== undefined) {
              const oobType = getLocalType(fctx, oobLocal);
              const instrs = collectInstrs(fctx, () => {
                compileExpression(ctx, fctx, oobInit!, oobType ?? { kind: "f64" });
                fctx.body.push({ op: "local.set", index: oobLocal! } as Instr);
              });
              fctx.body.push(...instrs);
              if (oobSyncGlobalIdx !== undefined) {
                fctx.body.push({ op: "local.get", index: oobLocal });
                fctx.body.push({ op: "global.set", index: oobSyncGlobalIdx });
              }
            }
          }
          continue;
        }

        const fieldType = tupleFields[i]!.type;

        // Handle nested destructuring: for ([{ a, b }] of arr) or for ([[x, y]] of arr)
        if (ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el)) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: i });
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfAssignDestructuring(ctx, fctx, el, nestedLocal, fieldType, vecTypeIdx, arrTypeIdx, stmt);
          continue;
        }

        // Handle assignment with default: [v = 10]
        let targetEl: ts.Expression = el;
        let defaultInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          targetEl = el.left;
          defaultInit = el.right;
        }

        if (!ts.isIdentifier(targetEl)) continue;

        let targetLocal = fctx.localMap.get(targetEl.text);
        let tupleSyncGlobalIdx: number | undefined;
        if (targetLocal === undefined) {
          const globalIdx = ctx.moduleGlobals.get(targetEl.text);
          if (globalIdx === undefined) continue;
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          const globalType = globalDef?.type ?? { kind: "externref" as const };
          targetLocal = allocLocal(fctx, targetEl.text, globalType);
          tupleSyncGlobalIdx = globalIdx;
        }

        const targetType = getLocalType(fctx, targetLocal);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: i });

        if (defaultInit) {
          // Check for undefined and apply default — BEFORE type coercion
          emitDefaultValueCheck(ctx, fctx, fieldType, targetLocal, defaultInit, targetType ?? undefined);
        } else {
          if (targetType && !valTypesMatch(fieldType, targetType)) {
            coerceType(ctx, fctx, fieldType, targetType);
          }
          fctx.body.push({ op: "local.set", index: targetLocal });
        }

        if (tupleSyncGlobalIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "global.set", index: tupleSyncGlobalIdx });
        }
      }
    } else {
      // Vec array assignment destructuring
      const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, innerVecTypeIdx);
      const innerArrDef = ctx.mod.types[innerArrTypeIdx];
      if (!innerArrDef || innerArrDef.kind !== "array") return;

      const innerElemType = innerArrDef.element;
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;

        // Handle nested destructuring: for ([{ a, b }] of arr) or for ([[x, y]] of arr)
        if (ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el)) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, innerElemType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfAssignDestructuring(ctx, fctx, el, nestedLocal, innerElemType, vecTypeIdx, arrTypeIdx, stmt);
          continue;
        }

        // Handle assignment with default: [v = 10]
        let targetEl: ts.Expression = el;
        let defaultInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          targetEl = el.left;
          defaultInit = el.right;
        }

        if (!ts.isIdentifier(targetEl)) continue;

        let targetLocal = fctx.localMap.get(targetEl.text);
        let vecSyncGlobalIdx: number | undefined;
        if (targetLocal === undefined) {
          const globalIdx = ctx.moduleGlobals.get(targetEl.text);
          if (globalIdx === undefined) continue;
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          const globalType = globalDef?.type ?? { kind: "externref" as const };
          targetLocal = allocLocal(fctx, targetEl.text, globalType);
          vecSyncGlobalIdx = globalIdx;
        }

        const targetType = getLocalType(fctx, targetLocal);

        if (defaultInit && innerElemType.kind === "externref") {
          // For externref elements with defaults, do explicit bounds check.
          // OOB produces ref.null.extern (Wasm null) which is indistinguishable from JS null.
          // We must apply defaults for OOB but NOT for JS null.
          const arrDataLocal = allocLocal(fctx, `__forof_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: innerArrTypeIdx,
          });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "local.tee", index: arrDataLocal });
          fctx.body.push({ op: "array.len" });
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.gt_s" } as Instr); // len > i means in-bounds

          const hintType = targetType ?? innerElemType;
          // Then branch: in-bounds — get element, check for undefined, apply default if needed
          const thenInstrs = collectInstrs(fctx, () => {
            fctx.body.push({ op: "local.get", index: arrDataLocal } as Instr);
            fctx.body.push({ op: "i32.const", value: i } as Instr);
            fctx.body.push({ op: "array.get", typeIdx: innerArrTypeIdx } as Instr);
            emitDefaultValueCheck(ctx, fctx, innerElemType, targetLocal!, defaultInit!, targetType ?? undefined);
          });
          // Else branch: OOB — apply default directly
          const elseInstrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, defaultInit!, hintType);
            fctx.body.push({ op: "local.set", index: targetLocal! } as Instr);
          });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: elseInstrs,
          } as Instr);
        } else {
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);

          if (defaultInit) {
            // Check for undefined and apply default — BEFORE type coercion
            emitDefaultValueCheck(ctx, fctx, innerElemType, targetLocal, defaultInit, targetType ?? undefined);
          } else {
            if (targetType && !valTypesMatch(innerElemType, targetType)) {
              coerceType(ctx, fctx, innerElemType, targetType);
            }
            fctx.body.push({ op: "local.set", index: targetLocal });
          }
        }

        if (vecSyncGlobalIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "global.set", index: vecSyncGlobalIdx });
        }
      }
    }
  }
}

/**
 * Handle assignment destructuring of externref arrays in for-of.
 * Uses __extern_get(elem, box(i)) for each element, with default value support.
 */
function compileForOfAssignDestructuringExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
  elemLocal: number,
): void {
  // Ensure __extern_get is available
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (getIdx === undefined) return;

  // Ensure __box_number is available
  let boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    boxIdx = ctx.funcMap.get("__box_number");
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (boxIdx === undefined || getIdx === undefined) return;

  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isSpreadElement(el)) continue;

    // Handle assignment with default: [v = 10]
    let targetEl: ts.Expression = el;
    let defaultInit: ts.Expression | undefined;
    if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      targetEl = el.left;
      defaultInit = el.right;
    }

    if (!ts.isIdentifier(targetEl)) continue;

    let targetLocal = fctx.localMap.get(targetEl.text);
    let extSyncGlobalIdx: number | undefined;
    if (targetLocal === undefined) {
      const globalIdx = ctx.moduleGlobals.get(targetEl.text);
      if (globalIdx === undefined) continue;
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      const globalType = globalDef?.type ?? { kind: "externref" as const };
      targetLocal = allocLocal(fctx, targetEl.text, globalType);
      extSyncGlobalIdx = globalIdx;
    }

    // Emit: __extern_get(elem, box(i)) -> externref
    fctx.body.push({ op: "local.get", index: elemLocal });
    fctx.body.push({ op: "f64.const", value: i });
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    fctx.body.push({ op: "call", funcIdx: getIdx! });

    if (defaultInit) {
      const targetType = getLocalType(fctx, targetLocal);
      emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, targetLocal, defaultInit, targetType ?? undefined);
    } else {
      // Coerce externref to target local's type and set
      emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
    }

    if (extSyncGlobalIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: targetLocal });
      fctx.body.push({ op: "global.set", index: extSyncGlobalIdx });
    }
  }
}

/** Collect all identifier names from a binding pattern (ObjectBindingPattern or ArrayBindingPattern) */
function collectBindingNames(pattern: ts.BindingPattern): string[] {
  const names: string[] = [];
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isBindingElement(element)) {
      if (ts.isIdentifier(element.name)) {
        names.push(element.name.text);
      } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        names.push(...collectBindingNames(element.name));
      }
    }
  }
  return names;
}

export function compileForOfStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForOfStatement): void {
  // Check the TS type of the iterable to decide compilation strategy
  const exprTsType = ctx.checker.getTypeAtLocation(stmt.expression);

  // String iteration: for (const c of "hello") iterates characters
  // In fast mode, use native string struct iteration (pure Wasm)
  if (isStringType(exprTsType) && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    compileForOfString(ctx, fctx, stmt);
    return;
  }

  const sym = (exprTsType as ts.TypeReference).symbol ?? (exprTsType as ts.Type).symbol;
  const isArray = sym?.name === "Array";

  if (isArray) {
    compileForOfArray(ctx, fctx, stmt);
  } else {
    // Type checker didn't resolve as Array — tentatively compile the expression
    // to check if it produces a vec struct (e.g. tuple types, union types, etc.).
    // If so, use the efficient array path; otherwise fall back to host iterator.
    if (!compileForOfArrayTentative(ctx, fctx, stmt)) {
      compileForOfIterator(ctx, fctx, stmt);
    }
  }
}

/** Compile for...of over a string — iterate characters using __str_charAt */
function compileForOfString(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForOfStatement): void {
  // Ensure native string helpers are available (provides __str_charAt)
  ensureNativeStringHelpers(ctx);

  const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
  if (charAtIdx === undefined) {
    reportError(ctx, stmt, "for-of on string: __str_charAt helper not available");
    return;
  }

  const strType = nativeStringType(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  // Compile the iterable expression (string ref)
  const bodyLenBefore = fctx.body.length;
  const compiledType = compileExpression(ctx, fctx, stmt.expression);
  if (!compiledType) {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of: failed to compile string expression");
    return;
  }

  // Save string ref to temp local
  const strLocal = allocLocal(fctx, `__forof_str_${fctx.locals.length}`, strType);
  fctx.body.push({ op: "local.set", index: strLocal });

  // Mark position for null guard wrapping
  const strNullGuardStart = fctx.body.length;

  // Extract length from string (field 0 of AnyString struct)
  const lenLocal = allocLocal(fctx, `__forof_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: strLocal });
  fctx.body.push({ op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Allocate counter local (i32)
  const iLocal = allocLocal(fctx, `__forof_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Element type is string (each character is a single-char string)
  const elemType = strType;

  // Declare the loop variable
  let elemLocal: number;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
    elemLocal = allocLocal(fctx, varName, elemType);
    // Track const bindings — assignment to const in for-of should throw TypeError
    if (stmt.initializer.flags & ts.NodeFlags.Const && ts.isIdentifier(decl.name)) {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(decl.name.text);
    }
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of str) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;
  adjustRethrowDepth(fctx, 2);

  fctx.breakStack.push(1); // break = depth 1 (exit block)
  fctx.continueStack.push(0); // continue = depth 0 (restart loop)

  // Condition: i >= length -> break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break

  // Get character: c = charAt(str, i)
  fctx.body.push({ op: "local.get", index: strLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "call", funcIdx: charAtIdx });
  fctx.body.push({ op: "local.set", index: elemLocal });

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  // Increment i
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;
  adjustRethrowDepth(fctx, -2);

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // Null guard: if string ref is nullable, throw TypeError on null (#775)
  // In JS, `for (const c of null)` throws TypeError
  if (strType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(strNullGuardStart);
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: strLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
      else: guardedInstrs,
    });
  }
}

/**
 * Tentatively try to compile for...of as an array iteration.
 * Compiles the iterable expression, checks if the result is a vec struct,
 * and if so delegates to compileForOfArray (which re-compiles the expression).
 * Returns true if the array path was used, false if caller should fall back.
 */
function compileForOfArrayTentative(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForOfStatement): boolean {
  // Tentatively compile just the expression to discover its Wasm type
  const bodyLenBefore = fctx.body.length;
  const localsLenBefore = fctx.locals.length;
  const exprType = compileExpression(ctx, fctx, stmt.expression);

  // Check if it compiled to a ref to a vec struct (not just any struct —
  // a class instance is also a struct but not iterable via array access).
  // A vec struct has {length: i32, data: (ref $arr)} — verified by getArrTypeIdxFromVec.
  if (exprType && (exprType.kind === "ref" || exprType.kind === "ref_null")) {
    const typeDef = ctx.mod.types[exprType.typeIdx];
    if (typeDef && typeDef.kind === "struct" && getArrTypeIdxFromVec(ctx, exprType.typeIdx) >= 0) {
      // Confirmed vec struct — undo the tentative compilation and use the
      // full array path (which compiles the expression again with proper setup)
      fctx.body.length = bodyLenBefore;
      fctx.locals.length = localsLenBefore;
      compileForOfArray(ctx, fctx, stmt);
      return true;
    }
  }

  // Not a vec struct — undo tentative compilation, let caller use iterator path
  fctx.body.length = bodyLenBefore;
  fctx.locals.length = localsLenBefore;
  return false;
}

/** Compile for...of over an array using index-based loop (existing behavior) */
function compileForOfArray(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForOfStatement): void {
  // Compile the iterable expression (vec struct ref)
  const bodyLenBefore = fctx.body.length;
  const vecType = compileExpression(ctx, fctx, stmt.expression);
  if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of requires an array expression");
    return;
  }

  // Expect a vec struct type {length: i32, data: (ref $__arr_T)}
  const vecTypeIdx = vecType.typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of requires an array type");
    return;
  }

  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of requires an array type");
    return;
  }
  const elemType = arrDef.element;

  // Save vec ref to temp local
  const vecLocal = allocLocal(fctx, `__forof_vec_${fctx.locals.length}`, vecType);
  fctx.body.push({ op: "local.set", index: vecLocal });

  // Mark position for null guard wrapping (struct.get on null ref traps)
  const nullGuardStart = fctx.body.length;

  // Extract data array from vec into a local
  const dataLocal = allocLocal(fctx, `__forof_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });

  // Extract length from vec into a local
  const lenLocal = allocLocal(fctx, `__forof_len_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Allocate counter local (i32)
  const iLocal = allocLocal(fctx, `__forof_i_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Declare the loop variable (may be a simple identifier or a destructuring pattern)
  let elemLocal: number;
  let destructPattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let assignDestructExpr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPattern = decl.name;
      // Allocate a temp local to hold the element for destructuring
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
      // Track const bindings for all identifiers in the destructuring pattern
      if (isConst) {
        collectBindingNames(decl.name).forEach((n) => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
      // Track const bindings — assignment to const in for-of should throw TypeError
      if (isConst && ts.isIdentifier(decl.name)) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(decl.name.text);
      }
    }
  } else if (ts.isObjectLiteralExpression(stmt.initializer) || ts.isArrayLiteralExpression(stmt.initializer)) {
    // Expression form with destructuring: for ({a, b} of arr) or for ([x, y] of arr)
    // These assign to already-declared variables
    assignDestructExpr = stmt.initializer;
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of arr) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;
  adjustRethrowDepth(fctx, 2);

  fctx.breakStack.push(1); // break = depth 1 (exit block)
  fctx.continueStack.push(0); // continue = depth 0 (restart loop)

  // Condition: i >= length → break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break

  // Get element: x = data[i]
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
  // Coerce from Wasm array element type to the local's declared type
  const elemLocalType = getLocalType(fctx, elemLocal);
  if (elemLocalType && !valTypesMatch(elemType, elemLocalType)) {
    coerceType(ctx, fctx, elemType, elemLocalType);
  }
  emitCoercedLocalSet(ctx, fctx, elemLocal, elemType);

  // If destructuring pattern (binding form), destructure from the element
  if (destructPattern) {
    compileForOfDestructuring(ctx, fctx, destructPattern, elemLocal, elemType, stmt);
  }
  // If assignment destructuring expression, assign to existing locals
  if (assignDestructExpr) {
    compileForOfAssignDestructuring(ctx, fctx, assignDestructExpr, elemLocal, elemType, vecTypeIdx, arrTypeIdx, stmt);
  }

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  // Increment i
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;
  adjustRethrowDepth(fctx, -2);

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // Null guard: if vec ref is nullable, guard against null (#775, #789)
  // If null from a failed guarded cast (wrong struct type), just skip the loop.
  // Only throw TypeError for genuinely null values (e.g. `for (const x of null)`).
  if (vecType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(nullGuardStart);
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    if (backupLocal !== undefined) {
      // A guarded cast backup exists: distinguish "wrong type" from "genuinely null"
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: backupLocal } as Instr,
          { op: "ref.is_null" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
            else: [], // wrong struct type → skip loop
          } as Instr,
        ],
        else: guardedInstrs,
      });
    } else {
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
        else: guardedInstrs,
      });
    }
  }
}

/**
 * Handle assignment destructuring for the iterator protocol path.
 * Element is externref — use __extern_get(elem, key) to extract properties/indices.
 */
function compileForOfIteratorAssignDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  elemLocal: number,
  stmt: ts.ForOfStatement,
): void {
  // Ensure __extern_get is available
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (getIdx === undefined) return;

  if (ts.isObjectLiteralExpression(expr)) {
    // for ({a, b} of iterable) — use __extern_get(elem, "propName") for each property
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) continue;
      if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;

      const propName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : undefined;
      if (!propName) continue;

      const targetName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
          ? prop.initializer.text
          : propName;

      let targetLocal = fctx.localMap.get(targetName);
      let iterObjSyncGlobalIdx: number | undefined;
      if (targetLocal === undefined) {
        const globalIdx = ctx.moduleGlobals.get(targetName);
        if (globalIdx === undefined) continue;
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const globalType = globalDef?.type ?? { kind: "externref" as const };
        targetLocal = allocLocal(fctx, targetName, globalType);
        iterObjSyncGlobalIdx = globalIdx;
      }

      // Register string constant for property name
      addStringConstantGlobal(ctx, propName);
      const strGlobalIdx = ctx.stringGlobalMap.get(propName);
      if (strGlobalIdx === undefined) continue;

      // Refresh getIdx in case addStringConstantGlobal shifted indices
      getIdx = ctx.funcMap.get("__extern_get");
      if (getIdx === undefined) continue;

      // Emit: __extern_get(elem, "propName") -> externref
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "global.get", index: strGlobalIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx });

      // Coerce externref to target local's type and set
      emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });

      if (iterObjSyncGlobalIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "global.set", index: iterObjSyncGlobalIdx });
      }
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // for ([x, y] of iterable) — use __extern_get(elem, box(i)) for each element

    // Ensure __box_number is available
    let boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      boxIdx = ctx.funcMap.get("__box_number");
      // Refresh getIdx since it may have shifted
      getIdx = ctx.funcMap.get("__extern_get");
    }
    if (boxIdx === undefined || getIdx === undefined) return;

    for (let i = 0; i < expr.elements.length; i++) {
      const el = expr.elements[i]!;
      if (ts.isOmittedExpression(el)) continue;
      if (ts.isSpreadElement(el)) continue;

      // Handle assignment with default: [v = 10]
      let targetElIter: ts.Expression = el;
      let defaultInitIter: ts.Expression | undefined;
      if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        targetElIter = el.left;
        defaultInitIter = el.right;
      }

      if (!ts.isIdentifier(targetElIter)) continue;

      let targetLocal = fctx.localMap.get(targetElIter.text);
      let iterArrSyncGlobalIdx: number | undefined;
      if (targetLocal === undefined) {
        const globalIdx = ctx.moduleGlobals.get(targetElIter.text);
        if (globalIdx === undefined) continue;
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const globalType = globalDef?.type ?? { kind: "externref" as const };
        targetLocal = allocLocal(fctx, targetElIter.text, globalType);
        iterArrSyncGlobalIdx = globalIdx;
      }

      // Emit: __extern_get(elem, box(i)) -> externref
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "f64.const", value: i });
      fctx.body.push({ op: "call", funcIdx: boxIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx! });

      if (defaultInitIter) {
        const targetType = getLocalType(fctx, targetLocal);
        emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, targetLocal, defaultInitIter, targetType ?? undefined);
      } else {
        // Coerce externref to target local's type and set
        emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
      }

      if (iterArrSyncGlobalIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "global.set", index: iterArrSyncGlobalIdx });
      }
    }
  }
}

/**
 * Compile for...of using direct Wasm method dispatch when the iterable
 * is a known struct with a @@iterator method.
 *
 * Calls @@iterator() directly in Wasm, then loops calling next() directly,
 * extracting done/value from struct fields — no host imports needed.
 *
 * Returns true if successfully compiled, false if caller should fall back.
 */
function compileForOfDirectIterator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  iterableType: ValType,
  iterMethodIdx: number,
): boolean {
  // Get the return type of the @@iterator method to find the iterator struct
  const iterMethodDef = ctx.mod.functions[iterMethodIdx - ctx.numImportFuncs];
  if (!iterMethodDef) return false;
  const iterMethodType = ctx.mod.types[iterMethodDef.typeIdx];
  if (!iterMethodType || iterMethodType.kind !== "func" || iterMethodType.results.length === 0) return false;

  const iterResultType = iterMethodType.results[0]!;
  if (iterResultType.kind !== "ref" && iterResultType.kind !== "ref_null") return false;

  const iterStructTypeIdx = iterResultType.typeIdx;
  const iterStructDef = ctx.mod.types[iterStructTypeIdx];
  if (!iterStructDef || iterStructDef.kind !== "struct") return false;

  // Find the struct name for the iterator type to look up the next method
  let iterStructName: string | undefined;
  for (const [name, idx] of ctx.structMap) {
    if (idx === iterStructTypeIdx) {
      iterStructName = name;
      break;
    }
  }
  if (!iterStructName) return false;

  const nextMethodIdx = ctx.funcMap.get(`${iterStructName}_next`);
  if (nextMethodIdx === undefined) return false;

  // Get the return type of next() to find the result struct ({value, done})
  const nextMethodDef = ctx.mod.functions[nextMethodIdx - ctx.numImportFuncs];
  if (!nextMethodDef) return false;
  const nextMethodType = ctx.mod.types[nextMethodDef.typeIdx];
  if (!nextMethodType || nextMethodType.kind !== "func" || nextMethodType.results.length === 0) return false;

  const nextResultType = nextMethodType.results[0]!;

  // If next() returns externref, we can't extract done/value in Wasm — fall back
  if (nextResultType.kind !== "ref" && nextResultType.kind !== "ref_null") return false;

  const resultStructTypeIdx = nextResultType.typeIdx;
  const resultStructDef = ctx.mod.types[resultStructTypeIdx];
  if (!resultStructDef || resultStructDef.kind !== "struct") return false;

  // Find "done" and "value" field indices in the result struct
  const resultFields =
    ctx.structFields.get(`${iterStructName}_next_result`) ?? findStructFieldsByTypeIdx(ctx, resultStructTypeIdx);
  if (!resultFields) return false;

  let doneFieldIdx = -1;
  let valueFieldIdx = -1;
  let doneFieldType: ValType | undefined;
  let valueFieldType: ValType | undefined;

  for (let i = 0; i < resultFields.length; i++) {
    const f = resultFields[i]!;
    if (f.name === "done") {
      doneFieldIdx = i;
      doneFieldType = f.type;
    }
    if (f.name === "value") {
      valueFieldIdx = i;
      valueFieldType = f.type;
    }
  }

  if (doneFieldIdx < 0 || valueFieldIdx < 0 || !doneFieldType || !valueFieldType) return false;

  // We have everything we need — compile the full iteration loop in Wasm!

  // Null check on iterable
  const nullTmp = allocLocal(fctx, `__forit_stmp_${fctx.locals.length}`, iterableType);
  fctx.body.push({ op: "local.tee", index: nullTmp });
  fctx.body.push({ op: "ref.is_null" });
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
    else: [],
  });

  // Call @@iterator method: iter = obj[Symbol.iterator]()
  fctx.body.push({ op: "local.get", index: nullTmp });
  if (iterableType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: iterMethodIdx });

  const iterLocal = allocLocal(fctx, `__forit_iter_${fctx.locals.length}`, iterResultType);
  fctx.body.push({ op: "local.set", index: iterLocal });

  // Allocate result local
  const resultLocal = allocLocal(fctx, `__forit_res_${fctx.locals.length}`, nextResultType);

  // Declare the loop variable
  const elemType: ValType = valueFieldType;
  let elemLocal: number;
  let destructPatternIter: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let assignDestructExprIter: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPatternIter = decl.name;
      elemLocal = allocLocal(fctx, `__forit_elem_${fctx.locals.length}`, elemType);
      if (isConst) {
        collectBindingNames(decl.name).forEach((n) => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forit_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
      if (isConst && ts.isIdentifier(decl.name)) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(decl.name.text);
      }
    }
  } else if (ts.isObjectLiteralExpression(stmt.initializer) || ts.isArrayLiteralExpression(stmt.initializer)) {
    assignDestructExprIter = stmt.initializer;
    elemLocal = allocLocal(fctx, `__forit_elem_${fctx.locals.length}`, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forit_elem_${fctx.locals.length}`, elemType);
  }

  // Look up the return() method on the iterator struct for iterator close (#851)
  const returnMethodIdx = ctx.funcMap.get(`${iterStructName}_return`);

  // Done flag: tracks whether iterator completed normally (done=true) (#851)
  const doneFlagDirect = allocLocal(fctx, `__forit_done_${fctx.locals.length}`, { kind: "i32" });

  // Build loop body
  const savedBody = pushBody(fctx);

  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;
  adjustRethrowDepth(fctx, 2);

  fctx.breakStack.push(1);
  fctx.continueStack.push(0);

  // Safety guard
  const iterCountLocal = allocLocal(fctx, `__forit_guard_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: iterCountLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.tee", index: iterCountLocal });
  fctx.body.push({ op: "i32.const", value: 1_000_000 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // Call next(): result = iter.next()
  fctx.body.push({ op: "local.get", index: iterLocal });
  if (iterResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: nextMethodIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Check done: result.done -> set done flag and break if truthy
  fctx.body.push({ op: "local.get", index: resultLocal });
  if (nextResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "struct.get", typeIdx: resultStructTypeIdx, fieldIdx: doneFieldIdx });
  // done field might be i32 (boolean) or f64; convert to i32 for br_if
  if (doneFieldType.kind === "f64") {
    fctx.body.push({ op: "i32.trunc_f64_s" } as Instr);
  }
  // If done, set the done flag to 1 before breaking (#851)
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: doneFlagDirect } as Instr,
      { op: "br", depth: 2 } as Instr, // break out of block (if + loop = depth 2)
    ],
    else: [],
  } as unknown as Instr);

  // Get value: elem = result.value
  fctx.body.push({ op: "local.get", index: resultLocal });
  if (nextResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "struct.get", typeIdx: resultStructTypeIdx, fieldIdx: valueFieldIdx });

  // Coerce value to element type if needed
  const targetElemType = getLocalType(fctx, elemLocal) ?? elemType;
  if (!valTypesMatch(valueFieldType, targetElemType)) {
    coerceType(ctx, fctx, valueFieldType, targetElemType);
  }
  fctx.body.push({ op: "local.set", index: elemLocal });

  // If destructuring, handle it
  if (destructPatternIter) {
    compileForOfDestructuring(ctx, fctx, destructPatternIter, elemLocal, elemType, stmt);
  }
  if (assignDestructExprIter) {
    compileForOfIteratorAssignDestructuring(ctx, fctx, assignDestructExprIter, elemLocal, stmt);
  }

  // Compile body
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 });

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;
  adjustRethrowDepth(fctx, -2);

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // Iterator close protocol (#851): call iterator.return() only on abrupt
  // completion (break/return), NOT on normal completion (done=true).
  if (returnMethodIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: doneFlagDirect });
    fctx.body.push({ op: "i32.eqz" }); // if NOT done (abrupt exit)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: iterLocal } as Instr,
        ...(iterResultType.kind === "ref_null" ? [{ op: "ref.as_non_null" } as Instr] : []),
        { op: "call", funcIdx: returnMethodIdx } as Instr,
        // Drop the return value (return() returns {value, done})
        { op: "drop" } as Instr,
      ],
      else: [],
    } as unknown as Instr);
  }

  return true;
}

/** Helper to find struct fields by type index when the name isn't directly in structFields */
function findStructFieldsByTypeIdx(
  ctx: CodegenContext,
  typeIdx: number,
): { name: string; type: ValType }[] | undefined {
  for (const [name, fields] of ctx.structFields) {
    const idx = ctx.structMap.get(name);
    if (idx === typeIdx) return fields;
  }
  // Fall back to the type definition if available
  const typeDef = ctx.mod.types[typeIdx];
  if (typeDef && typeDef.kind === "struct") {
    return typeDef.fields.map((f, i) => ({
      name: f.name ?? `field_${i}`,
      type: f.type,
    }));
  }
  return undefined;
}

/**
 * Compile for...of over a non-array iterable using the host-delegated
 * iterator protocol. Works with strings, Maps, Sets, and any object
 * implementing [Symbol.iterator]().
 *
 * Generated Wasm pseudo-code:
 *   iter = __iterator(obj)
 *   loop:
 *     result = __iterator_next(iter)
 *     if __iterator_done(result) → break
 *     elem = __iterator_value(result)
 *     <body>
 *     br loop
 */
function compileForOfIterator(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForOfStatement): void {
  // Compile the iterable expression
  const iterableType = compileExpression(ctx, fctx, stmt.expression);
  if (!iterableType) {
    reportError(ctx, stmt, "for-of: failed to compile iterable expression");
    return;
  }

  // Check if the iterable is a known struct type with a @@iterator method.
  // If so, compile the entire iteration loop in Wasm without host imports.
  if (iterableType.kind === "ref" || iterableType.kind === "ref_null") {
    let structName: string | undefined;
    for (const [name, idx] of ctx.structMap) {
      if (idx === iterableType.typeIdx) {
        structName = name;
        break;
      }
    }
    if (structName) {
      const methodFullName = `${structName}_@@iterator`;
      const iterMethodIdx = ctx.funcMap.get(methodFullName);
      if (iterMethodIdx !== undefined) {
        // Try to compile the full iteration loop in Wasm (no host imports)
        if (compileForOfDirectIterator(ctx, fctx, stmt, iterableType, iterMethodIdx)) {
          return;
        }
      }
    }
  }

  // Fallback: host-delegated iterator protocol
  // Ensure iterator host imports are registered before using them
  addIteratorImports(ctx);

  // Coerce to externref if the iterable is a struct ref (GC type).
  if (iterableType.kind !== "externref") {
    coerceType(ctx, fctx, iterableType, { kind: "externref" });
  }

  // Null check: throw TypeError for `for (const x of null)` (#775, #789)
  // If null from a failed guarded cast, skip instead of throw.
  {
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;
    const tagIdx = ensureExnTag(ctx);
    const iterTmp = allocLocal(fctx, `__forit_null_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.tee", index: iterTmp });
    fctx.body.push({ op: "ref.is_null" });
    if (backupLocal !== undefined) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: backupLocal } as Instr,
          { op: "ref.is_null" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
            else: [],
          } as Instr,
        ],
        else: [],
      });
    } else {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
        else: [],
      });
    }
    fctx.body.push({ op: "local.get", index: iterTmp });
  }

  // Look up the iterator host import function indices
  let iteratorIdx: number | undefined;
  if (stmt.awaitModifier) {
    iteratorIdx = ensureAsyncIterator(ctx, fctx);
  }
  if (iteratorIdx === undefined) {
    iteratorIdx = ctx.funcMap.get("__iterator");
  }
  if (iteratorIdx === undefined) {
    reportError(ctx, stmt, "for-of on non-array type requires iterator imports");
    return;
  }

  // Call __iterator/__async_iterator(obj) -> externref (the iterator)
  fctx.body.push({ op: "call", funcIdx: iteratorIdx });

  const nextIdx = ctx.funcMap.get("__iterator_next");
  const doneIdx = ctx.funcMap.get("__iterator_done");
  const valueIdx = ctx.funcMap.get("__iterator_value");
  const returnIdx = ctx.funcMap.get("__iterator_return");
  if (nextIdx === undefined || doneIdx === undefined || valueIdx === undefined) {
    reportError(ctx, stmt, "for-of on non-array type requires iterator imports");
    return;
  }
  const iterLocal = allocLocal(fctx, `__forof_iter_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: iterLocal });

  // Allocate locals for iterator result and loop element
  const resultLocal = allocLocal(fctx, `__forof_result_${fctx.locals.length}`, { kind: "externref" });

  // Declare the loop variable (element type is externref for iterator protocol)
  const elemType: ValType = { kind: "externref" };
  let elemLocal: number;
  let destructPatternIter: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let assignDestructExprIter: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPatternIter = decl.name;
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
      if (isConst) {
        collectBindingNames(decl.name).forEach((n) => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
      if (isConst && ts.isIdentifier(decl.name)) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(decl.name.text);
      }
    }
  } else if (ts.isObjectLiteralExpression(stmt.initializer) || ts.isArrayLiteralExpression(stmt.initializer)) {
    // Expression form with destructuring: for ({a, b} of arr) or for ([x, y] of arr)
    assignDestructExprIter = stmt.initializer;
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of arr) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: try+block+loop adds 3 nesting levels (#851).
  // The extra +1 (vs the old +2) is for the try wrapper that enables iterator close on throw.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  // Done flag: tracks whether iterator completed normally (done=true).
  // Used after the loop to decide whether to call iterator.return() (#851).
  const doneFlag = allocLocal(fctx, `__forof_done_${fctx.locals.length}`, { kind: "i32" });

  // Iterator close finallyStack entry (#851): inline before return/outer-break/outer-continue.
  // Push BEFORE the for-of break/continue entries so that:
  //   - break to for-of (breakIdx = N = breakStackLen)  → N < N = false → NOT inlined (post-loop handles it)
  //   - break to outer  (breakIdx < N)                  → true → inlined ✓
  //   - continue to for-of (contIdx = M = continueStackLen) → M < M = false → NOT inlined ✓
  //   - continue to outer  (contIdx < M)                → true → inlined ✓
  //   - return                                          → always inlined ✓
  const iterCloseBreakStackLen = fctx.breakStack.length;
  const iterCloseContinueStackLen = fctx.continueStack.length;
  if (returnIdx !== undefined) {
    const capturedDoneFlag = doneFlag;
    const capturedIterLocal = iterLocal;
    const capturedReturnIdx = returnIdx;
    if (!fctx.finallyStack) fctx.finallyStack = [];
    fctx.finallyStack.push({
      cloneFinally: (): Instr[] =>
        structuredClone([
          { op: "local.get", index: capturedDoneFlag } as Instr,
          { op: "i32.eqz" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: capturedIterLocal } as Instr,
              { op: "call", funcIdx: capturedReturnIdx } as Instr,
            ],
            else: [],
          } as unknown as Instr,
        ]),
      breakStackLen: iterCloseBreakStackLen,
      continueStackLen: iterCloseContinueStackLen,
    });
  }

  fctx.breakStack.push(1); // break = depth 1 (exit block, inside try wrapper)
  fctx.continueStack.push(0); // continue = depth 0 (restart loop)

  // Safety guard: max iteration counter to prevent infinite loops from collection mutation
  const iterCountLocal = allocLocal(fctx, `__forof_guard_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: iterCountLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.tee", index: iterCountLocal });
  fctx.body.push({ op: "i32.const", value: 1_000_000 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break if >1M iterations

  // Call __iterator_next(iter) → result
  fctx.body.push({ op: "local.get", index: iterLocal });
  fctx.body.push({ op: "call", funcIdx: nextIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Check done: __iterator_done(result) → i32, break if truthy
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "call", funcIdx: doneIdx });
  // If done, set the done flag to 1 before breaking
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: doneFlag } as Instr,
      { op: "br", depth: 2 } as Instr, // break out of block (if + loop = depth 2)
    ],
    else: [],
  } as unknown as Instr);

  // Get value: elem = __iterator_value(result)
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "call", funcIdx: valueIdx });
  fctx.body.push({ op: "local.set", index: elemLocal });

  // If destructuring pattern, destructure from the element
  if (destructPatternIter) {
    compileForOfDestructuring(ctx, fctx, destructPatternIter, elemLocal, elemType, stmt);
  }
  // If assignment destructuring expression, assign to existing locals.
  // For iterator path, elemType is externref — use __extern_get to extract properties/indices.
  if (assignDestructExprIter) {
    compileForOfIteratorAssignDestructuring(ctx, fctx, assignDestructExprIter, elemLocal, stmt);
  }

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Pop the iterator-close finallyStack entry (pushed before break/continue entries).
  if (returnIdx !== undefined && fctx.finallyStack && fctx.finallyStack.length > 0) {
    fctx.finallyStack.pop();
  }

  // Restore existing break/continue depths (undo the +3 applied at loop entry).
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  // The block/loop body; wrapped in try/catch_all when __iterator_return is available
  // to call iterator.return() on throw (#851 via-throw).
  const blockLoop = {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  };

  if (returnIdx !== undefined) {
    // Wrap in try/catch_all: on exception, call iterator.return() then rethrow.
    const catchAllBody: Instr[] = [
      { op: "local.get", index: doneFlag } as Instr,
      { op: "i32.eqz" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: iterLocal } as Instr, { op: "call", funcIdx: returnIdx } as Instr],
        else: [],
      } as unknown as Instr,
      { op: "rethrow", depth: 0 } as unknown as Instr,
    ];
    fctx.body.push({
      op: "try",
      blockType: { kind: "empty" },
      body: [blockLoop],
      catches: [],
      catchAll: catchAllBody,
    } as unknown as Instr);
  } else {
    fctx.body.push(blockLoop as unknown as Instr);
  }

  // Iterator close protocol (#851): call iterator.return() on break (post-loop check).
  // return/throw/outer-break/outer-continue are handled via finallyStack and try/catch_all above.
  if (returnIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: doneFlag });
    fctx.body.push({ op: "i32.eqz" }); // if NOT done (abrupt exit via break)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: iterLocal } as Instr, { op: "call", funcIdx: returnIdx } as Instr],
      else: [],
    } as unknown as Instr);
  }
}

export function compileForInStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForInStatement): void {
  // Get the loop variable name
  const init = stmt.initializer;
  let varName: string;
  let keyLocal: number;
  if (ts.isVariableDeclarationList(init)) {
    const decl = init.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) {
      // Destructuring patterns in for-in (e.g. `for (var [a] in obj)`)
      // are exotic — the key is a string, destructuring it gives characters.
      // For now, skip gracefully rather than crash.
      reportError(ctx, decl, "for-in variable must be an identifier");
      return;
    }
    varName = decl.name.text;
    // Allocate a local for the loop variable (string / externref)
    keyLocal = allocLocal(fctx, varName, { kind: "externref" });
  } else if (ts.isIdentifier(init)) {
    // Bare identifier: `for (x in obj)` — look up existing local
    varName = init.text;
    const existingLocal = fctx.localMap.get(varName);
    if (existingLocal !== undefined) {
      keyLocal = existingLocal;
    } else {
      // Variable might be a global or not yet declared — allocate as local
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    }
  } else if (
    ts.isBinaryExpression(init) &&
    init.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(init.left)
  ) {
    // Assignment expression: `for (x = defaultVal in obj)` — compile assignment, use the target
    varName = init.left.text;
    const existingLocal = fctx.localMap.get(varName);
    if (existingLocal !== undefined) {
      keyLocal = existingLocal;
    } else {
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    }
    // Compile the initializer assignment (default value)
    compileExpression(ctx, fctx, init.right);
    fctx.body.push({ op: "local.set", index: keyLocal });
  } else {
    reportError(ctx, stmt, "for-in requires a variable declaration or identifier");
    return;
  }

  // Look up for-in host imports
  const keysIdx = ctx.funcMap.get("__for_in_keys");
  const lenIdx = ctx.funcMap.get("__for_in_len");
  const getIdx = ctx.funcMap.get("__for_in_get");

  if (keysIdx === undefined || lenIdx === undefined || getIdx === undefined) {
    // Fallback: static unrolling when host imports are not available (standalone mode)
    const exprType = ctx.checker.getTypeAtLocation(stmt.expression);
    const props = exprType.getProperties();
    if (props.length === 0) return;
    for (const prop of props) {
      const globalIdx = ctx.stringGlobalMap.get(prop.name);
      if (globalIdx === undefined) continue;
      fctx.body.push({ op: "global.get", index: globalIdx });
      fctx.body.push({ op: "local.set", index: keyLocal });
      compileStatement(ctx, fctx, stmt.statement);
    }
    return;
  }

  // Compile the object expression and coerce to externref for the host import
  const exprType = compileExpression(ctx, fctx, stmt.expression);
  if (exprType && exprType.kind !== "externref") {
    coerceType(ctx, fctx, exprType, { kind: "externref" });
  }
  fctx.body.push({ op: "call", funcIdx: keysIdx }); // __for_in_keys(obj) -> keys array

  // Store keys array in a local
  const keysLocal = allocLocal(fctx, `__forin_keys_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keysLocal });

  // Get length
  const lenLocal = allocLocal(fctx, `__forin_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: keysLocal });
  fctx.body.push({ op: "call", funcIdx: lenIdx }); // __for_in_len(keys) -> i32
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Counter
  const iLocal = allocLocal(fctx, `__forin_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Build the user's loop body in a new body segment.
  // Structure: block $break { loop $loop { <cond> block $continue { <body> } <incr> br $loop } }
  // This ensures `continue` (br 0 = exit $continue) falls through to the increment,
  // while `break` (br 2 = exit $break) exits the entire loop.
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  fctx.breakStack.push(2); // break = depth 2 (exit $break block)
  fctx.continueStack.push(0); // continue = depth 0 (exit $continue block -> falls to incr)

  // Compile the user's loop body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  const userBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  // Build the full loop body: condition + key fetch + block{userBody} + increment + br
  const loopBody: Instr[] = [];

  // Condition: i >= length -> break (depth 1 exits $break from inside $loop)
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "i32.ge_s" });
  loopBody.push({ op: "br_if", depth: 1 }); // break out of $break block

  // Get current key: key = keys[i]
  loopBody.push({ op: "local.get", index: keysLocal });
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "call", funcIdx: getIdx }); // __for_in_get(keys, i) -> externref
  loopBody.push({ op: "local.set", index: keyLocal });

  // Wrap user body in block $continue so `continue` exits here
  loopBody.push({
    op: "block",
    blockType: { kind: "empty" },
    body: userBody,
  });

  // Increment counter (reached after user body OR after continue)
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.add" });
  loopBody.push({ op: "local.set", index: iLocal });

  loopBody.push({ op: "br", depth: 0 }); // restart $loop

  // Emit block $break { loop $loop { ...loopBody } }
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}
