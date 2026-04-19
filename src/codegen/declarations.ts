// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Declaration collection and compilation — unified AST visitor, class declarations,
 * function bodies, and struct type registration.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import ts from "typescript";
import {
  isBigIntType,
  isBooleanType,
  isHeterogeneousUnion,
  isNumberType,
  isStringType,
  isVoidType,
  mapTsTypeToWasm,
  unwrapPromiseType,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType, WasmFunction } from "../ir/types.js";
import { collectShapes } from "../shape-inference.js";
import { ensureWrapperTypes } from "./any-helpers.js";
import { collectClassDeclaration, compileClassBodies } from "./class-bodies.js";
import { reportError } from "./context/errors.js";
import type { CodegenContext, FunctionContext, OptionalParamInfo } from "./context/types.js";
import { bodyUsesArguments, compileFunctionBody, registerInlinableFunction } from "./function-body.js";
import {
  addArrayIteratorImports,
  addForInImports,
  addIteratorImports,
  addStringImports,
  addUnionImports,
  collectEnumDeclarations,
  ensureStructForType,
  extractConstantDefault,
  FUNCTIONAL_ARRAY_METHODS,
  hasAsyncModifier,
  hasDeclareModifier,
  hasExportModifier,
  isGeneratorFunction,
  KNOWN_CONSTRUCTORS,
  MATH_HOST_METHODS_1ARG,
  MATH_HOST_METHODS_2ARG,
  parseRegExpLiteral,
  resolveWasmType,
  STRING_METHODS,
  unwrapGeneratorYieldType,
} from "./index.js";
import { ensureNativeStringExternBridge, ensureNativeStringHelpers } from "./native-strings.js";
import { addImport, addStringConstantGlobal, localGlobalIdx, nextModuleGlobalIdx } from "./registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
import { compileExpression, compileStatement } from "./shared.js";

/** Accumulated state for the single-pass collector */
interface UnifiedCollectorState {
  // -- collectConsoleImports --
  consoleNeededByMethod: Map<string, Set<"number" | "bool" | "string" | "externref">>;
  // -- collectPrimitiveMethodImports --
  primitiveNeeded: Set<string>;
  // -- collectStringLiterals --
  stringLiterals: Set<string>;
  hasTypeofExprForStrings: boolean;
  hasTaggedTemplate: boolean;
  insideComputedPropertyName: number; // depth counter
  // -- collectStringMethodImports --
  stringMethodNeeded: Set<string>;
  /** String methods called with RegExp args — need host import even in native strings mode */
  stringRegexpMethodNeeded: Set<string>;
  // -- collectMathImports --
  mathNeeded: Set<string>;
  mathNeedsToUint32: boolean;
  // -- collectParseImports --
  parseNeeded: Set<string>;
  // -- collectURIImports --
  uriNeeded: Set<string>;
  // -- collectStringStaticImports --
  needsFromCharCode: boolean;
  needsFromCodePoint: boolean;
  // -- collectPromiseImports --
  promiseNeeded: Set<string>;
  promiseNeedConstructor: boolean;
  promiseNeedThen2: boolean;
  // -- collectJsonImports --
  jsonNeedStringify: boolean;
  jsonNeedParse: boolean;
  // -- collectCallbackImports --
  callbackFound: boolean;
  getterCallbackFound: boolean; // Object.defineProperty accessor descriptors (#929)
  // -- collectFunctionalArrayImports --
  funcArrayNeed1: boolean;
  funcArrayNeed2: boolean;
  // -- collectUnionImports --
  unionFound: boolean;
  // -- collectGeneratorImports --
  generatorFound: boolean;
  // -- collectIteratorImports --
  iteratorFound: boolean;
  // -- collectArrayIteratorImports --
  arrayIteratorFound: boolean;
  // -- collectForInStringLiterals --
  forInFound: boolean;
  forInLiterals: Set<string>;
  // -- collectInExprStringLiterals --
  inExprLiterals: Set<string>;
  // -- collectObjectMethodStringLiterals --
  objectMethodLiterals: Set<string>;
  objectMethodHasValues: boolean;
  // -- collectWrapperConstructors --
  wrapperFound: boolean;
  // -- collectUnknownConstructorImports --
  unknownCtorNeeded: Map<string, number>;
  // context
  sourceFile: ts.SourceFile;
}

const CONSOLE_METHODS_SET = new Set(["log", "warn", "error", "info", "debug"]);

export function createUnifiedCollectorState(sourceFile: ts.SourceFile): UnifiedCollectorState {
  return {
    consoleNeededByMethod: new Map(),
    primitiveNeeded: new Set(),
    stringLiterals: new Set(),
    hasTypeofExprForStrings: false,
    hasTaggedTemplate: false,
    insideComputedPropertyName: 0,
    stringMethodNeeded: new Set(),
    stringRegexpMethodNeeded: new Set(),
    mathNeeded: new Set(),
    mathNeedsToUint32: false,
    parseNeeded: new Set(),
    uriNeeded: new Set(),
    needsFromCharCode: false,
    needsFromCodePoint: false,
    promiseNeeded: new Set(),
    promiseNeedConstructor: false,
    promiseNeedThen2: false,
    jsonNeedStringify: false,
    jsonNeedParse: false,
    callbackFound: false,
    getterCallbackFound: false,
    funcArrayNeed1: false,
    funcArrayNeed2: false,
    unionFound: false,
    generatorFound: false,
    iteratorFound: false,
    arrayIteratorFound: false,
    forInFound: false,
    forInLiterals: new Set(),
    inExprLiterals: new Set(),
    objectMethodLiterals: new Set(),
    objectMethodHasValues: false,
    wrapperFound: false,
    unknownCtorNeeded: new Map(),
    sourceFile,
  };
}

