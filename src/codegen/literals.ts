// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Literal compilation for js2wasm — object, array, tuple, and symbol literals.
 *
 * Extracted from expressions.ts (issue #688, step 7).
 *
 * Functions in this file:
 *   - ensureComputedPropertyFields, compileObjectLiteral
 *   - resolveConstantExpression, resolvePropertyNameText
 *   - resolveWellKnownSymbol, getWellKnownSymbolId, ensureSymbolCounter, compileSymbolCall
 *   - resolveComputedKeyExpression, resolveAccessorPropName
 *   - compileWidenedEmptyObject, compileObjectLiteralForStruct
 *   - compileTupleLiteral, compileArrayLiteral, compileArrayConstructorCall
 */

import ts from "typescript";
import { isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType, WasmFunction } from "../ir/types.js";
import { emitMethodParamDefaults, promoteAccessorCapturesToGlobals } from "./closures.js";
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitUndefined, patchStructNewForAddedField } from "./expressions/late-imports.js";
import { resolveStructName } from "./expressions/misc.js";
import { bodyUsesArguments } from "./helpers/body-uses-arguments.js";
import {
  cacheStringLiterals,
  destructureParamArray,
  destructureParamObject,
  ensureStructForType,
  getOrRegisterTupleType,
  getTupleElementTypes,
  isTupleType,
  resolveWasmType,
} from "./index.js";
import { ensureExnTag, nextModuleGlobalIdx } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  emitArgumentsObject,
  ensureLateImport,
  flushLateImportShifts,
  registerResolveComputedKeyExpression,
} from "./shared.js";
import { pushDefaultValue } from "./type-coercion.js";

/**
 * Check if a TS expression is "undefined-like" — OmittedExpression (array hole),
 * undefined keyword, identifier `undefined`, or void expression.
 * Used to emit sNaN sentinels in tuple/array contexts so destructuring
 * default checks trigger correctly (#1024).
 */
function _isUndefinedLike(node: ts.Node): boolean {
  return (
    ts.isOmittedExpression(node) ||
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
}

/**
 * Ensure that a struct registered for an object literal includes fields for
 * computed property names that TypeScript cannot statically resolve.
 * When TS returns 0 properties (e.g. { [1+1]: 2 }), we resolve the computed
 * keys at compile time and create proper struct fields.
 */
export function ensureComputedPropertyFields(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  tsType: ts.Type,
): void {
  const existingName = resolveStructName(ctx, tsType);
  if (!existingName) return;
  const existingFields = ctx.structFields.get(existingName);
  if (!existingFields) return;

  // Collect all property assignments with their resolved names
  const resolvedProps: { name: string; valueExpr: ts.Expression }[] = [];
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const propName = resolvePropertyNameText(ctx, prop);
    if (propName === undefined) continue;
    // Check if this field already exists in the struct
    if (existingFields.some((f) => f.name === propName)) continue;
    resolvedProps.push({ name: propName, valueExpr: prop.initializer });
  }

  if (resolvedProps.length === 0) return;

  // Need to add new fields. Create a replacement struct with the combined fields.
  const fields = [...existingFields];
  for (const rp of resolvedProps) {
    const propType = ctx.checker.getTypeAtLocation(rp.valueExpr);
    const wasmType = resolveWasmType(ctx, propType);
    fields.push({ name: rp.name, type: wasmType, mutable: true });
  }

  // Update the existing struct in-place
  const structTypeIdx = ctx.structMap.get(existingName)!;
  const typeDef = ctx.mod.types[structTypeIdx] as any;
  typeDef.fields = fields;
  ctx.structFields.set(existingName, fields);

  // Patch existing struct.new instructions for this type with defaults for new fields
  for (const rp of resolvedProps) {
    const propType = ctx.checker.getTypeAtLocation(rp.valueExpr);
    const wasmType = resolveWasmType(ctx, propType);
    patchStructNewForAddedField(ctx, fctx, structTypeIdx, wasmType);
  }
}

/**
 * Last-resort fallback: compile an object literal as an externref plain object via host imports.
 * Used when the TS type can't be mapped to a WasmGC struct (e.g., `{...null}`, `{...yield}`,
 * or bundled JS objects with types too wide for struct inference).
 *
 * Creates a new plain object via __new_plain_object, then:
 * - For spread assignments: calls __object_assign(target, source) to copy properties
 * - For regular properties: calls __set_prop(target, key, value)
 *
 * Returns externref, or null if the host import is unavailable.
 */
function compileObjectLiteralAsExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined) return null;

  // Create the target plain object
  fctx.body.push({ op: "call", funcIdx: newObjIdx });
  const objLocal = allocLocal(fctx, `__objlit_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      // Compile spread source and call __object_assign(target, [source]) -> target
      const srcType = compileExpression(ctx, fctx, prop.expression);
      if (srcType) {
        if (srcType.kind !== "externref") {
          coerceType(ctx, fctx, srcType, { kind: "externref" });
        }
        // Wrap source in a single-element JS array for __object_assign(target, sources[])
        const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
        const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
        const assignIdx = ensureLateImport(
          ctx,
          "__object_assign",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (assignIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
          const srcLocal = allocLocal(fctx, `__spread_src_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: srcLocal });
          // Create sources array [source]
          fctx.body.push({ op: "call", funcIdx: arrNewIdx });
          const arrLocal = allocLocal(fctx, `__spread_arr_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: arrLocal });
          fctx.body.push({ op: "local.get", index: arrLocal });
          fctx.body.push({ op: "local.get", index: srcLocal });
          fctx.body.push({ op: "call", funcIdx: arrPushIdx });
          // Call __object_assign(target, [source])
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "local.get", index: arrLocal });
          fctx.body.push({ op: "call", funcIdx: assignIdx });
          fctx.body.push({ op: "local.set", index: objLocal });
        }
      }
    }
    // PropertyAssignment and ShorthandPropertyAssignment are not handled in this fallback —
    // mixed spread + named properties should have resolved via ensureStructForType.
    // If we reach here with named properties, let them be silently skipped.
    // The fallback is primarily for all-spread patterns like {...null}, {...yield}.
  }

  fctx.body.push({ op: "local.get", index: objLocal });
  return { kind: "externref" };
}

export function compileObjectLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  // If this empty object literal is the initializer of a variable with widened
  // properties (from pre-pass), register the struct with those extra fields and
  // compile as a struct.new with default values for the widened fields.
  if (expr.properties.length === 0 && ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
    const widenedProps = ctx.widenedTypeProperties.get(expr.parent.name.text);
    if (widenedProps && widenedProps.length > 0) {
      return compileWidenedEmptyObject(ctx, fctx, expr, widenedProps);
    }
  }

  // Empty `{}` used as an externref plain object — only when the TypeScript type
  // context is `any`, `unknown`, or `object` (non-primitive), meaning no specific struct
  // shape is expected.
  // Do NOT apply to: parameter defaults or binding element defaults where the struct system
  // expects a concrete typed object for destructuring.
  // (Too-broad application caused 150+ dstr regressions: parameter defaults like
  //  `function({ x } = {})` would call __new_plain_object instead of struct.new,
  //  making the WasmGC ref.test for the struct type fail and null-deref.)
  if (expr.properties.length === 0 && !ts.isParameter(expr.parent) && !ts.isBindingElement(expr.parent)) {
    // Check contextual type: only use plain object when context is untyped or the `object` type
    // (TypeScript's `object` = NonPrimitive, used e.g. for Object.defineProperty's first arg).
    // Variable declarations without annotation have no contextual type → isAnyContext = true.
    const ctxType = ctx.checker.getContextualType(expr);
    const isAnyContext =
      !ctxType ||
      (ctxType.flags & ts.TypeFlags.Any) !== 0 ||
      (ctxType.flags & ts.TypeFlags.Unknown) !== 0 ||
      (ctxType.flags & ts.TypeFlags.NonPrimitive) !== 0; // TypeScript `object` keyword type
    if (isAnyContext) {
      const funcIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
  }

  const contextType = ctx.checker.getContextualType(expr);
  if (!contextType) {
    const type = ctx.checker.getTypeAtLocation(expr);
    let typeName = resolveStructName(ctx, type);
    if (!typeName) {
      // Auto-register the struct type for inline object literals
      ensureStructForType(ctx, type);
      typeName = resolveStructName(ctx, type);
    }
    if (typeName) {
      ensureComputedPropertyFields(ctx, fctx, expr, type);
      return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
    }
    // Fall back to externref plain object for unmappable types (e.g. {...null})
    const fallback = compileObjectLiteralAsExternref(ctx, fctx, expr);
    if (fallback) return fallback;
    reportError(ctx, expr, "Cannot determine struct type for object literal");
    return null;
  }

  let typeName = resolveStructName(ctx, contextType);
  if (!typeName) {
    // Auto-register the struct type for the contextual type
    ensureStructForType(ctx, contextType);
    typeName = resolveStructName(ctx, contextType);
  }
  if (typeName) {
    ensureComputedPropertyFields(ctx, fctx, expr, contextType);
    return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
  }

  // Contextual type couldn't be mapped; fall back to inferred type-at-location
  const inferredType = ctx.checker.getTypeAtLocation(expr);
  let inferredName = resolveStructName(ctx, inferredType);
  if (!inferredName) {
    ensureStructForType(ctx, inferredType);
    inferredName = resolveStructName(ctx, inferredType);
  }
  if (inferredName) {
    ensureComputedPropertyFields(ctx, fctx, expr, inferredType);
    return compileObjectLiteralForStruct(ctx, fctx, expr, inferredName);
  }

  // Fall back to externref plain object for unmappable types
  const fallback = compileObjectLiteralAsExternref(ctx, fctx, expr);
  if (fallback) return fallback;

  reportError(ctx, expr, "Object literal type not mapped to struct");
  return null;
}

/**
 * Try to evaluate an expression to a constant numeric or string value at compile time.
 * Supports: numeric literals, string literals, simple arithmetic (+, -, *, /),
 * and const variable references.
 * Returns the resolved value (number or string) or undefined if not resolvable.
 */
export function resolveConstantExpression(ctx: CodegenContext, expr: ts.Expression): number | string | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);

  // Boolean literals
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 0;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isStringLiteral(expr)) return expr.text;

  // Parenthesized expression
  if (ts.isParenthesizedExpression(expr)) {
    return resolveConstantExpression(ctx, expr.expression);
  }

  // Const variable reference
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    if (sym) {
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const declList = decl.parent;
        if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
          return resolveConstantExpression(ctx, decl.initializer);
        }
        // Also resolve let/var with simple literal initializers
        if (ts.isVariableDeclarationList(declList) && decl.initializer) {
          if (ts.isStringLiteral(decl.initializer) || ts.isNumericLiteral(decl.initializer)) {
            return ts.isStringLiteral(decl.initializer) ? decl.initializer.text : String(Number(decl.initializer.text));
          }
        }
      }
    }
    return undefined;
  }

  // Assignment expression: x = value → resolve to the RHS value
  // This handles computed property names like [_ = 'str' + 'ing']
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return resolveConstantExpression(ctx, expr.right);
  }

  // Binary expression: a + b, a - b, a * b, a / b
  if (ts.isBinaryExpression(expr)) {
    const left = resolveConstantExpression(ctx, expr.left);
    const right = resolveConstantExpression(ctx, expr.right);
    if (left === undefined || right === undefined) return undefined;

    // String concatenation
    if (typeof left === "string" || typeof right === "string") {
      if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return String(left) + String(right);
      }
      return undefined;
    }

    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.SlashToken:
        return right !== 0 ? left / right : undefined;
      case ts.SyntaxKind.PercentToken:
        return right !== 0 ? left % right : undefined;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return left ** right;
      default:
        return undefined;
    }
  }

  // Prefix unary: -x, +x
  if (ts.isPrefixUnaryExpression(expr)) {
    const operand = resolveConstantExpression(ctx, expr.operand);
    if (typeof operand !== "number") return undefined;
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken:
        return -operand;
      case ts.SyntaxKind.PlusToken:
        return operand;
      default:
        return undefined;
    }
  }

  // Conditional (ternary) expression: cond ? a : b
  if (ts.isConditionalExpression(expr)) {
    const cond = resolveConstantExpression(ctx, expr.condition);
    if (cond === undefined) return undefined;
    // Evaluate truthiness: 0, NaN, "" are falsy; everything else is truthy
    const isTruthy = typeof cond === "string" ? cond.length > 0 : cond !== 0 && !isNaN(cond);
    return resolveConstantExpression(ctx, isTruthy ? expr.whenTrue : expr.whenFalse);
  }

  // Nullish coalescing: a ?? b
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = resolveConstantExpression(ctx, expr.left);
    // In constant expressions, values are never null/undefined, so left always wins
    if (left !== undefined) return left;
    return resolveConstantExpression(ctx, expr.right);
  }

  // Template literal: `prefix${expr}suffix`
  if (ts.isTemplateExpression(expr)) {
    let result = expr.head.text;
    for (const span of expr.templateSpans) {
      const val = resolveConstantExpression(ctx, span.expression);
      if (val === undefined) return undefined;
      result += String(val) + span.literal.text;
    }
    return result;
  }

  // No-substitution template literal: `hello`
  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }

  // Call expressions: String(expr), Number(expr)
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.arguments.length === 1) {
    const funcName = expr.expression.text;
    const argVal = resolveConstantExpression(ctx, expr.arguments[0]!);
    if (argVal !== undefined) {
      if (funcName === "String") return String(argVal);
      if (funcName === "Number") return typeof argVal === "string" ? Number(argVal) : argVal;
    }
  }

  return undefined;
}

/**
 * Resolve the property name of an ObjectLiteralElementLike to a static string.
 * Handles identifiers, string literals, and computed property names that can be
 * evaluated at compile time (string literal expressions, const variables, enum members).
 * Returns undefined if the name cannot be statically resolved.
 */
export function resolvePropertyNameText(ctx: CodegenContext, prop: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(prop)) return undefined;
  const name = prop.name;

  // Regular identifier: { x: 1 }
  if (ts.isIdentifier(name)) return name.text;

  // String literal property name: { "x": 1 }
  if (ts.isStringLiteral(name)) return name.text;

  // Numeric literal property name: { 0: 1 } → canonical string form
  if (ts.isNumericLiteral(name)) return String(Number(name.text));

  // Computed property name: { [expr]: 1 }
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedKeyExpression(ctx, name.expression);
  }

  return undefined;
}

/**
 * Well-known symbol IDs — fixed i32 constants used internally.
 * User-created symbols start at ID 100 via the global counter.
 */
const WELL_KNOWN_SYMBOLS: Record<string, number> = {
  iterator: 1,
  hasInstance: 2,
  toPrimitive: 3,
  toStringTag: 4,
  species: 5,
  isConcatSpreadable: 6,
  match: 7,
  replace: 8,
  search: 9,
  split: 10,
  unscopables: 11,
  asyncIterator: 12,
  dispose: 13,
  asyncDispose: 14,
};

/**
 * Map a well-known Symbol property name (e.g. "iterator") to a reserved
 * property key string "@@iterator" for use as struct field names.
 */
export function resolveWellKnownSymbol(name: string): string | undefined {
  if (name in WELL_KNOWN_SYMBOLS) return `@@${name}`;
  return undefined;
}

/**
 * Get the i32 constant for a well-known symbol, or undefined if not well-known.
 */
export function getWellKnownSymbolId(name: string): number | undefined {
  return WELL_KNOWN_SYMBOLS[name];
}

/**
 * Ensure the __symbol_counter mutable global exists (lazy init).
 * Starts at 100 so well-known symbol IDs (1-12) never collide.
 */
export function ensureSymbolCounter(ctx: CodegenContext): number {
  if (ctx.symbolCounterGlobalIdx >= 0) return ctx.symbolCounterGlobalIdx;
  const idx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__symbol_counter",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 100 }],
  });
  ctx.symbolCounterGlobalIdx = idx;
  return idx;
}

/**
 * Compile a Symbol() call — returns a unique i32 by incrementing a global counter.
 * The description argument (if any) is evaluated for side effects but discarded.
 */
export function compileSymbolCall(ctx: CodegenContext, fctx: FunctionContext, args: readonly ts.Expression[]): ValType {
  // Evaluate description arg for side effects, then drop it
  if (args.length > 0) {
    const argType = compileExpression(ctx, fctx, args[0]!);
    if (argType !== null) {
      fctx.body.push({ op: "drop" });
    }
  }

  const counterIdx = ensureSymbolCounter(ctx);
  // ++counter; return counter
  fctx.body.push({ op: "global.get", index: counterIdx });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "global.set", index: counterIdx });
  fctx.body.push({ op: "global.get", index: counterIdx });
  return { kind: "i32" };
}

/**
 * Try to evaluate a computed key expression to a static string at compile time.
 * Supports:
 * - String literals: ["x"]
 * - Const variable references: [key] where const key = "x"
 * - Enum member access: [MyEnum.Key]
 */
export function resolveComputedKeyExpression(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  // Well-known Symbol property access: [Symbol.iterator], [Symbol.toPrimitive], etc.
  // Map these to reserved names like "@@iterator", "@@toPrimitive" at compile time.
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    const propName = expr.name.text;

    if (objName === "Symbol") {
      const wellKnown = resolveWellKnownSymbol(propName);
      if (wellKnown !== undefined) return wellKnown;
    }

    // Property access for enum members: [MyEnum.Key]
    // Check this after Symbol since resolveConstantExpression doesn't know about enums.
    const enumKey = `${objName}.${propName}`;
    const enumStrVal = ctx.enumStringValues.get(enumKey);
    if (enumStrVal !== undefined) return enumStrVal;
    // Numeric enum — convert to string
    const enumNumVal = ctx.enumValues.get(enumKey);
    if (enumNumVal !== undefined) return String(enumNumVal);
  }

  // Delegate to resolveConstantExpression which handles literals, const variables,
  // binary expressions (+, -, *, /), ternary, nullish coalescing, template literals,
  // prefix unary, and parenthesized expressions.
  const constVal = resolveConstantExpression(ctx, expr);
  if (constVal !== undefined) return String(constVal);

  return undefined;
}

/**
 * Resolve the property name of a getter/setter accessor to a static string.
 * Handles identifiers, string literals, numeric literals, and computed property names.
 */
export function resolveAccessorPropName(ctx: CodegenContext, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedKeyExpression(ctx, name.expression);
  }
  return undefined;
}

/**
 * Compile an empty object literal ({}) that has widened properties from
 * later property assignments (e.g. `var obj = {}; obj.x = 42;`).
 * Registers a struct type with the widened fields and emits struct.new
 * with default values for each field.
 */
export function compileWidenedEmptyObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  widenedProps: { name: string; type: ValType }[],
): ValType | null {
  // The struct was already registered during the pre-pass (collectEmptyObjectWidening).
  // Look it up via the anonTypeMap, or the widenedVarStructMap (which holds the pre-pass
  // registration even for `any`-typed vars that must skip anonTypeMap to avoid polluting
  // the singleton `any` type object).
  const type = ctx.checker.getTypeAtLocation(expr);
  let typeName = ctx.anonTypeMap.get(type);
  if (!typeName && ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
    const varType = ctx.checker.getTypeAtLocation(expr.parent.name);
    typeName = ctx.anonTypeMap.get(varType);
  }
  if (!typeName && ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
    typeName = ctx.widenedVarStructMap.get(expr.parent.name.text);
  }
  if (!typeName) {
    // Fallback: the pre-pass should have registered it but didn't match type identity.
    // Search by variable name in the struct map.
    if (ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
      // Register now as a last resort
      // Widen ref to ref_null so struct.new can use ref.null defaults
      const fields: FieldDef[] = widenedProps.map((wp) => ({
        name: wp.name,
        type:
          wp.type.kind === "ref"
            ? { kind: "ref_null" as const, typeIdx: (wp.type as { typeIdx: number }).typeIdx }
            : wp.type,
        mutable: true,
      }));
      typeName = `__anon_${ctx.anonTypeCounter++}`;
      const typeIdx = ctx.mod.types.length;
      ctx.mod.types.push({
        kind: "struct",
        name: typeName,
        fields,
      } as StructTypeDef);
      ctx.structMap.set(typeName, typeIdx);
      ctx.typeIdxToStructName.set(typeIdx, typeName);
      ctx.structFields.set(typeName, fields);
      // Skip anonTypeMap registration for `any` — it's a singleton type object shared by
      // all any-typed vars, so registering it would pollute every any-typed var's lookup.
      if (!(type.flags & ts.TypeFlags.Any)) {
        ctx.anonTypeMap.set(type, typeName);
      }
      const varType = ctx.checker.getTypeAtLocation(expr.parent.name);
      if (!(varType.flags & ts.TypeFlags.Any)) {
        ctx.anonTypeMap.set(varType, typeName);
      }
      // Record via widenedVarStructMap so later lookups still find it for any-typed vars.
      ctx.widenedVarStructMap.set(expr.parent.name.text, typeName);
    }
  }
  if (!typeName) return null;

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) return null;

  // Emit default values for each field
  for (const field of fields) {
    switch (field.type.kind) {
      case "f64":
        fctx.body.push({ op: "f64.const", value: 0 });
        break;
      case "i32":
        fctx.body.push({ op: "i32.const", value: 0 });
        break;
      case "externref":
        fctx.body.push({ op: "ref.null.extern" });
        break;
      default:
        if (field.type.kind === "ref" || field.type.kind === "ref_null") {
          fctx.body.push({ op: "ref.null", typeIdx: (field.type as { typeIdx: number }).typeIdx });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  return { kind: "ref", typeIdx: structTypeIdx };
}

export function compileObjectLiteralForStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  typeName: string,
): ValType | null {
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, expr, `Unknown struct type: ${typeName}`);
    return null;
  }

  // Check if there are any spread assignments — if so, compile spread sources into locals
  const spreadSources: { local: number; srcStructTypeIdx: number; srcFields: { name: string }[] }[] = [];
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const srcType = ctx.checker.getTypeAtLocation(prop.expression);
      const srcStructName = resolveStructName(ctx, srcType);
      if (srcStructName) {
        const srcStructTypeIdx = ctx.structMap.get(srcStructName);
        const srcFields = ctx.structFields.get(srcStructName);
        if (srcStructTypeIdx !== undefined && srcFields) {
          const srcValType: ValType = { kind: "ref", typeIdx: srcStructTypeIdx };
          const srcLocal = allocLocal(fctx, `__spread_obj_${fctx.locals.length}`, srcValType);
          const spreadResult = compileExpression(ctx, fctx, prop.expression);
          if (!spreadResult) continue;
          fctx.body.push({ op: "local.set", index: srcLocal });
          spreadSources.push({ local: srcLocal, srcStructTypeIdx, srcFields });
        }
      }
    }
  }

  for (const field of fields) {
    // First check for an explicit property assignment (identifier, string literal, or computed key)
    const prop = expr.properties.find((p) => resolvePropertyNameText(ctx, p) === field.name);
    // Also check for shorthand property assignment ({ x, y } where x/y are identifiers)
    const shorthandProp = !prop
      ? expr.properties.find((p) => ts.isShorthandPropertyAssignment(p) && p.name.text === field.name)
      : undefined;
    if (prop && ts.isPropertyAssignment(prop)) {
      // Track closure types for valueOf/toString fields
      const bodyLenBefore = fctx.body.length;
      compileExpression(ctx, fctx, prop.initializer, field.type);
      if ((field.name === "valueOf" || field.name === "toString") && field.type.kind === "eqref") {
        // Find the struct.new instruction that creates the closure struct
        for (let bi = bodyLenBefore; bi < fctx.body.length; bi++) {
          const instr = fctx.body[bi]!;
          if (instr.op === "struct.new" && ctx.closureInfoByTypeIdx.has((instr as any).typeIdx)) {
            const closureTypeIdx = (instr as any).typeIdx as number;
            const existing = ctx.valueOfClosureTypes.get(typeName) ?? [];
            if (!existing.includes(closureTypeIdx)) {
              existing.push(closureTypeIdx);
              ctx.valueOfClosureTypes.set(typeName, existing);
            }
          }
        }
      }
    } else if (shorthandProp && ts.isShorthandPropertyAssignment(shorthandProp)) {
      // Shorthand { x } means the value is the identifier x — compile it
      compileExpression(ctx, fctx, shorthandProp.name, field.type);
    } else {
      // Check spread sources (last spread wins — JS semantics)
      let found = false;
      for (let si = spreadSources.length - 1; si >= 0; si--) {
        const src = spreadSources[si]!;
        const fieldIdx = src.srcFields.findIndex((f) => f.name === field.name);
        if (fieldIdx >= 0) {
          fctx.body.push({ op: "local.get", index: src.local });
          fctx.body.push({ op: "struct.get", typeIdx: src.srcStructTypeIdx, fieldIdx });
          found = true;
          break;
        }
      }
      if (!found) {
        // Default value for missing fields: use "undefined" sentinels so
        // destructuring default-value checks can detect missing properties.
        // f64 uses sNaN sentinel 0x7FF00000DEADC0DE (matches emitDefaultValueCheck #866).
        // externref uses JS undefined (via __get_undefined) not ref.null.extern,
        // because JS destructuring defaults fire only on `=== undefined`, not null.
        if (field.type.kind === "f64") {
          fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den } as unknown as Instr);
          fctx.body.push({ op: "f64.reinterpret_i64" } as unknown as Instr);
        } else if (field.type.kind === "externref") {
          emitUndefined(ctx, fctx);
        } else if (field.type.kind === "eqref") {
          fctx.body.push({ op: "ref.null.eq" });
        } else if (field.type.kind === "ref" || field.type.kind === "ref_null") {
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
        } else {
          fctx.body.push({ op: "i32.const", value: 0 });
        }
      }
    }
  }

  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // Register and compile getter/setter accessors on the object literal
  for (const prop of expr.properties) {
    if (
      ts.isGetAccessorDeclaration(prop) &&
      prop.name &&
      (ts.isIdentifier(prop.name) ||
        ts.isStringLiteral(prop.name) ||
        ts.isComputedPropertyName(prop.name) ||
        ts.isNumericLiteral(prop.name))
    ) {
      const propName = resolveAccessorPropName(ctx, prop.name);
      if (propName === undefined) continue;
      const accessorKey = `${typeName}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);

      const getterName = `${typeName}_get_${propName}`;
      const getterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      const sig = ctx.checker.getSignatureFromDeclaration(prop);
      let getterResults: ValType[] = [];
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retType)) {
          getterResults = [resolveWasmType(ctx, retType)];
        }
      }

      const getterTypeIdx = addFuncType(ctx, getterParams, getterResults, `${getterName}_type`);
      const getterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(getterName, getterFuncIdx);

      const getterFunc: WasmFunction = {
        name: getterName,
        typeIdx: getterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      ctx.mod.functions.push(getterFunc);

      // Promote captured locals to globals so the getter body can access them
      promoteAccessorCapturesToGlobals(ctx, fctx, prop.body);

      // Compile getter body
      const getterFctx: FunctionContext = {
        name: getterName,
        params: [{ name: "this", type: { kind: "ref", typeIdx: structTypeIdx } }],
        locals: [],
        localMap: new Map(),
        returnType: getterResults.length > 0 ? getterResults[0]! : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      };
      getterFctx.localMap.set("this", 0);

      const savedFunc = ctx.currentFunc;
      if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
      if (savedFunc) ctx.funcStack.push(savedFunc);
      ctx.currentFunc = getterFctx;
      if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, getterFctx, stmt);
        }
      }
      // Ensure valid return for non-void getters
      if (getterFctx.returnType) {
        const lastInstr = getterFctx.body[getterFctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (getterFctx.returnType.kind === "f64") {
            getterFctx.body.push({ op: "f64.const", value: 0 });
          } else if (getterFctx.returnType.kind === "i32") {
            getterFctx.body.push({ op: "i32.const", value: 0 });
          } else if (getterFctx.returnType.kind === "externref") {
            getterFctx.body.push({ op: "ref.null.extern" });
          } else if (getterFctx.returnType.kind === "ref" || getterFctx.returnType.kind === "ref_null") {
            getterFctx.body.push({ op: "ref.null", typeIdx: getterFctx.returnType.typeIdx });
          }
        }
      }
      cacheStringLiterals(ctx, getterFctx);
      getterFunc.locals = getterFctx.locals;
      getterFunc.body = getterFctx.body;
      if (savedFunc) ctx.funcStack.pop();
      if (savedFunc) ctx.parentBodiesStack.pop();
      ctx.currentFunc = savedFunc;
    }

    if (
      ts.isSetAccessorDeclaration(prop) &&
      prop.name &&
      (ts.isIdentifier(prop.name) ||
        ts.isStringLiteral(prop.name) ||
        ts.isComputedPropertyName(prop.name) ||
        ts.isNumericLiteral(prop.name))
    ) {
      const propName = resolveAccessorPropName(ctx, prop.name);
      if (propName === undefined) continue;
      const accessorKey = `${typeName}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);

      const setterName = `${typeName}_set_${propName}`;
      const setterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of prop.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        setterParams.push(resolveWasmType(ctx, paramType));
      }

      const setterTypeIdx = addFuncType(ctx, setterParams, [], `${setterName}_type`);
      const setterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(setterName, setterFuncIdx);

      const setterFunc: WasmFunction = {
        name: setterName,
        typeIdx: setterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      ctx.mod.functions.push(setterFunc);

      // Promote captured locals to globals so the setter body can access them
      promoteAccessorCapturesToGlobals(ctx, fctx, prop.body);

      // Compile setter body
      const setterFctxParams: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        setterFctxParams.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
      }

      const setterFctx: FunctionContext = {
        name: setterName,
        params: setterFctxParams,
        locals: [],
        localMap: new Map(),
        returnType: null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      };
      for (let i = 0; i < setterFctxParams.length; i++) {
        setterFctx.localMap.set(setterFctxParams[i]!.name, i);
      }

      const savedFunc = ctx.currentFunc;
      if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
      if (savedFunc) ctx.funcStack.push(savedFunc);
      ctx.currentFunc = setterFctx;

      // Emit default-value initialization for setter parameters with initializers (#377)
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        if (!param.initializer) continue;

        const paramLocalIdx = pi + 1; // account for 'this' param
        const paramType = setterFctxParams[paramLocalIdx]!.type;

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(setterFctx);
        compileExpression(ctx, setterFctx, param.initializer, paramType);
        setterFctx.body.push({ op: "local.set", index: paramLocalIdx });
        const thenInstrs = setterFctx.body;
        popBody(setterFctx, savedBody);

        // Emit the null/zero check + conditional assignment
        if (paramType.kind === "externref") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "ref.is_null" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "ref.is_null" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "i32") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "i32.eqz" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "f64") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "f64.const", value: 0 });
          setterFctx.body.push({ op: "f64.eq" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        }
      }

      if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, setterFctx, stmt);
        }
      }
      cacheStringLiterals(ctx, setterFctx);
      setterFunc.locals = setterFctx.locals;
      setterFunc.body = setterFctx.body;
      if (savedFunc) ctx.funcStack.pop();
      if (savedFunc) ctx.parentBodiesStack.pop();
      ctx.currentFunc = savedFunc;
    }

    // Object literal methods: { method() { ... } }, { "method"() { ... } }, { [key]() { ... } }
    if (
      ts.isMethodDeclaration(prop) &&
      prop.name &&
      (ts.isIdentifier(prop.name) ||
        ts.isStringLiteral(prop.name) ||
        ts.isNumericLiteral(prop.name) ||
        ts.isComputedPropertyName(prop.name))
    ) {
      const methodName = resolveAccessorPropName(ctx, prop.name);
      if (methodName === undefined) continue;
      const fullName = `${typeName}_${methodName}`;
      ctx.classMethodSet.add(fullName);

      // Check if this is a generator method (*method() { ... })
      const isGeneratorMethod = prop.asteriskToken !== undefined;
      if (isGeneratorMethod) {
        ctx.generatorFunctions.add(fullName);
      }

      const methodParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of prop.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // If the parameter has a default value and is a non-null ref type,
        // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
        if (param.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        methodParams.push(wasmType);
      }

      const sig = ctx.checker.getSignatureFromDeclaration(prop);
      // For async methods, unwrap Promise<T> to get T (matching top-level handling)
      // Exclude async generators: they return AsyncGenerator objects, not Promises.
      const isAsyncMethod = prop.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      if (isAsyncMethod && !isGeneratorMethod) {
        ctx.asyncFunctions.add(fullName);
      }
      let retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;
      if (isAsyncMethod && retType) {
        retType = unwrapPromiseType(retType, ctx.checker);
      }
      const methodResults: ValType[] = isGeneratorMethod
        ? [{ kind: "externref" }]
        : retType && !isVoidType(retType)
          ? [resolveWasmType(ctx, retType)]
          : [];

      // Track object-literal methods that read `arguments` (#1053) so
      // callers can populate the __extras_argv global with runtime args
      // beyond the formal param count.
      if (prop.body && bodyUsesArguments(prop.body)) {
        ctx.funcUsesArguments.add(fullName);
      }

      const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);

      // Check if a placeholder function was already pre-registered (by ensureStructForType).
      // If so, reuse it instead of pushing a duplicate with an empty body.
      const existingFuncIdx = ctx.funcMap.get(fullName);
      let methodFunc: WasmFunction;
      if (existingFuncIdx !== undefined) {
        const localIdx = existingFuncIdx - ctx.numImportFuncs;
        methodFunc = ctx.mod.functions[localIdx]!;
        // Update type in case it was refined
        methodFunc.typeIdx = methodTypeIdx;
      } else {
        const methodFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
        ctx.funcMap.set(fullName, methodFuncIdx);
        methodFunc = {
          name: fullName,
          typeIdx: methodTypeIdx,
          locals: [],
          body: [],
          exported: false,
        };
        ctx.mod.functions.push(methodFunc);
      }

      // Promote captured locals to globals so the method body can access them
      promoteAccessorCapturesToGlobals(ctx, fctx, prop.body);

      // Compile method body
      const methodFctxParams: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults or optional params
        // to match the function signature (which uses ref_null so callers can pass ref.null)
        if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        methodFctxParams.push({ name: paramName, type: wasmType });
      }

      const methodFctx: FunctionContext = {
        name: fullName,
        params: methodFctxParams,
        locals: [],
        localMap: new Map(),
        returnType: methodResults.length > 0 ? methodResults[0]! : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
        isGenerator: isGeneratorMethod,
      };
      for (let i = 0; i < methodFctxParams.length; i++) {
        methodFctx.localMap.set(methodFctxParams[i]!.name, i);
      }

      const savedFunc = ctx.currentFunc;
      if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
      if (savedFunc) ctx.funcStack.push(savedFunc);
      ctx.currentFunc = methodFctx;

      // Emit default-value initialization for parameters with initializers
      emitMethodParamDefaults(ctx, methodFctx, prop.parameters, 1); // 1 to skip 'this'

      // Destructure parameters with binding patterns (e.g. method([...x]) or method({a, b}))
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        const paramLocalIdx = pi + 1; // +1 to skip 'this'
        if (ts.isObjectBindingPattern(param.name)) {
          destructureParamObject(ctx, methodFctx, paramLocalIdx, param.name, methodFctxParams[paramLocalIdx]!.type);
        } else if (ts.isArrayBindingPattern(param.name)) {
          destructureParamArray(ctx, methodFctx, paramLocalIdx, param.name, methodFctxParams[paramLocalIdx]!.type);
        }
      }

      // Set up `arguments` object if the method body references it (#820).
      // Object literal methods need an arguments vec struct so that
      // `arguments.length` and `arguments[n]` work at runtime.
      if (prop.body && bodyUsesArguments(prop.body)) {
        const methodParamTypes = methodFctxParams.slice(1).map((p) => p.type); // skip 'this'
        emitArgumentsObject(ctx, methodFctx, methodParamTypes, 1); // paramOffset 1 to skip 'this'
      }

      if (isGeneratorMethod && prop.body) {
        // Generator method: eagerly evaluate body, collect yields into a buffer,
        // then wrap with __create_generator to return a Generator-like object.
        // Body is wrapped in try/catch to defer thrown exceptions to first next() (#928).
        const bufferLocal = allocLocal(methodFctx, "__gen_buffer", { kind: "externref" });
        const pendingThrowLocal = allocLocal(methodFctx, "__gen_pending_throw", { kind: "externref" });
        const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
        methodFctx.body.push({ op: "call", funcIdx: createBufIdx });
        methodFctx.body.push({ op: "local.set", index: bufferLocal });
        methodFctx.body.push({ op: "ref.null.extern" } as unknown as Instr);
        methodFctx.body.push({ op: "local.set", index: pendingThrowLocal });

        const bodyInstrs: Instr[] = [];
        const outerBody = methodFctx.body;
        methodFctx.body = bodyInstrs;

        methodFctx.generatorReturnDepth = 0;
        methodFctx.blockDepth++;
        for (let i = 0; i < methodFctx.breakStack.length; i++) methodFctx.breakStack[i]!++;
        for (let i = 0; i < methodFctx.continueStack.length; i++) methodFctx.continueStack[i]!++;

        for (const stmt of prop.body.statements) {
          compileStatement(ctx, methodFctx, stmt);
        }

        methodFctx.blockDepth--;
        for (let i = 0; i < methodFctx.breakStack.length; i++) methodFctx.breakStack[i]!--;
        for (let i = 0; i < methodFctx.continueStack.length; i++) methodFctx.continueStack[i]!--;
        methodFctx.generatorReturnDepth = undefined;

        methodFctx.body = outerBody;

        // Wrap generator body block in try/catch to capture exceptions as pending throw
        const tagIdx = ensureExnTag(ctx);
        const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
        const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal } as unknown as Instr];
        const catchAllBody: Instr[] =
          getCaughtIdx !== undefined
            ? [
                { op: "call", funcIdx: getCaughtIdx } as Instr,
                { op: "local.set", index: pendingThrowLocal } as unknown as Instr,
              ]
            : [];
        methodFctx.body.push({
          op: "try",
          blockType: { kind: "empty" },
          body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
          catches: [{ tagIdx, body: catchBody }],
          catchAll: catchAllBody.length > 0 ? catchAllBody : undefined,
        } as unknown as Instr);

        // Return __create_generator or __create_async_generator depending on async flag
        const createGenName = isAsyncMethod ? "__create_async_generator" : "__create_generator";
        const createGenIdx = ctx.funcMap.get(createGenName)!;
        methodFctx.body.push({ op: "local.get", index: bufferLocal });
        methodFctx.body.push({ op: "local.get", index: pendingThrowLocal });
        methodFctx.body.push({ op: "call", funcIdx: createGenIdx });
      } else if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, methodFctx, stmt);
        }
      }
      // Ensure valid return for non-void, non-generator methods
      if (methodFctx.returnType && !isGeneratorMethod) {
        const lastInstr = methodFctx.body[methodFctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (methodFctx.returnType.kind === "f64") {
            methodFctx.body.push({ op: "f64.const", value: 0 });
          } else if (methodFctx.returnType.kind === "i32") {
            methodFctx.body.push({ op: "i32.const", value: 0 });
          } else if (methodFctx.returnType.kind === "externref") {
            methodFctx.body.push({ op: "ref.null.extern" });
          } else if (methodFctx.returnType.kind === "ref" || methodFctx.returnType.kind === "ref_null") {
            methodFctx.body.push({ op: "ref.null", typeIdx: methodFctx.returnType.typeIdx });
          }
        }
      }
      cacheStringLiterals(ctx, methodFctx);
      methodFunc.locals = methodFctx.locals;
      methodFunc.body = methodFctx.body;
      if (savedFunc) ctx.funcStack.pop();
      if (savedFunc) ctx.parentBodiesStack.pop();
      ctx.currentFunc = savedFunc;
    }
  }

  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * Compile a tuple literal [a, b, c] to a Wasm GC struct.new instruction.
 * Each element is compiled to its corresponding field type.
 */
export function compileTupleLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
  tupleType: ts.Type,
): ValType | null {
  const elemTypes = getTupleElementTypes(ctx, tupleType);

  const tupleIdx = getOrRegisterTupleType(ctx, elemTypes);

  // Compile each element with the expected field type.
  // For missing positions (literal shorter than tuple), push default values
  // so the struct.new gets a full set of fields (#852).
  for (let i = 0; i < elemTypes.length; i++) {
    const expectedType = elemTypes[i] ?? { kind: "externref" as const };
    if (i < expr.elements.length) {
      const el = expr.elements[i]!;
      // For holes (OmittedExpression) and explicit `undefined` in f64 context,
      // emit the sNaN sentinel so destructuring default checks trigger correctly.
      // compileExpression emits regular NaN for undefined, which doesn't match
      // the sNaN sentinel that emitDefaultValueCheck looks for (#1024).
      if (expectedType.kind === "f64" && _isUndefinedLike(el)) {
        fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den } as unknown as Instr);
        fctx.body.push({ op: "f64.reinterpret_i64" } as unknown as Instr);
      } else {
        compileExpression(ctx, fctx, el, expectedType);
      }
    } else {
      // Missing element — push sentinel value that destructuring recognizes as
      // "absent": sNaN sentinel for f64, JS undefined for externref, ref.null
      // for refs, 0 for i32. For externref we emit `call $__get_undefined` so
      // destructuring defaults (which fire on `=== undefined`, not `null`)
      // trigger correctly when a tuple-typed arg is shorter than the pattern
      // (e.g. `([x = d]) => {}` called with `[]`) — per §8.6.2 (#852, #866).
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den } as unknown as Instr);
        fctx.body.push({ op: "f64.reinterpret_i64" } as unknown as Instr);
      } else if (expectedType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (expectedType.kind === "externref") {
        emitUndefined(ctx, fctx);
      } else if (expectedType.kind === "ref_null" || expectedType.kind === "ref") {
        const typeIdx = (expectedType as { typeIdx: number }).typeIdx;
        fctx.body.push({ op: "ref.null", typeIdx } as unknown as Instr);
      } else {
        pushDefaultValue(fctx, expectedType, ctx);
      }
    }
  }

  fctx.body.push({ op: "struct.new", typeIdx: tupleIdx });
  return { kind: "ref", typeIdx: tupleIdx };
}

/**
 * Detect a counted push loop pattern after an empty array literal (#1001):
 *   const arr: number[] = [];
 *   for (let i = 0; i < N; i++) arr.push(expr);
 *
 * Returns N (the trip count) if the pattern is statically provable, 0 otherwise.
 * This allows preallocating the backing WasmGC array to eliminate growth overhead.
 */
function detectCountedPushLoopSize(expr: ts.ArrayLiteralExpression): number {
  // Walk up: ArrayLiteralExpression → VariableDeclaration → VariableDeclarationList → VariableStatement → Block/SourceFile
  const varDecl = expr.parent;
  if (!varDecl || !ts.isVariableDeclaration(varDecl) || !ts.isIdentifier(varDecl.name)) return 0;
  const arrName = varDecl.name.text;

  const declList = varDecl.parent;
  if (!declList || !ts.isVariableDeclarationList(declList)) return 0;
  const varStmt = declList.parent;
  if (!varStmt || !ts.isVariableStatement(varStmt)) return 0;

  const block = varStmt.parent;
  if (!block) return 0;
  let stmts: ts.NodeArray<ts.Statement>;
  if (ts.isBlock(block)) stmts = block.statements;
  else if (ts.isSourceFile(block)) stmts = block.statements;
  else return 0;

  // Find the variable statement's index and look at the next statement
  const idx = stmts.indexOf(varStmt);
  if (idx < 0 || idx + 1 >= stmts.length) return 0;
  const nextStmt = stmts[idx + 1]!;
  if (!ts.isForStatement(nextStmt)) return 0;

  // Check initializer: `let i = 0` or `var i = 0`
  const init = nextStmt.initializer;
  if (!init || !ts.isVariableDeclarationList(init)) return 0;
  if (init.declarations.length !== 1) return 0;
  const loopDecl = init.declarations[0]!;
  if (!ts.isIdentifier(loopDecl.name)) return 0;
  const loopVar = loopDecl.name.text;
  if (!loopDecl.initializer || !ts.isNumericLiteral(loopDecl.initializer) || loopDecl.initializer.text !== "0")
    return 0;

  // Check condition: `i < N` where N is a numeric literal
  const cond = nextStmt.condition;
  if (!cond || !ts.isBinaryExpression(cond)) return 0;
  if (cond.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return 0;
  if (!ts.isIdentifier(cond.left) || cond.left.text !== loopVar) return 0;
  if (!ts.isNumericLiteral(cond.right)) return 0;
  const tripCount = Number(cond.right.text);
  if (!Number.isFinite(tripCount) || tripCount <= 0 || tripCount > 1_000_000) return 0;

  // Check incrementor: `i++` or `i += 1`
  const inc = nextStmt.incrementor;
  if (!inc) return 0;
  if (ts.isPostfixUnaryExpression(inc)) {
    if (inc.operator !== ts.SyntaxKind.PlusPlusToken) return 0;
    if (!ts.isIdentifier(inc.operand) || inc.operand.text !== loopVar) return 0;
  } else if (ts.isPrefixUnaryExpression(inc)) {
    if (inc.operator !== ts.SyntaxKind.PlusPlusToken) return 0;
    if (!ts.isIdentifier(inc.operand) || inc.operand.text !== loopVar) return 0;
  } else {
    return 0;
  }

  // Check body: must contain only `arr.push(expr)` (as expression statement)
  const body = nextStmt.statement;
  let bodyStmt: ts.Statement;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return 0;
    bodyStmt = body.statements[0]!;
  } else {
    bodyStmt = body;
  }
  if (!ts.isExpressionStatement(bodyStmt)) return 0;
  const callExpr = bodyStmt.expression;
  if (!ts.isCallExpression(callExpr)) return 0;
  if (!ts.isPropertyAccessExpression(callExpr.expression)) return 0;
  if (callExpr.expression.name.text !== "push") return 0;
  if (!ts.isIdentifier(callExpr.expression.expression)) return 0;
  if (callExpr.expression.expression.text !== arrName) return 0;
  if (callExpr.arguments.length !== 1) return 0;

  return tripCount;
}

/**
 * Detect a counted dense-fill loop pattern after an empty array literal (#1198):
 *   const arr = [];
 *   for (let i = 0; i < N; i++) arr[i] = <pure expr involving i and outer locals>;
 *
 * This is the cousin of `detectCountedPushLoopSize` for `a[i] = …` instead of
 * `a.push(…)`. The match unlocks pre-sizing the WasmGC backing array to N up
 * front, eliminating O(n²) grow-and-copy churn that the per-write
 * grow-on-demand path emits.
 *
 * Returns the loop-bound `ts.Expression` if the pattern matches, `null`
 * otherwise. The caller compiles the expression to i32 at allocation time
 * (literal `N` is constant-folded into `i32.const N`; an identifier compiles
 * via the normal expression path with an i32 hint).
 *
 * **Conservative checks** — the matcher rejects shapes whose pre-sizing
 * would change observable semantics:
 *
 * - Loop body must be **exactly** `arr[i] = expr` (one expression statement
 *   wrapping a single assignment).
 * - The RHS must be "non-throwing" — only NumericLiteral, Identifier,
 *   PrefixUnary on the above, BinaryExpression composing the above. This
 *   excludes calls, property access, and element access (any of which can
 *   throw in JS, which would leave a partial-fill `arr.length` that doesn't
 *   match the pre-sized value).
 * - LHS must be `arr[i]` exactly — no `arr[i+1]`, no `arr[other]`, no
 *   `arr.field` in the RHS that could read the array under construction.
 * - The loop body must not reference `arr` anywhere else (rules out `arr
 *   .length` reads, which would observe the pre-sized length immediately
 *   instead of the grow-as-you-go length).
 */
function detectCountedFillLoopBound(expr: ts.ArrayLiteralExpression): ts.Expression | null {
  // Same outer-walk as detectCountedPushLoopSize: literal must be the
  // initializer of a single variable declaration whose next sibling
  // statement is the for-loop.
  const varDecl = expr.parent;
  if (!varDecl || !ts.isVariableDeclaration(varDecl) || !ts.isIdentifier(varDecl.name)) return null;
  const arrName = varDecl.name.text;

  const declList = varDecl.parent;
  if (!declList || !ts.isVariableDeclarationList(declList)) return null;
  const varStmt = declList.parent;
  if (!varStmt || !ts.isVariableStatement(varStmt)) return null;

  const block = varStmt.parent;
  if (!block) return null;
  let stmts: ts.NodeArray<ts.Statement>;
  if (ts.isBlock(block)) stmts = block.statements;
  else if (ts.isSourceFile(block)) stmts = block.statements;
  else return null;

  const idx = stmts.indexOf(varStmt);
  if (idx < 0 || idx + 1 >= stmts.length) return null;
  const nextStmt = stmts[idx + 1]!;
  if (!ts.isForStatement(nextStmt)) return null;

  // Initializer: `let i = 0` (or var). Single declaration, init === 0.
  const init = nextStmt.initializer;
  if (!init || !ts.isVariableDeclarationList(init)) return null;
  if (init.declarations.length !== 1) return null;
  const loopDecl = init.declarations[0]!;
  if (!ts.isIdentifier(loopDecl.name)) return null;
  const loopVar = loopDecl.name.text;
  if (!loopDecl.initializer || !ts.isNumericLiteral(loopDecl.initializer) || loopDecl.initializer.text !== "0") {
    return null;
  }

  // Condition: `i < BOUND` where BOUND is any expression. We capture it for
  // the caller to compile; we never evaluate it here.
  const cond = nextStmt.condition;
  if (!cond || !ts.isBinaryExpression(cond)) return null;
  if (cond.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null;
  if (!ts.isIdentifier(cond.left) || cond.left.text !== loopVar) return null;
  const boundExpr = cond.right;

  // BOUND may not reference the array under construction — that would
  // observe the pre-sized length and change semantics.
  if (!isExprFreeOfReference(boundExpr, arrName)) return null;

  // Incrementor: `i++` or `++i`.
  const inc = nextStmt.incrementor;
  if (!inc) return null;
  if (ts.isPostfixUnaryExpression(inc) || ts.isPrefixUnaryExpression(inc)) {
    if (inc.operator !== ts.SyntaxKind.PlusPlusToken) return null;
    if (!ts.isIdentifier(inc.operand) || inc.operand.text !== loopVar) return null;
  } else {
    return null;
  }

  // Body: exactly one expression statement of shape `arr[loopVar] = pureExpr`.
  const bodyStmtNode = nextStmt.statement;
  let bodyStmt: ts.Statement;
  if (ts.isBlock(bodyStmtNode)) {
    if (bodyStmtNode.statements.length !== 1) return null;
    bodyStmt = bodyStmtNode.statements[0]!;
  } else {
    bodyStmt = bodyStmtNode;
  }
  if (!ts.isExpressionStatement(bodyStmt)) return null;
  const assign = bodyStmt.expression;
  if (!ts.isBinaryExpression(assign)) return null;
  if (assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;

  // LHS: `arr[loopVar]`.
  const lhs = assign.left;
  if (!ts.isElementAccessExpression(lhs)) return null;
  if (!ts.isIdentifier(lhs.expression) || lhs.expression.text !== arrName) return null;
  if (!ts.isIdentifier(lhs.argumentExpression) || lhs.argumentExpression.text !== loopVar) return null;

  // RHS must be pure (non-throwing) AND must not reference the array.
  if (!isPureFillRhs(assign.right, arrName)) return null;

  return boundExpr;
}

/**
 * Is `expr` a "pure" fill RHS — guaranteed non-throwing and free of any read
 * of `arrName`? Conservative: only literals, identifier reads, parenthesized
 * versions of those, and unary / binary compositions of the above.
 */
function isPureFillRhs(expr: ts.Expression, arrName: string): boolean {
  if (ts.isParenthesizedExpression(expr)) return isPureFillRhs(expr.expression, arrName);
  if (ts.isNumericLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isStringLiteral(expr)) return true;
  if (ts.isIdentifier(expr)) {
    // Plain identifier read is pure (variable access doesn't throw); but we
    // must reject reads of the array under construction.
    return expr.text !== arrName;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    const op = expr.operator;
    // Only allow safely-pure unary ops. `++`/`--` are mutations (could
    // touch the array if the operand is a complex thing); we keep it
    // simple and allow `+` `-` `~` `!` only.
    if (
      op === ts.SyntaxKind.PlusToken ||
      op === ts.SyntaxKind.MinusToken ||
      op === ts.SyntaxKind.TildeToken ||
      op === ts.SyntaxKind.ExclamationToken
    ) {
      return isPureFillRhs(expr.operand, arrName);
    }
    return false;
  }
  if (ts.isBinaryExpression(expr)) {
    // Reject assignment / compound-assignment.
    const k = expr.operatorToken.kind;
    if (
      k === ts.SyntaxKind.EqualsToken ||
      k === ts.SyntaxKind.PlusEqualsToken ||
      k === ts.SyntaxKind.MinusEqualsToken ||
      k === ts.SyntaxKind.AsteriskEqualsToken ||
      k === ts.SyntaxKind.SlashEqualsToken ||
      k === ts.SyntaxKind.PercentEqualsToken ||
      k === ts.SyntaxKind.AmpersandEqualsToken ||
      k === ts.SyntaxKind.BarEqualsToken ||
      k === ts.SyntaxKind.CaretEqualsToken ||
      k === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      k === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
      k === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
      k === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      k === ts.SyntaxKind.BarBarEqualsToken ||
      k === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      k === ts.SyntaxKind.CommaToken
    ) {
      return false;
    }
    return isPureFillRhs(expr.left, arrName) && isPureFillRhs(expr.right, arrName);
  }
  return false;
}

/**
 * Cheap walk that returns true iff `expr` doesn't textually reference
 * the identifier `name`. We scan the AST and reject any Identifier whose
 * text matches; PropertyAccessExpression names (the `.foo` part) are
 * skipped because they are not variable references.
 */
function isExprFreeOfReference(expr: ts.Node, name: string): boolean {
  if (ts.isIdentifier(expr)) return expr.text !== name;
  if (ts.isPropertyAccessExpression(expr)) {
    return isExprFreeOfReference(expr.expression, name);
    // expr.name is a property *name*, not a variable reference — skipped.
  }
  let ok = true;
  expr.forEachChild((child) => {
    if (!ok) return;
    if (!isExprFreeOfReference(child, name)) ok = false;
  });
  return ok;
}

export function compileArrayLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
): ValType | null {
  // Check if the target type is a tuple — compile as struct.new instead of array.
  // Skip if _arrayLiteralForceVec is set (e.g. destructuring default where the target
  // is a vec type, but TS contextual type resolution sees a tuple pattern).
  const ctxTupleType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
  if (ctxTupleType && isTupleType(ctxTupleType) && !(ctx as any)._arrayLiteralForceVec) {
    // When the contextual type gives degenerate tuple types (e.g. all void from
    // destructuring defaults: `[w = counter()] = [null, 0, false, '']`),
    // prefer getTypeAtLocation which reflects the actual literal element types (#801).
    let tupleType = ctxTupleType;
    if (expr.elements.length > 1) {
      const ctxElemTypes = getTupleElementTypes(ctx, ctxTupleType);
      // If the contextual tuple type has fewer slots than the literal has elements,
      // the tuple would truncate data. Fall through to vec path (#971).
      // This happens when destructuring rest `[x, ...y] = [1, 2, 3]` gives a
      // contextual type of [number, number] but the literal has 3 elements.
      if (ctxElemTypes.length < expr.elements.length) {
        // Don't use tuple — fall through to vec
      } else {
        const allSameKind = ctxElemTypes.length > 0 && ctxElemTypes.every((t) => t.kind === ctxElemTypes[0]!.kind);
        if (allSameKind) {
          const actualType = ctx.checker.getTypeAtLocation(expr);
          if (actualType && isTupleType(actualType)) {
            const actualElemTypes = getTupleElementTypes(ctx, actualType);
            const actualHeterogeneous =
              actualElemTypes.length > 1 && !actualElemTypes.every((t) => t.kind === actualElemTypes[0]!.kind);
            if (actualHeterogeneous) {
              // Don't switch to the actual type if the heterogeneity is only
              // from undefined/void holes (i32) mixed with f64. The contextual
              // type's f64 is better because it supports the sNaN sentinel for
              // destructuring default checks. Switching to [i32, i32, f64] would
              // lose default-value detection on the hole positions (#1024).
              const onlyUndefinedHeterogeneity =
                actualElemTypes.every((t) => t.kind === "f64" || t.kind === "i32") &&
                actualElemTypes.some((t) => t.kind === "i32") &&
                actualElemTypes.some((t) => t.kind === "f64");
              if (!onlyUndefinedHeterogeneity) {
                tupleType = actualType;
              }
            }
          }
        }
        return compileTupleLiteral(ctx, fctx, expr, tupleType);
      }
    } else {
      return compileTupleLiteral(ctx, fctx, expr, tupleType);
    }
  }

  if (expr.elements.length === 0) {
    // Detect counted push loop pattern and preallocate (#1001)
    const prealloc = detectCountedPushLoopSize(expr);
    // Detect counted dense-fill loop pattern (#1198) — sister of the
    // push-loop matcher. When the array is followed by a
    // `for (let i = 0; i < N; i++) arr[i] = pureExpr` loop, we know the
    // final length is exactly N and we can pre-size both the data buffer
    // and the vec.length field, eliminating the O(n²) grow-and-copy cost
    // the per-write grow-on-demand path otherwise pays.
    const fillBoundExpr = prealloc > 0 ? null : detectCountedFillLoopBound(expr);

    // Empty array — try to determine element type from contextual type (e.g. number[])
    let emptyElemKind = "externref";
    const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
    if (ctxType) {
      const sym = (ctxType as ts.TypeReference).symbol ?? ctxType.symbol;
      if (sym?.name === "Array") {
        const typeArgs = ctx.checker.getTypeArguments(ctxType as ts.TypeReference);
        if (typeArgs[0]) {
          const elemWasmType = resolveWasmType(ctx, typeArgs[0]);
          emptyElemKind =
            elemWasmType.kind === "ref" || elemWasmType.kind === "ref_null"
              ? `ref_${(elemWasmType as { typeIdx: number }).typeIdx}`
              : elemWasmType.kind;
        }
      }
    }
    const vecTypeIdx = getOrRegisterVecType(ctx, emptyElemKind);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      reportError(ctx, expr, "Empty array literal: invalid vec type");
      return null;
    }

    if (fillBoundExpr !== null) {
      // Dense-fill prealloc (#1198): emit `vec.length = N` AND
      // `vec.data = array.new_default(N)`. Setting length=N up front
      // matches the post-loop observable state — `arr.length === N`
      // after every iteration writes its slot — so the optimization
      // preserves semantics for the canonical pattern detected.
      //
      // For a literal-numeric bound, fold to `i32.const N`.
      // Otherwise compile the bound expression with an i32 hint and
      // tee into a temp local so we can use it for both the struct's
      // length field and the array.new_default size.
      if (ts.isNumericLiteral(fillBoundExpr)) {
        const n = Number(fillBoundExpr.text);
        if (Number.isFinite(n) && n >= 0 && n <= 1_000_000_000) {
          fctx.body.push({ op: "i32.const", value: n }); // length field
          fctx.body.push({ op: "i32.const", value: n }); // size for array.new_default
          fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }
        // Fall through to the empty-allocation path on out-of-range
        // literals; preserves grow-on-write semantics for pathological
        // cases without changing observable behaviour.
      } else {
        // Identifier or expression bound. Compile with i32 hint and
        // stash in a temp local so we can re-emit it for both fields.
        const tmpN = allocTempLocal(fctx, { kind: "i32" });
        compileExpression(ctx, fctx, fillBoundExpr, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: tmpN }); // length field (top of stack)
        fctx.body.push({ op: "local.get", index: tmpN }); // size for array.new_default
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        releaseTempLocal(fctx, tmpN);
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }
    }

    fctx.body.push({ op: "i32.const", value: 0 }); // length field (field 0)
    fctx.body.push({ op: "i32.const", value: prealloc > 0 ? prealloc : 0 }); // size for array.new_default (#1001: preallocate if counted push loop detected)
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx }); // data field (field 1)
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx }); // wrap in vec struct
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Check if any element is a spread
  const hasSpread = expr.elements.some((el) => ts.isSpreadElement(el));

  // Determine element type from first non-omitted, non-spread element, or from spread source
  let elemWasm: ValType;
  // biome-ignore lint/style/useConst: reassigned in branches below
  let elemKind: string;
  const firstSignificantElem = expr.elements.find((el) => !ts.isOmittedExpression(el));
  const firstElem = firstSignificantElem ?? expr.elements[0]!;
  if (ts.isSpreadElement(firstElem)) {
    const spreadType = ctx.checker.getTypeAtLocation(firstElem.expression);
    const typeArgs = ctx.checker.getTypeArguments(spreadType as ts.TypeReference);
    const innerType = typeArgs[0];
    elemWasm = innerType ? resolveWasmType(ctx, innerType) : { kind: "f64" };
  } else if (ts.isOmittedExpression(firstElem)) {
    // All elements are omitted — use externref (undefined)
    elemWasm = { kind: "externref" };
  } else {
    const firstElemType = ctx.checker.getTypeAtLocation(firstElem);
    elemWasm = resolveWasmType(ctx, firstElemType);
    // If the literal mixes a `null` literal with another kind (e.g. `[1, null]`),
    // fall back to externref so the null survives. Without this, null gets coerced
    // to f64 0 and destructuring defaults misbehave (#1021). We gate on `null`
    // specifically rather than any heterogeneity, because promoting on other
    // mismatches (`[7, undefined]`, `[0, "last"]`) causes downstream regressions
    // in paths that rely on the first-element heuristic.
    if (elemWasm.kind !== "externref") {
      const hasNullLiteral = expr.elements.some((e) => e.kind === ts.SyntaxKind.NullKeyword);
      if (hasNullLiteral) {
        elemWasm = { kind: "externref" };
      }
    }
  }
  elemKind = elemWasm.kind === "ref" || elemWasm.kind === "ref_null" ? `ref_${elemWasm.typeIdx}` : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    reportError(ctx, expr, "Array literal: invalid vec type");
    return null;
  }

  if (!hasSpread) {
    // No spread — use the fast array.new_fixed path, then wrap in vec struct
    for (const el of expr.elements) {
      // For holes and explicit undefined in f64 context, emit sNaN sentinel
      // so destructuring default checks trigger correctly (#1024).
      if (elemWasm.kind === "f64" && _isUndefinedLike(el)) {
        fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den } as unknown as Instr);
        fctx.body.push({ op: "f64.reinterpret_i64" } as unknown as Instr);
      } else {
        compileExpression(ctx, fctx, el, elemWasm);
      }
    }
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: expr.elements.length });
    // Store data array in temp local, then build vec struct
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: expr.elements.length }); // length field (field 0)
    fctx.body.push({ op: "local.get", index: tmpData }); // data field (field 1)
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx }); // wrap in vec struct
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Has spread elements — compute total length, create array, then fill
  // Step 1: Compute total length and store spread sources in locals
  const spreadLocals: { local: number; elemIdx: number; srcVecTypeIdx: number }[] = [];
  const nonSpreadCount = expr.elements.filter((el) => !ts.isSpreadElement(el)).length;

  // Push the non-spread count as the initial length
  fctx.body.push({ op: "i32.const", value: nonSpreadCount });

  // For each spread source, compile it, store in local, and add its length
  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isSpreadElement(el)) {
      const srcType = compileExpression(ctx, fctx, el.expression);
      if (!srcType || (srcType.kind !== "ref" && srcType.kind !== "ref_null")) {
        // The compiled expression left a value on the stack — drop it so we
        // don't corrupt the running total (i32) that sits underneath.
        if (srcType) {
          fctx.body.push({ op: "drop" });
        }
        continue;
      }
      const srcVecTypeIdx = (srcType as { typeIdx: number }).typeIdx;
      const srcLocal = allocLocal(fctx, `__spread_src_${fctx.locals.length}`, srcType);
      fctx.body.push({ op: "local.tee", index: srcLocal });
      fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 0 }); // get length from vec
      fctx.body.push({ op: "i32.add" }); // accumulate total length
      spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx });
    }
  }

  // Step 2: Create the result backing array with computed length, default-initialized
  const resultArrType: ValType = { kind: "ref", typeIdx: arrTypeIdx };
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  const resultLocal = allocLocal(fctx, `__spread_result_${fctx.locals.length}`, resultArrType);
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Step 3: Fill the array — track current write index
  const writeIdx = allocLocal(fctx, `__spread_wi_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: writeIdx });

  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isSpreadElement(el)) {
      // Copy all elements from spread source using a loop
      const spreadInfo = spreadLocals.find((s) => s.elemIdx === i);
      if (!spreadInfo) continue;

      const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, spreadInfo.srcVecTypeIdx);
      if (srcArrTypeIdx < 0) continue;
      const readIdx = allocLocal(fctx, `__spread_ri_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: readIdx });

      // loop: while readIdx < srcVec.length
      const loopBody: Instr[] = [];
      // Condition: readIdx >= srcVec.length → break
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "local.get", index: spreadInfo.local });
      loopBody.push({ op: "struct.get", typeIdx: spreadInfo.srcVecTypeIdx, fieldIdx: 0 }); // get length from vec
      loopBody.push({ op: "i32.ge_s" });
      loopBody.push({ op: "br_if", depth: 1 }); // break out of block
      // result[writeIdx] = src.data[readIdx]
      loopBody.push({ op: "local.get", index: resultLocal });
      loopBody.push({ op: "local.get", index: writeIdx });
      loopBody.push({ op: "local.get", index: spreadInfo.local });
      loopBody.push({ op: "struct.get", typeIdx: spreadInfo.srcVecTypeIdx, fieldIdx: 1 }); // get data from vec
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "array.get", typeIdx: srcArrTypeIdx });
      loopBody.push({ op: "array.set", typeIdx: arrTypeIdx });
      // writeIdx++; readIdx++
      loopBody.push({ op: "local.get", index: writeIdx });
      loopBody.push({ op: "i32.const", value: 1 });
      loopBody.push({ op: "i32.add" });
      loopBody.push({ op: "local.set", index: writeIdx });
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "i32.const", value: 1 });
      loopBody.push({ op: "i32.add" });
      loopBody.push({ op: "local.set", index: readIdx });
      loopBody.push({ op: "br", depth: 0 }); // continue loop

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
      });
    } else {
      // Non-spread element: result[writeIdx] = el; writeIdx++
      fctx.body.push({ op: "local.get", index: resultLocal });
      fctx.body.push({ op: "local.get", index: writeIdx });
      compileExpression(ctx, fctx, el, elemWasm);
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.get", index: writeIdx });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.set", index: writeIdx });
    }
  }

  // Wrap the result backing array in a vec struct
  // Stack: totalLen (= writeIdx), data ref → struct.new
  fctx.body.push({ op: "local.get", index: writeIdx }); // length field (field 0)
  fctx.body.push({ op: "local.get", index: resultLocal }); // data field (field 1)
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx }); // wrap in vec struct
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Compile Array(n) or Array(a,b,c) function calls (non-new).
 * Array(n) creates a sparse array of length n (all slots undefined/default).
 * Array(a,b,c) creates [a, b, c].
 * These have identical semantics to new Array(...).
 */
export function compileArrayConstructorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const args = expr.arguments;

  // Determine element type from contextual type or expression type
  const ctxType = ctx.checker.getContextualType(expr);
  const exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);

  // Infer element type
  let elemWasm: ValType;
  const rawTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
  const elemTsType = rawTypeArgs?.[0];
  if (elemTsType && !(elemTsType.flags & ts.TypeFlags.Any)) {
    elemWasm = resolveWasmType(ctx, elemTsType);
  } else {
    // Default to f64 for untyped arrays
    elemWasm = { kind: "f64" };
  }

  const elemKind =
    elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
      ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
      : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    reportError(ctx, expr, "Array(): invalid vec type");
    return null;
  }

  if (args.length === 0) {
    // Array() → empty array
    fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
    fctx.body.push({ op: "i32.const", value: 0 }); // size for array.new_default
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  if (args.length === 1) {
    // Array(n) → sparse array of length n with default values
    compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: sizeLocal });
    fctx.body.push({ op: "local.get", index: sizeLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Array(a, b, c) → [a, b, c]
  for (const arg of args) {
    compileExpression(ctx, fctx, arg, elemWasm);
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: args.length });
  const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpData });
  fctx.body.push({ op: "i32.const", value: args.length });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

// Register delegate in shared.ts so index.ts can call resolveComputedKeyExpression
// without importing literals.ts directly (which imports index.ts → cycle).
registerResolveComputedKeyExpression(resolveComputedKeyExpression);
