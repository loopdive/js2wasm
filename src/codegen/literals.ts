/**
 * Literal compilation for ts2wasm — object, array, tuple, and symbol literals.
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
import type { CodegenContext, FunctionContext } from "./index.js";
import {
  allocLocal,
  resolveWasmType,
  getOrRegisterVecType,
  getArrTypeIdxFromVec,
  addFuncType,
  nextModuleGlobalIdx,
  ensureStructForType,
  isTupleType,
  getTupleElementTypes,
  getOrRegisterTupleType,
  cacheStringLiterals,
  pushBody,
  popBody,
  destructureParamArray,
  destructureParamObject,
} from "./index.js";
import {
  isVoidType,
} from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction, FieldDef, StructTypeDef } from "../ir/types.js";
import { compileStatement } from "./statements.js";
import { compileExpression, getLine, getCol, VOID_RESULT } from "./shared.js";
import { promoteAccessorCapturesToGlobals, emitMethodParamDefaults } from "./closures.js";
import { resolveStructName, patchStructNewForAddedField } from "./expressions.js";

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
    if (existingFields.some(f => f.name === propName)) continue;
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
    ctx.errors.push({
      message: "Cannot determine struct type for object literal",
      line: getLine(expr),
      column: getCol(expr),
    });
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

  ctx.errors.push({
    message: "Object literal type not mapped to struct",
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

/**
 * Try to evaluate an expression to a constant numeric or string value at compile time.
 * Supports: numeric literals, string literals, simple arithmetic (+, -, *, /),
 * and const variable references.
 * Returns the resolved value (number or string) or undefined if not resolvable.
 */
export function resolveConstantExpression(
  ctx: CodegenContext,
  expr: ts.Expression,
): number | string | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);

  // Boolean literals
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 0;
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
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.SlashToken: return right !== 0 ? left / right : undefined;
      case ts.SyntaxKind.PercentToken: return right !== 0 ? left % right : undefined;
      case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
      default: return undefined;
    }
  }

  // Prefix unary: -x, +x
  if (ts.isPrefixUnaryExpression(expr)) {
    const operand = resolveConstantExpression(ctx, expr.operand);
    if (typeof operand !== "number") return undefined;
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken: return -operand;
      case ts.SyntaxKind.PlusToken: return operand;
      default: return undefined;
    }
  }

  // Conditional (ternary) expression: cond ? a : b
  if (ts.isConditionalExpression(expr)) {
    const cond = resolveConstantExpression(ctx, expr.condition);
    if (cond === undefined) return undefined;
    // Evaluate truthiness: 0, NaN, "" are falsy; everything else is truthy
    const isTruthy = typeof cond === "string" ? cond.length > 0 : (cond !== 0 && !isNaN(cond));
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

  return undefined;
}

/**
 * Resolve the property name of an ObjectLiteralElementLike to a static string.
 * Handles identifiers, string literals, and computed property names that can be
 * evaluated at compile time (string literal expressions, const variables, enum members).
 * Returns undefined if the name cannot be statically resolved.
 */