/** Single-pass visitor called on every AST node */
export function unifiedVisitNode(ctx: CodegenContext, state: UnifiedCollectorState, node: ts.Node): void {
  // ── collectStringLiterals (skip computed property names) ──
  if (state.insideComputedPropertyName === 0) {
    if (ts.isStringLiteral(node)) {
      state.stringLiterals.add(node.text);
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      state.stringLiterals.add(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      state.stringLiterals.add(node.head.text); // include empty strings
      for (const span of node.templateSpans) {
        state.stringLiterals.add(span.literal.text); // include empty strings
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      state.hasTaggedTemplate = true;
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        state.stringLiterals.add(node.template.text);
        const rawText = (node.template as any).rawText;
        if (rawText !== undefined) state.stringLiterals.add(rawText);
      } else if (ts.isTemplateExpression(node.template)) {
        state.stringLiterals.add(node.template.head.text);
        const headRaw = (node.template.head as any).rawText;
        if (headRaw !== undefined) state.stringLiterals.add(headRaw);
        for (const span of node.template.templateSpans) {
          state.stringLiterals.add(span.literal.text);
          const spanRaw = (span.literal as any).rawText;
          if (spanRaw !== undefined) state.stringLiterals.add(spanRaw);
        }
      }
    }
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const { pattern, flags } = parseRegExpLiteral(node.getText());
      state.stringLiterals.add(pattern);
      if (flags) state.stringLiterals.add(flags);
    }
    if (ts.isTypeOfExpression(node)) {
      state.hasTypeofExprForStrings = true;
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta") {
      state.stringLiterals.add("module.wasm");
      state.stringLiterals.add("[object Object]");
    }
  }

  // ── collectConsoleImports ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console"
  ) {
    const method = node.expression.name.text;
    if (CONSOLE_METHODS_SET.has(method)) {
      if (!state.consoleNeededByMethod.has(method)) state.consoleNeededByMethod.set(method, new Set());
      const needed = state.consoleNeededByMethod.get(method)!;
      for (const arg of node.arguments) {
        const argType = ctx.checker.getTypeAtLocation(arg);
        if (isStringType(argType)) {
          needed.add("string");
        } else if (isBooleanType(argType)) {
          needed.add("bool");
        } else if (isNumberType(argType)) {
          needed.add("number");
        } else {
          needed.add("externref");
        }
      }
    }
  }

  // ── collectPrimitiveMethodImports ──
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const prop = node.expression;
    const receiverType = ctx.checker.getTypeAtLocation(prop.expression);
    const methodName = prop.name.text;
    if (isNumberType(receiverType) && methodName === "toString") {
      state.primitiveNeeded.add("number_toString");
    }
    if (isNumberType(receiverType) && methodName === "toFixed") {
      state.primitiveNeeded.add("number_toFixed");
    }
    if (isNumberType(receiverType) && methodName === "toPrecision") {
      state.primitiveNeeded.add("number_toPrecision");
    }
    if (isNumberType(receiverType) && methodName === "toExponential") {
      state.primitiveNeeded.add("number_toExponential");
    }
    // ── collectStringMethodImports (also uses call+propertyAccess) ──
    if (isStringType(receiverType) && Object.prototype.hasOwnProperty.call(STRING_METHODS, methodName)) {
      state.stringMethodNeeded.add(methodName);
      // Track if the method is called with a RegExp arg (replace, replaceAll, split, match, search)
      if (
        (methodName === "replace" ||
          methodName === "replaceAll" ||
          methodName === "split" ||
          methodName === "match" ||
          methodName === "search") &&
        ts.isCallExpression(node) &&
        node.arguments.length > 0
      ) {
        const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
        const symName = argType.getSymbol()?.getName();
        if (symName === "RegExp") {
          state.stringRegexpMethodNeeded.add(methodName);
        }
      }
    }
  }
  // Template expressions with number/boolean/bigint substitutions need number_toString
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const spanType = ctx.checker.getTypeAtLocation(span.expression);
      if (isNumberType(spanType) || isBooleanType(spanType) || isBigIntType(spanType)) {
        state.primitiveNeeded.add("number_toString");
      }
    }
  }
  // String(expr) calls need number_toString
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "String" &&
    node.arguments.length >= 1
  ) {
    const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
    if (isNumberType(argType) || !isStringType(argType)) {
      state.primitiveNeeded.add("number_toString");
    }
  }
  // String + non-string concatenation
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.PlusToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
  ) {
    const leftType = ctx.checker.getTypeAtLocation(node.left);
    const rightType = ctx.checker.getTypeAtLocation(node.right);
    if (isStringType(leftType) && !isStringType(rightType)) {
      state.primitiveNeeded.add("number_toString");
    }
    if (!isStringType(leftType) && isStringType(rightType)) {
      state.primitiveNeeded.add("number_toString");
    }
    if (
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      (leftType.flags & ts.TypeFlags.Any) !== 0 &&
      !isStringType(rightType)
    ) {
      state.primitiveNeeded.add("number_toString");
    }
  }
  // String comparison operators
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
      node.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken)
  ) {
    const leftType = ctx.checker.getTypeAtLocation(node.left);
    if (isStringType(leftType)) {
      state.primitiveNeeded.add("string_compare");
    }
  }

  // ── collectMathImports ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Math"
  ) {
    const method = node.expression.name.text;
    if (MATH_HOST_METHODS_1ARG.has(method) || MATH_HOST_METHODS_2ARG.has(method) || method === "random") {
      state.mathNeeded.add(method);
    }
    if (method === "clz32" || method === "imul") {
      state.mathNeedsToUint32 = true;
    }
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
      node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
  ) {
    state.mathNeeded.add("pow");
  }

  // ── collectParseImports ──
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    let name = node.expression.text;
    // Resolve aliases like `var freeParseInt = parseInt; freeParseInt(...)` (#1109)
    if (name !== "parseInt" && name !== "parseFloat") {
      const sym = ctx.checker.getSymbolAtLocation(node.expression);
      const decl = sym?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.initializer)) {
        const initName = decl.initializer.text;
        if (initName === "parseInt" || initName === "parseFloat") {
          name = initName;
        }
      }
    }
    if (name === "parseInt" || name === "parseFloat") {
      state.parseNeeded.add(name);
    }
    if (
      name === "decodeURI" ||
      name === "decodeURIComponent" ||
      name === "encodeURI" ||
      name === "encodeURIComponent"
    ) {
      state.uriNeeded.add(name);
    }
    if (name === "Number") {
      state.parseNeeded.add("parseFloat");
    }
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.PlusToken &&
    !ts.isStringLiteral(node.operand) &&
    !ts.isNoSubstitutionTemplateLiteral(node.operand)
  ) {
    const operandType = ctx.checker.getTypeAtLocation(node.operand);
    if (operandType.flags & ts.TypeFlags.StringLike) {
      state.parseNeeded.add("parseFloat");
    }
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
  ) {
    try {
      const leftType = ctx.checker.getTypeAtLocation(node.left);
      const rightType = ctx.checker.getTypeAtLocation(node.right);
      const leftIsStr = isStringType(leftType);
      const rightIsStr = isStringType(rightType);
      const leftIsNumOrBool = isNumberType(leftType) || isBooleanType(leftType);
      const rightIsNumOrBool = isNumberType(rightType) || isBooleanType(rightType);
      if ((leftIsStr && rightIsNumOrBool) || (rightIsStr && leftIsNumOrBool)) {
        state.parseNeeded.add("parseFloat");
      }
    } catch {
      // Type resolution may fail for some nodes
    }
  }
  if (ts.isBinaryExpression(node)) {
    const opKind = node.operatorToken.kind;
    const isArithOrBitwise =
      opKind === ts.SyntaxKind.MinusToken ||
      opKind === ts.SyntaxKind.AsteriskToken ||
      opKind === ts.SyntaxKind.AsteriskAsteriskToken ||
      opKind === ts.SyntaxKind.SlashToken ||
      opKind === ts.SyntaxKind.PercentToken ||
      opKind === ts.SyntaxKind.AmpersandToken ||
      opKind === ts.SyntaxKind.BarToken ||
      opKind === ts.SyntaxKind.CaretToken ||
      opKind === ts.SyntaxKind.LessThanLessThanToken ||
      opKind === ts.SyntaxKind.GreaterThanGreaterThanToken ||
      opKind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
    if (isArithOrBitwise) {
      try {
        const leftType = ctx.checker.getTypeAtLocation(node.left);
        const rightType = ctx.checker.getTypeAtLocation(node.right);
        if (isStringType(leftType) || isStringType(rightType)) {
          state.parseNeeded.add("parseFloat");
        }
      } catch {
        // Type resolution may fail
      }
    }
  }

  // ── collectStringStaticImports (String.fromCharCode / String.fromCodePoint) ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "String"
  ) {
    if (node.expression.name.text === "fromCharCode") state.needsFromCharCode = true;
    if (node.expression.name.text === "fromCodePoint") state.needsFromCodePoint = true;
  }

  // ── collectPromiseImports ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Promise"
  ) {
    const method = node.expression.name.text;
    if (
      method === "all" ||
      method === "race" ||
      method === "resolve" ||
      method === "reject" ||
      method === "allSettled" ||
      method === "any"
    ) {
      state.promiseNeeded.add(method);
    }
  }
  // NOTE: Promise instance methods (.then/.catch/.finally) are NOT detected here.
  // Pre-registering them adds func types that shift struct type indices, breaking
  // non-Promise code in the same module. They're handled at codegen time instead.
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise") {
    state.promiseNeedConstructor = true;
  }

  // ── collectJsonImports ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON"
  ) {
    const method = node.expression.name.text;
    if (method === "stringify") state.jsonNeedStringify = true;
    if (method === "parse") state.jsonNeedParse = true;
  }

  // ── collectCallbackImports ──
  if (!state.callbackFound) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      state.callbackFound = true;
    }
  }
  // ── getterCallbackFound: Object.defineProperty / Reflect.defineProperty with accessor descriptor (#929) ──
  // Also covers Object.defineProperties(obj, { p1: desc1, p2: desc2, ... }) (#1027)
  if (!state.getterCallbackFound && ts.isCallExpression(node)) {
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect")
    ) {
      const methodName = node.expression.name.text;
      if (methodName === "defineProperty" && node.arguments.length >= 3) {
        if (isAccessorDescriptor(node.arguments[2]!)) {
          state.getterCallbackFound = true;
        }
      } else if (methodName === "defineProperties" && node.arguments.length >= 2) {
        const propsArg = node.arguments[1]!;
        if (ts.isObjectLiteralExpression(propsArg)) {
          for (const prop of propsArg.properties) {
            if (ts.isPropertyAssignment(prop) && isAccessorDescriptor(prop.initializer)) {
              state.getterCallbackFound = true;
              break;
            }
          }
        }
      }
    }
  }

  // ── collectFunctionalArrayImports ──
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (FUNCTIONAL_ARRAY_METHODS.has(method)) {
      if (method === "reduce") {
        state.funcArrayNeed2 = true;
      } else {
        state.funcArrayNeed1 = true;
      }
    }
    if (method === "call" && ts.isPropertyAccessExpression(node.expression.expression)) {
      const innerMethod = node.expression.expression.name.text;
      if (FUNCTIONAL_ARRAY_METHODS.has(innerMethod)) {
        if (innerMethod === "reduce") {
          state.funcArrayNeed2 = true;
        } else {
          state.funcArrayNeed1 = true;
        }
      }
    }
  }

  // ── collectUnionImports ──
  if (!state.unionFound) {
    if (ts.isFunctionDeclaration(node) && node.parameters) {
      for (const param of node.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        if (isHeterogeneousUnion(paramType, ctx.checker)) {
          state.unionFound = true;
          break;
        }
      }
    }
    if (!state.unionFound && ts.isVariableDeclaration(node) && node.type) {
      const varType = ctx.checker.getTypeAtLocation(node);
      if (isHeterogeneousUnion(varType, ctx.checker)) {
        state.unionFound = true;
      }
    }
    if (!state.unionFound && ts.isTypeOfExpression(node)) {
      state.unionFound = true;
    }
    if (
      !state.unionFound &&
      ts.isFunctionDeclaration(node) &&
      node.asteriskToken &&
      node.body &&
      !hasDeclareModifier(node)
    ) {
      state.unionFound = true;
    }
    if (!state.unionFound && ts.isFunctionExpression(node) && node.asteriskToken) {
      state.unionFound = true;
    }
    if (!state.unionFound && ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      state.unionFound = true;
    }
    if (!state.unionFound && ts.isForOfStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      const sym = (exprType as ts.TypeReference).symbol ?? (exprType as ts.Type).symbol;
      if (sym?.name !== "Array") {
        state.unionFound = true;
      }
    }
  }

  // ── collectGeneratorImports ──
  if (!state.generatorFound) {
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.body && !hasDeclareModifier(node)) {
      state.generatorFound = true;
    }
    if (!state.generatorFound && ts.isFunctionExpression(node) && node.asteriskToken) {
      state.generatorFound = true;
    }
    if (!state.generatorFound && ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      state.generatorFound = true;
    }
  }

  // ── collectArrayIteratorImports ──
  if (!state.arrayIteratorFound && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const methodName = node.expression.name.text;
    if (methodName === "entries" || methodName === "keys" || methodName === "values") {
      const recvType = ctx.checker.getTypeAtLocation(node.expression.expression);
      const sym = (recvType as ts.TypeReference).symbol ?? (recvType as ts.Type).symbol;
      if (sym?.name === "Array") {
        state.arrayIteratorFound = true;
      }
    }
  }

  // ── collectIteratorImports ──
  if (!state.iteratorFound && ts.isForOfStatement(node)) {
    const exprType = ctx.checker.getTypeAtLocation(node.expression);
    const sym = (exprType as ts.TypeReference).symbol ?? (exprType as ts.Type).symbol;
    if (sym?.name !== "Array") {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(exprType)) {
        // In fast mode, strings are iterated natively
      } else {
        state.iteratorFound = true;
      }
    }
  }

  // ── collectForInStringLiterals ──
  if (ts.isForInStatement(node)) {
    state.forInFound = true;
    const exprType = ctx.checker.getTypeAtLocation(node.expression);
    const props = exprType.getProperties();
    for (const prop of props) {
      if (!ctx.stringGlobalMap.has(prop.name)) state.forInLiterals.add(prop.name);
    }
  }

  // ── collectInExprStringLiterals ──
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
    if (!ts.isStringLiteral(node.left) && !ts.isNumericLiteral(node.left)) {
      const rightType = ctx.checker.getTypeAtLocation(node.right);
      const props = rightType.getProperties();
      for (const prop of props) {
        if (!ctx.stringGlobalMap.has(prop.name)) state.inExprLiterals.add(prop.name);
      }
    }
  }

  // ── collectObjectMethodStringLiterals ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Object" &&
    (node.expression.name.text === "keys" ||
      node.expression.name.text === "values" ||
      node.expression.name.text === "entries") &&
    node.arguments.length === 1
  ) {
    if (node.expression.name.text === "values" || node.expression.name.text === "entries")
      state.objectMethodHasValues = true;
    const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
    const props = argType.getProperties();
    for (const prop of props) {
      if (!ctx.stringLiteralMap.has(prop.name)) state.objectMethodLiterals.add(prop.name);
    }
  }

  // ── collectWrapperConstructors ──
  if (!state.wrapperFound && ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    if (name === "Number" || name === "String" || name === "Boolean") {
      state.wrapperFound = true;
    }
  }

  // ── collectUnknownConstructorImports ──
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    if (!KNOWN_CONSTRUCTORS.has(name)) {
      const sym = ctx.checker.getSymbolAtLocation(node.expression);
      const decls = sym?.getDeclarations() ?? [];
      const isLocalClass = decls.some((d) => {
        if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) return d.getSourceFile() === state.sourceFile;
        if (ts.isVariableDeclaration(d) && d.initializer && ts.isClassExpression(d.initializer))
          return d.getSourceFile() === state.sourceFile;
        return false;
      });
      const isExtern = ctx.externClasses.has(name);
      if (!isLocalClass && !isExtern) {
        const argCount = node.arguments?.length ?? 0;
        const prev = state.unknownCtorNeeded.get(name) ?? 0;
        state.unknownCtorNeeded.set(name, Math.max(prev, argCount));
      }
    }
  }

  // ── collectFunctionClassNames: pre-register .name values as string literals ──
  // Function declarations: function foo() {} → name = "foo"
  if (ts.isFunctionDeclaration(node) && node.name) {
    state.stringLiterals.add(node.name.text);
  }
  // Named function expressions: const x = function foo() {} → name = "foo"
  if (ts.isFunctionExpression(node) && node.name) {
    state.stringLiterals.add(node.name.text);
  }
  // Class declarations: class Foo {} → name = "Foo"
  if (ts.isClassDeclaration(node) && node.name) {
    state.stringLiterals.add(node.name.text);
  }
  // Named class expressions: const x = class Foo {} → name = "Foo"
  if (ts.isClassExpression(node) && node.name) {
    state.stringLiterals.add(node.name.text);
  }
  // Variable declarations with anonymous function/class initializers:
  // const foo = function() {} → name = "foo"
  // const Bar = class {} → name = "Bar"
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    if (ts.isFunctionExpression(node.initializer) && !node.initializer.name) {
      state.stringLiterals.add(node.name.text);
    }
    if (ts.isArrowFunction(node.initializer)) {
      state.stringLiterals.add(node.name.text);
    }
    if (ts.isClassExpression(node.initializer) && !node.initializer.name) {
      state.stringLiterals.add(node.name.text);
    }
  }
  // Method declarations: { method() {} } → name = "method"
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    state.stringLiterals.add(node.name.text);
  }
  // Getter/setter declarations
  if (ts.isGetAccessorDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    state.stringLiterals.add(`get ${node.name.text}`);
  }
  if (ts.isSetAccessorDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    state.stringLiterals.add(`set ${node.name.text}`);
  }

  // ── Recurse into children ──
  // Track computed property name depth for string literal collection
  if (ts.isComputedPropertyName(node)) {
    state.insideComputedPropertyName++;
    ts.forEachChild(node, (child) => unifiedVisitNode(ctx, state, child));
    state.insideComputedPropertyName--;
    return; // already recursed
  }
  ts.forEachChild(node, (child) => unifiedVisitNode(ctx, state, child));
}

