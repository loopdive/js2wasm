/**
 * typeof, delete, instanceof, and RegExp literal compilation.
 * Extracted from expressions.ts (issue #688 step 5).
 */
import ts from "typescript";
import { reportError } from "./context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addImport } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { resolveWasmType, addUnionImports, parseRegExpLiteral } from "./index.js";
import { isAnyValue, ensureAnyHelpers } from "./shared.js";
import { isNumberType, isBooleanType, isStringType, isSymbolType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { compileExpression, getLine, getCol } from "./shared.js";
import type { InnerResult } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { resolveStructName } from "./expressions/misc.js";
import { shiftLateImportIndices } from "./expressions/late-imports.js";

// ── Delete expression ─────────────────────────────────────────────────

/**
 * Emit the sentinel (undefined) value for a given Wasm field type.
 * - ref/ref_null: ref.null of the struct's type index
 * - externref: ref.null.extern
 * - f64: NaN (chosen as sentinel since deleted numeric props return undefined -> NaN in numeric context)
 * - i32: 0
 */
function emitDeleteSentinel(fctx: FunctionContext, fieldType: ValType): void {
  switch (fieldType.kind) {
    case "ref":
    case "ref_null":
      fctx.body.push({ op: "ref.null", typeIdx: (fieldType as { typeIdx: number }).typeIdx });
      break;
    case "externref":
      fctx.body.push({ op: "ref.null.extern" });
      break;
    case "f64":
      fctx.body.push({ op: "f64.const", value: NaN });
      break;
    case "i32":
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
    default:
      fctx.body.push({ op: "ref.null.extern" });
      break;
  }
}

/**
 * Compile `delete expr`.
 * - `delete obj.prop` / `delete obj[key]`: set the field to a sentinel (undefined) value, return true
 * - `delete identifier`: return false (i32 0) — variables are not deletable
 * - `delete otherExpr`: compile for side effects, drop, return true (i32 1)
 *
 * WasmGC struct fields cannot be removed at runtime, so we simulate deletion
 * by setting the field to a sentinel value (ref.null for ref types, NaN for f64).
 * Property reads of ref.null / NaN naturally produce undefined-like behavior.
 */
export function compileDeleteExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.DeleteExpression,
): InnerResult {
  const operand = expr.expression;

  // Unwrap parenthesized/type-assertion wrappers to find the underlying expression
  let inner: ts.Expression = operand;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = ts.isParenthesizedExpression(inner)
      ? inner.expression
      : ts.isAsExpression(inner)
        ? inner.expression
        : ts.isNonNullExpression(inner)
          ? inner.expression
          : (inner as ts.TypeAssertion).expression;
  }

  if (ts.isIdentifier(inner)) {
    // Variables are not deletable — return false
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Try to resolve struct type and field for property access: delete obj.prop
  if (ts.isPropertyAccessExpression(inner)) {
    const objType = ctx.checker.getTypeAtLocation(inner.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(inner.expression)) {
      typeName = ctx.widenedVarStructMap.get(inner.expression.text);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = ts.isPrivateIdentifier(inner.name) ? "__priv_" + inner.name.text.slice(1) : inner.name.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          // Compile the object expression, then set field to sentinel
          compileExpression(ctx, fctx, inner.expression);
          emitDeleteSentinel(fctx, fieldType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fctx.body.push({ op: "i32.const", value: 1 });
          return { kind: "i32" };
        }
      }
    }
  }

  // Try to resolve struct type and field for element access: delete obj["prop"]
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteral(inner.argumentExpression)) {
    const objType = ctx.checker.getTypeAtLocation(inner.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(inner.expression)) {
      typeName = ctx.widenedVarStructMap.get(inner.expression.text);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = inner.argumentExpression.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          compileExpression(ctx, fctx, inner.expression);
          emitDeleteSentinel(fctx, fieldType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fctx.body.push({ op: "i32.const", value: 1 });
          return { kind: "i32" };
        }
      }
    }
  }

  // For property access / element access / other expressions:
  // compile the operand for side effects, drop, return true
  const operandType = compileExpression(ctx, fctx, operand);
  if (operandType !== null) {
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "i32.const", value: 1 });
  return { kind: "i32" };
}

// ── RegExp literal ────────────────────────────────────────────────────

/**
 * Compile a RegExp literal (e.g. /\d+/g) by desugaring it to new RegExp(pattern, flags).
 * The pattern and flags strings are loaded from the string pool, then RegExp_new is called.
 */