export function resolvePropertyNameText(
  ctx: CodegenContext,
  prop: ts.ObjectLiteralElementLike,
): string | undefined {
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
export function compileSymbolCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType {
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
export function resolveComputedKeyExpression(
  ctx: CodegenContext,
  expr: ts.Expression,
): string | undefined {
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
  // Look it up via the anonTypeMap.
  const type = ctx.checker.getTypeAtLocation(expr);
  let typeName = ctx.anonTypeMap.get(type);
  if (!typeName && ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
    const varType = ctx.checker.getTypeAtLocation(expr.parent.name);
    typeName = ctx.anonTypeMap.get(varType);
  }
  if (!typeName) {
    // Fallback: the pre-pass should have registered it but didn't match type identity.
    // Search by variable name in the struct map.
    if (ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
      // Register now as a last resort
      // Widen ref to ref_null so struct.new can use ref.null defaults
      const fields: FieldDef[] = widenedProps.map(wp => ({
        name: wp.name,
        type: wp.type.kind === "ref"
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
      ctx.structFields.set(typeName, fields);
      ctx.anonTypeMap.set(type, typeName);
      const varType = ctx.checker.getTypeAtLocation(expr.parent.name);
      ctx.anonTypeMap.set(varType, typeName);
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
    ctx.errors.push({
      message: `Unknown struct type: ${typeName}`,
      line: getLine(expr),
      column: getCol(expr),
    });
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
    const prop = expr.properties.find(
      (p) => resolvePropertyNameText(ctx, p) === field.name,
    );
    // Also check for shorthand property assignment ({ x, y } where x/y are identifiers)
    const shorthandProp = !prop
      ? expr.properties.find(
          (p) =>
            ts.isShorthandPropertyAssignment(p) &&
            p.name.text === field.name,
        )
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
        // Default value
        if (field.type.kind === "f64") {
          fctx.body.push({ op: "f64.const", value: 0 });
        } else if (field.type.kind === "externref") {
          fctx.body.push({ op: "ref.null.extern" });
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
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isComputedPropertyName(prop.name) || ts.isNumericLiteral(prop.name))
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
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isComputedPropertyName(prop.name) || ts.isNumericLiteral(prop.name))
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
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name) || ts.isComputedPropertyName(prop.name))
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
      const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;
      const methodResults: ValType[] = isGeneratorMethod
        ? [{ kind: "externref" }]
        : (retType && !isVoidType(retType) ? [resolveWasmType(ctx, retType)] : []);

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

      if (isGeneratorMethod && prop.body) {
        // Generator method: eagerly evaluate body, collect yields into a buffer,
        // then wrap with __create_generator to return a Generator-like object.
        const bufferLocal = allocLocal(methodFctx, "__gen_buffer", { kind: "externref" });
        const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
        methodFctx.body.push({ op: "call", funcIdx: createBufIdx });
        methodFctx.body.push({ op: "local.set", index: bufferLocal });

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
        methodFctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: bodyInstrs,
        });

        // Return __create_generator(__gen_buffer)
        const createGenIdx = ctx.funcMap.get("__create_generator")!;
        methodFctx.body.push({ op: "local.get", index: bufferLocal });
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
  // If the array literal has fewer elements than the tuple expects,
  // push default values (0 for f64/i32, ref.null for ref types) for
  // the missing fields so struct.new gets the right number of arguments.
  for (let i = 0; i < elemTypes.length; i++) {
    const expectedType = elemTypes[i] ?? { kind: "externref" as const };
    if (i < expr.elements.length) {
      compileExpression(ctx, fctx, expr.elements[i]!, expectedType);
    } else {
      // Push a default value for the missing tuple element
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (expectedType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (expectedType.kind === "externref") {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (expectedType.kind === "ref" || expectedType.kind === "ref_null") {
        fctx.body.push({ op: "ref.null", typeIdx: (expectedType as { typeIdx: number }).typeIdx } as any);
      }
    }
  }

  fctx.body.push({ op: "struct.new", typeIdx: tupleIdx });
  return { kind: "ref", typeIdx: tupleIdx };
}

export function compileArrayLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
): ValType | null {
  // Check if the target type is a tuple — compile as struct.new instead of array
  const ctxTupleType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
  if (ctxTupleType && isTupleType(ctxTupleType)) {
    return compileTupleLiteral(ctx, fctx, expr, ctxTupleType);
  }

  if (expr.elements.length === 0) {
    // Empty array — try to determine element type from contextual type (e.g. number[])
    let emptyElemKind = "externref";
    const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
    if (ctxType) {
      const sym = (ctxType as ts.TypeReference).symbol ?? ctxType.symbol;
      if (sym?.name === "Array") {
        const typeArgs = ctx.checker.getTypeArguments(ctxType as ts.TypeReference);
        if (typeArgs[0]) {
          const elemWasmType = resolveWasmType(ctx, typeArgs[0]);
          emptyElemKind = (elemWasmType.kind === "ref" || elemWasmType.kind === "ref_null")
            ? `ref_${(elemWasmType as { typeIdx: number }).typeIdx}`
            : elemWasmType.kind;
        }
      }
    }
    const vecTypeIdx = getOrRegisterVecType(ctx, emptyElemKind);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      ctx.errors.push({ message: "Empty array literal: invalid vec type", line: getLine(expr), column: getCol(expr) });
      return null;
    }
    fctx.body.push({ op: "i32.const", value: 0 });           // length field (field 0)
    fctx.body.push({ op: "i32.const", value: 0 });           // size for array.new_default
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx }); // data field (field 1)
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx }); // wrap in vec struct
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Check if any element is a spread
  const hasSpread = expr.elements.some((el) => ts.isSpreadElement(el));

  // Determine element type from first non-omitted, non-spread element, or from spread source
  let elemWasm: ValType;
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
  }
  elemKind = (elemWasm.kind === "ref" || elemWasm.kind === "ref_null")
    ? `ref_${elemWasm.typeIdx}` : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    ctx.errors.push({ message: "Array literal: invalid vec type", line: getLine(expr), column: getCol(expr) });
    return null;
  }

  if (!hasSpread) {
    // No spread — use the fast array.new_fixed path, then wrap in vec struct
    for (const el of expr.elements) {
      compileExpression(ctx, fctx, el, elemWasm);
    }
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: expr.elements.length });
    // Store data array in temp local, then build vec struct
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: expr.elements.length }); // length field (field 0)
    fctx.body.push({ op: "local.get", index: tmpData });               // data field (field 1)
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });          // wrap in vec struct
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
        if (srcType && srcType !== VOID_RESULT) {
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
  fctx.body.push({ op: "local.get", index: writeIdx });    // length field (field 0)
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
  let exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);

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

  const elemKind = (elemWasm.kind === "ref" || elemWasm.kind === "ref_null")
    ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}` : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    ctx.errors.push({ message: "Array(): invalid vec type", line: getLine(expr), column: getCol(expr) });
    return null;
  }

  if (args.length === 0) {
    // Array() → empty array
    fctx.body.push({ op: "i32.const", value: 0 });           // length = 0
    fctx.body.push({ op: "i32.const", value: 0 });           // size for array.new_default
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