/** Run all post-walk finalization (register imports based on collected state) */
export function finalizeUnifiedCollector(ctx: CodegenContext, state: UnifiedCollectorState): void {
  // ── collectConsoleImports finalize ──
  // In WASI mode, console.log/error use fd_write — skip JS host console imports
  if (!ctx.wasi) {
    const CONSOLE_METHODS = ["log", "warn", "error", "info", "debug"] as const;
    for (const method of CONSOLE_METHODS) {
      const needed = state.consoleNeededByMethod.get(method);
      if (!needed) continue;
      if (needed.has("number")) {
        const t = addFuncType(ctx, [{ kind: "f64" }], []);
        addImport(ctx, "env", `console_${method}_number`, { kind: "func", typeIdx: t });
      }
      if (needed.has("bool")) {
        const t = addFuncType(ctx, [{ kind: "i32" }], []);
        addImport(ctx, "env", `console_${method}_bool`, { kind: "func", typeIdx: t });
      }
      if (needed.has("string")) {
        const t = addFuncType(ctx, [{ kind: "externref" }], []);
        addImport(ctx, "env", `console_${method}_string`, { kind: "func", typeIdx: t });
      }
      if (needed.has("externref")) {
        const t = addFuncType(ctx, [{ kind: "externref" }], []);
        addImport(ctx, "env", `console_${method}_externref`, { kind: "func", typeIdx: t });
      }
    }
  }

  // ── collectPrimitiveMethodImports finalize ──
  if (state.primitiveNeeded.has("number_toString")) {
    const t = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toString", { kind: "func", typeIdx: t });
  }
  if (state.primitiveNeeded.has("number_toFixed")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toFixed", { kind: "func", typeIdx: t });
  }
  if (state.primitiveNeeded.has("number_toPrecision")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toPrecision", { kind: "func", typeIdx: t });
  }
  if (state.primitiveNeeded.has("number_toExponential")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toExponential", { kind: "func", typeIdx: t });
  }
  if (state.primitiveNeeded.has("string_compare") && !ctx.nativeStrings) {
    // In native strings mode, __str_compare Wasm helper handles this — no host import needed
    const t = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "string_compare", { kind: "func", typeIdx: t });
  }

  // ── collectStringLiterals finalize ──
  // Register the empty string if any other strings are in the pool — it's used
  // implicitly by template expressions, default values, and many string operations (#668).
  // Don't add it unconditionally as that forces string_constants import on all modules.
  if (state.stringLiterals.size > 0) {
    state.stringLiterals.add("");
  }

  if (state.hasTypeofExprForStrings) {
    for (const s of ["number", "string", "boolean", "object", "undefined", "function", "symbol"]) {
      state.stringLiterals.add(s);
    }
  }
  if (state.hasTaggedTemplate) {
    getOrRegisterTemplateVecType(ctx);
  }
  if (state.stringLiterals.size > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of state.stringLiterals) {
        if (!ctx.stringGlobalMap.has(value)) {
          ctx.stringGlobalMap.set(value, -1);
        }
      }
    } else {
      addStringImports(ctx);
      for (const value of state.stringLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }

  // ── collectStringMethodImports finalize ──
  {
    const NATIVE_STR_METHODS = new Set([
      "charAt",
      "substring",
      "slice",
      "at",
      "indexOf",
      "lastIndexOf",
      "includes",
      "startsWith",
      "endsWith",
      "trim",
      "trimStart",
      "trimEnd",
      "repeat",
      "padStart",
      "padEnd",
      "toLowerCase",
      "toUpperCase",
      "replace",
      "replaceAll",
      "split",
    ]);
    for (const method of state.stringMethodNeeded) {
      if (ctx.nativeStrings && NATIVE_STR_METHODS.has(method) && !state.stringRegexpMethodNeeded.has(method)) {
        ensureNativeStringHelpers(ctx);
        continue;
      }
      if (ctx.nativeStrings && NATIVE_STR_METHODS.has(method) && state.stringRegexpMethodNeeded.has(method)) {
        // Need BOTH native helpers AND host import for RegExp-arg calls
        ensureNativeStringHelpers(ctx);
      }
      const sig = STRING_METHODS[method]!;
      const params: ValType[] = [{ kind: "externref" }, ...sig.params];
      const t = addFuncType(ctx, params, [sig.result]);
      addImport(ctx, "env", `string_${method}`, { kind: "func", typeIdx: t });
    }
    if ((state.stringMethodNeeded.has("split") || state.stringMethodNeeded.has("match")) && !ctx.nativeStrings) {
      if (!ctx.funcMap.has("__extern_get")) {
        const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
        addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
      }
      if (!ctx.funcMap.has("__extern_length")) {
        const lenType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
        addImport(ctx, "env", "__extern_length", { kind: "func", typeIdx: lenType });
      }
    }
  }

  // ── collectMathImports finalize ──
  for (const method of state.mathNeeded) {
    if (method === "random") {
      const typeIdx = addFuncType(ctx, [], [{ kind: "f64" }]);
      addImport(ctx, "env", `Math_${method}`, { kind: "func", typeIdx });
    } else {
      ctx.pendingMathMethods.add(method);
    }
  }
  // ToUint32: defer emission until after all imports are registered (#1094).
  // Registering as a defined function here would leave a stale funcMap index
  // since subsequent imports added via addImport (e.g. __register_prototype)
  // do not shift defined-function indices. emitToUint32Helper() runs later.
  if (state.mathNeedsToUint32) {
    ctx.needsToUint32 = true;
  }

  // ── collectParseImports finalize ──
  for (const name of state.parseNeeded) {
    // Skip if already registered (e.g. by collectExternDeclarations from lib.d.ts) (#1109)
    if (ctx.funcMap.has(name)) continue;
    if (name === "parseInt") {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", name, { kind: "func", typeIdx });
    } else {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
      addImport(ctx, "env", name, { kind: "func", typeIdx });
    }
  }

  // ── collectURIImports finalize ──
  for (const name of state.uriNeeded) {
    if (ctx.funcMap.has(name)) continue;
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", name, { kind: "func", typeIdx });
  }

  // ── collectStringStaticImports finalize ──
  if (state.needsFromCharCode) {
    const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "String_fromCharCode", { kind: "func", typeIdx });
    if (ctx.nativeStrings) {
      ensureNativeStringExternBridge(ctx);
    }
  }
  if (state.needsFromCodePoint) {
    if (ctx.nativeStrings) {
      // Native strings mode: use pure-Wasm helper, no host import needed
      ensureNativeStringHelpers(ctx);
    } else {
      const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "String_fromCodePoint", { kind: "func", typeIdx });
    }
  }

  // ── collectPromiseImports finalize ──
  // Only register STATIC Promise methods (e.g., Promise.resolve, Promise.all).
  // Instance methods (.then/.catch/.finally) are NOT pre-registered because
  // adding their func types here shifts struct type indices, breaking
  // non-Promise code in the same module (#855 regression fix).
  for (const method of state.promiseNeeded) {
    if (method === "then" || method === "catch" || method === "finally") continue;
    const importName = `Promise_${method}`;
    if (!ctx.funcMap.has(importName)) {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
    }
  }
  if (state.promiseNeedConstructor && !ctx.funcMap.has("Promise_new")) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "Promise_new", { kind: "func", typeIdx });
  }

  // ── collectJsonImports finalize ──
  if (state.jsonNeedStringify || state.jsonNeedParse) {
    addUnionImports(ctx);
  }
  if (state.jsonNeedStringify) {
    // (value: externref, replacer: externref, space: externref) -> externref
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx });
  }
  if (state.jsonNeedParse) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "JSON_parse", { kind: "func", typeIdx });
  }

  // ── collectCallbackImports finalize ──
  if (state.callbackFound || state.getterCallbackFound) {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "externref" }], [{ kind: "externref" }]);
    if (state.callbackFound) {
      addImport(ctx, "env", "__make_callback", { kind: "func", typeIdx });
    }
    if (state.getterCallbackFound) {
      // __make_getter_callback: same signature — wraps a function so 'this' is bound (#929)
      // Used for Object.defineProperty accessor descriptors (getter/setter callbacks).
      addImport(ctx, "env", "__make_getter_callback", { kind: "func", typeIdx });
    }
  }

  // ── collectFunctionalArrayImports finalize ──
  if (state.funcArrayNeed1) {
    if (ctx.fast) {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }]);
      addImport(ctx, "env", "__call_1_i32", { kind: "func", typeIdx });
    } else {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__call_1_f64", { kind: "func", typeIdx });
    }
  }
  if (state.funcArrayNeed2) {
    if (ctx.fast) {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
      addImport(ctx, "env", "__call_2_i32", { kind: "func", typeIdx });
    } else {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__call_2_f64", { kind: "func", typeIdx });
    }
  }

  // ── collectUnionImports finalize ──
  if (state.unionFound) {
    addUnionImports(ctx);
  }

  // ── collectGeneratorImports finalize ──
  if (state.generatorFound && !ctx.funcMap.has("__gen_create_buffer")) {
    const bufType = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", "__gen_create_buffer", { kind: "func", typeIdx: bufType });

    const pushF64Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], []);
    addImport(ctx, "env", "__gen_push_f64", { kind: "func", typeIdx: pushF64Type });

    const pushI32Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], []);
    addImport(ctx, "env", "__gen_push_i32", { kind: "func", typeIdx: pushI32Type });

    const pushRefType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
    addImport(ctx, "env", "__gen_push_ref", { kind: "func", typeIdx: pushRefType });

    // __create_generator: (buf: externref, pendingThrow: externref) -> externref
    // Takes a buffer of yielded values and an optional pending exception,
    // returns a Generator-like object that defers the throw to the first next() call.
    const createGenType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__create_generator", { kind: "func", typeIdx: createGenType });
    // __create_async_generator: same Wasm signature as __create_generator, but .next()/.return()/.throw()
    // return Promise-wrapped results as required by the ES spec for async generators.
    addImport(ctx, "env", "__create_async_generator", { kind: "func", typeIdx: createGenType });
    const genType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__gen_next", { kind: "func", typeIdx: genType });

    const genReturnType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__gen_return", { kind: "func", typeIdx: genReturnType });
    addImport(ctx, "env", "__gen_throw", { kind: "func", typeIdx: genReturnType });

    addImport(ctx, "env", "__gen_result_value", { kind: "func", typeIdx: genType });

    const resultValF64Type = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
    addImport(ctx, "env", "__gen_result_value_f64", { kind: "func", typeIdx: resultValF64Type });

    const resultDoneType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "__gen_result_done", { kind: "func", typeIdx: resultDoneType });

    // Ensure __get_caught_exception is available for generator body try/catch wrappers
    if (!ctx.funcMap.has("__get_caught_exception")) {
      const getCaughtType = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", "__get_caught_exception", { kind: "func", typeIdx: getCaughtType });
    }
  }

  // ── collectIteratorImports finalize ──
  if (state.iteratorFound) {
    addIteratorImports(ctx);
  }

  // ── collectArrayIteratorImports finalize ──
  if (state.arrayIteratorFound) {
    addArrayIteratorImports(ctx);
    // Array iterator results are externref iterators consumed via for-of generic path
    if (!state.iteratorFound) {
      addIteratorImports(ctx);
    }
  }

  // ── collectForInStringLiterals finalize ──
  if (state.forInFound) {
    addForInImports(ctx);
  }
  if (state.forInLiterals.size > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of state.forInLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of state.forInLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }

  // ── collectInExprStringLiterals finalize ──
  if (state.inExprLiterals.size > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of state.inExprLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of state.inExprLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }

  // ── collectObjectMethodStringLiterals finalize ──
  if (state.objectMethodHasValues) {
    addUnionImports(ctx);
  }
  if (state.objectMethodLiterals.size > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of state.objectMethodLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of state.objectMethodLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }

  // ── collectWrapperConstructors finalize ──
  if (state.wrapperFound) {
    ensureWrapperTypes(ctx);
  }

  // ── collectUnknownConstructorImports finalize ──
  for (const [name, argCount] of state.unknownCtorNeeded) {
    const importName = `__new_${name}`;
    if (ctx.funcMap.has(importName)) continue;
    const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
    const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
  }
}