export function compileRegExpLiteral(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): ValType | null {
  const { pattern, flags } = parseRegExpLiteral(expr.getText());

  // Load pattern string
  const patternResult = compileStringLiteral(ctx, fctx, pattern, expr);
  if (!patternResult) return null;

  // Load flags string (empty string "" if no flags — ref.null.extern would
  // become null in JS, causing "Invalid flags 'null'" at runtime)
  const flagsStr = flags ?? "";
  const flagsResult = compileStringLiteral(ctx, fctx, flagsStr, expr);
  if (!flagsResult) return null;

  // Call RegExp_new(pattern, flags) -> externref
  let funcIdx = ctx.funcMap.get("RegExp_new");
  if (funcIdx === undefined) {
    // Register RegExp_new import on demand: (externref, externref) -> externref
    const importsBefore = ctx.numImportFuncs;
    const regexpNewType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "RegExp_new", { kind: "func", typeIdx: regexpNewType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    funcIdx = ctx.funcMap.get("RegExp_new");
  }
  if (funcIdx === undefined) {
    reportError(ctx, expr, "Missing RegExp_new import for regex literal");
    return null;
  }
  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

// ── instanceof ────────────────────────────────────────────────────────

/**
 * Collect all class tags that are "instanceof-compatible" with the given class:
 * the class itself plus all its descendants (transitive children).
 */
function collectInstanceOfTags(ctx: CodegenContext, className: string): number[] {
  const ownTag = ctx.classTagMap.get(className);
  if (ownTag === undefined) return [];
  const tags = [ownTag];
  // Walk classParentMap to find all children (classes whose parent is className)
  for (const [child, parent] of ctx.classParentMap) {
    if (parent === className) {
      tags.push(...collectInstanceOfTags(ctx, child));
    }
  }
  return tags;
}

/**
 * Resolve the class name from the right operand of an instanceof expression.
 * Handles identifiers, class expressions, and arbitrary expressions via the type checker.
 */
function resolveInstanceOfClassName(ctx: CodegenContext, rightExpr: ts.Expression): string | undefined {
  // Direct identifier: `x instanceof Foo`
  if (ts.isIdentifier(rightExpr)) {
    const name = rightExpr.text;
    // Check direct name first, then classExprNameMap
    if (ctx.classTagMap.has(name)) return name;
    const mapped = ctx.classExprNameMap.get(name);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    // Fall through to type checker
  }

  // Use the TypeScript type checker to resolve the type of the right operand
  const tsType = ctx.checker.getTypeAtLocation(rightExpr);
  // For class constructors, get the construct signatures' return type
  const constructSigs = tsType.getConstructSignatures?.();
  if (constructSigs && constructSigs.length > 0) {
    const instanceType = constructSigs[0]!.getReturnType();
    const symbolName = instanceType.getSymbol()?.name;
    if (symbolName) {
      if (ctx.classTagMap.has(symbolName)) return symbolName;
      const mapped = ctx.classExprNameMap.get(symbolName);
      if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    }
  }

  // Try the symbol name directly (for class expressions assigned to variables)
  const symbolName = tsType.getSymbol()?.name;
  if (symbolName) {
    if (ctx.classTagMap.has(symbolName)) return symbolName;
    const mapped = ctx.classExprNameMap.get(symbolName);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }

  return undefined;
}

/**
 * Compile `expr instanceof ClassName`.
 * Reads the hidden __tag field (index 0) from the struct and compares
 * it against the class's compile-time tag value (and all descendant tags
 * for class hierarchy support).
 */
export function compileInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  // Resolve the right operand class name (supports identifiers, expressions, class expressions)
  const className = resolveInstanceOfClassName(ctx, expr.right);
  if (className === undefined) {
    // Cannot resolve the class — emit false (i32.const 0) as a graceful fallback
    // We still need to compile the left operand for side effects, then drop it
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Collect all compatible tags (this class + all descendants)
  const compatibleTags = collectInstanceOfTags(ctx, className);
  if (compatibleTags.length === 0) {
    // No tags found — emit false
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Compile left operand (the value to test) — must be a ref to a class struct
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) return null;

  // Resolve the struct type index for the right-side class (the target we test against)
  const rightStructTypeIdx = ctx.structMap.get(className);

  // Find the root ancestor of the right class (for casting externref values)
  let rootClass = className;
  while (ctx.classParentMap.has(rootClass)) {
    rootClass = ctx.classParentMap.get(rootClass)!;
  }
  const rootStructTypeIdx = ctx.structMap.get(rootClass) ?? rightStructTypeIdx;

  // --- Handle externref left operand (any type) ---
  // When the left operand is externref, we cannot do struct.get directly.
  // Convert externref -> anyref, try to cast to the root struct type,
  // then read the __tag field and compare against compatible tags.
  // We use ref.test first to avoid trapping on non-struct values (null, primitives).
  if (leftType.kind === "externref") {
    if (rootStructTypeIdx === undefined) {
      // Cannot resolve any struct type — drop and emit false
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // Convert externref -> anyref, store in local
    fctx.body.push({ op: "any.convert_extern" });
    const anyLocalIdx = allocTempLocal(fctx, { kind: "anyref" });
    fctx.body.push({ op: "local.set", index: anyLocalIdx });

    // Build the "then" branch: value is NOT a struct of the right root type -> false
    const thenBody: Instr[] = [{ op: "i32.const", value: 0 }];

    // Build the "else" branch: value IS a struct -> read __tag and compare
    const elseBody: Instr[] = [
      { op: "local.get", index: anyLocalIdx },
      { op: "ref.cast", typeIdx: rootStructTypeIdx },
      { op: "struct.get", typeIdx: rootStructTypeIdx, fieldIdx: 0 },
    ];

    if (compatibleTags.length === 1) {
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
    } else {
      const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
      elseBody.push({ op: "local.set", index: tagLocalIdx });
      elseBody.push({ op: "local.get", index: tagLocalIdx });
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
      for (let i = 1; i < compatibleTags.length; i++) {
        elseBody.push({ op: "local.get", index: tagLocalIdx });
        elseBody.push({ op: "i32.const", value: compatibleTags[i]! });
        elseBody.push({ op: "i32.eq" });
        elseBody.push({ op: "i32.or" });
      }
    }

    // Emit: (local.get $any) (ref.test (ref $rootStruct))
    //        (if (result i32) (then i32.const 0) (else ...read tag...))
    // Note: ref.test returns 0 for non-struct values and null, 1 for matching struct.
    // We invert the condition: if ref.test FAILS -> 0, if PASSES -> check tag.
    fctx.body.push({ op: "local.get", index: anyLocalIdx });
    fctx.body.push({ op: "ref.test", typeIdx: rootStructTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: elseBody, // ref.test passed -> check tag
      else: thenBody, // ref.test failed -> false
    });
    releaseTempLocal(fctx, anyLocalIdx);

    return { kind: "i32" };
  }

  // --- Handle i32 or f64 left operand (primitive types) ---
  // Primitives are never instances of a class — drop and emit false
  if (leftType.kind === "i32" || leftType.kind === "f64") {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // --- Resolve the struct type index from the left operand's type ---
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  let leftClassName = leftTsType.getSymbol()?.name;
  if (leftClassName && !ctx.structMap.has(leftClassName)) {
    leftClassName = ctx.classExprNameMap.get(leftClassName) ?? leftClassName;
  }
  let leftStructTypeIdx = leftClassName ? ctx.structMap.get(leftClassName) : undefined;

  // If the left operand type is not directly resolvable, try to find any struct
  // that could be the base type. For union types or 'any', we try the right class's struct.
  if (leftStructTypeIdx === undefined) {
    leftStructTypeIdx = rootStructTypeIdx;
  }

  if (leftStructTypeIdx === undefined) {
    // Still cannot resolve — drop left value and emit false
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // --- Handle nullable ref (ref_null) — null instanceof X must be false ---
  // For nullable refs, emit: if (ref.is_null) then 0 else (tag check)
  const isNullable = leftType.kind === "ref_null";
  if (isNullable) {
    // Store the ref in a local so we can test it for null and re-use it
    const refLocalIdx = allocLocal(fctx, `__instanceof_ref_${fctx.locals.length}`, leftType);
    fctx.body.push({ op: "local.set", index: refLocalIdx });

    // Build the "then" branch (null case -> false)
    const thenBody: Instr[] = [{ op: "i32.const", value: 0 }];

    // Build the "else" branch (non-null case -> guard with ref.test then read tag)
    // Use ref.test to avoid trapping on wrong struct type (illegal cast)
    const tagCheckBody: Instr[] = [
      { op: "local.get", index: refLocalIdx },
      { op: "ref.cast", typeIdx: leftStructTypeIdx },
      { op: "struct.get", typeIdx: leftStructTypeIdx, fieldIdx: 0 },
    ];

    if (compatibleTags.length === 1) {
      tagCheckBody.push({ op: "i32.const", value: compatibleTags[0]! });
      tagCheckBody.push({ op: "i32.eq" });
    } else {
      const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
      tagCheckBody.push({ op: "local.set", index: tagLocalIdx });
      tagCheckBody.push({ op: "local.get", index: tagLocalIdx });
      tagCheckBody.push({ op: "i32.const", value: compatibleTags[0]! });
      tagCheckBody.push({ op: "i32.eq" });
      for (let i = 1; i < compatibleTags.length; i++) {
        tagCheckBody.push({ op: "local.get", index: tagLocalIdx });
        tagCheckBody.push({ op: "i32.const", value: compatibleTags[i]! });
        tagCheckBody.push({ op: "i32.eq" });
        tagCheckBody.push({ op: "i32.or" });
      }
    }

    // Guarded: ref.test before ref.cast to avoid illegal cast traps
    const elseBody: Instr[] = [
      { op: "local.get", index: refLocalIdx },
      { op: "ref.test", typeIdx: leftStructTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: tagCheckBody,
        else: [{ op: "i32.const", value: 0 }], // wrong struct type → false
      } as Instr,
    ];

    // Emit: (local.get $ref) (ref.is_null) (if (result i32) (then ...) (else ...))
    fctx.body.push({ op: "local.get", index: refLocalIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: thenBody,
      else: elseBody,
    });

    return { kind: "i32" };
  }

  // --- Non-nullable ref path: read __tag field directly ---
  // Read the __tag field (field index 0) from the struct
  fctx.body.push({ op: "struct.get", typeIdx: leftStructTypeIdx, fieldIdx: 0 });

  if (compatibleTags.length === 1) {
    // Simple case: exact match only (no subclasses)
    fctx.body.push({ op: "i32.const", value: compatibleTags[0]! });
    fctx.body.push({ op: "i32.eq" });
  } else {
    // Multiple tags: emit (tag == t1) || (tag == t2) || ...
    // We need to store the tag value in a local to avoid re-reading it
    const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: tagLocalIdx });

    // First comparison
    fctx.body.push({ op: "local.get", index: tagLocalIdx });
    fctx.body.push({ op: "i32.const", value: compatibleTags[0]! });
    fctx.body.push({ op: "i32.eq" });

    // Remaining comparisons, OR'd together
    for (let i = 1; i < compatibleTags.length; i++) {
      fctx.body.push({ op: "local.get", index: tagLocalIdx });
      fctx.body.push({ op: "i32.const", value: compatibleTags[i]! });
      fctx.body.push({ op: "i32.eq" });
      fctx.body.push({ op: "i32.or" });
    }
  }

  return { kind: "i32" };
}

// ── typeof ────────────────────────────────────────────────────────────

/**
 * Determine the typeof result string for a TS type at compile time.
 * Returns null if the type cannot be statically resolved (e.g., any/unknown).
 */
function staticTypeofForType(ctx: CodegenContext, tsType: ts.Type): string | null {
  if (tsType.flags & ts.TypeFlags.Null) return "object";
  if (tsType.flags & ts.TypeFlags.Undefined || tsType.flags & ts.TypeFlags.Void) return "undefined";
  if (tsType.flags & ts.TypeFlags.BigInt || tsType.flags & ts.TypeFlags.BigIntLiteral) return "bigint";

  // Wrapper objects (new String/Number/Boolean) are "object" not their primitive type (#929)
  if (tsType.flags & ts.TypeFlags.Object) {
    const sym = tsType.getSymbol?.();
    if (sym && (sym.name === "String" || sym.name === "Number" || sym.name === "Boolean")) {
      return "object";
    }
  }
  // Check string before wasm type mapping (native strings map to ref)
  if (isStringType(tsType)) return "string";

  const wasmType = resolveWasmType(ctx, tsType);
  if (wasmType.kind === "f64") return "number";
  if (wasmType.kind === "i32") {
    if (isSymbolType(tsType)) return "symbol";
    if (isBooleanType(tsType)) return "boolean";
    return "number";
  }
  if (wasmType.kind === "ref" || wasmType.kind === "ref_null") {
    if (isAnyValue(wasmType, ctx)) return null; // truly dynamic
    const callSigs = tsType.getCallSignatures?.();
    if (callSigs && callSigs.length > 0) return "function";
    const ctorSigs = tsType.getConstructSignatures?.();
    if (ctorSigs && ctorSigs.length > 0) return "function";
    return "object";
  }
  if (wasmType.kind === "externref") {
    const callSigs = tsType.getCallSignatures?.();
    if (callSigs && callSigs.length > 0) return "function";
    const ctorSigs = tsType.getConstructSignatures?.();
    if (ctorSigs && ctorSigs.length > 0) return "function";
    if (tsType.flags & ts.TypeFlags.Object) return "object";
  }

  // For union types, check if all members resolve to the same result
  if (tsType.isUnion?.()) {
    const results = new Set<string>();
    for (const member of (tsType as ts.UnionType).types) {
      const r = staticTypeofForType(ctx, member);
      if (r === null) return null;
      results.add(r);
    }
    if (results.size === 1) return [...results][0]!;
  }

  return null;
}

/**
 * Compile `typeof x` as a standalone expression that returns a type string (externref).
 * For statically known types, emits the string constant directly.
 * For externref/union types, calls the __typeof host helper.
 */
export function compileTypeofExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TypeOfExpression,
): ValType | null {
  const operand = expr.expression;

  // typeof Math.<constant> -> "number", typeof Math.<method> -> "function"
  if (
    ts.isPropertyAccessExpression(operand) &&
    ts.isIdentifier(operand.expression) &&
    operand.expression.text === "Math"
  ) {
    const mathConstants = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
    if (mathConstants.has(operand.name.text)) {
      return compileStringLiteral(ctx, fctx, "number");
    }
    return compileStringLiteral(ctx, fctx, "function");
  }

  // typeof import.meta -> "object"
  if (
    ts.isMetaProperty(operand) &&
    operand.keywordToken === ts.SyntaxKind.ImportKeyword &&
    operand.name.text === "meta"
  ) {
    return compileStringLiteral(ctx, fctx, "object");
  }

  // typeof new.target -> "function" inside constructors, "undefined" outside
  if (
    ts.isMetaProperty(operand) &&
    operand.keywordToken === ts.SyntaxKind.NewKeyword &&
    operand.name.text === "target"
  ) {
    if (fctx.isConstructor) {
      return compileStringLiteral(ctx, fctx, "function");
    } else {
      return compileStringLiteral(ctx, fctx, "undefined");
    }
  }

  const tsType = ctx.checker.getTypeAtLocation(operand);

  // Try static resolution first via the shared helper
  const staticResult = staticTypeofForType(ctx, tsType);
  if (staticResult !== null) {
    return compileStringLiteral(ctx, fctx, staticResult);
  }

  // Fast mode: any-typed operand -> runtime typeof via __any_typeof
  const wasmType = resolveWasmType(ctx, tsType);
  if (ctx.fast && (wasmType.kind === "ref" || wasmType.kind === "ref_null") && isAnyValue(wasmType, ctx)) {
    ensureAnyHelpers(ctx);
    const typeofIdx = ctx.funcMap.get("__any_typeof");
    if (typeofIdx !== undefined) {
      const operandType = compileExpression(ctx, fctx, operand);
      if (operandType === null) return null;
      fctx.body.push({ op: "call", funcIdx: typeofIdx });
      return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
    }
  }

  // For union/unknown externref types, call the __typeof host helper at runtime
  addUnionImports(ctx);
  const funcIdx = ctx.funcMap.get("__typeof");
  if (funcIdx === undefined) return null;

  // Compile the operand to push its value onto the stack
  const operandType = compileExpression(ctx, fctx, operand);
  if (operandType === null) return null;

  // Coerce to externref if needed (e.g. f64 -> boxed number, ref -> extern.convert_any)
  if (operandType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (operandType.kind === "i32") {
    const boxIdx = ctx.funcMap.get("__box_boolean");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (operandType.kind === "ref" || operandType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  }

  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

/**
 * Compile `typeof x === "number"` / `typeof x !== "string"` etc.
 * Returns i32 result, or null if the expression is not a typeof comparison.
 */
export function compileTypeofComparison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  const op = expr.operatorToken.kind;
  const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  // Detect typeof on left or right
  let typeofExpr: ts.TypeOfExpression | null = null;
  let stringLiteral: string | null = null;

  if (ts.isTypeOfExpression(expr.left) && ts.isStringLiteral(expr.right)) {
    typeofExpr = expr.left;
    stringLiteral = expr.right.text;
  } else if (ts.isTypeOfExpression(expr.right) && ts.isStringLiteral(expr.left)) {
    typeofExpr = expr.right;
    stringLiteral = expr.left.text;
  }

  if (!typeofExpr || !stringLiteral) return null;

  // Static resolution: if the typeof result is known at compile time,
  // emit a constant comparison result without any runtime call.
  const operand = typeofExpr.expression;
  const tsType = ctx.checker.getTypeAtLocation(operand);
  let staticTypeof: string | null = null;
  // Math.<constant> -> "number", Math.<method> -> "function"
  if (
    ts.isPropertyAccessExpression(operand) &&
    ts.isIdentifier(operand.expression) &&
    operand.expression.text === "Math"
  ) {
    const mathConstants = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
    staticTypeof = mathConstants.has(operand.name.text) ? "number" : "function";
  } else {
    staticTypeof = staticTypeofForType(ctx, tsType);
  }
  if (staticTypeof !== null) {
    const matches = staticTypeof === stringLiteral;
    const result = isEq ? (matches ? 1 : 0) : matches ? 0 : 1;
    fctx.body.push({ op: "i32.const", value: result });
    return { kind: "i32" };
  }

  // Any-typed typeof comparison via tag check
  // Instead of calling __any_typeof + string comparison, we can directly check the tag
  // on the $AnyValue struct. This avoids pulling in the full native string helpers.
  if (isAnyValue(resolveWasmType(ctx, tsType), ctx)) {
    ensureAnyHelpers(ctx);
    // Map the string literal to tag check(s)
    let tagChecks: number[] | null = null;
    if (stringLiteral === "number")
      tagChecks = [2, 3]; // i32 or f64
    else if (stringLiteral === "boolean") tagChecks = [4];
    else if (stringLiteral === "string")
      tagChecks = [5, 6]; // externref string or gcref string
    else if (stringLiteral === "undefined") tagChecks = [1];
    else if (stringLiteral === "object") tagChecks = [0]; // null -> "object"

    if (tagChecks !== null) {
      // Compile the operand
      const operandType = compileExpression(ctx, fctx, operand);
      if (!operandType) return null;
      // Get the tag field
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 0 });
      // Check if tag matches any of the expected values
      if (tagChecks.length === 1) {
        fctx.body.push({ op: "i32.const", value: tagChecks[0]! });
        fctx.body.push({ op: "i32.eq" });
      } else {
        // Multiple tags: (tag == t1) || (tag == t2)
        const tagLocal = allocTempLocal(fctx, { kind: "i32" });
        fctx.body.push({ op: "local.set", index: tagLocal });
        fctx.body.push({ op: "local.get", index: tagLocal });
        fctx.body.push({ op: "i32.const", value: tagChecks[0]! });
        fctx.body.push({ op: "i32.eq" });
        for (let i = 1; i < tagChecks.length; i++) {
          fctx.body.push({ op: "local.get", index: tagLocal });
          fctx.body.push({ op: "i32.const", value: tagChecks[i]! });
          fctx.body.push({ op: "i32.eq" });
          fctx.body.push({ op: "i32.or" });
        }
        releaseTempLocal(fctx, tagLocal);
      }
      if (isNeq) {
        fctx.body.push({ op: "i32.eqz" });
      }
      return { kind: "i32" };
    }
  }

  // Ensure union imports are registered
  addUnionImports(ctx);

  // Determine the helper function name
  let helperName: string | null = null;
  if (stringLiteral === "number") helperName = "__typeof_number";
  else if (stringLiteral === "string") helperName = "__typeof_string";
  else if (stringLiteral === "boolean") helperName = "__typeof_boolean";
  else if (stringLiteral === "undefined") helperName = "__typeof_undefined";
  else if (stringLiteral === "object") helperName = "__typeof_object";
  else if (stringLiteral === "function") helperName = "__typeof_function";

  if (!helperName) return null;

  const funcIdx = ctx.funcMap.get(helperName);
  if (funcIdx === undefined) return null;

  // Compile the operand of typeof — need to get the raw externref value
  // The operand should be loaded without narrowing (use the declared type)
  if (ts.isIdentifier(operand)) {
    const localIdx = fctx.localMap.get(operand.text);
    if (localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
    } else {
      // Try other resolution paths
      const valType = compileExpression(ctx, fctx, operand);
      if (!valType) return null;
    }
  } else {
    const valType = compileExpression(ctx, fctx, operand);
    if (!valType) return null;
  }

  // Call the typeof helper
  fctx.body.push({ op: "call", funcIdx });

  // If !== comparison, negate the result
  if (isNeq) {
    fctx.body.push({ op: "i32.eqz" });
  }

  return { kind: "i32" };
}