/**
 * Perform a single AST walk that collects all import-phase information.
 * Replaces 19 separate collect* passes with one O(n) traversal.
 * (#592)
 */

export function resolveGenericCallSiteTypes(
  ctx: CodegenContext,
  funcName: string,
  sourceFile: ts.SourceFile,
): { params: ValType[]; results: ValType[] } | null {
  let found: { params: ValType[]; results: ValType[] } | null = null;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === funcName) {
      const sig = ctx.checker.getResolvedSignature(node);
      if (sig) {
        const params: ValType[] = [];
        const sigParams = sig.getParameters();
        for (let i = 0; i < sigParams.length; i++) {
          const paramType = ctx.checker.getTypeOfSymbol(sigParams[i]!);
          params.push(resolveWasmType(ctx, paramType));
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        const results: ValType[] = isVoidType(retType) ? [] : [resolveWasmType(ctx, retType)];
        found = { params, results };
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Infer a concrete type for an untyped function parameter by scanning call sites.
 * When a parameter has no type annotation (TS gives it `any`), we look at every
 * call to that function and collect the argument types at the given index.
 * If all call sites agree on a single concrete wasm type, we return it.
 * Returns null if no call site found or types disagree.
 */
export function inferParamTypeFromCallSites(
  ctx: CodegenContext,
  funcName: string,
  paramIndex: number,
  sourceFile: ts.SourceFile,
): ValType | null {
  let agreed: ValType | null = null;
  let conflict = false;

  function visit(node: ts.Node) {
    if (conflict) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === funcName) {
      const arg = node.arguments[paramIndex];
      if (arg) {
        const argType = ctx.checker.getTypeAtLocation(arg);
        // Skip if the argument itself is also `any` — no useful info
        if (argType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
          // Don't count this call site — it doesn't help
        } else {
          const wasmType = resolveWasmType(ctx, argType);
          if (agreed === null) {
            agreed = wasmType;
          } else if (agreed.kind !== wasmType.kind) {
            conflict = true;
          } else if (
            (agreed.kind === "ref" || agreed.kind === "ref_null") &&
            (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
            (agreed as { typeIdx: number }).typeIdx !== (wasmType as { typeIdx: number }).typeIdx
          ) {
            conflict = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return conflict ? null : agreed;
}

/**
 * Pre-pass: detect empty object literals (`var obj = {}`) that later receive
 * property assignments (`obj.prop = val`) and record the extra properties so
 * that ensureStructForType creates a struct with the correct fields.
 *
 * This runs *before* collectDeclarations so the struct type is correct from
 * the start.
 */
export function collectEmptyObjectWidening(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  // Scan all statements (top-level and inside function bodies)
  function scanStatements(stmts: readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      // Look for var/let/const declarations with empty object literal initializer
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
          if (decl.initializer.properties.length > 0) continue;

          // Found `var X = {}` — now scan siblings for `X.prop = val`
          const varName = decl.name.text;
          const extraProps: { name: string; type: ValType }[] = [];
          const seenProps = new Set<string>();

          // Scan all following statements in the same block for property assignments
          collectPropsFromStatements(checker, ctx, stmts, varName, extraProps, seenProps);

          if (extraProps.length > 0) {
            ctx.widenedTypeProperties.set(varName, extraProps);

            // Register the struct type now so that collectDeclarations
            // can resolve the variable type to a struct ref instead of externref
            const fields: FieldDef[] = extraProps.map((wp) => ({
              name: wp.name,
              type: wp.type,
              mutable: true,
            }));
            const structName = `__anon_${ctx.anonTypeCounter++}`;
            const typeIdx = ctx.mod.types.length;
            ctx.mod.types.push({
              kind: "struct",
              name: structName,
              fields,
            } as StructTypeDef);
            ctx.structMap.set(structName, typeIdx);
            ctx.typeIdxToStructName.set(typeIdx, structName);
            ctx.structFields.set(structName, fields);
            // Map variable name to struct name for later lookup
            ctx.widenedVarStructMap.set(varName, structName);
            // Also try to map TS types (may not match later due to type identity)
            const varType = checker.getTypeAtLocation(decl.name);
            ctx.anonTypeMap.set(varType, structName);
            const initType = checker.getTypeAtLocation(decl.initializer);
            ctx.anonTypeMap.set(initType, structName);
          }
        }
      }
      // Recurse into function bodies
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        scanStatements(stmt.body.statements);
      }
      // Recurse into try/catch blocks (wrapTest wraps test bodies in try blocks)
      if (ts.isTryStatement(stmt)) {
        scanStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) {
          scanStatements(stmt.catchClause.block.statements);
        }
        if (stmt.finallyBlock) {
          scanStatements(stmt.finallyBlock.statements);
        }
      }
    }
  }

  scanStatements(sourceFile.statements);
}

/** Returns true if an Object.defineProperty descriptor ObjectLiteral is an accessor descriptor
 * with an ACTUAL function getter or setter that needs the sidecar/extern path.
 * Descriptors with `get: undefined` or `set: undefined` are NOT treated as accessor descriptors —
 * they are widened like data descriptors so the property appears in for-in and hasOwnProperty
 * (matching baseline behavior where all Object.defineProperty targets are widened). (#929) */
function isAccessorDescriptor(descArg: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(descArg)) return false;
  for (const prop of descArg.properties) {
    // Method shorthand: get() {...} or set(v) {...} — always a real accessor
    if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name)) {
      if (prop.name.text === "get" || prop.name.text === "set") return true;
    }
    // Property assignment: get: <expr> or set: <expr>
    // Only treat as accessor if the value is an actual function (not `undefined` or other non-callable)
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      if (prop.name.text === "get" || prop.name.text === "set") {
        const init = prop.initializer;
        if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return true;
        // Named identifier that is NOT `undefined` or `null` — may be a function variable
        if (ts.isIdentifier(init) && init.text !== "undefined" && init.text !== "null") return true;
      }
    }
  }
  return false;
}

export function collectPropsFromStatements(
  checker: ts.TypeChecker,
  ctx: CodegenContext,
  stmts: readonly ts.Statement[],
  varName: string,
  extraProps: { name: string; type: ValType }[],
  seenProps: Set<string>,
): void {
  for (const s of stmts) {
    // ExpressionStatement: obj.prop = value
    if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression)) {
      const bin = s.expression;
      if (
        bin.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(bin.left) &&
        ts.isIdentifier(bin.left.expression) &&
        bin.left.expression.text === varName
      ) {
        const propName = bin.left.name.text;
        if (!seenProps.has(propName)) {
          seenProps.add(propName);
          // Infer wasm type from the RHS
          const rhsType = checker.getTypeAtLocation(bin.right);
          const wasmType = resolveWasmType(ctx, rhsType);
          extraProps.push({ name: propName, type: wasmType });
        }
      }
    }
    // Object.defineProperty(obj, "prop", { value: v }) — treat as obj.prop = v for widening
    if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
      const call = s.expression;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Object" &&
        ts.isIdentifier(call.expression.name) &&
        call.expression.name.text === "defineProperty" &&
        call.arguments.length >= 3
      ) {
        const objArg = call.arguments[0]!;
        const propArg = call.arguments[1]!;
        const descArg = call.arguments[2]!;
        if (ts.isIdentifier(objArg) && objArg.text === varName && ts.isStringLiteral(propArg)) {
          const propName = propArg.text;
          if (!seenProps.has(propName)) {
            seenProps.add(propName);
            // Try to get value type from descriptor.value
            let wasmType: ValType = { kind: "externref" };
            if (ts.isObjectLiteralExpression(descArg)) {
              for (const prop of descArg.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") {
                  const rhsType = checker.getTypeAtLocation(prop.initializer);
                  wasmType = resolveWasmType(ctx, rhsType);
                  break;
                }
              }
            }
            extraProps.push({ name: propName, type: wasmType });
          }
        }
      }
    }
    // Also handle: const result = Object.defineProperty(obj, ...)
    if (ts.isVariableStatement(s)) {
      for (const decl of s.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const call = decl.initializer;
          if (
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isIdentifier(call.expression.expression) &&
            call.expression.expression.text === "Object" &&
            ts.isIdentifier(call.expression.name) &&
            call.expression.name.text === "defineProperty" &&
            call.arguments.length >= 3
          ) {
            const objArg = call.arguments[0]!;
            const propArg = call.arguments[1]!;
            const descArg = call.arguments[2]!;
            if (ts.isIdentifier(objArg) && objArg.text === varName && ts.isStringLiteral(propArg)) {
              const propName = propArg.text;
              if (!seenProps.has(propName)) {
                seenProps.add(propName);
                let wasmType: ValType = { kind: "externref" };
                if (ts.isObjectLiteralExpression(descArg)) {
                  for (const prop of descArg.properties) {
                    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") {
                      const rhsType = checker.getTypeAtLocation(prop.initializer);
                      wasmType = resolveWasmType(ctx, rhsType);
                      break;
                    }
                  }
                }
                extraProps.push({ name: propName, type: wasmType });
              }
            }
          }
        }
      }
    }
    // Recurse into compound statement bodies to find property assignments
    if (ts.isBlock(s)) {
      collectPropsFromStatements(checker, ctx, s.statements, varName, extraProps, seenProps);
    }
    if (ts.isIfStatement(s)) {
      if (ts.isBlock(s.thenStatement)) {
        collectPropsFromStatements(checker, ctx, s.thenStatement.statements, varName, extraProps, seenProps);
      }
      if (s.elseStatement && ts.isBlock(s.elseStatement)) {
        collectPropsFromStatements(checker, ctx, s.elseStatement.statements, varName, extraProps, seenProps);
      }
    }
    // Recurse into try/catch/finally blocks (wrapTest wraps test bodies in try blocks)
    if (ts.isTryStatement(s)) {
      collectPropsFromStatements(checker, ctx, s.tryBlock.statements, varName, extraProps, seenProps);
      if (s.catchClause) {
        collectPropsFromStatements(checker, ctx, s.catchClause.block.statements, varName, extraProps, seenProps);
      }
      if (s.finallyBlock) {
        collectPropsFromStatements(checker, ctx, s.finallyBlock.statements, varName, extraProps, seenProps);
      }
    }
    // Recurse into for/while/do-while/switch bodies
    if (
      ts.isForStatement(s) ||
      ts.isForInStatement(s) ||
      ts.isForOfStatement(s) ||
      ts.isWhileStatement(s) ||
      ts.isDoStatement(s)
    ) {
      if (ts.isBlock(s.statement)) {
        collectPropsFromStatements(checker, ctx, s.statement.statements, varName, extraProps, seenProps);
      }
    }
    if (ts.isSwitchStatement(s)) {
      for (const clause of s.caseBlock.clauses) {
        collectPropsFromStatements(checker, ctx, clause.statements, varName, extraProps, seenProps);
      }
    }
  }
}

/**
 * Apply shape inference: detect module-level variables used as array-like objects
 * and override their global types from externref/AnyValue to vec struct types.
 * Must be called after collectDeclarations (which registers module globals).
 */
export function applyShapeInference(ctx: CodegenContext, checker: ts.TypeChecker, sourceFile: ts.SourceFile): void {
  const shapes = collectShapes(checker, sourceFile);
  if (shapes.size === 0) return;

  for (const [varName, shape] of shapes) {
    const globalIdx = ctx.moduleGlobals.get(varName);
    if (globalIdx === undefined) continue;

    // Determine element type for the vec struct from the shape's numeric value type
    let elemType: ValType;
    let elemKey: string;
    if (shape.numericValueType === "number") {
      if (ctx.fast) {
        elemType = { kind: "i32" };
        elemKey = "i32";
      } else {
        elemType = { kind: "f64" };
        elemKey = "f64";
      }
    } else if (shape.numericValueType === "string") {
      elemType = { kind: "externref" };
      elemKey = "externref";
    } else {
      // Default to f64 for unknown numeric types
      if (ctx.fast) {
        elemType = { kind: "i32" };
        elemKey = "i32";
      } else {
        elemType = { kind: "f64" };
        elemKey = "f64";
      }
    }

    // Register or reuse the vec struct type
    const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

    // Override the module global's type to ref_null of the vec struct
    const localIdx = localGlobalIdx(ctx, globalIdx);
    const globalDef = ctx.mod.globals[localIdx];
    if (globalDef) {
      const newType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
      globalDef.type = newType;
      // Update initializer to ref.null of the vec type
      globalDef.init = [{ op: "ref.null", typeIdx: vecTypeIdx }];
    }

    // Record in shapeMap for use during compilation
    ctx.shapeMap.set(varName, { vecTypeIdx, arrTypeIdx, elemType });
  }
}

export function collectDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile, isEntryFile = true): void {
  function getAssignmentRootIdentifier(expr: ts.Expression): string | undefined {
    let current: ts.Expression = expr;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    }
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isTypeAssertionExpression(current)
      ) {
        current = current.expression;
      }
    }
    return ts.isIdentifier(current) ? current.text : undefined;
  }

  // First: collect enum declarations (so enum values are available)
  collectEnumDeclarations(ctx, sourceFile);

  // Second: collect interfaces and type aliases (so struct types are available)
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      collectInterface(ctx, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      const aliasType = ctx.checker.getTypeAtLocation(stmt);
      if (aliasType.flags & ts.TypeFlags.Object) {
        collectObjectType(ctx, stmt.name.text, aliasType);
      }
    }
  }

  // Resolve struct field types: now that all interfaces and type aliases are
  // registered, re-resolve any externref fields that should be ref $struct.
  // This fixes ordering issues (e.g. Outer references Inner, regardless of
  // declaration order) and ensures nested destructuring works correctly.
  resolveStructFieldTypes(ctx, sourceFile);

  // Collect class declarations (struct types + constructor/method functions)
  // Also collect class expressions in variable declarations: const C = class { ... }
  // Scan recursively into function bodies to find class expressions defined inside functions
  // Recursively scan an AST node for `new (class { ... })()` patterns
  // and pre-register the anonymous class so struct types are available during codegen
  function registerClassExpression(classExpr: ts.ClassExpression, nameHint?: string): void {
    if (ctx.anonClassExprNames.has(classExpr)) return;
    // Generate a synthetic name and pre-register the class
    // For named class expressions (class C { ... }), use the name to avoid
    // collisions; for anonymous ones, generate a counter-based name.
    const syntheticName = nameHint
      ? `__anonClass_${nameHint}_${ctx.anonTypeCounter++}`
      : classExpr.name
        ? `__anonClass_${classExpr.name.text}_${ctx.anonTypeCounter++}`
        : `__anonClass_${ctx.anonTypeCounter++}`;
    // Store a mapping from the AST node to the synthetic name so codegen can find it
    ctx.anonClassExprNames.set(classExpr, syntheticName);
    collectClassDeclaration(ctx, classExpr, syntheticName);
  }

  function collectAnonymousClassesInNewExpr(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      let inner: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
      }
      if (ts.isClassExpression(inner)) {
        registerClassExpression(inner);
      }
    }
    // Class expression in assignment RHS: x = class { ... }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      let rhs: ts.Expression = node.right;
      while (ts.isParenthesizedExpression(rhs)) {
        rhs = rhs.expression;
      }
      if (ts.isClassExpression(rhs)) {
        // Use the LHS identifier as the name hint if available
        const nameHint = ts.isIdentifier(node.left) ? node.left.text : undefined;
        registerClassExpression(rhs, nameHint);
        // Also map the LHS identifier to the synthetic name so `new C()` resolves
        if (nameHint) {
          const syntheticName = ctx.anonClassExprNames.get(rhs);
          if (syntheticName) {
            ctx.classExprNameMap.set(nameHint, syntheticName);
          }
        }
      }
    }
    // Standalone class expression in any other position
    if (ts.isClassExpression(node)) {
      registerClassExpression(node);
    }
    ts.forEachChild(node, collectAnonymousClassesInNewExpr);
  }

  function collectClassesFromStatements(stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      if (ts.isClassDeclaration(stmt) && stmt.name && !hasDeclareModifier(stmt)) {
        collectClassDeclaration(ctx, stmt);
        // Register class declaration .name
        ctx.functionNameMap.set(stmt.name.text, stmt.name.text);
      } else if (ts.isVariableStatement(stmt) && !hasDeclareModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isClassExpression(decl.initializer)) {
            collectClassDeclaration(ctx, decl.initializer, decl.name.text);
            // Register class expression .name: named class keeps its own name, anonymous gets variable name
            const esName = decl.initializer.name ? decl.initializer.name.text : decl.name.text;
            ctx.functionNameMap.set(decl.name.text, esName);
          }
          // Recurse into arrow functions and function expressions
          if (decl.initializer) {
            collectClassesFromFunctionBody(decl.initializer);
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        collectClassesFromStatements(stmt.body.statements);
      } else if (ts.isIfStatement(stmt)) {
        // Recurse into if/else blocks
        if (ts.isBlock(stmt.thenStatement)) {
          collectClassesFromStatements(stmt.thenStatement.statements);
        }
        if (stmt.elseStatement && ts.isBlock(stmt.elseStatement)) {
          collectClassesFromStatements(stmt.elseStatement.statements);
        }
      } else if (ts.isBlock(stmt)) {
        collectClassesFromStatements(stmt.statements);
      } else if (
        ts.isForStatement(stmt) ||
        ts.isForInStatement(stmt) ||
        ts.isForOfStatement(stmt) ||
        ts.isWhileStatement(stmt) ||
        ts.isDoStatement(stmt)
      ) {
        const body = stmt.statement;
        if (ts.isBlock(body)) {
          collectClassesFromStatements(body.statements);
        }
      } else if (ts.isSwitchStatement(stmt)) {
        for (const clause of stmt.caseBlock.clauses) {
          collectClassesFromStatements(clause.statements);
        }
      } else if (ts.isTryStatement(stmt)) {
        collectClassesFromStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) {
          collectClassesFromStatements(stmt.catchClause.block.statements);
        }
        if (stmt.finallyBlock) {
          collectClassesFromStatements(stmt.finallyBlock.statements);
        }
      } else if (ts.isLabeledStatement(stmt)) {
        if (ts.isBlock(stmt.statement)) {
          collectClassesFromStatements(stmt.statement.statements);
        }
      } else if (ts.isExportAssignment(stmt) || ts.isExportDeclaration(stmt)) {
        // handled at top level
      }
      // Also scan all statements for new (class { ... })() patterns
      collectAnonymousClassesInNewExpr(stmt);
    }
  }

  /** Recurse into arrow functions and function expressions to find class declarations */
  function collectClassesFromFunctionBody(expr: ts.Expression): void {
    if (ts.isArrowFunction(expr)) {
      if (ts.isBlock(expr.body)) {
        collectClassesFromStatements(expr.body.statements);
      }
    } else if (ts.isFunctionExpression(expr)) {
      if (expr.body) {
        collectClassesFromStatements(expr.body.statements);
      }
      // Also scan all statements for new (class { ... })() patterns
      collectAnonymousClassesInNewExpr(expr);
    }
  }
  collectClassesFromStatements(sourceFile.statements);

  // Third: collect function declarations (uses resolveWasmType for real type indices)
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && (stmt.name || hasExportModifier(stmt))) {
      // Skip declare function stubs (no body, inside or matching declare)
      if (hasDeclareModifier(stmt)) continue;

      // Anonymous `export default function() {}` gets the synthetic name "default"
      const name = stmt.name ? stmt.name.text : "default";
      // Register the function's .name value for ES-spec compliance
      ctx.functionNameMap.set(name, name);
      const sig = ctx.checker.getSignatureFromDeclaration(stmt);
      if (!sig) continue;

      // Check if this is a generic function — resolve types from call site
      const isGeneric = stmt.typeParameters && stmt.typeParameters.length > 0;
      const resolved = isGeneric ? resolveGenericCallSiteTypes(ctx, name, sourceFile) : null;
      if (resolved) {
        ctx.genericResolved.set(name, resolved);
      }

      // Track async functions — unwrap Promise<T> for Wasm return type
      // Exclude async generators: they return AsyncGenerator objects, not Promises.
      const isAsync = hasAsyncModifier(stmt);
      const isGenerator = isGeneratorFunction(stmt);
      if (isAsync && !isGenerator) {
        ctx.asyncFunctions.add(name);
      }

      // Track generator functions (function*)
      if (isGenerator) {
        ctx.generatorFunctions.add(name);
        // Determine yield element type from Generator<T> return annotation
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        const yieldType = unwrapGeneratorYieldType(retType, ctx);
        ctx.generatorYieldType.set(name, yieldType);
      }

      // Ensure anonymous types in signature are registered as structs
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      // For async functions, unwrap Promise<T> to get T for struct registration
      const unwrappedRetType = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
      if (!isGenerator && !isVoidType(unwrappedRetType)) ensureStructForType(ctx, unwrappedRetType);
      for (const p of stmt.parameters) {
        const pt = ctx.checker.getTypeAtLocation(p);
        ensureStructForType(ctx, pt);
      }

      let params: ValType[];
      let results: ValType[];

      // A binding-pattern parameter with a rest element and no type annotation
      // (e.g. `function f([...r])` or `function f({...x})`) infers as `{}` or
      // `{ [k: string]: any }` in TypeScript, which resolveWasmType maps to a
      // degenerate struct (single-field cell or empty struct). Callers that
      // pass an array/object to such a param fail the ref.test cast and
      // receive ref.null — breaking destructuring inside the function. Force
      // externref so the conversion paths in destructureParam{Array,Object}
      // handle the incoming value correctly.
      const restBindingOverridesToExternref = (p: ts.ParameterDeclaration): boolean => {
        if (p.type || p.dotDotDotToken) return false;
        if (ts.isArrayBindingPattern(p.name)) {
          return p.name.elements.some((e) => !ts.isOmittedExpression(e) && !!e.dotDotDotToken);
        }
        if (ts.isObjectBindingPattern(p.name)) {
          return p.name.elements.some((e) => !!e.dotDotDotToken);
        }
        return false;
      };

      if (isGenerator) {
        // Generator functions: parameters are compiled normally, return is externref
        params = [];
        for (let i = 0; i < stmt.parameters.length; i++) {
          const param = stmt.parameters[i]!;
          const paramType = ctx.checker.getTypeAtLocation(param);
          let wasmType: ValType = restBindingOverridesToExternref(param)
            ? { kind: "externref" }
            : resolveWasmType(ctx, paramType);
          // If the parameter has a default value and is a non-null ref type,
          // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
          if (param.initializer && wasmType.kind === "ref") {
            wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
          }
          // Infer untyped any params from call sites (same as non-generator path)
          if (
            !param.type &&
            paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) &&
            (wasmType.kind === "externref" ||
              (wasmType.kind === "ref_null" &&
                ctx.anyValueTypeIdx >= 0 &&
                (wasmType as { typeIdx: number }).typeIdx === ctx.anyValueTypeIdx))
          ) {
            const inferred = inferParamTypeFromCallSites(ctx, name, i, sourceFile);
            if (inferred) {
              wasmType = inferred;
            }
          }
          params.push(wasmType);
        }
        results = [{ kind: "externref" }]; // Returns a JS Generator object
      } else if (resolved) {
        // Use call-site resolved types for generic functions
        params = resolved.params;
        results = resolved.results;
      } else {
        params = [];
        for (let i = 0; i < stmt.parameters.length; i++) {
          const param = stmt.parameters[i]!;
          if (param.dotDotDotToken) {
            // Rest parameter: ...args: T[] → single (ref $__vec_elemKind) param
            const paramType = ctx.checker.getTypeAtLocation(param);
            const typeArgs = ctx.checker.getTypeArguments(paramType as ts.TypeReference);
            const elemTsType = typeArgs[0];
            const elemType: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
            // Use a unique key for ref element types so each struct gets its own array type
            const elemKey =
              elemType.kind === "ref" || elemType.kind === "ref_null" ? `ref_${elemType.typeIdx}` : elemType.kind;
            const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
            const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
            params.push({ kind: "ref_null", typeIdx: vecTypeIdx });
            ctx.funcRestParams.set(name, {
              restIndex: i,
              elemType,
              arrayTypeIdx: arrTypeIdx,
              vecTypeIdx,
            });
          } else {
            const paramType = ctx.checker.getTypeAtLocation(param);
            let wasmType: ValType = restBindingOverridesToExternref(param)
              ? { kind: "externref" }
              : resolveWasmType(ctx, paramType);
            // If the parameter has a default value and is a non-null ref type,
            // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
            if (param.initializer && wasmType.kind === "ref") {
              wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
            }
            // If the parameter has no explicit type annotation and resolved to
            // externref (from `any`), try to infer a concrete type from call sites.
            if (
              !param.type &&
              paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) &&
              (wasmType.kind === "externref" ||
                (wasmType.kind === "ref_null" &&
                  ctx.anyValueTypeIdx >= 0 &&
                  (wasmType as { typeIdx: number }).typeIdx === ctx.anyValueTypeIdx))
            ) {
              const inferred = inferParamTypeFromCallSites(ctx, name, i, sourceFile);
              if (inferred) {
                wasmType = inferred;
              }
            }
            params.push(wasmType);
          }
        }
        const r = ctx.checker.getReturnTypeOfSignature(sig);
        // For async functions, unwrap Promise<T> to get T for Wasm return type
        const rUnwrapped = isAsync ? unwrapPromiseType(r, ctx.checker) : r;
        results = isVoidType(rUnwrapped) ? [] : [resolveWasmType(ctx, rUnwrapped)];
      }

      const optionalParams: OptionalParamInfo[] = [];
      for (let i = 0; i < stmt.parameters.length; i++) {
        const param = stmt.parameters[i]!;
        if (param.questionToken || param.initializer) {
          const info: OptionalParamInfo = { index: i, type: params[i]! };
          if (param.initializer) {
            const cd = extractConstantDefault(param.initializer, params[i]!);
            if (cd) {
              info.constantDefault = cd;
            } else {
              info.hasExpressionDefault = true;
            }
          }
          optionalParams.push(info);
        }
      }

      if (optionalParams.length > 0) {
        ctx.funcOptionalParams.set(name, optionalParams);
      }

      // Track functions that read `arguments` (#1053) so callers can
      // populate the __extras_argv global with runtime args beyond the
      // formal param count.
      if (stmt.body && bodyUsesArguments(stmt.body)) {
        ctx.funcUsesArguments.add(name);
      }

      const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
      const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(name, funcIdx);

      // Create placeholder function to be filled in second pass
      // Only export as Wasm exports if this is the entry file
      const isExported = isEntryFile && hasExportModifier(stmt);
      const func: WasmFunction = {
        name,
        typeIdx,
        locals: [],
        body: [],
        exported: isExported,
      };
      ctx.mod.functions.push(func);

      if (isExported) {
        ctx.mod.exports.push({
          name,
          desc: { kind: "func", index: funcIdx },
        });
        // `export default function foo() {}` — also export as "default" (#1074)
        // Skip if name is already "default" (anonymous export default function)
        const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
        const isDefault = mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
        if (isDefault && name !== "default") {
          ctx.mod.exports.push({
            name: "default",
            desc: { kind: "func", index: funcIdx },
          });
        }
      }
    }
  }

  // Export default: surface `export default <ident>` as Wasm exports (#1074).
  // Walk ExportAssignment nodes and resolve the bound declaration to a function
  // already registered in funcMap.  Emit under both the declaration name AND
  // "default" so either `instance.exports.identity(x)` or
  // `instance.exports.default(x)` works from a JS host.
  if (isEntryFile) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isExportAssignment(stmt)) continue;
      // `export = expr` (isExportEquals) is CJS — skip for now (#1075)
      if (stmt.isExportEquals) continue;

      let targetName: string | undefined;

      // Case 1: `export default <identifier>` — resolve the referenced name
      if (ts.isIdentifier(stmt.expression)) {
        targetName = stmt.expression.text;
      }
      // Case 2: `export default function foo() {}` — inline function decl
      else if (ts.isFunctionExpression(stmt.expression) && stmt.expression.name) {
        targetName = stmt.expression.name.text;
      }

      if (targetName && ctx.funcMap.has(targetName)) {
        const funcIdx = ctx.funcMap.get(targetName)!;

        // Mark the function as exported (for dead-code elimination etc.)
        const func = ctx.mod.functions[funcIdx - ctx.numImportFuncs];
        if (func && !func.exported) {
          func.exported = true;
        }

        // Add the declaration name as an export if not already exported
        const alreadyExported = ctx.mod.exports.some((e) => e.desc.kind === "func" && e.desc.index === funcIdx);
        if (!alreadyExported) {
          ctx.mod.exports.push({
            name: targetName,
            desc: { kind: "func", index: funcIdx },
          });
        }

        // Always add "default" alias so ESM semantics are preserved
        ctx.mod.exports.push({
          name: "default",
          desc: { kind: "func", index: funcIdx },
        });
      }
    }
  }

  // CJS exports: recognize `module.exports` / `exports.foo` patterns (#1075).
  // Phase 1 — register CJS function expressions and surface CJS assignments as Wasm exports.
  // This runs after the ESM export-default block so CJS and ESM don't conflict.
  if (isEntryFile) {
    // Helper: check if expression is `module.exports`
    function isModuleExports(e: ts.Expression): boolean {
      return (
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === "module" &&
        e.name.text === "exports"
      );
    }

    // Helper: extract export name from `module.exports.foo` or `exports.foo`
    function getCjsNamedExportName(e: ts.Expression): string | undefined {
      if (!ts.isPropertyAccessExpression(e)) return undefined;
      // module.exports.foo
      if (isModuleExports(e.expression)) return e.name.text;
      // exports.foo
      if (ts.isIdentifier(e.expression) && e.expression.text === "exports") return e.name.text;
      return undefined;
    }

    // Track whether we saw `module.exports = ...` (replaces entire exports object)
    let hasModuleExportsDefault = false;

    for (const stmt of sourceFile.statements) {
      if (!ts.isExpressionStatement(stmt)) continue;
      const expr = stmt.expression;
      if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;

      // Pattern 1: `module.exports = <ident>` — default export of an existing function
      if (isModuleExports(expr.left) && ts.isIdentifier(expr.right)) {
        const targetName = expr.right.text;
        if (ctx.funcMap.has(targetName)) {
          hasModuleExportsDefault = true;
          const funcIdx = ctx.funcMap.get(targetName)!;
          const func = ctx.mod.functions[funcIdx - ctx.numImportFuncs];
          if (func && !func.exported) func.exported = true;

          const alreadyExported = ctx.mod.exports.some((e) => e.desc.kind === "func" && e.desc.index === funcIdx);
          if (!alreadyExported) {
            ctx.mod.exports.push({ name: targetName, desc: { kind: "func", index: funcIdx } });
          }
          ctx.mod.exports.push({ name: "default", desc: { kind: "func", index: funcIdx } });
        }
        continue;
      }

      // Pattern 1b: `module.exports = function foo() {}` — default export of inline function
      if (isModuleExports(expr.left) && ts.isFunctionExpression(expr.right)) {
        hasModuleExportsDefault = true;
        const fnExpr = expr.right;
        const name = fnExpr.name?.text ?? "default";
        if (!ctx.funcMap.has(name)) {
          // Register the function expression
          const sig = ctx.checker.getSignatureFromDeclaration(fnExpr);
          if (sig) {
            const params: ValType[] = [];
            for (const param of fnExpr.parameters) {
              const paramType = ctx.checker.getTypeAtLocation(param);
              params.push(resolveWasmType(ctx, paramType));
            }
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            const results = isVoidType(retType) ? [] : [resolveWasmType(ctx, retType)];
            const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
            const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
            ctx.funcMap.set(name, funcIdx);
            ctx.functionNameMap.set(name, fnExpr.name?.text ?? name);
            ctx.mod.functions.push({ name, typeIdx, locals: [], body: [], exported: true });
            ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
            if (name !== "default") {
              ctx.mod.exports.push({ name: "default", desc: { kind: "func", index: funcIdx } });
            }
          }
        }
        continue;
      }

      // Pattern 2: `module.exports.foo = <fn>` or `exports.foo = <fn>` — named export
      const exportName = getCjsNamedExportName(expr.left);
      if (!exportName) continue;

      if (ts.isFunctionExpression(expr.right)) {
        const fnExpr = expr.right;
        const name = exportName;
        if (!ctx.funcMap.has(name)) {
          // Register the CJS function expression
          const sig = ctx.checker.getSignatureFromDeclaration(fnExpr);
          if (!sig) continue;
          const params: ValType[] = [];
          for (const param of fnExpr.parameters) {
            const paramType = ctx.checker.getTypeAtLocation(param);
            params.push(resolveWasmType(ctx, paramType));
          }
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          const results = isVoidType(retType) ? [] : [resolveWasmType(ctx, retType)];
          const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
          const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
          ctx.funcMap.set(name, funcIdx);
          ctx.functionNameMap.set(name, fnExpr.name?.text ?? name);
          ctx.mod.functions.push({ name, typeIdx, locals: [], body: [], exported: true });
          ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
        } else {
          // Function already registered (e.g., as a FunctionDeclaration) — just export it
          const funcIdx = ctx.funcMap.get(name)!;
          const func = ctx.mod.functions[funcIdx - ctx.numImportFuncs];
          if (func && !func.exported) func.exported = true;
          if (!ctx.mod.exports.some((e) => e.name === name)) {
            ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
          }
        }
      } else if (ts.isIdentifier(expr.right)) {
        // `exports.foo = someExistingFunction`
        const targetName = expr.right.text;
        if (ctx.funcMap.has(targetName)) {
          const funcIdx = ctx.funcMap.get(targetName)!;
          const func = ctx.mod.functions[funcIdx - ctx.numImportFuncs];
          if (func && !func.exported) func.exported = true;
          if (!ctx.mod.exports.some((e) => e.name === exportName)) {
            ctx.mod.exports.push({ name: exportName, desc: { kind: "func", index: funcIdx } });
          }
        }
      }
    }
  }

  // Fourth: collect module-level variable declarations as wasm globals
  /** Register a single module-level global variable with the given name and wasm type. */
  function registerModuleGlobal(name: string, wasmType: ValType): void {
    if (ctx.funcMap.has(name)) return; // skip if shadowed by function
    if (ctx.moduleGlobals.has(name)) return; // skip if already registered
    if (ctx.classSet.has(name)) return; // skip class expression variables

    // Build null/zero initializer for the global
    const init: Instr[] =
      wasmType.kind === "f64"
        ? [{ op: "f64.const", value: 0 }]
        : wasmType.kind === "i32"
          ? [{ op: "i32.const", value: 0 }]
          : wasmType.kind === "i64"
            ? [{ op: "i64.const", value: 0n }]
            : wasmType.kind === "ref_null" || wasmType.kind === "ref"
              ? [
                  {
                    op: "ref.null",
                    typeIdx: (wasmType as { typeIdx: number }).typeIdx,
                  },
                ]
              : [{ op: "ref.null.extern" }];

    // Widen non-nullable ref to ref_null so the global can hold null initially
    const globalType: ValType =
      wasmType.kind === "ref"
        ? {
            kind: "ref_null",
            typeIdx: (wasmType as { typeIdx: number }).typeIdx,
          }
        : wasmType;

    const globalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__mod_${name}`,
      type: globalType,
      mutable: true,
      init,
    });
    ctx.moduleGlobals.set(name, globalIdx);
  }

  /** Register binding names from destructuring patterns as module globals. */
  function registerBindingNames(pattern: ts.BindingPattern): void {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) {
        const elemType = ctx.checker.getTypeAtLocation(element);
        const wasmType = resolveWasmType(ctx, elemType);
        registerModuleGlobal(element.name.text, wasmType);
      } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        registerBindingNames(element.name);
      }
    }
  }

  /** Register var declarations from a variable declaration list as module globals. */
  function registerVarDeclListGlobals(list: ts.VariableDeclarationList): void {
    // Only hoist `var` (not let/const) — let/const are block-scoped
    if (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) return;
    for (const decl of list.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const varType = ctx.checker.getTypeAtLocation(decl);
        const wasmType = resolveWasmType(ctx, varType);
        registerModuleGlobal(decl.name.text, wasmType);
      } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
        registerBindingNames(decl.name);
      }
    }
  }

  /**
   * Recursively walk a statement to find and register `var` declarations
   * as module globals. This implements JavaScript var-hoisting semantics
   * at the module level: `var` declarations inside for-loops, if-blocks,
   * try/catch, switch, etc. are hoisted to the module scope.
   */
  function walkModuleStmtForVars(stmt: ts.Statement): void {
    if (ts.isVariableStatement(stmt)) {
      if (hasDeclareModifier(stmt)) return;
      registerVarDeclListGlobals(stmt.declarationList);
      return;
    }
    if (ts.isBlock(stmt)) {
      for (const s of stmt.statements) walkModuleStmtForVars(s);
      return;
    }
    if (ts.isIfStatement(stmt)) {
      walkModuleStmtForVars(stmt.thenStatement);
      if (stmt.elseStatement) walkModuleStmtForVars(stmt.elseStatement);
      return;
    }
    if (ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
      walkModuleStmtForVars(stmt.statement);
      return;
    }
    if (ts.isForStatement(stmt)) {
      if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
        registerVarDeclListGlobals(stmt.initializer);
      }
      walkModuleStmtForVars(stmt.statement);
      return;
    }
    if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
      if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
        registerVarDeclListGlobals(stmt.initializer);
      }
      walkModuleStmtForVars(stmt.statement);
      return;
    }
    if (ts.isLabeledStatement(stmt)) {
      walkModuleStmtForVars(stmt.statement);
      return;
    }
    if (ts.isTryStatement(stmt)) {
      for (const s of stmt.tryBlock.statements) walkModuleStmtForVars(s);
      if (stmt.catchClause) {
        for (const s of stmt.catchClause.block.statements) walkModuleStmtForVars(s);
      }
      if (stmt.finallyBlock) {
        for (const s of stmt.finallyBlock.statements) walkModuleStmtForVars(s);
      }
      return;
    }
    if (ts.isSwitchStatement(stmt)) {
      for (const clause of stmt.caseBlock.clauses) {
        for (const s of clause.statements) walkModuleStmtForVars(s);
      }
    }
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      if (hasDeclareModifier(stmt)) continue;
      // Track let/const for TDZ enforcement
      const isLetOrConst = (stmt.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const varType = ctx.checker.getTypeAtLocation(decl);
          const wasmType = resolveWasmType(ctx, varType);
          registerModuleGlobal(decl.name.text, wasmType);
          if (isLetOrConst) {
            ctx.tdzLetConstNames.add(decl.name.text);
          }
        } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
          registerBindingNames(decl.name);
        }
      }
      // Collect the statement for init compilation (skip pure class expression bindings)
      const hasNonClassDecl = stmt.declarationList.declarations.some(
        (d) => !(ts.isIdentifier(d.name) && d.initializer && ts.isClassExpression(d.initializer)),
      );
      if (hasNonClassDecl) {
        ctx.moduleInitStatements.push(stmt);
      }
      continue;
    }
    // For control-flow statements at module level, recursively scan for
    // `var` declarations (JavaScript var-hoisting) and collect the statement
    // for init compilation so it executes at module load time.
    if (
      ts.isForStatement(stmt) ||
      ts.isForInStatement(stmt) ||
      ts.isForOfStatement(stmt) ||
      ts.isWhileStatement(stmt) ||
      ts.isDoStatement(stmt)
    ) {
      walkModuleStmtForVars(stmt);
      ctx.moduleInitStatements.push(stmt);
      continue;
    }
    if (ts.isIfStatement(stmt)) {
      walkModuleStmtForVars(stmt);
      ctx.moduleInitStatements.push(stmt);
      continue;
    }
    if (ts.isTryStatement(stmt)) {
      walkModuleStmtForVars(stmt);
      ctx.moduleInitStatements.push(stmt);
      continue;
    }
    if (ts.isSwitchStatement(stmt)) {
      walkModuleStmtForVars(stmt);
      ctx.moduleInitStatements.push(stmt);
      continue;
    }
    if (ts.isLabeledStatement(stmt)) {
      walkModuleStmtForVars(stmt);
      ctx.moduleInitStatements.push(stmt);
      continue;
    }
    if (ts.isBlock(stmt)) {
      walkModuleStmtForVars(stmt);
      ctx.moduleInitStatements.push(stmt);
    }
  }

  // Fifth: collect module-level expression statements for init compilation
  // (e.g. obj.length = 3, obj[0] = 10 for shape-inferred array-like variables,
  //  new function(){}(args) constructor calls, standalone function calls)
  for (const stmt of sourceFile.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;

    // Collect `new` expression statements (e.g. `new function(){...}(args)`)
    if (ts.isNewExpression(expr)) {
      ctx.moduleInitStatements.push(stmt);
      continue;
    }

    // Collect standalone function call statements (e.g. `foo()`)
    if (ts.isCallExpression(expr)) {
      ctx.moduleInitStatements.push(stmt);
      continue;
    }

    // Collect prefix/postfix increment/decrement expressions (++x, x++, --x, x--)
    if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) {
      ctx.moduleInitStatements.push(stmt);
      continue;
    }

    // Collect binary expression statements that modify module-level globals
    if (!ts.isBinaryExpression(expr)) continue;
    // Accept all assignment operators (=, +=, -=, etc.) and any binary op that
    // might have side effects on module globals
    const opKind = expr.operatorToken.kind;
    const isAssignOp =
      opKind === ts.SyntaxKind.EqualsToken ||
      opKind === ts.SyntaxKind.PlusEqualsToken ||
      opKind === ts.SyntaxKind.MinusEqualsToken ||
      opKind === ts.SyntaxKind.AsteriskEqualsToken ||
      opKind === ts.SyntaxKind.SlashEqualsToken ||
      opKind === ts.SyntaxKind.PercentEqualsToken ||
      opKind === ts.SyntaxKind.AmpersandEqualsToken ||
      opKind === ts.SyntaxKind.BarEqualsToken ||
      opKind === ts.SyntaxKind.CaretEqualsToken ||
      opKind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      opKind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      opKind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken;
    if (!isAssignOp) continue;
    // Check if the left side references a known module global
    const targetName = getAssignmentRootIdentifier(expr.left);
    if (targetName && ctx.moduleGlobals.has(targetName)) {
      ctx.moduleInitStatements.push(stmt);
    }
  }

  // Export default for module globals (#1108): `export default <variable>` where
  // the variable is a module-level global (e.g. `var add = createMathOperation(fn, 0)`)
  // This runs AFTER module globals are registered (Fourth pass above).
  if (isEntryFile) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue;
      if (!ts.isIdentifier(stmt.expression)) continue;
      const varName = stmt.expression.text;
      // Skip if already handled as a function export
      if (ctx.funcMap.has(varName)) continue;
      if (ctx.moduleGlobals.has(varName)) {
        // Defer the actual export — global indices are not final yet because
        // later collectDeclarations calls may add string-constant import globals
        // which shift all defined-global indices.  Record the variable name
        // and resolve the correct absolute index in a fixup pass.
        if (!ctx.deferredDefaultGlobalExport) {
          ctx.deferredDefaultGlobalExport = varName;
        }
      }
    }
  }
}

export function collectInterface(ctx: CodegenContext, decl: ts.InterfaceDeclaration): void {
  const name = decl.name.text;
  const fields: FieldDef[] = [];

  for (const member of decl.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const memberName = (member.name as ts.Identifier).text;
      const memberType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(memberType, ctx.checker);
      fields.push({
        name: memberName,
        type: wasmType,
        mutable: true,
      });
    }
  }

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name,
    fields,
  } as StructTypeDef);
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
}

/**
 * After all interfaces and type aliases are collected, re-resolve field types
 * that were initially mapped to externref but should be ref $struct.
 * This handles cross-references between interfaces regardless of declaration order.
 */
export function resolveStructFieldTypes(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  for (const stmt of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt)) continue;

    const name = ts.isInterfaceDeclaration(stmt) ? stmt.name.text : stmt.name.text;
    const fields = ctx.structFields.get(name);
    const structTypeIdx = ctx.structMap.get(name);
    if (!fields || structTypeIdx === undefined) continue;

    let changed = false;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      if (field.type.kind !== "externref") continue;

      // Try to re-resolve using resolveWasmType which knows about structs
      let memberTsType: ts.Type | undefined;
      if (ts.isInterfaceDeclaration(stmt)) {
        for (const member of stmt.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const memberName = (member.name as ts.Identifier).text;
            if (memberName === field.name) {
              memberTsType = ctx.checker.getTypeAtLocation(member);
              break;
            }
          }
        }
      } else {
        const aliasType = ctx.checker.getTypeAtLocation(stmt);
        const props = aliasType.getProperties();
        for (const prop of props) {
          if (prop.name === field.name) {
            memberTsType = ctx.checker.getTypeOfSymbol(prop);
            break;
          }
        }
      }

      if (!memberTsType) continue;
      const resolved = resolveWasmType(ctx, memberTsType);
      if (resolved.kind === "ref" || resolved.kind === "ref_null") {
        field.type = resolved;
        changed = true;
      }
    }

    // If any fields changed, update the type definition in mod.types too
    if (changed) {
      const typeDef = ctx.mod.types[structTypeIdx];
      if (typeDef && typeDef.kind === "struct") {
        (typeDef as any).fields = fields;
      }
    }
  }
}

export function collectObjectType(ctx: CodegenContext, name: string, type: ts.Type): void {
  const fields: FieldDef[] = [];
  for (const prop of type.getProperties()) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const wasmType = mapTsTypeToWasm(propType, ctx.checker);
    fields.push({
      name: prop.name,
      type: wasmType,
      mutable: true,
    });
  }

  if (fields.length > 0) {
    const typeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name,
      fields,
    } as StructTypeDef);
    ctx.structMap.set(name, typeIdx);
    ctx.typeIdxToStructName.set(typeIdx, name);
    ctx.structFields.set(name, fields);
  }
}

/** Compile all function bodies (including class constructors and methods) */
export function compileDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  // Build a map from function name → index within ctx.mod.functions
  const funcByName = new Map<string, number>();
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    funcByName.set(ctx.mod.functions[i]!.name, i);
  }

  // Compile class constructors and methods
  // Also compile class expressions in variable declarations
  // Scan recursively into function bodies for class expressions
  function compileClassesFromStatements(
    stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
    insideFunction = false,
  ): void {
    for (const stmt of stmts) {
      if (ts.isClassDeclaration(stmt) && stmt.name && !hasDeclareModifier(stmt)) {
        if (insideFunction) {
          // Defer body compilation — will be compiled in compileNestedClassDeclaration
          // when the enclosing function is compiled (so captured locals are available)
          ctx.deferredClassBodies.add(stmt.name.text);
        } else {
          try {
            compileClassBodies(ctx, stmt, funcByName);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            reportError(ctx, stmt, `Internal error compiling class '${stmt.name.text}': ${msg}`);
          }
        }
      } else if (ts.isVariableStatement(stmt) && !hasDeclareModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isClassExpression(decl.initializer)) {
            if (insideFunction) {
              ctx.deferredClassBodies.add(decl.name.text);
            } else {
              try {
                compileClassBodies(ctx, decl.initializer, funcByName, decl.name.text);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                reportError(ctx, decl, `Internal error compiling class expression: ${msg}`);
              }
            }
          }
          // Recurse into arrow functions and function expressions
          if (decl.initializer) {
            compileClassesFromFunctionBody(decl.initializer);
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        compileClassesFromStatements(stmt.body.statements, true);
      } else if (ts.isIfStatement(stmt)) {
        if (ts.isBlock(stmt.thenStatement)) {
          compileClassesFromStatements(stmt.thenStatement.statements);
        }
        if (stmt.elseStatement && ts.isBlock(stmt.elseStatement)) {
          compileClassesFromStatements(stmt.elseStatement.statements);
        }
      } else if (ts.isBlock(stmt)) {
        compileClassesFromStatements(stmt.statements);
      } else if (
        ts.isForStatement(stmt) ||
        ts.isForInStatement(stmt) ||
        ts.isForOfStatement(stmt) ||
        ts.isWhileStatement(stmt) ||
        ts.isDoStatement(stmt)
      ) {
        const body = stmt.statement;
        if (ts.isBlock(body)) {
          compileClassesFromStatements(body.statements);
        }
      } else if (ts.isSwitchStatement(stmt)) {
        for (const clause of stmt.caseBlock.clauses) {
          compileClassesFromStatements(clause.statements);
        }
      } else if (ts.isTryStatement(stmt)) {
        compileClassesFromStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) {
          compileClassesFromStatements(stmt.catchClause.block.statements);
        }
        if (stmt.finallyBlock) {
          compileClassesFromStatements(stmt.finallyBlock.statements);
        }
      } else if (ts.isLabeledStatement(stmt)) {
        if (ts.isBlock(stmt.statement)) {
          compileClassesFromStatements(stmt.statement.statements);
        }
      }
      // Compile bodies for anonymous class expressions in new expressions
      compileAnonymousClassBodiesInNode(stmt);
    }
  }

  /** Recurse into arrow functions and function expressions to compile class bodies */
  function compileClassesFromFunctionBody(expr: ts.Expression): void {
    if (ts.isArrowFunction(expr)) {
      if (ts.isBlock(expr.body)) {
        compileClassesFromStatements(expr.body.statements, true);
      }
    } else if (ts.isFunctionExpression(expr)) {
      if (expr.body) {
        compileClassesFromStatements(expr.body.statements, true);
      }
      // Compile bodies for anonymous class expressions in new expressions
      compileAnonymousClassBodiesInNode(expr);
    }
  }

  // Recursively scan for class expressions and compile the class bodies
  const compiledAnonClasses = new Set<ts.ClassExpression>();
  function compileAnonClassIfNeeded(classExpr: ts.ClassExpression): void {
    if (compiledAnonClasses.has(classExpr)) return;
    const syntheticName = ctx.anonClassExprNames.get(classExpr);
    if (syntheticName) {
      compiledAnonClasses.add(classExpr);
      try {
        compileClassBodies(ctx, classExpr, funcByName, syntheticName);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reportError(ctx, classExpr, `Internal error compiling anonymous class: ${msg}`);
      }
    }
  }
  function compileAnonymousClassBodiesInNode(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      let inner: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
      }
      if (ts.isClassExpression(inner)) {
        compileAnonClassIfNeeded(inner);
      }
    }
    // Also compile class expressions in any other position
    if (ts.isClassExpression(node)) {
      compileAnonClassIfNeeded(node);
    }
    ts.forEachChild(node, compileAnonymousClassBodiesInNode);
  }

  compileClassesFromStatements(sourceFile.statements);

  // Create TDZ flag globals for let/const module globals.
  // Each TDZ flag is an i32 global initialized to 0 (uninitialized).
  // When the variable's initializer runs, the flag is set to 1.
  // Reads of the variable check the flag and throw ReferenceError if 0.
  for (const name of ctx.tdzLetConstNames) {
    if (!ctx.moduleGlobals.has(name)) continue; // safety check
    const flagGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__tdz_${name}`,
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    ctx.tdzGlobals.set(name, flagGlobalIdx);
  }

  // Compile module-level init statements BEFORE function bodies so that
  // closureMap is populated for module-level arrow function variables.
  // This allows function bodies (e.g. test()) to reference module-level closures.
  const hasModuleInits = ctx.moduleInitStatements.length > 0;
  const hasStaticInits = ctx.staticInitExprs.length > 0;
  let compiledInitFctx: FunctionContext | null = null;

  function compileModuleInitBody(): FunctionContext {
    const initFctx: FunctionContext = {
      name: "__module_init",
      params: [],
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
    ctx.currentFunc = initFctx;

    // Compile static property initializers
    for (const { globalIdx, initializer } of ctx.staticInitExprs) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      compileExpression(ctx, initFctx, initializer, globalDef?.type);
      initFctx.body.push({ op: "global.set", index: globalIdx });
    }

    // Compile module-level variable init statements
    for (const stmt of ctx.moduleInitStatements) {
      compileStatement(ctx, initFctx, stmt);
    }

    ctx.currentFunc = null;
    return initFctx;
  }

  if (hasModuleInits || hasStaticInits) {
    compiledInitFctx = compileModuleInitBody();
    // Expose the pending init body so fixupModuleGlobalIndices can adjust it
    // when addStringConstantGlobal is called during function body compilation.
    ctx.pendingInitBody = compiledInitFctx.body;
  }

  // Compile top-level function declarations
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && (stmt.name || hasExportModifier(stmt)) && !hasDeclareModifier(stmt)) {
      const fnName = stmt.name ? stmt.name.text : "default";
      if (stmt.body) {
        const idx = funcByName.get(fnName);
        if (idx !== undefined) {
          const func = ctx.mod.functions[idx]!;
          try {
            compileFunctionBody(ctx, stmt, func);
            registerInlinableFunction(ctx, fnName, func);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            reportError(ctx, stmt, `Internal error compiling function '${fnName}': ${msg}`);
          }
        }
      }
    }
  }

  // Compile CJS function expression bodies (#1075)
  // These were registered in collectDeclarations from `module.exports.foo = function() {}`
  // and `exports.foo = function() {}` patterns.
  for (const stmt of sourceFile.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;

    // Extract the function expression from CJS patterns
    let fnExpr: ts.FunctionExpression | undefined;
    let funcName: string | undefined;

    const left = expr.left;
    if (ts.isFunctionExpression(expr.right)) {
      // Check for module.exports = function() {} or module.exports.foo = function() {} or exports.foo = function() {}
      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === "module" &&
        left.name.text === "exports"
      ) {
        // module.exports = function foo() {}
        fnExpr = expr.right;
        funcName = fnExpr.name?.text ?? "default";
      } else if (ts.isPropertyAccessExpression(left)) {
        // module.exports.foo or exports.foo
        const inner = left.expression;
        const isModExports =
          ts.isPropertyAccessExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === "module" &&
          inner.name.text === "exports";
        const isExports = ts.isIdentifier(inner) && inner.text === "exports";
        if (isModExports || isExports) {
          fnExpr = expr.right;
          funcName = left.name.text;
        }
      }
    }

    if (!fnExpr || !funcName || !fnExpr.body) continue;
    const idx = funcByName.get(funcName);
    if (idx === undefined) continue;
    const func = ctx.mod.functions[idx]!;
    // Skip if body already compiled (e.g., was also a FunctionDeclaration)
    if (func.body.length > 0) continue;
    try {
      compileFunctionBody(ctx, fnExpr as unknown as ts.FunctionDeclaration, func);
      registerInlinableFunction(ctx, funcName, func);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reportError(ctx, stmt, `Internal error compiling CJS function '${funcName}': ${msg}`);
    }
  }

  // Recompile module init after top-level functions are compiled so call sites
  // inside module-level code can see the final inlinable-function registry.
  // The first compile above still serves early closure/setup discovery.
  if (hasModuleInits || hasStaticInits) {
    compiledInitFctx = compileModuleInitBody();
    ctx.pendingInitBody = compiledInitFctx.body;
  }

  // Clear pendingInitBody before injection (it will be in mod.functions or main body after this)
  ctx.pendingInitBody = null;

  // Helper: recursively shift local indices in instruction trees
  function shiftLocalIndices(instrs: Instr[], shift: number): void {
    for (const instr of instrs) {
      if (
        (instr.op === "local.get" || instr.op === "local.set" || instr.op === "local.tee") &&
        typeof (instr as any).index === "number"
      ) {
        (instr as any).index += shift;
      }
      // Recurse into nested blocks
      const a = instr as any;
      if (a.then) shiftLocalIndices(a.then, shift);
      if (a.else) shiftLocalIndices(a.else, shift);
      if (a.body) shiftLocalIndices(a.body, shift);
      if (a.instrs) shiftLocalIndices(a.instrs, shift);
    }
  }

  // Inject the compiled init body into the appropriate location
  if (compiledInitFctx && compiledInitFctx.body.length > 0) {
    ctx.mod.hasTopLevelStatements = true;
    const mainIdx = funcByName.get("main");
    if (mainIdx !== undefined) {
      const mainFunc = ctx.mod.functions[mainIdx]!;
      // Prepend init body + init locals to main's body
      mainFunc.body = [...compiledInitFctx.body, ...mainFunc.body];
      // Add init locals to main's locals (adjust any local indices in init body)
      // Find number of existing main locals
      const existingLocals = mainFunc.locals.length;
      // Append init locals to main's locals
      mainFunc.locals = [...mainFunc.locals, ...compiledInitFctx.locals];
      // Adjust local indices in init body (shift by existing locals count in main)
      // Must recurse into nested blocks (if/then/else, block, loop)
      if (existingLocals > 0) {
        shiftLocalIndices(compiledInitFctx.body, existingLocals);
      }
    } else {
      // No main() function — create a standalone __module_init.
      // Strategy depends on whether there are user-exported functions (#907):
      //   - No exports: export __module_init directly as _start (no guard needed)
      //   - Has exports: inject guarded call via __init_done into each export

      const hasExportedFunctions = ctx.mod.functions.some((f) => f.exported && f.name !== "__module_init");

      if (!hasExportedFunctions) {
        // Module-init-only program: export __module_init as _start.
        // No __init_done guard needed — the caller invokes _start once.
        const initTypeIdx = addFuncType(ctx, [], [], "__module_init_type");
        const initFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
        ctx.mod.functions.push({
          name: "_start",
          typeIdx: initTypeIdx,
          locals: compiledInitFctx.locals,
          body: compiledInitFctx.body,
          exported: true,
        });
        ctx.mod.exports.push({
          name: "_start",
          desc: { kind: "func", index: initFuncIdx },
        });
      } else {
        // Has exports but no main() — use __init_done guard for lazy init.
        const guardGlobalIdx = nextModuleGlobalIdx(ctx);
        ctx.mod.globals.push({
          name: "__init_done",
          type: { kind: "i32" },
          mutable: true,
          init: [{ op: "i32.const", value: 0 }],
        });

        const initTypeIdx = addFuncType(ctx, [], [], "__module_init_type");
        const initFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
        ctx.mod.functions.push({
          name: "__module_init",
          typeIdx: initTypeIdx,
          locals: compiledInitFctx.locals,
          body: compiledInitFctx.body,
          exported: false,
        });

        // Inject guarded call at the start of every exported function.
        // Each function gets its own deep copy of the guard preamble instructions
        // to avoid shared-object bugs during dead-import elimination's index remapping.
        for (const func of ctx.mod.functions) {
          if (func.exported && func.name !== "__module_init") {
            const guardPreamble: Instr[] = [
              { op: "global.get", index: guardGlobalIdx },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "global.set", index: guardGlobalIdx } as Instr,
                  { op: "call", funcIdx: initFuncIdx } as Instr,
                ],
              } as Instr,
            ];
            func.body = [...guardPreamble, ...func.body];
          }
        }
      }
    }
  }
}

/**
 * Post-compilation fixup: insert extern.convert_any after struct.new when
 * the result is stored into an externref local (local.set / local.tee).
 *
 * This happens when a vec/class struct is created but the target variable
 * was typed as externref by the compiler.
 */

/** Internal field names that are not user-visible properties */
